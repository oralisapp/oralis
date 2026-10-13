import { Inject, Injectable } from '@nestjs/common';
import {
  APPOINTMENT_STATUS_LABEL,
  type AppointmentStatus,
  BLOCKING_STATUSES,
  CANCELLATION_REASONS,
  type CreateAppointmentInput,
  type RescheduleAppointmentInput,
  type ScheduleBlockInput,
  type ScheduleConflictDetail,
  type TransitionAppointmentInput,
  dayRangeInTz,
  findTransition,
  fitsBusinessHours,
  minutesToTime,
  parseTimeToMinutes,
  zonedParts,
  zonedToInstant,
} from '@oralis/shared';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { AppError, forbidden, notFound } from '../../common/app-error';
import { Clock } from '../../common/clock';
import { type AuthContext, type RequestMeta, type TenantContext, canAccessUnit } from '../../common/request-context';
import { DB, type Db, type Tx } from '../../db/db';
import {
  appointmentStatusHistory,
  appointments,
  businessHours,
  chairs,
  clinicUnits,
  patients,
  professionalUnits,
  professionals,
  scheduleBlocks,
  services,
  tasks,
  users,
  waitlistEntries,
} from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { DomainEvents } from '../platform/domain-events';

const MINUTE = 60_000;
const DAY = 86_400_000;

interface SlotRequest {
  organizationId: string;
  unitId: string;
  patientId: string;
  professionalId: string;
  chairId: string | null;
  start: Date;
  end: Date;
  exceptAppointmentId?: string;
}

export interface TransitionActor {
  userId: string | null;
  source: 'staff' | 'patient_link' | 'patient_portal' | 'automation';
}

/** Ocorrências de uma recorrência, mantendo o horário local mesmo em mudanças de fuso. */
export function occurrences(start: Date, tz: string, repeat: { frequency: 'weekly' | 'biweekly' | 'monthly'; count: number } | undefined): Date[] {
  if (!repeat) return [start];
  const p = zonedParts(start, tz);
  const time = minutesToTime(p.minutes);
  const [y, m, d] = p.date.split('-').map(Number) as [number, number, number];
  const out: Date[] = [];
  for (let i = 0; i < repeat.count; i++) {
    let date: string;
    if (repeat.frequency === 'monthly') {
      const dt = new Date(Date.UTC(y, m - 1 + i, d));
      if (dt.getUTCDate() !== d) continue; // ex.: dia 31 em meses mais curtos
      date = dt.toISOString().slice(0, 10);
    } else {
      date = new Date(Date.UTC(y, m - 1, d) + i * (repeat.frequency === 'weekly' ? 7 : 14) * DAY).toISOString().slice(0, 10);
    }
    out.push(zonedToInstant(date, time, tz));
  }
  return out;
}

