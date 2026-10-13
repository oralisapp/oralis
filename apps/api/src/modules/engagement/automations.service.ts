import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { parseTimeToMinutes, toCents, zonedParts } from '@oralis/shared';
import { and, asc, desc, eq, gt, gte, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, notFound } from '../../common/app-error';
import { Clock } from '../../common/clock';
import { type AuthContext, type RequestMeta, type TenantContext } from '../../common/request-context';
import { env } from '../../config/env';
import { DB, type Db } from '../../db/db';
import {
  appointmentLinks,
  appointments,
  automationExecutions,
  automations,
  automationVersions,
  clinicUnits,
  inventoryItems,
  messageTemplates,
  patients,
  professionals,
  quotes,
  quoteVersions,
  receivables,
  stockMovements,
  tasks,
  treatmentItems,
  treatmentPlans,
  users,
} from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { newToken, sha256 } from '../identity/session.service';
import { CommunicationService } from '../patients/communication.service';
import { DomainEvents } from '../platform/domain-events';
import { JobsService } from '../platform/jobs.service';
import { WaitlistService } from '../scheduling/waitlist.service';
import { type Candidate, TEMPLATE_INFO, type TemplateKey, confirmationRule, continuityRule, overdueRule, quoteRule, stockRule, syntheticCandidates, vacancyRule } from './automation-rules';
import { MessagingService } from './messaging.service';

const TEMPLATE_KEYS = Object.keys(TEMPLATE_INFO) as [TemplateKey, ...TemplateKey[]];
export const automationSchema = z.object({
  templateKey: z.enum(TEMPLATE_KEYS),
  name: z.string().trim().min(3).max(120),
  description: z.string().trim().max(500).optional(),
  unitId: z.uuid().optional(),
  config: z.object({
    hoursBefore: z.number().int().min(2).max(96).optional(),
    daysWithoutContact: z.number().int().min(1).max(90).optional(),
    daysOverdue: z.number().int().min(1).max(180).optional(),
    action: z.enum(['task', 'message']).optional(),
  }),
  channel: z.enum(['email', 'sms', 'whatsapp']).optional(),
  messageTemplateId: z.uuid().optional(),
  windowStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('08:00'),
  windowEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('20:00'),
  timezone: z.string().default('America/Sao_Paulo'),
  frequencyLimitHours: z.number().int().min(1).max(24 * 30).default(72),
});
export const simulateSchema = z.object({ mode: z.enum(['synthetic', 'real']), templateKey: z.enum(TEMPLATE_KEYS), config: automationSchema.shape.config, channel: z.enum(['email', 'sms', 'whatsapp']).optional() });

type Auto = typeof automations.$inferSelect;
const DEFAULT_CONFIRMATION = 'Olá, {{primeiro_nome}}! Sua consulta em {{clinica}} está marcada para {{data}} às {{hora}} com {{profissional}}. Confirme ou peça outro horário: {{link}}';
const DEFAULT_OVERDUE = 'Olá, {{primeiro_nome}}. Consta uma pendência de pagamento com {{clinica}}. Se já regularizou, desconsidere. Em caso de dúvida, fale conosco.';
const DEFAULT_QUOTE = 'Olá, {{primeiro_nome}}! Ficou alguma dúvida sobre o plano de tratamento apresentado em {{clinica}}? Estamos à disposição.';

/**
 * Motor de automações: Evento → Condições → Ação → Resultado.
 * - Pausadas por padrão; ativação explícita por quem tem permissão.
 * - Condição reavaliada imediatamente antes de cada ação.
 * - Dedupe por chave lógica; janela de horário e limite de frequência por paciente.
 * - Toda execução (feita, pulada ou com falha) fica registrada com o motivo.
 */
