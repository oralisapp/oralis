import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, gte, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, notFound } from '../../common/app-error';
import { Clock } from '../../common/clock';
import { type AuthContext, type RequestMeta, type TenantContext } from '../../common/request-context';
import { DB, type Db, type Tx } from '../../db/db';
import { appointments, campaigns, communicationEvents, messageTemplates, organizations, patients, quotes, treatmentPlans, users } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { CommunicationService } from '../patients/communication.service';
import { MailService, mailLayout } from '../platform/mail.service';
import { MobileMessageProvider } from './mobile-message-provider';

export const templateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  category: z.enum(['transactional', 'relationship', 'promotional']),
  channel: z.enum(['email', 'sms', 'whatsapp']),
  subject: z.string().trim().max(160).optional(),
  body: z.string().trim().min(5).max(2000),
});
export const sendSchema = z.object({ patientId: z.uuid(), templateId: z.uuid(), vars: z.record(z.string(), z.string().max(300)).default({}) });
export const campaignCriteriaSchema = z.object({
  /** Pacientes sem consulta concluída há pelo menos N dias. */
  inactiveDays: z.number().int().min(30).max(3650).optional(),
  /** Pacientes com orçamento apresentado e não decidido. */
  pendingQuote: z.boolean().optional(),
});
export const campaignSchema = z.object({ name: z.string().trim().min(3).max(120), templateId: z.uuid(), criteria: campaignCriteriaSchema, confirmRecipientCount: z.number().int().min(1) });

/** Limite de mensagens de relacionamento/campanha por paciente em 7 dias. */
const WEEKLY_LIMIT = 3;
const PLACEHOLDERS = ['primeiro_nome', 'clinica', 'data', 'hora', 'profissional', 'link'] as const;

export type SendStatus = 'sent' | 'logged_locally' | 'queued' | 'failed' | 'not_configured' | 'blocked_consent' | 'blocked_frequency' | 'blocked_demo';

/**
 * Central de comunicações: todo envio passa por aqui, com consentimento,
 * limite de frequência, ambiente de demonstração e registro do resultado
 * informado pelo provedor (nunca "lido" sem confirmação).
 */