@Injectable()
export class SchedulingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly events: DomainEvents,
  ) {}

  // ---------------------------------------------------------------- Leitura

  async agenda(tenant: TenantContext, unitId: string, date: string) {
    const unit = await this.loadUnit(this.db, tenant, unitId);
    const { start, end } = dayRangeInTz(date, unit.timezone);
    const [hours, profs, chairRows, serviceRows, appts, blocks] = await Promise.all([
      this.db.select({ weekday: businessHours.weekday, opensAt: businessHours.opensAt, closesAt: businessHours.closesAt }).from(businessHours).where(eq(businessHours.unitId, unitId)),
      this.unitProfessionals(tenant, unitId),
      this.db.select({ id: chairs.id, name: chairs.name, kind: chairs.kind }).from(chairs).where(and(eq(chairs.organizationId, tenant.organizationId), eq(chairs.unitId, unitId), eq(chairs.active, true))).orderBy(asc(chairs.name)),
      this.db.select({ id: services.id, name: services.name, durationMinutes: services.durationMinutes }).from(services).where(and(eq(services.organizationId, tenant.organizationId), eq(services.active, true))).orderBy(asc(services.name)),
      this.listAppointments(tenant.organizationId, and(eq(appointments.unitId, unitId), lt(appointments.startsAt, end), gt(appointments.endsAt, start))!),
      this.listBlocks(tenant.organizationId, unitId, start, end),
    ]);
    const weekday = zonedParts(new Date((start.getTime() + end.getTime()) / 2), unit.timezone).weekday;
    return {
      unit: { id: unit.id, name: unit.name, timezone: unit.timezone },
      date,
      businessHours: hours.filter((h) => h.weekday === weekday),
      professionals: profs,
      chairs: chairRows,
      services: serviceRows,
      appointments: appts,
      blocks,
      serverNow: this.clock.now().toISOString(),
    };
  }

  /** Visões de semana e mês: consultas e bloqueios de um intervalo de datas (máx. 42 dias). */
  async range(tenant: TenantContext, unitId: string, from: string, to: string) {
    const unit = await this.loadUnit(this.db, tenant, unitId);
    const start = dayRangeInTz(from, unit.timezone).start;
    const end = dayRangeInTz(to, unit.timezone).end;
    if (end.getTime() - start.getTime() > 43 * DAY) throw new AppError('validation_failed', 'Período máximo de 42 dias.');
    const [hours, profs, appts, blocks] = await Promise.all([
      this.db.select({ weekday: businessHours.weekday, opensAt: businessHours.opensAt, closesAt: businessHours.closesAt }).from(businessHours).where(eq(businessHours.unitId, unitId)),
      this.unitProfessionals(tenant, unitId),
      this.listAppointments(tenant.organizationId, and(eq(appointments.unitId, unitId), lt(appointments.startsAt, end), gt(appointments.endsAt, start))!),
      this.listBlocks(tenant.organizationId, unitId, start, end),
    ]);
    return { unit: { id: unit.id, name: unit.name, timezone: unit.timezone }, from, to, businessHours: hours, professionals: profs, appointments: appts, blocks };
  }

  /**
   * Vagas livres de um dia: horário de funcionamento menos bloqueios e
   * consultas ativas, por profissional, com duração mínima.
   */
  async openSlots(tenant: TenantContext, unitId: string, date: string, minMinutes = 30) {
    const day = await this.agenda(tenant, unitId, date);
    const tz = day.unit.timezone;
    const now = this.clock.now();
    const localNow = zonedParts(now, tz);
    const result: { professionalId: string; startsAt: string; endsAt: string; minutes: number }[] = [];
    for (const prof of day.professionals) {
      const busy: [number, number][] = [];
      for (const a of day.appointments) {
        if (a.professionalId !== prof.id || !BLOCKING_STATUSES.includes(a.status as AppointmentStatus)) continue;
        busy.push([zonedParts(new Date(a.startsAt), tz).minutes, zonedParts(new Date(a.endsAt), tz).minutes || 24 * 60]);
      }
      for (const b of day.blocks) {
        if (b.professionalId && b.professionalId !== prof.id) continue;
        if (b.chairId && !b.professionalId) continue;
        const s = new Date(b.startsAt) < dayRangeInTz(date, tz).start ? 0 : zonedParts(new Date(b.startsAt), tz).minutes;
        const e = new Date(b.endsAt) >= dayRangeInTz(date, tz).end ? 24 * 60 : zonedParts(new Date(b.endsAt), tz).minutes;
        busy.push([s, e]);
      }
      busy.sort((x, y) => x[0] - y[0]);
      for (const h of day.businessHours) {
        let cursor = parseTimeToMinutes(h.opensAt);
        // A gap that began earlier today can still accommodate an appointment.
        // Offer the next quarter hour, never an already elapsed start time.
        if (date === localNow.date) cursor = Math.max(cursor, (Math.floor(localNow.minutes / 15) + 1) * 15);
        const close = parseTimeToMinutes(h.closesAt);
        for (const [s, e] of [...busy, [close, close] as [number, number]]) {
          if (e <= cursor) continue;
          const gapEnd = Math.min(s, close);
          if (gapEnd - cursor >= minMinutes) {
            const startsAt = zonedToInstant(date, minutesToTime(cursor), tz);
            if (startsAt > now) result.push({ professionalId: prof.id, startsAt: startsAt.toISOString(), endsAt: zonedToInstant(date, minutesToTime(gapEnd), tz).toISOString(), minutes: gapEnd - cursor });
          }
          cursor = Math.max(cursor, e);
          if (cursor >= close) break;
        }
      }
    }
    return { unit: day.unit, date, slots: result, professionals: day.professionals };
  }

  private unitProfessionals(tenant: TenantContext, unitId: string) {
    return this.db
      .select({ id: professionals.id, displayName: professionals.displayName, color: professionals.color, membershipId: professionals.membershipId, specialties: professionals.specialties })
      .from(professionals)
      .innerJoin(professionalUnits, and(eq(professionalUnits.professionalId, professionals.id), eq(professionalUnits.unitId, unitId)))
      .where(and(eq(professionals.organizationId, tenant.organizationId), eq(professionals.active, true)))
      .orderBy(asc(professionals.displayName));
  }

  private listBlocks(organizationId: string, unitId: string, start: Date, end: Date) {
    return this.db
      .select({ id: scheduleBlocks.id, kind: scheduleBlocks.kind, reason: scheduleBlocks.reason, professionalId: scheduleBlocks.professionalId, chairId: scheduleBlocks.chairId, startsAt: scheduleBlocks.startsAt, endsAt: scheduleBlocks.endsAt, seriesId: scheduleBlocks.seriesId })
      .from(scheduleBlocks)
      .where(and(eq(scheduleBlocks.organizationId, organizationId), eq(scheduleBlocks.unitId, unitId), lt(scheduleBlocks.startsAt, end), gt(scheduleBlocks.endsAt, start)))
      .orderBy(asc(scheduleBlocks.startsAt));
  }

  async listAppointments(organizationId: string, where: SQL) {
    return this.db
      .select({
        id: appointments.id,
        unitId: appointments.unitId,
        startsAt: appointments.startsAt,
        endsAt: appointments.endsAt,
        status: appointments.status,
        version: appointments.version,
        notes: appointments.notes,
        cancellationReason: appointments.cancellationReason,
        patientId: patients.id,
        patientName: patients.fullName,
        patientSocialName: patients.socialName,
        patientPhone: patients.phone,
        professionalId: appointments.professionalId,
        chairId: appointments.chairId,
        serviceId: appointments.serviceId,
        serviceName: services.name,
        seriesId: appointments.seriesId,
        treatmentItemId: appointments.treatmentItemId,
        /** Momento do check-in, para exibir o tempo de espera na recepção. */
        arrivedAt: sql<string | null>`(
          select max(h.changed_at) from appointment_status_history h
          where h.appointment_id = ${appointments.id} and h.to_status = 'arrived'
        )`,
      })
      .from(appointments)
      .innerJoin(patients, eq(patients.id, appointments.patientId))
      .leftJoin(services, eq(services.id, appointments.serviceId))
      .where(and(eq(appointments.organizationId, organizationId), where))
      .orderBy(asc(appointments.startsAt));
  }

  async detail(tenant: TenantContext, id: string) {
    const [a] = await this.listAppointments(tenant.organizationId, eq(appointments.id, id));
    if (!a || !canAccessUnit(tenant, a.unitId)) throw notFound('Consulta');
    const changer = alias(users, 'changer');
    const history = await this.db
      .select({
        id: appointmentStatusHistory.id,
        fromStatus: appointmentStatusHistory.fromStatus,
        toStatus: appointmentStatusHistory.toStatus,
        reason: appointmentStatusHistory.reason,
        note: appointmentStatusHistory.note,
        source: appointmentStatusHistory.source,
        changedAt: appointmentStatusHistory.changedAt,
        changedByName: changer.name,
      })
      .from(appointmentStatusHistory)
      .leftJoin(changer, eq(changer.id, appointmentStatusHistory.changedBy))
      .where(and(eq(appointmentStatusHistory.appointmentId, id), eq(appointmentStatusHistory.organizationId, tenant.organizationId)))
      .orderBy(asc(appointmentStatusHistory.changedAt));
    const sourceLabel: Record<string, string> = { patient_link: 'Paciente (link de confirmação)', patient_portal: 'Paciente (portal)', automation: 'Automação' };
    return {
      appointment: a,
      history: history.map((h) => ({
        ...h,
        changedByName: h.changedByName ?? sourceLabel[h.source] ?? 'Sistema',
        toLabel: APPOINTMENT_STATUS_LABEL[h.toStatus as AppointmentStatus],
        fromLabel: h.fromStatus ? APPOINTMENT_STATUS_LABEL[h.fromStatus as AppointmentStatus] : null,
        reasonLabel: h.reason ? (CANCELLATION_REASONS[h.reason as keyof typeof CANCELLATION_REASONS] ?? h.reason) : null,
      })),
    };
  }

  // ---------------------------------------------------------------- Escrita

  async create(auth: AuthContext, tenant: TenantContext, input: CreateAppointmentInput, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const unit = await this.loadUnit(tx, tenant, input.unitId);
      await this.lockUnit(tx, unit.id);
      const [patient] = await tx
        .select({ id: patients.id })
        .from(patients)
        .where(and(eq(patients.id, input.patientId), eq(patients.organizationId, tenant.organizationId), eq(patients.status, 'active')));
      if (!patient) throw notFound('Paciente');
      if (input.serviceId) {
        const [svc] = await tx.select({ id: services.id }).from(services).where(and(eq(services.id, input.serviceId), eq(services.organizationId, tenant.organizationId), eq(services.active, true)));
        if (!svc) throw notFound('Serviço');
      }
      if (input.waitlistEntryId) {
        const [w] = await tx
          .select()
          .from(waitlistEntries)
          .where(and(eq(waitlistEntries.id, input.waitlistEntryId), eq(waitlistEntries.organizationId, tenant.organizationId)))
          .for('update');
        if (!w) throw notFound('Item da lista de espera');
        if (w.status !== 'active') throw new AppError('conflict', 'Este paciente já foi agendado a partir da lista de espera.');
        if (w.patientId !== input.patientId) throw new AppError('validation_failed', 'O item da lista de espera é de outro paciente.');
      }
      const first = new Date(input.startsAt);
      if (first.getTime() < this.clock.now().getTime() - 15 * MINUTE) {
        throw new AppError('validation_failed', 'Não é possível agendar em um horário que já passou.');
      }
      const starts = occurrences(first, unit.timezone, input.repeat);
      const ok: Date[] = [];
      const failed: { startsAt: string; message: string }[] = [];
      for (const start of starts) {
        const slot: SlotRequest = {
          organizationId: tenant.organizationId,
          unitId: unit.id,
          patientId: input.patientId,
          professionalId: input.professionalId,
          chairId: input.chairId ?? null,
          start,
          end: new Date(start.getTime() + input.durationMinutes * MINUTE),
        };
        try {
          await this.validateSlot(tx, unit.timezone, slot);
          ok.push(start);
        } catch (err) {
          if (!input.repeat || !(err instanceof AppError) || !['schedule_conflict', 'outside_business_hours'].includes(err.code)) throw err;
          failed.push({ startsAt: start.toISOString(), message: err.message });
        }
      }
      if (input.repeat && failed.length && (!input.skipConflicts || ok.length === 0)) {
        throw new AppError('schedule_conflict', `${failed.length} de ${starts.length} ocorrências têm conflito.`, { occurrences: failed });
      }

      const seriesId = input.repeat ? randomUUID() : null;
      const created: { id: string; version: number; startsAt: string }[] = [];
      for (const start of ok) {
        const end = new Date(start.getTime() + input.durationMinutes * MINUTE);
        const [row] = await tx
          .insert(appointments)
          .values({
            organizationId: tenant.organizationId,
            unitId: unit.id,
            patientId: input.patientId,
            professionalId: input.professionalId,
            chairId: input.chairId ?? null,
            serviceId: input.serviceId ?? null,
            startsAt: start,
            endsAt: end,
            notes: input.notes ?? null,
            seriesId,
            waitlistEntryId: input.waitlistEntryId ?? null,
            treatmentItemId: input.treatmentItemId ?? null,
            createdBy: auth.userId,
          })
          .returning({ id: appointments.id, version: appointments.version });
        await tx.insert(appointmentStatusHistory).values({ organizationId: tenant.organizationId, appointmentId: row!.id, fromStatus: null, toStatus: 'scheduled', changedBy: auth.userId });
        await this.audit.record(tx, {
          organizationId: tenant.organizationId,
          actorUserId: auth.userId,
          action: 'appointment.created',
          entityType: 'appointment',
          entityId: row!.id,
          unitId: unit.id,
          metadata: { startsAt: start.toISOString(), endsAt: end.toISOString(), professionalId: input.professionalId, chairId: input.chairId ?? null, patientId: input.patientId, seriesId, waitlistEntryId: input.waitlistEntryId ?? null },
          meta,
        });
        await this.events.emit(tx, 'appointment.created', { organizationId: tenant.organizationId, appointmentId: row!.id, actorUserId: auth.userId });
        created.push({ id: row!.id, version: row!.version, startsAt: start.toISOString() });
      }
      if (input.waitlistEntryId) {
        await tx.update(waitlistEntries).set({ status: 'scheduled', scheduledAppointmentId: created[0]!.id, updatedAt: this.clock.now() }).where(eq(waitlistEntries.id, input.waitlistEntryId));
      }
      return { id: created[0]!.id, version: created[0]!.version, seriesId, created, skipped: failed };
    });
  }

  async reschedule(auth: AuthContext, tenant: TenantContext, id: string, input: RescheduleAppointmentInput, meta: RequestMeta) {
    const start = new Date(input.startsAt);
    const end = new Date(start.getTime() + input.durationMinutes * MINUTE);
    return this.db.transaction(async (tx) => {
      const current = await this.lockAppointment(tx, tenant, id, input.version);
      if (current.status !== 'scheduled' && current.status !== 'confirmed') {
        throw new AppError('invalid_transition', `Uma consulta "${APPOINTMENT_STATUS_LABEL[current.status as AppointmentStatus]}" não pode ser reagendada.`);
      }
      if (start.getTime() < this.clock.now().getTime() - 15 * MINUTE) {
        throw new AppError('validation_failed', 'Não é possível reagendar para um horário que já passou.');
      }
      const unit = await this.loadUnit(tx, tenant, current.unitId);
      await this.lockUnit(tx, unit.id);
      await this.validateSlot(tx, unit.timezone, {
        organizationId: tenant.organizationId,
        unitId: current.unitId,
        patientId: current.patientId,
        professionalId: input.professionalId,
        chairId: input.chairId,
        start,
        end,
        exceptAppointmentId: id,
      });

      const wasConfirmed = current.status === 'confirmed';
      await tx
        .update(appointments)
        .set({ startsAt: start, endsAt: end, professionalId: input.professionalId, chairId: input.chairId, status: 'scheduled', version: current.version + 1, updatedAt: this.clock.now() })
        .where(eq(appointments.id, id));
      if (wasConfirmed) {
        await tx.insert(appointmentStatusHistory).values({
          organizationId: tenant.organizationId,
          appointmentId: id,
          fromStatus: 'confirmed',
          toStatus: 'scheduled',
          note: 'Reagendamento: a confirmação anterior deixou de valer.',
          changedBy: auth.userId,
        });
      }
      await this.audit.record(tx, {
        organizationId: tenant.organizationId,
        actorUserId: auth.userId,
        action: 'appointment.rescheduled',
        entityType: 'appointment',
        entityId: id,
        unitId: current.unitId,
        metadata: {
          before: { startsAt: current.startsAt.toISOString(), endsAt: current.endsAt.toISOString(), professionalId: current.professionalId, chairId: current.chairId },
          after: { startsAt: start.toISOString(), endsAt: end.toISOString(), professionalId: input.professionalId, chairId: input.chairId },
          confirmationReset: wasConfirmed,
        },
        meta,
      });
      await this.events.emit(tx, 'appointment.rescheduled', { organizationId: tenant.organizationId, appointmentId: id, actorUserId: auth.userId });
      return { id, version: current.version + 1, status: 'scheduled' as const };
    });
  }

  async transition(auth: AuthContext, tenant: TenantContext, id: string, input: TransitionAppointmentInput, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const current = await this.lockAppointment(tx, tenant, id, input.version);
      const from = current.status as AppointmentStatus;
      const rule = findTransition(from, input.to);
      if (!rule) {
        throw new AppError('invalid_transition', `Não é possível passar de "${APPOINTMENT_STATUS_LABEL[from]}" para "${APPOINTMENT_STATUS_LABEL[input.to]}".`);
      }
      if (!tenant.permissions.has(rule.permission)) throw forbidden();
      if (rule.permission === 'schedule.attend' && !tenant.permissions.has('schedule.attend_any')) {
        const [prof] = await tx.select({ membershipId: professionals.membershipId }).from(professionals).where(eq(professionals.id, current.professionalId));
        if (prof?.membershipId !== tenant.membershipId) {
          throw forbidden('Somente o profissional responsável pela consulta pode iniciá-la ou concluí-la.');
        }
      }
      if (rule.requiresReason && !input.reason) {
        throw new AppError('validation_failed', 'Informe o motivo do cancelamento.', [{ path: 'reason', message: 'Obrigatório.' }]);
      }
      return this.applyTransition(tx, tenant.organizationId, current, input.to, { userId: auth.userId, source: 'staff' }, { reason: input.reason, note: input.note }, meta);
    });
  }

  /**
   * Aplica uma transição já autorizada (equipe, paciente por link/portal ou
   * automação). Regras de horário valem para todas as origens.
   */
  async applyTransition(
    tx: Tx,
    organizationId: string,
    current: typeof appointments.$inferSelect,
    to: AppointmentStatus,
    actor: TransitionActor,
    extra: { reason?: string; note?: string },
    meta?: RequestMeta,
  ) {
    const from = current.status as AppointmentStatus;
    if (!findTransition(from, to)) {
      throw new AppError('invalid_transition', `Não é possível passar de "${APPOINTMENT_STATUS_LABEL[from]}" para "${APPOINTMENT_STATUS_LABEL[to]}".`);
    }
    const [unit] = await tx.select({ timezone: clinicUnits.timezone }).from(clinicUnits).where(eq(clinicUnits.id, current.unitId));
    this.assertTimeRules(to, current.startsAt, current.endsAt, unit!.timezone);
    await tx
      .update(appointments)
      .set({ status: to, cancellationReason: to === 'cancelled' ? (extra.reason ?? 'other') : null, version: current.version + 1, updatedAt: this.clock.now() })
      .where(eq(appointments.id, current.id));
    await tx.insert(appointmentStatusHistory).values({
      organizationId,
      appointmentId: current.id,
      fromStatus: from,
      toStatus: to,
      reason: to === 'cancelled' ? (extra.reason ?? 'other') : null,
      note: extra.note ?? null,
      changedBy: actor.userId,
      source: actor.source,
    });
    await this.audit.record(tx, {
      organizationId,
      actorUserId: actor.userId,
      action: 'appointment.status_changed',
      entityType: 'appointment',
      entityId: current.id,
      unitId: current.unitId,
      metadata: { from, to, reason: extra.reason ?? null, source: actor.source },
      meta,
    });
    await this.events.emit(tx, 'appointment.status_changed', { organizationId, appointmentId: current.id, from, to, actorUserId: actor.userId });
    return { id: current.id, status: to, version: current.version + 1 };
  }

  // -------------------------------------------------------------- Bloqueios

  async createBlock(auth: AuthContext, tenant: TenantContext, input: ScheduleBlockInput, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const unit = await this.loadUnit(tx, tenant, input.unitId);
      await this.lockUnit(tx, unit.id);
      if (input.professionalId) {
        const [p] = await tx.select({ id: professionals.id }).from(professionals).where(and(eq(professionals.id, input.professionalId), eq(professionals.organizationId, tenant.organizationId)));
        if (!p) throw notFound('Profissional');
      }
      if (input.chairId) {
        const [c] = await tx.select({ unitId: chairs.unitId }).from(chairs).where(and(eq(chairs.id, input.chairId), eq(chairs.organizationId, tenant.organizationId)));
        if (!c || c.unitId !== unit.id) throw notFound('Cadeira');
      }
      const length = new Date(input.endsAt).getTime() - new Date(input.startsAt).getTime();
      const starts = occurrences(new Date(input.startsAt), unit.timezone, input.repeat);

      // Consultas ativas atingidas pelo bloqueio.
      const affected: { id: string; startsAt: Date; patientName: string }[] = [];
      for (const s of starts) {
        const e = new Date(s.getTime() + length);
        const scope: SQL[] = [];
        if (input.professionalId) scope.push(eq(appointments.professionalId, input.professionalId));
        if (input.chairId) scope.push(eq(appointments.chairId, input.chairId));
        const rows = await tx
          .select({ id: appointments.id, startsAt: appointments.startsAt, patientName: patients.fullName })
          .from(appointments)
          .innerJoin(patients, eq(patients.id, appointments.patientId))
          .where(
            and(
              eq(appointments.organizationId, tenant.organizationId),
              eq(appointments.unitId, unit.id),
              inArray(appointments.status, ['scheduled', 'confirmed']),
              lt(appointments.startsAt, e),
              gt(appointments.endsAt, s),
              scope.length ? or(...scope) : undefined,
            ),
          );
        affected.push(...rows);
      }
      if (affected.length && !input.acknowledgeConflicts) {
        throw new AppError('schedule_conflict', `${affected.length} consulta(s) marcada(s) neste período.`, {
          affected: affected.map((a) => ({ appointmentId: a.id, startsAt: a.startsAt.toISOString(), patientName: a.patientName })),
        });
      }

      const seriesId = input.repeat ? randomUUID() : null;
      const ids: string[] = [];
      for (const s of starts) {
        const [b] = await tx
          .insert(scheduleBlocks)
          .values({
            organizationId: tenant.organizationId,
            unitId: unit.id,
            professionalId: input.professionalId ?? null,
            chairId: input.chairId ?? null,
            kind: input.kind,
            reason: input.reason ?? null,
            startsAt: s,
            endsAt: new Date(s.getTime() + length),
            seriesId,
            createdBy: auth.userId,
          })
          .returning({ id: scheduleBlocks.id });
        ids.push(b!.id);
      }
      if (affected.length) {
        await tx.insert(tasks).values({
          organizationId: tenant.organizationId,
          unitId: unit.id,
          title: `Reagendar ${affected.length} consulta(s) afetada(s) por bloqueio`,
          description: affected.map((a) => `${a.patientName} — ${a.startsAt.toISOString()}`).join('\n'),
          assigneeRoleKey: 'reception',
          origin: 'system',
          relatedType: 'schedule_block',
          relatedId: ids[0],
          createdBy: auth.userId,
        });
      }
      await this.audit.record(tx, {
        organizationId: tenant.organizationId,
        actorUserId: auth.userId,
        action: 'schedule_block.created',
        entityType: 'schedule_block',
        entityId: ids[0],
        unitId: unit.id,
        metadata: { kind: input.kind, occurrences: ids.length, professionalId: input.professionalId ?? null, chairId: input.chairId ?? null, affectedAppointments: affected.length },
        meta,
      });
      return { ids, seriesId, affectedAppointments: affected.length };
    });
  }

  async deleteBlock(auth: AuthContext, tenant: TenantContext, id: string, wholeSeries: boolean, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const [b] = await tx.select().from(scheduleBlocks).where(and(eq(scheduleBlocks.id, id), eq(scheduleBlocks.organizationId, tenant.organizationId)));
      if (!b || !canAccessUnit(tenant, b.unitId)) throw notFound('Bloqueio');
      const where = wholeSeries && b.seriesId ? and(eq(scheduleBlocks.seriesId, b.seriesId), gt(scheduleBlocks.endsAt, this.clock.now())) : eq(scheduleBlocks.id, id);
      const removed = await tx.delete(scheduleBlocks).where(and(eq(scheduleBlocks.organizationId, tenant.organizationId), where)).returning({ id: scheduleBlocks.id });
      await this.audit.record(tx, {
        organizationId: tenant.organizationId,
        actorUserId: auth.userId,
        action: 'schedule_block.removed',
        entityType: 'schedule_block',
        entityId: id,
        unitId: b.unitId,
        metadata: { removed: removed.length, kind: b.kind, startsAt: b.startsAt.toISOString() },
        meta,
      });
      return { removed: removed.length };
    });
  }

  // --------------------------------------------------------------- Regras

  private assertTimeRules(to: AppointmentStatus, startsAt: Date, endsAt: Date, tz: string) {
    const now = this.clock.now();
    const sameDay = zonedParts(now, tz).date === zonedParts(startsAt, tz).date;
    if ((to === 'arrived' || to === 'in_progress') && !sameDay) {
      throw new AppError('invalid_transition', to === 'arrived' ? 'O check-in só pode ser feito no dia da consulta.' : 'O atendimento só pode ser iniciado no dia da consulta.');
    }
    if (to === 'no_show' && now < startsAt) {
      throw new AppError('invalid_transition', 'A falta só pode ser registrada depois do horário de início.');
    }
    if (to === 'confirmed' && now >= endsAt) {
      throw new AppError('invalid_transition', 'Esta consulta já terminou; não há presença a confirmar.');
    }
  }

  /**
   * Serializa gravações da agenda por unidade (advisory lock da transação):
   * a verificação de bloqueios não pode correr em paralelo com novas consultas.
   * Sobreposição de consultas continua garantida também pela exclusion constraint.
   */
  private async lockUnit(tx: Tx, unitId: string) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`agenda:${unitId}`}, 0))`);
  }

  private async validateSlot(tx: Tx, timezone: string, s: SlotRequest) {
    const [prof] = await tx
      .select({ id: professionals.id, active: professionals.active, linked: professionalUnits.unitId })
      .from(professionals)
      .leftJoin(professionalUnits, and(eq(professionalUnits.professionalId, professionals.id), eq(professionalUnits.unitId, s.unitId)))
      .where(and(eq(professionals.id, s.professionalId), eq(professionals.organizationId, s.organizationId)));
    if (!prof) throw notFound('Profissional');
    if (!prof.active) throw new AppError('validation_failed', 'Este profissional está inativo.');
    if (!prof.linked) throw new AppError('validation_failed', 'Este profissional não atende nesta unidade.');

    if (s.chairId) {
      const [chair] = await tx.select({ unitId: chairs.unitId, active: chairs.active }).from(chairs).where(and(eq(chairs.id, s.chairId), eq(chairs.organizationId, s.organizationId)));
      if (!chair) throw notFound('Cadeira');
      if (chair.unitId !== s.unitId) throw new AppError('validation_failed', 'Esta cadeira pertence a outra unidade.');
      if (!chair.active) throw new AppError('validation_failed', 'Esta cadeira está inativa.');
    }

    const hours = await tx.select({ weekday: businessHours.weekday, opensAt: businessHours.opensAt, closesAt: businessHours.closesAt }).from(businessHours).where(eq(businessHours.unitId, s.unitId));
    if (!fitsBusinessHours(s.start, s.end, timezone, hours)) {
      throw new AppError('outside_business_hours', 'O horário escolhido está fora do funcionamento da unidade.');
    }

    // Bloqueios: da unidade inteira, do profissional ou da cadeira.
    const blockScope: SQL[] = [and(isNull(scheduleBlocks.professionalId), isNull(scheduleBlocks.chairId))!, eq(scheduleBlocks.professionalId, s.professionalId)];
    if (s.chairId) blockScope.push(eq(scheduleBlocks.chairId, s.chairId));
    const [block] = await tx
      .select({ id: scheduleBlocks.id, kind: scheduleBlocks.kind, reason: scheduleBlocks.reason, startsAt: scheduleBlocks.startsAt, endsAt: scheduleBlocks.endsAt })
      .from(scheduleBlocks)
      .where(and(eq(scheduleBlocks.organizationId, s.organizationId), eq(scheduleBlocks.unitId, s.unitId), lt(scheduleBlocks.startsAt, s.end), gt(scheduleBlocks.endsAt, s.start), or(...blockScope)))
      .limit(1);
    if (block) {
      const label = { block: 'bloqueio', vacation: 'férias', break: 'intervalo', maintenance: 'manutenção' }[block.kind] ?? 'bloqueio';
      throw new AppError('schedule_conflict', `O horário está bloqueado (${label}${block.reason ? `: ${block.reason}` : ''}).`, {
        conflicts: [{ kind: 'block', appointmentId: block.id, startsAt: block.startsAt.toISOString(), endsAt: block.endsAt.toISOString(), reason: block.reason } satisfies ScheduleConflictDetail],
      });
    }

    const who: SQL[] = [eq(appointments.professionalId, s.professionalId), eq(appointments.patientId, s.patientId)];
    if (s.chairId) who.push(eq(appointments.chairId, s.chairId));
    const clashes = await tx
      .select({ id: appointments.id, startsAt: appointments.startsAt, endsAt: appointments.endsAt, professionalId: appointments.professionalId, chairId: appointments.chairId, patientId: appointments.patientId })
      .from(appointments)
      .where(
        and(
          eq(appointments.organizationId, s.organizationId),
          inArray(appointments.status, [...BLOCKING_STATUSES]),
          lt(appointments.startsAt, s.end),
          gt(appointments.endsAt, s.start),
          or(...who),
          s.exceptAppointmentId ? ne(appointments.id, s.exceptAppointmentId) : undefined,
        ),
      );
    if (clashes.length) {
      const details: ScheduleConflictDetail[] = [];
      for (const c of clashes) {
        const base = { appointmentId: c.id, startsAt: c.startsAt.toISOString(), endsAt: c.endsAt.toISOString() };
        if (c.professionalId === s.professionalId) details.push({ kind: 'professional', ...base });
        if (s.chairId && c.chairId === s.chairId) details.push({ kind: 'chair', ...base });
        if (c.patientId === s.patientId) details.push({ kind: 'patient', ...base });
      }
      const first = details[0]!.kind;
      const msg =
        first === 'professional'
          ? 'O profissional já tem uma consulta neste horário.'
          : first === 'chair'
            ? 'A cadeira já está ocupada neste horário.'
            : 'O paciente já tem outra consulta neste horário.';
      throw new AppError('schedule_conflict', msg, { conflicts: details });
    }
  }

  async loadUnit(db: Db | Tx, tenant: TenantContext, unitId: string) {
    const [unit] = await db
      .select({ id: clinicUnits.id, name: clinicUnits.name, timezone: clinicUnits.timezone, active: clinicUnits.active })
      .from(clinicUnits)
      .where(and(eq(clinicUnits.id, unitId), eq(clinicUnits.organizationId, tenant.organizationId)));
    if (!unit || !canAccessUnit(tenant, unit.id)) throw notFound('Unidade');
    return unit;
  }

  /** Bloqueia a linha e confere a versão lida pelo cliente (controle otimista). */
  async lockAppointment(tx: Tx, tenant: TenantContext, id: string, expectedVersion: number) {
    const [current] = await tx
      .select()
      .from(appointments)
      .where(and(eq(appointments.id, id), eq(appointments.organizationId, tenant.organizationId)))
      .for('update');
    if (!current || !canAccessUnit(tenant, current.unitId)) throw notFound('Consulta');
    if (current.version !== expectedVersion) {
      throw new AppError('stale_version', 'Esta consulta foi alterada por outra pessoa. Atualize a agenda e tente novamente.', {
        currentVersion: current.version,
        currentStatus: current.status,
      });
    }
    return current;
  }
}
