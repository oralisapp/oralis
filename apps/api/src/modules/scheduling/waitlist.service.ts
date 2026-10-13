import { Inject, Injectable } from '@nestjs/common';
import { BLOCKING_STATUSES, WEEKDAY_LABEL, type WaitlistInput, zonedParts } from '@oralis/shared';
import { and, asc, desc, eq, gt, inArray, isNull, lt, or } from 'drizzle-orm';
import { notFound } from '../../common/app-error';
import { Clock } from '../../common/clock';
import { type AuthContext, type RequestMeta, type TenantContext } from '../../common/request-context';
import { DB, type Db } from '../../db/db';
import { appointments, patients, professionals, services, waitlistEntries } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { SchedulingService } from './scheduling.service';

const PERIOD_LABEL = { morning: 'manhã', afternoon: 'tarde', evening: 'noite', any: 'qualquer período' } as const;

function periodOf(minutes: number): 'morning' | 'afternoon' | 'evening' {
  return minutes < 12 * 60 ? 'morning' : minutes < 18 * 60 ? 'afternoon' : 'evening';
}

/**
 * Lista de espera. A sugestão de candidatos para uma vaga é explicável
 * (cada critério aparece no resultado) e NUNCA reserva a vaga: a reserva
 * acontece só quando a recepção agenda, e a agenda impede vaga dupla.
 */
