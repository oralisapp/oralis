import { Inject, Injectable } from '@nestjs/common';
import { BLOCKING_STATUSES, fromCents, toCents } from '@oralis/shared';
import { and, asc, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { Response } from 'express';
import { z } from 'zod';
import { AppError, notFound } from '../../common/app-error';
import { Clock } from '../../common/clock';
import type { AuthContext, RequestMeta, TenantContext } from '../../common/request-context';
import { env } from '../../config/env';
import { DB, type Db } from '../../db/db';
import {
  anamnesisTemplates,
  appointments,
  clinicUnits,
  documentVersions,
  documents,
  organizations,
  patientPortalTokens,
  patientSessions,
  patients,
  payments,
  professionals,
  quoteDecisions,
  quoteVersions,
  quotes,
  services,
  tasks,
  treatmentItems,
  treatmentPlans,
} from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { ClinicalService } from '../clinical/clinical.service';
import { StorageService } from '../documents/storage.service';
import { FinanceService } from '../finance/finance.service';
import { newToken, sha256 } from '../identity/session.service';
import { CommunicationService } from '../patients/communication.service';
import { MailService, mailLayout } from '../platform/mail.service';
import { SchedulingService } from '../scheduling/scheduling.service';
import { TreatmentsService } from '../treatments/treatments.service';

export const PATIENT_COOKIE = 'oralis_patient';
const LINK_TTL_MS = 7 * 86_400_000;
const SESSION_TTL_MS = 12 * 60 * 60_000;

export interface PatientCtx {
  organizationId: string;
  patientId: string;
  sessionId: string;
}

export const profileUpdateSchema = z.object({
  phone: z.string().trim().max(30).optional(),
  email: z.string().trim().max(254).optional(),
  address: z.string().trim().max(300).optional(),
  message: z.string().trim().max(500).optional(),
});

/**
 * Portal do paciente. Tudo é escopado ao paciente da sessão e à sua
 * organização; só aparece o que a clínica decidiu compartilhar
 * (planos e documentos marcados). Prontuário nunca é exposto.
 */
@Injectable()
export class PortalService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly scheduling: SchedulingService,
    private readonly treatments: TreatmentsService,
    private readonly finance: FinanceService,
    private readonly clinical: ClinicalService,
    private readonly storage: StorageService,
    private readonly comms: CommunicationService,
  ) {}

  // ----------------------------------------------------------------- Acesso

  /** A clínica gera (e opcionalmente envia por e-mail) o link de acesso do paciente. */
  async createLink(auth: AuthContext, tenant: TenantContext, patientId: string, sendEmail: boolean, meta: RequestMeta) {
    const [p] = await this.db.select().from(patients).where(and(eq(patients.id, patientId), eq(patients.organizationId, tenant.organizationId)));
    if (!p) throw notFound('Paciente');
    const token = newToken();
    await this.db.insert(patientPortalTokens).values({ organizationId: tenant.organizationId, patientId, tokenHash: sha256(token), createdBy: auth.userId, source: 'clinic', expiresAt: new Date(this.clock.now().getTime() + LINK_TTL_MS) });
    const url = `${env().WEB_ORIGIN}/paciente/acesso?token=${token}`;
    let emailDelivery = 'not_requested';
    if (sendEmail) {
      if (!p.email) emailDelivery = 'no_email';
      else if (!(await this.comms.canContact(tenant.organizationId, patientId, 'email', 'transactional'))) emailDelivery = 'not_allowed';
      else emailDelivery = (await this.sendLinkEmail(tenant.organizationId, p.email, p.socialName || p.fullName, url)).delivery;
    }
    await this.audit.record(this.db, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'portal.link_created', entityType: 'patient', entityId: patientId, metadata: { emailDelivery }, meta });
    return { url, emailDelivery, expiresAt: new Date(this.clock.now().getTime() + LINK_TTL_MS) };
  }

  private async sendLinkEmail(organizationId: string, email: string, name: string, url: string) {
    const [org] = await this.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, organizationId));
    const body = mailLayout(`Acesso ao portal — ${org!.name}`, [`Olá, ${name.split(' ')[0]}.`, 'Use o botão abaixo para acessar suas consultas, planos e documentos. O link vale por 7 dias e funciona uma única vez.'], { label: 'Acessar o portal', url });
    return this.mail.send({ to: email, subject: `Seu acesso ao portal — ${org!.name}`, organizationId, ...body });
  }

  /** O próprio paciente pede um link pelo e-mail cadastrado. Resposta sempre igual (não revela cadastro). */
  async requestLink(email: string, meta: RequestMeta) {
    const rows = await this.db.select().from(patients).where(and(eq(patients.email, email.trim().toLowerCase()), eq(patients.status, 'active'))).limit(3);
    for (const p of rows) {
      if (!(await this.comms.canContact(p.organizationId, p.id, 'email', 'transactional'))) continue;
      const token = newToken();
      await this.db.insert(patientPortalTokens).values({ organizationId: p.organizationId, patientId: p.id, tokenHash: sha256(token), source: 'patient_request', expiresAt: new Date(this.clock.now().getTime() + LINK_TTL_MS) });
      await this.sendLinkEmail(p.organizationId, p.email!, p.socialName || p.fullName, `${env().WEB_ORIGIN}/paciente/acesso?token=${token}`);
      await this.audit.record(this.db, { organizationId: p.organizationId, actorUserId: null, action: 'portal.link_requested', entityType: 'patient', entityId: p.id, meta });
    }
  }

  /** Troca o link de uso único por uma sessão curta do portal. */
  async exchange(token: string, meta: RequestMeta, res: Response) {
    const session = await this.db.transaction(async (tx) => {
      const [t] = await tx.select().from(patientPortalTokens).where(and(eq(patientPortalTokens.tokenHash, sha256(token)), isNull(patientPortalTokens.usedAt), gt(patientPortalTokens.expiresAt, this.clock.now()))).for('update');
      if (!t) throw new AppError('unauthenticated', 'Link inválido, expirado ou já utilizado. Peça um novo à clínica ou pelo seu e-mail.');
      await tx.update(patientPortalTokens).set({ usedAt: this.clock.now() }).where(eq(patientPortalTokens.id, t.id));
      const raw = newToken();
      const expiresAt = new Date(this.clock.now().getTime() + SESSION_TTL_MS);
      await tx.insert(patientSessions).values({ organizationId: t.organizationId, patientId: t.patientId, tokenHash: sha256(raw), expiresAt, ip: meta.ip, userAgent: meta.userAgent });
      await this.audit.record(tx, { organizationId: t.organizationId, actorUserId: null, action: 'portal.login', entityType: 'patient', entityId: t.patientId, meta });
      return { raw, expiresAt };
    });
    res.cookie(PATIENT_COOKIE, session.raw, { httpOnly: true, sameSite: 'lax', secure: env().SESSION_COOKIE_SECURE, path: '/', expires: session.expiresAt });
    return { ok: true };
  }

  async resolve(token: string | undefined): Promise<PatientCtx | null> {
    if (!token || token.length > 100) return null;
    const [s] = await this.db
      .select({ id: patientSessions.id, organizationId: patientSessions.organizationId, patientId: patientSessions.patientId })
      .from(patientSessions)
      .innerJoin(organizations, eq(organizations.id, patientSessions.organizationId))
      .where(and(eq(patientSessions.tokenHash, sha256(token)), isNull(patientSessions.revokedAt), gt(patientSessions.expiresAt, this.clock.now()), eq(organizations.status, 'active')));
    return s ? { organizationId: s.organizationId, patientId: s.patientId, sessionId: s.id } : null;
  }

  async logout(ctx: PatientCtx, res: Response) {
    await this.db.update(patientSessions).set({ revokedAt: this.clock.now() }).where(eq(patientSessions.id, ctx.sessionId));
    res.clearCookie(PATIENT_COOKIE, { path: '/' });
    return { ok: true };
  }

  // ---------------------------------------------------------------- Conteúdo

  async me(ctx: PatientCtx) {
    const [p] = await this.db.select().from(patients).where(eq(patients.id, ctx.patientId));
    const [org] = await this.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, ctx.organizationId));
    const units = await this.db.select({ name: clinicUnits.name, phone: clinicUnits.phone, addressLine: clinicUnits.addressLine, city: clinicUnits.city, timezone: clinicUnits.timezone }).from(clinicUnits).where(and(eq(clinicUnits.organizationId, ctx.organizationId), eq(clinicUnits.active, true)));
    return { patient: { firstName: (p!.socialName || p!.fullName).split(' ')[0], fullName: p!.socialName || p!.fullName, email: p!.email, phone: p!.phone }, clinic: { name: org!.name, units } };
  }

  async appointments(ctx: PatientCtx) {
    const rows = await this.db
      .select({ id: appointments.id, startsAt: appointments.startsAt, endsAt: appointments.endsAt, status: appointments.status, version: appointments.version, unitName: clinicUnits.name, timezone: clinicUnits.timezone, address: clinicUnits.addressLine, professionalName: professionals.displayName, serviceName: services.name })
      .from(appointments)
      .innerJoin(clinicUnits, eq(clinicUnits.id, appointments.unitId))
      .innerJoin(professionals, eq(professionals.id, appointments.professionalId))
      .leftJoin(services, eq(services.id, appointments.serviceId))
      .where(and(eq(appointments.organizationId, ctx.organizationId), eq(appointments.patientId, ctx.patientId)))
      .orderBy(desc(appointments.startsAt))
      .limit(100);
    const now = this.clock.now();
    return { upcoming: rows.filter((a) => a.startsAt > now && BLOCKING_STATUSES.includes(a.status as never)).reverse(), past: rows.filter((a) => a.startsAt <= now || !BLOCKING_STATUSES.includes(a.status as never)) };
  }

  private async ownAppointment(ctx: PatientCtx, id: string) {
    const [a] = await this.db.select().from(appointments).where(and(eq(appointments.id, id), eq(appointments.organizationId, ctx.organizationId), eq(appointments.patientId, ctx.patientId)));
    if (!a) throw notFound('Consulta');
    return a;
  }

  async confirm(ctx: PatientCtx, id: string, meta: RequestMeta) {
    await this.ownAppointment(ctx, id);
    return this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(appointments).where(eq(appointments.id, id)).for('update');
      if (current!.status === 'confirmed') return { status: 'confirmed' };
      if (current!.status !== 'scheduled') throw new AppError('invalid_transition', 'Esta consulta não está aguardando confirmação.');
      await this.scheduling.applyTransition(tx, ctx.organizationId, current!, 'confirmed', { userId: null, source: 'patient_portal' }, { note: 'Confirmado pelo paciente no portal' }, meta);
      return { status: 'confirmed' };
    });
  }

  private async patientTask(ctx: PatientCtx, title: string, description: string, relatedType: string, relatedId: string, dedupeKey: string) {
    const [p] = await this.db.select({ fullName: patients.fullName }).from(patients).where(eq(patients.id, ctx.patientId));
    await this.db
      .insert(tasks)
      .values({ organizationId: ctx.organizationId, title: `${title}: ${p!.fullName}`, description, assigneeRoleKey: 'reception', origin: 'patient_portal', relatedType, relatedId, dedupeKey, dueAt: this.clock.now() })
      .onConflictDoNothing();
  }

  async requestReschedule(ctx: PatientCtx, id: string, message: string | undefined, meta: RequestMeta) {
    const a = await this.ownAppointment(ctx, id);
    if (!['scheduled', 'confirmed'].includes(a.status)) throw new AppError('invalid_transition', 'Esta consulta não pode ser reagendada pelo portal.');
    await this.patientTask(ctx, 'Pedido de reagendamento (portal)', message ? `Mensagem: ${message}` : 'Sem mensagem.', 'appointment', id, `portal-reschedule:${id}:${a.version}`);
    await this.audit.record(this.db, { organizationId: ctx.organizationId, actorUserId: null, action: 'appointment.reschedule_requested', entityType: 'appointment', entityId: id, metadata: { source: 'patient_portal' }, meta });
    return { ok: true };
  }

  /** Planos que a clínica disponibilizou, com a versão vigente do orçamento. */
  async plans(ctx: PatientCtx) {
    const rows = await this.db
      .select({ id: treatmentPlans.id, title: treatmentPlans.title, objective: treatmentPlans.objective, status: treatmentPlans.status, responsibleName: professionals.displayName })
      .from(treatmentPlans)
      .leftJoin(professionals, eq(professionals.id, treatmentPlans.responsibleProfessionalId))
      .where(and(eq(treatmentPlans.organizationId, ctx.organizationId), eq(treatmentPlans.patientId, ctx.patientId), eq(treatmentPlans.sharedWithPatient, true)))
      .orderBy(desc(treatmentPlans.createdAt));
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [items, qs] = await Promise.all([
      this.db.select({ planId: treatmentItems.planId, description: treatmentItems.description, tooth: treatmentItems.tooth, stage: treatmentItems.stage, status: treatmentItems.status, unitPrice: treatmentItems.unitPrice, sessionsPlanned: treatmentItems.sessionsPlanned }).from(treatmentItems).where(inArray(treatmentItems.planId, ids)).orderBy(asc(treatmentItems.stage)),
      this.db.select({ q: quotes, v: quoteVersions }).from(quotes).leftJoin(quoteVersions, eq(quoteVersions.id, quotes.currentVersionId)).where(inArray(quotes.planId, ids)),
    ]);
    const decisions = qs.length ? await this.db.select().from(quoteDecisions).where(inArray(quoteDecisions.quoteId, qs.map((x) => x.q.id))) : [];
    return rows.map((r) => {
      const q = qs.find((x) => x.q.planId === r.id);
      return {
        ...r,
        items: items.filter((i) => i.planId === r.id && i.status !== 'cancelled'),
        quote: q && q.v ? { id: q.q.id, status: q.q.status, versionId: q.v.id, version: q.v.version, subtotal: q.v.subtotal, discount: q.v.discount, total: q.v.total, paymentTerms: q.v.paymentTerms, validUntil: q.v.validUntil, decision: decisions.find((d) => d.quoteId === q.q.id && d.versionId === q.v!.id) ?? null } : null,
      };
    });
  }

  async approveQuote(ctx: PatientCtx, quoteId: string, input: { versionId: string; acknowledgedName: string }, meta: RequestMeta) {
    const [q] = await this.db.select({ planId: quotes.planId, shared: treatmentPlans.sharedWithPatient, patientId: treatmentPlans.patientId }).from(quotes).innerJoin(treatmentPlans, eq(treatmentPlans.id, quotes.planId)).where(and(eq(quotes.id, quoteId), eq(quotes.organizationId, ctx.organizationId)));
    if (!q || q.patientId !== ctx.patientId || !q.shared) throw notFound('Orçamento');
    return this.treatments.decide({ userId: null, via: 'portal' }, ctx.organizationId, quoteId, { versionId: input.versionId, decision: 'approved', acknowledgedName: input.acknowledgedName, generateReceivables: true, createSchedulingTasks: true }, meta);
  }

  async payments(ctx: PatientCtx) {
    const recs = await this.finance.openForPatient(ctx.organizationId, ctx.patientId);
    const pays = await this.db.select({ id: payments.id, amount: payments.amount, method: payments.method, receivedAt: payments.receivedAt }).from(payments).where(and(eq(payments.organizationId, ctx.organizationId), eq(payments.patientId, ctx.patientId))).orderBy(desc(payments.receivedAt));
    const balance = recs.filter((r) => r.status === 'open').reduce((s, r) => s + toCents(r.balance), 0);
    return { receivables: recs.map(({ collectionHoldReason: _r, ...r }) => r), payments: pays, balance: fromCents(balance) };
  }

  async documents(ctx: PatientCtx) {
    return this.db
      .select({ id: documents.id, title: documents.title, category: documents.category, createdAt: documents.createdAt })
      .from(documents)
      .where(and(eq(documents.organizationId, ctx.organizationId), eq(documents.patientId, ctx.patientId), eq(documents.sharedWithPatient, true), isNull(documents.archivedAt)))
      .orderBy(desc(documents.createdAt));
  }

  async documentLink(ctx: PatientCtx, id: string, meta: RequestMeta) {
    const [d] = await this.db.select().from(documents).where(and(eq(documents.id, id), eq(documents.organizationId, ctx.organizationId), eq(documents.patientId, ctx.patientId), eq(documents.sharedWithPatient, true), isNull(documents.archivedAt)));
    if (!d) throw notFound('Documento');
    const [v] = await this.db.select().from(documentVersions).where(and(eq(documentVersions.documentId, id), eq(documentVersions.version, d.currentVersion)));
    await this.audit.record(this.db, { organizationId: ctx.organizationId, actorUserId: null, action: 'document.downloaded', entityType: 'patient', entityId: ctx.patientId, metadata: { documentId: id, source: 'patient_portal' }, meta });
    return { url: this.storage.signedPath(v!.id, 300, this.clock.now().getTime()) };
  }

  async forms(ctx: PatientCtx) {
    const templates = await this.clinical.templates({ organizationId: ctx.organizationId } as TenantContext);
    return templates.map((t) => ({ id: t.id, name: t.name, version: t.version, questions: t.questions }));
  }

  async submitAnamnesis(ctx: PatientCtx, input: { templateId: string; answers: Record<string, string | boolean | null> }, meta: RequestMeta) {
    const [t] = await this.db.select({ id: anamnesisTemplates.id }).from(anamnesisTemplates).where(and(eq(anamnesisTemplates.id, input.templateId), eq(anamnesisTemplates.organizationId, ctx.organizationId)));
    if (!t) throw notFound('Formulário');
    const r = await this.clinical.recordAnamnesis(null, { organizationId: ctx.organizationId }, ctx.patientId, input, 'patient_portal', meta);
    await this.patientTask(ctx, 'Anamnese enviada pelo portal — revisar', 'O paciente respondeu a anamnese. Revise no atendimento antes de considerar no prontuário.', 'patient', ctx.patientId, `portal-anamnesis:${r.id}`);
    return r;
  }

  async communication(ctx: PatientCtx) {
    return this.comms.matrix({ organizationId: ctx.organizationId } as TenantContext, ctx.patientId);
  }

  async updateCommunication(ctx: PatientCtx, prefs: { channel: 'email' | 'sms' | 'whatsapp'; category: 'transactional' | 'relationship' | 'promotional'; allowed: boolean }[], meta: RequestMeta) {
    return this.comms.update(null, { organizationId: ctx.organizationId }, ctx.patientId, prefs, 'patient_portal', meta);
  }

  /** Atualização cadastral passa pela validação da clínica (vira tarefa; nada muda direto). */
  async requestProfileUpdate(ctx: PatientCtx, input: z.infer<typeof profileUpdateSchema>, meta: RequestMeta) {
    const lines = [input.phone && `Telefone: ${input.phone}`, input.email && `E-mail: ${input.email}`, input.address && `Endereço: ${input.address}`, input.message && `Mensagem: ${input.message}`].filter(Boolean);
    if (!lines.length) throw new AppError('validation_failed', 'Informe o que deseja atualizar.');
    await this.patientTask(ctx, 'Atualização cadastral pedida no portal', lines.join('\n'), 'patient', ctx.patientId, `portal-profile:${ctx.patientId}:${this.clock.now().getTime()}`);
    await this.audit.record(this.db, { organizationId: ctx.organizationId, actorUserId: null, action: 'portal.profile_update_requested', entityType: 'patient', entityId: ctx.patientId, metadata: { fields: Object.keys(input) }, meta });
    return { ok: true };
  }

  /** Solicitações feitas pelo paciente e seu andamento. */
  async requests(ctx: PatientCtx) {
    const appts = await this.db.select({ id: appointments.id }).from(appointments).where(and(eq(appointments.organizationId, ctx.organizationId), eq(appointments.patientId, ctx.patientId)));
    return this.db
      .select({ id: tasks.id, title: tasks.title, status: tasks.status, createdAt: tasks.createdAt, completedAt: tasks.completedAt })
      .from(tasks)
      .where(and(eq(tasks.organizationId, ctx.organizationId), eq(tasks.origin, 'patient_portal'), inArray(tasks.relatedId, [ctx.patientId, ...appts.map((a) => a.id)])))
      .orderBy(desc(tasks.createdAt))
      .limit(50);
  }
}