@Injectable()
export class AutomationsService implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly jobs: JobsService,
    private readonly events: DomainEvents,
    private readonly messaging: MessagingService,
    private readonly comms: CommunicationService,
    private readonly waitlist: WaitlistService,
  ) {}

  onModuleInit() {
    // Eventos só enfileiram: a avaliação acontece depois, com dados confirmados.
    this.events.on('appointment.status_changed', async (_tx, e) => {
      if (e.to === 'cancelled') await this.jobs.enqueue('automation.event', { templateKey: 'vacancy', organizationId: e.organizationId, entityId: e.appointmentId }, { organizationId: e.organizationId });
    });
    this.events.on('treatment_item.done', async (_tx, e) => {
      await this.jobs.enqueue('automation.event', { templateKey: 'continuity', organizationId: e.organizationId, entityId: e.itemId }, { organizationId: e.organizationId });
    });
    this.events.on('stock.moved', async (_tx, e) => {
      await this.jobs.enqueue('automation.event', { templateKey: 'stock_minimum', organizationId: e.organizationId, entityId: e.itemId, unitId: e.unitId }, { organizationId: e.organizationId });
    });
    this.jobs.register('automation.event', async (p) => this.runEvent(p as { templateKey: TemplateKey; organizationId: string; entityId: string; unitId?: string }));
    this.jobs.every({ name: 'automations.tick', everyMs: 5 * 60_000, run: () => this.tick() });
  }

  // ------------------------------------------------------------- Cadastro

  async list(tenant: TenantContext) {
    const rows = await this.db.select({ a: automations, ownerName: users.name }).from(automations).innerJoin(users, eq(users.id, automations.ownerUserId)).where(eq(automations.organizationId, tenant.organizationId)).orderBy(asc(automations.name));
    const stats = rows.length
      ? await this.db.select({ automationId: automationExecutions.automationId, status: automationExecutions.status, n: sql<number>`count(*)::int` }).from(automationExecutions).where(inArray(automationExecutions.automationId, rows.map((r) => r.a.id))).groupBy(automationExecutions.automationId, automationExecutions.status)
      : [];
    return { templates: TEMPLATE_INFO, automations: rows.map((r) => ({ ...r.a, ownerName: r.ownerName, stats: Object.fromEntries(stats.filter((s) => s.automationId === r.a.id).map((s) => [s.status, s.n])) })) };
  }

  private validate(input: z.infer<typeof automationSchema>) {
    const info = TEMPLATE_INFO[input.templateKey];
    if (input.templateKey === 'confirmation' && !input.config.hoursBefore) throw new AppError('validation_failed', 'Informe quantas horas antes enviar.');
    if (input.templateKey === 'quote_followup' && !input.config.daysWithoutContact) throw new AppError('validation_failed', 'Informe os dias sem contato.');
    if (input.templateKey === 'overdue_receivable' && !input.config.daysOverdue) throw new AppError('validation_failed', 'Informe os dias de atraso.');
    const sends = input.templateKey === 'confirmation' || (info.usesMessage && input.config.action === 'message');
    if (sends && !input.channel) throw new AppError('validation_failed', 'Escolha o canal da mensagem.');
    if (parseTimeToMinutes(input.windowStart) >= parseTimeToMinutes(input.windowEnd)) throw new AppError('validation_failed', 'A janela de horário é inválida.');
  }

  async save(auth: AuthContext, tenant: TenantContext, id: string | null, input: z.infer<typeof automationSchema>, meta: RequestMeta) {
    this.validate(input);
    return this.db.transaction(async (tx) => {
      const values = { ...input, description: input.description ?? null, unitId: input.unitId ?? null, channel: input.channel ?? null, messageTemplateId: input.messageTemplateId ?? null };
      let row: Auto;
      if (id) {
        const [cur] = await tx.select().from(automations).where(and(eq(automations.id, id), eq(automations.organizationId, tenant.organizationId))).for('update');
        if (!cur) throw notFound('Automação');
        [row] = (await tx.update(automations).set({ ...values, version: cur.version + 1, updatedAt: this.clock.now() }).where(eq(automations.id, id)).returning()) as [Auto];
      } else {
        [row] = (await tx.insert(automations).values({ organizationId: tenant.organizationId, ...values, ownerUserId: auth.userId }).returning()) as [Auto];
      }
      await tx.insert(automationVersions).values({ automationId: row.id, version: row.version, snapshot: values, changedBy: auth.userId });
      await this.audit.record(tx, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: id ? 'automation.updated' : 'automation.created', entityType: 'automation', entityId: row.id, metadata: { version: row.version, templateKey: input.templateKey }, meta });
      return { id: row.id, version: row.version, status: row.status };
    });
  }

  async setStatus(auth: AuthContext, tenant: TenantContext, id: string, status: 'active' | 'paused', meta: RequestMeta) {
    const r = await this.db.update(automations).set({ status, updatedAt: this.clock.now() }).where(and(eq(automations.id, id), eq(automations.organizationId, tenant.organizationId))).returning({ id: automations.id });
    if (!r.length) throw notFound('Automação');
    await this.audit.record(this.db, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: status === 'active' ? 'automation.activated' : 'automation.paused', entityType: 'automation', entityId: id, meta });
    return { status };
  }

  async history(tenant: TenantContext, id: string) {
    const [a] = await this.db.select().from(automations).where(and(eq(automations.id, id), eq(automations.organizationId, tenant.organizationId)));
    if (!a) throw notFound('Automação');
    const [versions, executions] = await Promise.all([
      this.db.select({ v: automationVersions, byName: users.name }).from(automationVersions).innerJoin(users, eq(users.id, automationVersions.changedBy)).where(eq(automationVersions.automationId, id)).orderBy(desc(automationVersions.version)),
      this.db.select().from(automationExecutions).where(eq(automationExecutions.automationId, id)).orderBy(desc(automationExecutions.executedAt)).limit(200),
    ]);
    return { automation: a, versions: versions.map((v) => ({ ...v.v, byName: v.byName })), executions };
  }

  // ------------------------------------------------------------- Seleção

  private today(tz: string) {
    return zonedParts(this.clock.now(), tz).date;
  }

  /** Lê os dados reais e aplica a regra pura. `scopeId` restringe a uma entidade (eventos). */
  async candidates(orgId: string, key: TemplateKey, autoId: string, cfg: Auto['config'] & Record<string, number>, channel: string | null, scopeId?: string, unitId?: string): Promise<Candidate[]> {
    const now = this.clock.now();
    const today = this.today('America/Sao_Paulo');
    switch (key) {
      case 'confirmation': {
        const horizon = new Date(now.getTime() + (cfg.hoursBefore ?? 24) * 3_600_000 + 6 * 3_600_000);
        const rows = await this.db
          .select({ a: appointments, name: patients.fullName, email: patients.email, phone: patients.phone })
          .from(appointments)
          .innerJoin(patients, eq(patients.id, appointments.patientId))
          .where(and(eq(appointments.organizationId, orgId), scopeId ? eq(appointments.id, scopeId) : and(gt(appointments.startsAt, now), lt(appointments.startsAt, horizon), inArray(appointments.status, ['scheduled', 'confirmed']))));
        const recs = [];
        for (const r of rows) {
          recs.push({ id: r.a.id, version: r.a.version, startsAt: r.a.startsAt, status: r.a.status, patientId: r.a.patientId, patientName: r.name, hasChannel: channel === 'email' ? !!r.email : !!r.phone, consent: await this.comms.canContact(orgId, r.a.patientId, (channel ?? 'email') as 'email', 'transactional') });
        }
        return confirmationRule(autoId, { hoursBefore: cfg.hoursBefore ?? 24 }, recs, now);
      }
      case 'vacancy': {
        if (!scopeId) return [];
        const [a] = await this.db.select({ a: appointments, name: patients.fullName }).from(appointments).innerJoin(patients, eq(patients.id, appointments.patientId)).where(and(eq(appointments.id, scopeId), eq(appointments.organizationId, orgId)));
        if (!a) return [];
        const tenant = { organizationId: orgId, allUnits: true, unitIds: new Set<string>() } as unknown as TenantContext;
        const sugg = a.a.startsAt > now ? await this.waitlist.suggestions(tenant, a.a.unitId, a.a.professionalId, a.a.startsAt, a.a.endsAt) : [];
        return vacancyRule(autoId, [{ id: a.a.id, startsAt: a.a.startsAt, status: a.a.status, candidates: sugg.length, label: `Vaga de ${a.a.startsAt.toISOString()}` }], now);
      }
      case 'quote_followup': {
        const rows = await this.db
          .select({ q: quotes, v: quoteVersions, name: patients.fullName })
          .from(quotes)
          .innerJoin(quoteVersions, eq(quoteVersions.id, quotes.currentVersionId))
          .innerJoin(patients, eq(patients.id, quotes.patientId))
          .where(and(eq(quotes.organizationId, orgId), scopeId ? eq(quotes.id, scopeId) : eq(quotes.status, 'presented')));
        return quoteRule(autoId, { daysWithoutContact: cfg.daysWithoutContact ?? 7 }, rows.map((r) => ({ id: r.q.id, versionId: r.v.id, patientId: r.q.patientId, patientName: r.name, status: r.q.status, lastContactAt: r.q.lastContactAt ?? r.v.presentedAt, validUntil: r.v.validUntil })), now, today);
      }
      case 'continuity': {
        let planIds: string[] = [];
        if (scopeId) {
          // Evento traz a etapa concluída; a reavaliação traz o próprio plano.
          const [it] = await this.db.select({ planId: treatmentItems.planId }).from(treatmentItems).where(eq(treatmentItems.id, scopeId));
          planIds = [it?.planId ?? scopeId];
        } else {
          planIds = (await this.db.select({ id: treatmentPlans.id }).from(treatmentPlans).where(and(eq(treatmentPlans.organizationId, orgId), eq(treatmentPlans.status, 'in_progress')))).map((p) => p.id);
        }
        if (!planIds.length) return [];
        const plans = await this.db.select({ p: treatmentPlans, name: patients.fullName }).from(treatmentPlans).innerJoin(patients, eq(patients.id, treatmentPlans.patientId)).where(inArray(treatmentPlans.id, planIds));
        const items = await this.db.select().from(treatmentItems).where(inArray(treatmentItems.planId, planIds));
        return continuityRule(autoId, plans.map((p) => ({ planId: p.p.id, patientId: p.p.patientId, patientName: p.name, doneCount: items.filter((i) => i.planId === p.p.id && i.status === 'done').length, pendingUnscheduled: items.filter((i) => i.planId === p.p.id && i.status === 'planned').map((i) => `${i.description}${i.tooth ? ` (dente ${i.tooth})` : ''}`) })));
      }
      case 'stock_minimum': {
        const rows = await this.db
          .select({ itemId: inventoryItems.id, name: inventoryItems.name, min: inventoryItems.minQuantity, unitId: stockMovements.unitId, b: sql<string>`coalesce(sum(case when ${stockMovements.type} in ('in','adjust_in','transfer_in') then ${stockMovements.quantity} else -${stockMovements.quantity} end), 0)` })
          .from(inventoryItems)
          .innerJoin(stockMovements, eq(stockMovements.itemId, inventoryItems.id))
          .where(and(eq(inventoryItems.organizationId, orgId), scopeId ? eq(inventoryItems.id, scopeId) : undefined, unitId ? eq(stockMovements.unitId, unitId) : undefined))
          .groupBy(inventoryItems.id, inventoryItems.name, inventoryItems.minQuantity, stockMovements.unitId);
        return stockRule(autoId, rows.map((r) => ({ itemId: r.itemId, unitId: r.unitId, name: r.name, balance: Number(r.b), min: Number(r.min) })), today);
      }
      case 'overdue_receivable': {
        const rows = await this.db
          .select({ r: receivables, name: patients.fullName, paid: sql<string>`(select coalesce(sum(a.amount),0) from payment_allocations a where a.receivable_id = ${receivables.id})` })
          .from(receivables)
          .leftJoin(patients, eq(patients.id, receivables.patientId))
          .where(and(eq(receivables.organizationId, orgId), scopeId ? eq(receivables.id, scopeId) : and(eq(receivables.status, 'open'), lt(receivables.dueDate, today))));
        return overdueRule(autoId, { daysOverdue: cfg.daysOverdue ?? 3 }, rows.map((x) => ({ id: x.r.id, patientId: x.r.patientId, patientName: x.name ?? 'Sem paciente', balanceCents: x.r.status === 'open' ? toCents(x.r.amount) - toCents(String(x.paid)) : 0, dueDate: x.r.dueDate, hold: x.r.collectionHold })), today);
      }
    }
  }

  /** Simulação: dados sintéticos ou reais, SEM enviar mensagens nem alterar registros. */
  async simulate(tenant: TenantContext, input: z.infer<typeof simulateSchema>) {
    const cfg = input.config as Record<string, number>;
    const list =
      input.mode === 'synthetic'
        ? syntheticCandidates(input.templateKey, cfg, this.clock.now(), this.today('America/Sao_Paulo'))
        : await this.candidates(tenant.organizationId, input.templateKey, 'simulacao', cfg as never, input.channel ?? 'email');
    const action = input.config.action === 'message' || input.templateKey === 'confirmation' ? `Mensagem por ${input.channel ?? 'e-mail'}${input.channel && input.channel !== 'email' ? ' (canal sem provedor configurado: seria registrada como não enviada)' : ''}` : 'Tarefa para a equipe';
    return { mode: input.mode, environment: env().APP_ENV, plannedAction: action, info: TEMPLATE_INFO[input.templateKey], selected: list.filter((c) => c.selected), excluded: list.filter((c) => !c.selected), notice: 'Simulação: nada foi enviado nem alterado.' };
  }

  // ------------------------------------------------------------- Execução

  private inWindow(a: Auto) {
    const m = zonedParts(this.clock.now(), a.timezone).minutes;
    return m >= parseTimeToMinutes(a.windowStart) && m < parseTimeToMinutes(a.windowEnd);
  }

  async tick() {
    const active = await this.db.select().from(automations).where(and(eq(automations.status, 'active'), inArray(automations.templateKey, ['confirmation', 'quote_followup', 'overdue_receivable', 'continuity'])));
    let n = 0;
    for (const a of active) n += await this.runAutomation(a);
    return n;
  }

  private async runEvent(p: { templateKey: TemplateKey; organizationId: string; entityId: string; unitId?: string }) {
    const active = await this.db.select().from(automations).where(and(eq(automations.organizationId, p.organizationId), eq(automations.templateKey, p.templateKey), eq(automations.status, 'active')));
    let n = 0;
    for (const a of active) n += await this.runAutomation(a, p.entityId, p.unitId);
    return { executed: n };
  }

  async runAutomation(a: Auto, scopeId?: string, unitId?: string): Promise<number> {
    if (!this.inWindow(a)) return 0;
    const list = await this.candidates(a.organizationId, a.templateKey as TemplateKey, a.id, a.config as never, a.channel, scopeId, unitId);
    let n = 0;
    for (const c of list.filter((x) => x.selected)) {
      const [done] = await this.db.select({ id: automationExecutions.id }).from(automationExecutions).where(eq(automationExecutions.dedupeKey, c.dedupeKey));
      if (done) continue;
      n += await this.execute(a, c);
    }
    return n;
  }

  private async record(a: Auto, c: Candidate, status: 'done' | 'skipped' | 'failed', reason: string | null, result: unknown) {
    await this.db.insert(automationExecutions).values({ organizationId: a.organizationId, automationId: a.id, entityType: c.entityType, entityId: c.entityId, patientId: c.patientId ?? null, dedupeKey: c.dedupeKey, status, reason, action: c.action, result: result as never, executedAt: this.clock.now() }).onConflictDoNothing();
  }

  private async execute(a: Auto, c: Candidate): Promise<number> {
    // Reavaliação imediatamente antes da ação.
    const again = await this.candidates(a.organizationId, a.templateKey as TemplateKey, a.id, a.config as never, a.channel, c.entityId);
    const fresh = again.find((x) => x.dedupeKey === c.dedupeKey);
    if (!fresh?.selected) {
      const why = (fresh ?? again.find((x) => x.entityId === c.entityId))?.reasons.join('; ') ?? 'registro não encontrado ou alterado';
      await this.record(a, c, 'skipped', `Condição deixou de valer: ${why}`, null);
      return 0;
    }
    if (c.patientId) {
      const since = new Date(this.clock.now().getTime() - a.frequencyLimitHours * 3_600_000);
      const [recent] = await this.db.select({ id: automationExecutions.id }).from(automationExecutions).where(and(eq(automationExecutions.automationId, a.id), eq(automationExecutions.patientId, c.patientId), eq(automationExecutions.status, 'done'), gte(automationExecutions.executedAt, since)));
      if (recent) {
        await this.record(a, c, 'skipped', `Limite de frequência: já houve ação para este paciente nas últimas ${a.frequencyLimitHours} h`, null);
        return 0;
      }
    }
    try {
      const cfg = a.config as { action?: 'task' | 'message' };
      const wantsMessage = a.templateKey === 'confirmation' || cfg.action === 'message';
      if (wantsMessage && c.patientId) {
        const result = await this.sendMessage(a, c);
        await this.record(a, c, result.status === 'sent' || result.status === 'logged_locally' || result.status === 'queued' ? 'done' : 'skipped', result.status === 'sent' || result.status === 'logged_locally' || result.status === 'queued' ? null : `Mensagem não enviada: ${result.status}`, result);
      } else {
        const id = await this.createTask(a, c);
        await this.record(a, c, 'done', null, { taskId: id });
      }
      return 1;
    } catch (err) {
      await this.record(a, c, 'failed', err instanceof Error ? err.message.slice(0, 300) : 'erro', null);
      return 0;
    }
  }

  private async createTask(a: Auto, c: Candidate) {
    const titles: Record<string, string> = {
      vacancy: `Vaga aberta com candidatos na lista de espera`,
      quote_followup: `Retomar orçamento sem retorno: ${c.label}`,
      continuity: `Agendar próxima etapa do tratamento: ${c.label}`,
      stock_minimum: `Repor estoque: ${c.label}`,
      overdue_receivable: `Recebimento vencido: ${c.label}`,
    };
    const [t] = await this.db
      .insert(tasks)
      .values({ organizationId: a.organizationId, unitId: a.unitId, title: titles[a.templateKey] ?? a.name, description: `${a.name}\nCritério: ${c.reasons.join('; ')}`, assigneeRoleKey: a.templateKey === 'overdue_receivable' ? 'finance' : a.templateKey === 'stock_minimum' ? null : 'reception', origin: 'automation', relatedType: c.entityType === 'receivable' ? 'receivable' : c.entityType, relatedId: c.entityId, dedupeKey: c.dedupeKey, dueAt: this.clock.now() })
      .onConflictDoNothing()
      .returning({ id: tasks.id });
    return t?.id ?? null;
  }

  private async sendMessage(a: Auto, c: Candidate) {
    const extra: Record<string, string> = {};
    let body = a.templateKey === 'confirmation' ? DEFAULT_CONFIRMATION : a.templateKey === 'overdue_receivable' ? DEFAULT_OVERDUE : DEFAULT_QUOTE;
    let subject: string | null = a.templateKey === 'confirmation' ? 'Confirme sua consulta' : null;
    let category: 'transactional' | 'relationship' = a.templateKey === 'quote_followup' ? 'relationship' : 'transactional';
    let templateId: string | null = null;
    let templateVersion: number | null = null;
    if (a.messageTemplateId) {
      const [t] = await this.db.select().from(messageTemplates).where(eq(messageTemplates.id, a.messageTemplateId));
      if (t) ({ body, subject, category, templateId, templateVersion } = { body: t.body, subject: t.subject, category: t.category as 'relationship', templateId: t.id, templateVersion: t.version });
    }
    if (a.templateKey === 'confirmation') {
      const [ap] = await this.db.select({ a: appointments, prof: professionals.displayName, tz: clinicUnits.timezone }).from(appointments).innerJoin(professionals, eq(professionals.id, appointments.professionalId)).innerJoin(clinicUnits, eq(clinicUnits.id, appointments.unitId)).where(eq(appointments.id, c.entityId));
      const token = newToken();
      await this.db.insert(appointmentLinks).values({ organizationId: a.organizationId, appointmentId: c.entityId, tokenHash: sha256(token), appointmentVersion: ap!.a.version, expiresAt: ap!.a.startsAt });
      const p = zonedParts(ap!.a.startsAt, ap!.tz);
      Object.assign(extra, { data: p.date.split('-').reverse().join('/'), hora: `${String(Math.floor(p.minutes / 60)).padStart(2, '0')}:${String(p.minutes % 60).padStart(2, '0')}`, profissional: ap!.prof, link: `${env().WEB_ORIGIN}/c/${token}` });
    }
    const vars = await this.messaging.varsFor(a.organizationId, c.patientId!, extra);
    return this.messaging.send({ organizationId: a.organizationId, patientId: c.patientId!, channel: (a.channel ?? 'email') as 'email', category, subject: subject ? this.messaging.render(subject, vars) : null, body: this.messaging.render(body, vars), vars, templateId, templateVersion, automationId: a.id });
  }

}