@Injectable()
export class WaitlistService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly scheduling: SchedulingService,
  ) {}

  async list(tenant: TenantContext, status: 'active' | 'scheduled' | 'removed' = 'active') {
    return this.db
      .select({
        id: waitlistEntries.id,
        patientId: waitlistEntries.patientId,
        patientName: patients.fullName,
        patientPhone: patients.phone,
        unitId: waitlistEntries.unitId,
        professionalId: waitlistEntries.professionalId,
        professionalName: professionals.displayName,
        serviceId: waitlistEntries.serviceId,
        serviceName: services.name,
        durationMinutes: waitlistEntries.durationMinutes,
        weekdays: waitlistEntries.weekdays,
        period: waitlistEntries.period,
        earliestDate: waitlistEntries.earliestDate,
        latestDate: waitlistEntries.latestDate,
        priority: waitlistEntries.priority,
        notes: waitlistEntries.notes,
        status: waitlistEntries.status,
        createdAt: waitlistEntries.createdAt,
      })
      .from(waitlistEntries)
      .innerJoin(patients, eq(patients.id, waitlistEntries.patientId))
      .leftJoin(professionals, eq(professionals.id, waitlistEntries.professionalId))
      .leftJoin(services, eq(services.id, waitlistEntries.serviceId))
      .where(and(eq(waitlistEntries.organizationId, tenant.organizationId), eq(waitlistEntries.status, status)))
      .orderBy(desc(waitlistEntries.priority), asc(waitlistEntries.createdAt));
  }

  async add(auth: AuthContext, tenant: TenantContext, input: WaitlistInput, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const [p] = await tx.select({ id: patients.id }).from(patients).where(and(eq(patients.id, input.patientId), eq(patients.organizationId, tenant.organizationId)));
      if (!p) throw notFound('Paciente');
      const [row] = await tx
        .insert(waitlistEntries)
        .values({
          organizationId: tenant.organizationId,
          patientId: input.patientId,
          unitId: input.unitId ?? null,
          professionalId: input.professionalId ?? null,
          serviceId: input.serviceId ?? null,
          durationMinutes: input.durationMinutes,
          weekdays: input.weekdays,
          period: input.period,
          earliestDate: input.earliestDate ?? null,
          latestDate: input.latestDate ?? null,
          priority: input.priority,
          notes: input.notes ?? null,
          createdBy: auth.userId,
        })
        .returning({ id: waitlistEntries.id });
      await this.audit.record(tx, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'waitlist.added', entityType: 'waitlist_entry', entityId: row!.id, metadata: { patientId: input.patientId }, meta });
      return { id: row!.id };
    });
  }

  async remove(auth: AuthContext, tenant: TenantContext, id: string, meta: RequestMeta) {
    const r = await this.db
      .update(waitlistEntries)
      .set({ status: 'removed', updatedAt: this.clock.now() })
      .where(and(eq(waitlistEntries.id, id), eq(waitlistEntries.organizationId, tenant.organizationId), eq(waitlistEntries.status, 'active')))
      .returning({ id: waitlistEntries.id });
    if (!r.length) throw notFound('Item da lista de espera');
    await this.audit.record(this.db, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'waitlist.removed', entityType: 'waitlist_entry', entityId: id, meta });
    return { ok: true };
  }

  /** Candidatos elegíveis para uma vaga específica, com os critérios que os incluíram. */
  async suggestions(tenant: TenantContext, unitId: string, professionalId: string, startsAt: Date, endsAt: Date) {
    const unit = await this.scheduling.loadUnit(this.db, tenant, unitId);
    const tz = unit.timezone;
    const parts = zonedParts(startsAt, tz);
    const slotMinutes = Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000);
    const period = periodOf(parts.minutes);

    const entries = await this.db
      .select()
      .from(waitlistEntries)
      .where(
        and(
          eq(waitlistEntries.organizationId, tenant.organizationId),
          eq(waitlistEntries.status, 'active'),
          or(isNull(waitlistEntries.unitId), eq(waitlistEntries.unitId, unitId)),
          or(isNull(waitlistEntries.professionalId), eq(waitlistEntries.professionalId, professionalId)),
        ),
      )
      .orderBy(desc(waitlistEntries.priority), asc(waitlistEntries.createdAt));
    if (!entries.length) return [];

    const patientIds = [...new Set(entries.map((e) => e.patientId))];
    const [pats, busy] = await Promise.all([
      this.db.select({ id: patients.id, fullName: patients.fullName, phone: patients.phone }).from(patients).where(inArray(patients.id, patientIds)),
      this.db
        .select({ patientId: appointments.patientId })
        .from(appointments)
        .where(and(inArray(appointments.patientId, patientIds), inArray(appointments.status, [...BLOCKING_STATUSES]), lt(appointments.startsAt, endsAt), gt(appointments.endsAt, startsAt))),
    ]);
    const busySet = new Set(busy.map((b) => b.patientId));
    const nameOf = new Map(pats.map((p) => [p.id, p]));

    const out = [];
    for (const e of entries) {
      if (e.durationMinutes > slotMinutes) continue;
      if (e.weekdays.length && !e.weekdays.includes(parts.weekday)) continue;
      if (e.period !== 'any' && e.period !== period) continue;
      if (e.earliestDate && parts.date < e.earliestDate) continue;
      if (e.latestDate && parts.date > e.latestDate) continue;
      if (busySet.has(e.patientId)) continue;
      const reasons = [
        `Precisa de ${e.durationMinutes} min; a vaga tem ${slotMinutes} min`,
        e.weekdays.length ? `Disponível em: ${e.weekdays.map((d) => WEEKDAY_LABEL[d]).join(', ')}` : 'Aceita qualquer dia',
        `Prefere ${PERIOD_LABEL[e.period as keyof typeof PERIOD_LABEL]}`,
        e.professionalId ? 'Pediu este profissional' : 'Aceita qualquer profissional',
        `Na lista desde ${e.createdAt.toISOString().slice(0, 10).split('-').reverse().join('/')}`,
      ];
      if (e.priority > 0) reasons.unshift(e.priority === 2 ? 'Prioridade alta' : 'Prioridade média');
      out.push({
        entryId: e.id,
        patientId: e.patientId,
        patientName: nameOf.get(e.patientId)?.fullName ?? '',
        patientPhone: nameOf.get(e.patientId)?.phone ?? null,
        durationMinutes: e.durationMinutes,
        serviceId: e.serviceId,
        reasons,
      });
    }
    return out;
  }
}
