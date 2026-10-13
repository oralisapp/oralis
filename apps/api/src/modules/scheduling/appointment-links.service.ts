import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, notFound } from '../../common/app-error';
import { Clock } from '../../common/clock';
import { type AuthContext, type RequestMeta, type TenantContext } from '../../common/request-context';
import { env } from '../../config/env';
import { DB, type Db } from '../../db/db';
import { appointmentLinks, appointments, clinicUnits, organizations, patients, professionals, tasks } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { newToken, sha256 } from '../identity/session.service';
import { CommunicationService } from '../patients/communication.service';
import { MailService, mailLayout } from '../platform/mail.service';
import { SchedulingService } from './scheduling.service';

export const rescheduleRequestSchema = z.object({ message: z.string().trim().max(300).optional() });

/**
 * Link seguro de confirmação: escopo de UMA consulta, validade até o início
 * dela, uso único, e invalidado se a consulta for alterada. A página pública
 * mostra o mínimo (data, horário, unidade, profissional) — nada clínico.
 */
@Injectable()
export class AppointmentLinksService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly scheduling: SchedulingService,
    private readonly mail: MailService,
    private readonly comms: CommunicationService,
  ) {}

  async create(auth: AuthContext, tenant: TenantContext, appointmentId: string, sendEmail: boolean, meta: RequestMeta) {
    const [a] = await this.db
      .select({ appt: appointments, patientEmail: patients.email, patientName: patients.fullName, socialName: patients.socialName })
      .from(appointments)
      .innerJoin(patients, eq(patients.id, appointments.patientId))
      .where(and(eq(appointments.id, appointmentId), eq(appointments.organizationId, tenant.organizationId)));
    if (!a) throw notFound('Consulta');
    await this.scheduling.loadUnit(this.db, tenant, a.appt.unitId);
    if (!['scheduled', 'confirmed'].includes(a.appt.status)) throw new AppError('invalid_transition', 'Só é possível enviar link para consultas agendadas.');
    if (a.appt.startsAt <= this.clock.now()) throw new AppError('invalid_transition', 'A consulta já começou.');

    const token = newToken();
    await this.db.insert(appointmentLinks).values({
      organizationId: tenant.organizationId,
      appointmentId,
      tokenHash: sha256(token),
      appointmentVersion: a.appt.version,
      expiresAt: a.appt.startsAt,
      createdBy: auth.userId,
    });
    const url = `${env().WEB_ORIGIN}/c/${token}`;
    let emailDelivery: string = 'not_requested';
    if (sendEmail) {
      const allowed = a.patientEmail && (await this.comms.canContact(tenant.organizationId, a.appt.patientId, 'email', 'transactional'));
      if (!allowed) emailDelivery = a.patientEmail ? 'not_allowed' : 'no_email';
      else {
        const [org] = await this.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, tenant.organizationId));
        // Mensagem sem procedimento nem informação clínica.
        const body = mailLayout(
          `Confirme sua consulta — ${org!.name}`,
          [`Olá, ${(a.socialName || a.patientName).split(' ')[0]}.`, 'Você tem uma consulta marcada. Use o botão abaixo para confirmar presença ou pedir outro horário.'],
          { label: 'Ver e confirmar', url },
        );
        emailDelivery = (await this.mail.send({ to: a.patientEmail!, subject: `Confirme sua consulta — ${org!.name}`, organizationId: tenant.organizationId, ...body })).delivery;
      }
    }
    await this.audit.record(this.db, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'appointment.link_created', entityType: 'appointment', entityId: appointmentId, metadata: { emailDelivery }, meta });
    return { url, expiresAt: a.appt.startsAt, emailDelivery };
  }

  private async resolve(token: string) {
    if (!token || token.length > 100) return null;
    const [row] = await this.db
      .select({
        link: appointmentLinks,
        appt: appointments,
        orgName: organizations.name,
        unitName: clinicUnits.name,
        unitAddress: clinicUnits.addressLine,
        unitCity: clinicUnits.city,
        unitPhone: clinicUnits.phone,
        timezone: clinicUnits.timezone,
        professionalName: professionals.displayName,
        patientName: patients.fullName,
        patientSocialName: patients.socialName,
      })
      .from(appointmentLinks)
      .innerJoin(appointments, eq(appointments.id, appointmentLinks.appointmentId))
      .innerJoin(organizations, eq(organizations.id, appointmentLinks.organizationId))
      .innerJoin(clinicUnits, eq(clinicUnits.id, appointments.unitId))
      .innerJoin(professionals, eq(professionals.id, appointments.professionalId))
      .innerJoin(patients, eq(patients.id, appointments.patientId))
      .where(eq(appointmentLinks.tokenHash, sha256(token)));
    return row ?? null;
  }

  private stateOf(r: NonNullable<Awaited<ReturnType<AppointmentLinksService['resolve']>>>) {
    if (r.link.usedAt) return r.link.usedAction === 'confirmed' ? 'confirmed' : 'reschedule_requested';
    if (r.appt.status === 'cancelled') return 'cancelled';
    if (r.link.expiresAt <= this.clock.now()) return 'expired';
    if (r.appt.version !== r.link.appointmentVersion && r.appt.status !== 'confirmed') return 'changed';
    if (r.appt.status === 'confirmed') return 'confirmed';
    return 'pending';
  }

  async view(token: string) {
    const r = await this.resolve(token);
    if (!r) throw notFound('Link');
    return {
      state: this.stateOf(r),
      clinicName: r.orgName,
      unitName: r.unitName,
      unitAddress: [r.unitAddress, r.unitCity].filter(Boolean).join(' — ') || null,
      unitPhone: r.unitPhone,
      timezone: r.timezone,
      startsAt: r.appt.startsAt,
      professionalName: r.professionalName,
      patientFirstName: (r.patientSocialName || r.patientName).split(' ')[0],
    };
  }

  async confirm(token: string, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const r = await this.resolve(token);
      if (!r) throw notFound('Link');
      const state = this.stateOf(r);
      if (state === 'confirmed') return { state };
      if (state !== 'pending') throw new AppError('invalid_transition', 'Este link não pode mais ser usado. Entre em contato com a clínica.');
      const [current] = await tx.select().from(appointments).where(eq(appointments.id, r.appt.id)).for('update');
      await this.scheduling.applyTransition(tx, r.link.organizationId, current!, 'confirmed', { userId: null, source: 'patient_link' }, { note: 'Confirmado pelo paciente via link' }, meta);
      await tx.update(appointmentLinks).set({ usedAt: this.clock.now(), usedAction: 'confirmed' }).where(eq(appointmentLinks.id, r.link.id));
      return { state: 'confirmed' };
    });
  }

  async requestReschedule(token: string, message: string | undefined, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const r = await this.resolve(token);
      if (!r) throw notFound('Link');
      const state = this.stateOf(r);
      if (state !== 'pending' && state !== 'confirmed') throw new AppError('invalid_transition', 'Este link não pode mais ser usado. Entre em contato com a clínica.');
      await tx.update(appointmentLinks).set({ usedAt: this.clock.now(), usedAction: 'reschedule_requested' }).where(eq(appointmentLinks.id, r.link.id));
      // Nunca reagenda sozinho: vira tarefa para a recepção.
      await tx
        .insert(tasks)
        .values({
          organizationId: r.link.organizationId,
          unitId: r.appt.unitId,
          title: `Paciente pediu reagendamento: ${r.patientName}`,
          description: message ? `Mensagem do paciente: ${message}` : 'Sem mensagem.',
          assigneeRoleKey: 'reception',
          origin: 'patient_link',
          relatedType: 'appointment',
          relatedId: r.appt.id,
          dedupeKey: `reschedule-request:${r.appt.id}:${r.appt.version}`,
          dueAt: this.clock.now(),
        })
        .onConflictDoNothing();
      await this.audit.record(tx, { organizationId: r.link.organizationId, actorUserId: null, action: 'appointment.reschedule_requested', entityType: 'appointment', entityId: r.appt.id, metadata: { source: 'patient_link' }, meta });
      return { state: 'reschedule_requested' };
    });
  }
}