@Injectable()
export class MessagingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly clock: Clock,
    private readonly mail: MailService,
    private readonly comms: CommunicationService,
    private readonly audit: AuditService,
    private readonly mobile: MobileMessageProvider,
  ) {}

  render(body: string, vars: Record<string, string>) {
    return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? '');
  }

  async varsFor(organizationId: string, patientId: string, extra: Record<string, string> = {}) {
    const [p] = await this.db.select({ fullName: patients.fullName, socialName: patients.socialName }).from(patients).where(and(eq(patients.id, patientId), eq(patients.organizationId, organizationId)));
    if (!p) throw notFound('Paciente');
    const [org] = await this.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, organizationId));
    return { primeiro_nome: (p.socialName || p.fullName).split(' ')[0]!, clinica: org!.name, ...extra };
  }

  /** Envia (ou registra o bloqueio). Reavalia tudo no momento do envio. */
  async send(input: {
    organizationId: string;
    patientId: string;
    channel: 'email' | 'sms' | 'whatsapp';
    category: 'transactional' | 'relationship' | 'promotional';
    subject?: string | null;
    body: string;
    vars?: Record<string, string>;
    templateId?: string | null;
    templateVersion?: number | null;
    sentBy?: string | null;
    automationId?: string | null;
    campaignId?: string | null;
  }): Promise<{ id: string; status: SendStatus }> {
    const record = async (status: SendStatus, detail?: string, providerMessageId?: string, db: Db | Tx = this.db) => {
      const [e] = await db
        .insert(communicationEvents)
        .values({ organizationId: input.organizationId, patientId: input.patientId, channel: input.channel, category: input.category, templateId: input.templateId ?? null, templateVersion: input.templateVersion ?? null, subject: input.subject ?? null, body: input.body, status, statusDetail: detail ?? null, providerMessageId: providerMessageId ?? null, sentBy: input.sentBy ?? null, automationId: input.automationId ?? null, campaignId: input.campaignId ?? null, createdAt: this.clock.now() })
        .returning({ id: communicationEvents.id });
      return { id: e!.id, status };
    };
    const [org] = await this.db.select({ isDemo: organizations.isDemo }).from(organizations).where(eq(organizations.id, input.organizationId));
    if (org?.isDemo) return record('blocked_demo', 'Organização de demonstração: nenhuma mensagem é enviada.');
    if (!(await this.comms.canContact(input.organizationId, input.patientId, input.channel, input.category))) return record('blocked_consent', 'Sem autorização do paciente para este canal e tipo de mensagem.');
    const [patient] = await this.db.select({ phone: patients.phone, email: patients.email }).from(patients).where(and(eq(patients.id, input.patientId), eq(patients.organizationId, input.organizationId)));
    // Reserve a counted slot under a patient-scoped lock, then release the
    // transaction before any external IO. Concurrent channels share the cap.
    const pending = await this.db.transaction(async (tx) => {
      if (input.category !== 'transactional') {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`messaging:${input.organizationId}:${input.patientId}`}, 0))`);
        const since = new Date(this.clock.now().getTime() - 7 * 86_400_000);
        const [{ n }] = (await tx.select({ n: count() }).from(communicationEvents).where(and(
          eq(communicationEvents.organizationId, input.organizationId), eq(communicationEvents.patientId, input.patientId),
          inArray(communicationEvents.category, ['relationship', 'promotional']),
          inArray(communicationEvents.status, ['sent', 'logged_locally', 'queued']), gte(communicationEvents.createdAt, since),
        ))) as [{ n: number }];
        if (n >= WEEKLY_LIMIT) return record('blocked_frequency', `Limite de ${WEEKLY_LIMIT} mensagens não transacionais por semana atingido.`, undefined, tx);
      }
      if (input.channel !== 'email' && !this.mobile.configured(input.channel, input.templateId)) return record('not_configured', 'Provedor ou modelo aprovado não configurado para este canal. Nenhuma mensagem enviada.', undefined, tx);
      if (input.channel === 'email' && !patient?.email) return record('failed', 'Paciente sem e-mail cadastrado.', undefined, tx);
      return record('queued', 'Envio iniciado; confira o provedor antes de repetir em caso de interrupção.', undefined, tx);
    });
    if (pending.status !== 'queued') return pending;
    const finish = async (status: SendStatus, detail?: string, providerMessageId?: string) => {
      await this.db.update(communicationEvents).set({ status, statusDetail: detail ?? null, providerMessageId: providerMessageId ?? null }).where(eq(communicationEvents.id, pending.id));
      return { id: pending.id, status };
    };
    if (input.channel !== 'email') {
      const result = await this.mobile.send({ channel: input.channel, phone: patient?.phone ?? null, body: input.body, templateId: input.templateId, vars: input.vars });
      return finish(result.status, result.detail, result.providerMessageId);
    }
    const [o] = await this.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, input.organizationId));
    const layout = mailLayout(input.subject ?? o!.name, input.body.split(/\n{2,}/));
    const r = await this.mail.send({ to: patient!.email!, subject: input.subject ?? `Mensagem de ${o!.name}`, organizationId: input.organizationId, category: input.category, ...layout });
    return finish(r.delivery === 'sent' ? 'sent' : r.delivery === 'logged_locally' ? 'logged_locally' : 'queued', r.delivery === 'logged_locally' ? 'SMTP não configurado: mensagem na caixa de saída local.' : undefined);
  }

  // ---------------------------------------------------------------- Modelos

  async templates(tenant: TenantContext) {
    return this.db.select().from(messageTemplates).where(and(eq(messageTemplates.organizationId, tenant.organizationId), eq(messageTemplates.active, true))).orderBy(asc(messageTemplates.name));
  }

  async saveTemplate(auth: AuthContext, tenant: TenantContext, id: string | null, input: z.infer<typeof templateSchema>, meta: RequestMeta) {
    const unknown = [...input.body.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]!).filter((k) => !(PLACEHOLDERS as readonly string[]).includes(k));
    if (unknown.length) throw new AppError('validation_failed', `Campos desconhecidos: ${unknown.join(', ')}. Use: ${PLACEHOLDERS.join(', ')}.`);
    return this.db.transaction(async (tx) => {
      let key: string = randomUUID();
      let version = 1;
      if (id) {
        const [cur] = await tx.select().from(messageTemplates).where(and(eq(messageTemplates.id, id), eq(messageTemplates.organizationId, tenant.organizationId))).for('update');
        if (!cur) throw notFound('Modelo');
        await tx.update(messageTemplates).set({ active: false }).where(eq(messageTemplates.id, id));
        key = cur.key;
        version = cur.version + 1;
      }
      const [row] = await tx.insert(messageTemplates).values({ organizationId: tenant.organizationId, key, version, ...input, subject: input.subject ?? null, createdBy: auth.userId }).returning({ id: messageTemplates.id });
      await this.audit.record(tx, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'messaging.template_saved', entityType: 'message_template', entityId: row!.id, metadata: { version }, meta });
      return { id: row!.id, version };
    });
  }

  async preview(tenant: TenantContext, templateId: string, patientId: string, vars: Record<string, string>) {
    const [t] = await this.db.select().from(messageTemplates).where(and(eq(messageTemplates.id, templateId), eq(messageTemplates.organizationId, tenant.organizationId)));
    if (!t) throw notFound('Modelo');
    const v = await this.varsFor(tenant.organizationId, patientId, vars);
    const allowed = await this.comms.canContact(tenant.organizationId, patientId, t.channel as 'email', t.category as 'relationship');
    return { channel: t.channel, category: t.category, subject: t.subject ? this.render(t.subject, v) : null, body: this.render(t.body, v), consent: allowed, channelConfigured: t.channel === 'email' || this.mobile.configured(t.channel, t.id) };
  }

  async sendManual(auth: AuthContext, tenant: TenantContext, input: z.infer<typeof sendSchema>, meta: RequestMeta) {
    const p = await this.preview(tenant, input.templateId, input.patientId, input.vars);
    const [t] = await this.db.select().from(messageTemplates).where(eq(messageTemplates.id, input.templateId));
    const vars = await this.varsFor(tenant.organizationId, input.patientId, input.vars);
    const r = await this.send({ organizationId: tenant.organizationId, patientId: input.patientId, channel: t!.channel as 'email', category: t!.category as 'relationship', subject: p.subject, body: p.body, vars, templateId: t!.id, templateVersion: t!.version, sentBy: auth.userId });
    await this.audit.record(this.db, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'messaging.sent', entityType: 'patient', entityId: input.patientId, metadata: { templateId: t!.id, status: r.status }, meta });
    return r;
  }

  async events(tenant: TenantContext, q: { patientId?: string; category?: string; status?: string }) {
    const f: SQL[] = [eq(communicationEvents.organizationId, tenant.organizationId)];
    if (q.patientId) f.push(eq(communicationEvents.patientId, q.patientId));
    if (q.category) f.push(eq(communicationEvents.category, q.category));
    if (q.status) f.push(eq(communicationEvents.status, q.status));
    return this.db
      .select({ e: communicationEvents, patientName: patients.fullName, sentByName: users.name, templateName: messageTemplates.name })
      .from(communicationEvents)
      .leftJoin(patients, eq(patients.id, communicationEvents.patientId))
      .leftJoin(users, eq(users.id, communicationEvents.sentBy))
      .leftJoin(messageTemplates, eq(messageTemplates.id, communicationEvents.templateId))
      .where(and(...f))
      .orderBy(desc(communicationEvents.createdAt))
      .limit(300);
  }

  // --------------------------------------------------------------- Campanhas

  private async selectRecipients(organizationId: string, criteria: z.infer<typeof campaignCriteriaSchema>) {
    const filters: SQL[] = [eq(patients.organizationId, organizationId), eq(patients.status, 'active')];
    if (criteria.inactiveDays) {
      const since = new Date(this.clock.now().getTime() - criteria.inactiveDays * 86_400_000);
      filters.push(sql`not exists (select 1 from ${appointments} a where a.patient_id = ${patients.id} and a.status = 'completed' and a.starts_at >= ${since})`);
      filters.push(sql`not exists (select 1 from ${appointments} a where a.patient_id = ${patients.id} and a.status in ('scheduled', 'confirmed') and a.starts_at >= ${this.clock.now()})`);
    }
    if (criteria.pendingQuote) {
      filters.push(sql`exists (select 1 from ${quotes} q join ${treatmentPlans} tp on tp.id = q.plan_id where tp.patient_id = ${patients.id} and q.status = 'presented')`);
    }
    return this.db.select({ id: patients.id, fullName: patients.fullName }).from(patients).where(and(...filters)).orderBy(asc(patients.fullName)).limit(5000);
  }

  /** Mostra quantos e quem seria atingido, quantos não têm autorização, e a mensagem final. */
  async previewCampaign(tenant: TenantContext, templateId: string, criteria: z.infer<typeof campaignCriteriaSchema>) {
    const [t] = await this.db.select().from(messageTemplates).where(and(eq(messageTemplates.id, templateId), eq(messageTemplates.organizationId, tenant.organizationId)));
    if (!t) throw notFound('Modelo');
    if (t.category === 'transactional') throw new AppError('validation_failed', 'Campanhas usam modelos de relacionamento ou promocionais.');
    const all = await this.selectRecipients(tenant.organizationId, criteria);
    const allowed: typeof all = [];
    for (const p of all) if (await this.comms.canContact(tenant.organizationId, p.id, t.channel as 'email', t.category as 'promotional')) allowed.push(p);
    const sample = allowed[0] ? await this.preview(tenant, templateId, allowed[0].id, {}) : null;
    return {
      criteria,
      matched: all.length,
      withConsent: allowed.length,
      withoutConsent: all.length - allowed.length,
      sampleRecipients: allowed.slice(0, 10).map((p) => p.fullName),
      message: sample ? { subject: sample.subject, body: sample.body } : null,
      channel: t.channel,
      channelConfigured: t.channel === 'email' || this.mobile.configured(t.channel, t.id),
    };
  }

  /** Envio coletivo exige confirmar o número exato de destinatários exibido na prévia. */
  async sendCampaign(auth: AuthContext, tenant: TenantContext, input: z.infer<typeof campaignSchema>, meta: RequestMeta) {
    const pv = await this.previewCampaign(tenant, input.templateId, input.criteria);
    if (pv.withConsent !== input.confirmRecipientCount) throw new AppError('conflict', `A lista mudou desde a prévia (${pv.withConsent} destinatários agora). Revise antes de confirmar.`, { withConsent: pv.withConsent });
    const [t] = await this.db.select().from(messageTemplates).where(eq(messageTemplates.id, input.templateId));
    const [c] = await this.db.insert(campaigns).values({ organizationId: tenant.organizationId, name: input.name, templateId: t!.id, criteria: input.criteria, recipientCount: pv.withConsent, createdBy: auth.userId }).returning({ id: campaigns.id });
    const recipients = await this.selectRecipients(tenant.organizationId, input.criteria);
    const result: Record<string, number> = {};
    for (const p of recipients) {
      if (!(await this.comms.canContact(tenant.organizationId, p.id, t!.channel as 'email', t!.category as 'promotional'))) continue;
      const v = await this.varsFor(tenant.organizationId, p.id);
      const r = await this.send({ organizationId: tenant.organizationId, patientId: p.id, channel: t!.channel as 'email', category: t!.category as 'promotional', subject: t!.subject ? this.render(t!.subject, v) : null, body: this.render(t!.body, v), vars: v, templateId: t!.id, templateVersion: t!.version, sentBy: auth.userId, campaignId: c!.id });
      result[r.status] = (result[r.status] ?? 0) + 1;
    }
    await this.audit.record(this.db, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'messaging.campaign_sent', entityType: 'campaign', entityId: c!.id, metadata: { recipients: pv.withConsent, result }, meta });
    return { id: c!.id, result };
  }
}
