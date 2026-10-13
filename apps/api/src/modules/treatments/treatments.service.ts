import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { BLOCKING_STATUSES, ODONTOGRAM_CONDITIONS, fromCents, isValidTooth, percentOf, toCents, zonedParts } from '@oralis/shared';
import { and, asc, desc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, forbidden, notFound } from '../../common/app-error';
import { Clock } from '../../common/clock';
import { type AuthContext, type RequestMeta, type TenantContext, canAccessUnit } from '../../common/request-context';
import { DB, type Db, type DbOrTx, type Tx } from '../../db/db';
import {
  appointments,
  clinicUnits,
  odontogramEntries,
  patients,
  professionals,
  quoteDecisions,
  quoteVersions,
  quotes,
  services,
  tasks,
  treatmentItems,
  treatmentPlans,
  users,
} from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { DomainEvents } from '../platform/domain-events';

const conditionKeys = Object.keys(ODONTOGRAM_CONDITIONS) as [keyof typeof ODONTOGRAM_CONDITIONS, ...(keyof typeof ODONTOGRAM_CONDITIONS)[]];

export const odontogramEntrySchema = z.object({
  tooth: z.number().int().refine(isValidTooth, { error: 'Dente inválido (notação FDI).' }),
  surfaces: z.array(z.enum(['M', 'D', 'O', 'V', 'L'])).max(5).default([]),
  condition: z.enum(conditionKeys),
  status: z.enum(['existing', 'planned', 'done']),
  notes: z.string().trim().max(300).optional(),
  clinicalRecordId: z.uuid().optional(),
});
export const planSchema = z.object({
  unitId: z.uuid(),
  title: z.string().trim().min(3).max(160),
  objective: z.string().trim().max(2000).optional(),
  responsibleProfessionalId: z.uuid().optional(),
});
export const planUpdateSchema = planSchema.omit({ unitId: true }).partial().extend({ sharedWithPatient: z.boolean().optional() });
export const itemSchema = z.object({
  description: z.string().trim().min(2).max(200),
  serviceId: z.uuid().optional(),
  tooth: z.number().int().refine(isValidTooth, { error: 'Dente inválido (notação FDI).' }).optional(),
  surfaces: z.array(z.enum(['M', 'D', 'O', 'V', 'L'])).max(5).default([]),
  stage: z.number().int().min(1).max(20).default(1),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
  professionalId: z.uuid().optional(),
  dependsOnItemId: z.uuid().optional(),
  sessionsPlanned: z.number().int().min(1).max(50).default(1),
  unitPrice: z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, { error: 'Valor inválido.' }).default('0'),
});
export const presentSchema = z.object({
  discount: z.string().regex(/^\d{1,9}(\.\d{1,2})?$/).default('0'),
  discountReason: z.string().trim().max(300).optional(),
  installments: z.number().int().min(1).max(24).default(1),
  method: z.enum(['pix', 'card_credit', 'card_debit', 'cash', 'boleto', 'transfer', 'to_define']).default('to_define'),
  firstDueDate: z.iso.date(),
  validUntil: z.iso.date(),
});
export const decisionSchema = z.object({
  versionId: z.uuid(),
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().trim().max(300).optional(),
  acknowledgedName: z.string().trim().max(160).optional(),
  /** Ao aprovar: gerar as parcelas a receber no financeiro. */
  generateReceivables: z.boolean().default(true),
  /** Ao aprovar: criar tarefas para agendar as primeiras etapas. */
  createSchedulingTasks: z.boolean().default(true),
});

export const CONTINUITY_STAGES = ['evaluation', 'presented', 'approved', 'scheduled', 'in_progress', 'completed', 'follow_up'] as const;

@Injectable()
export class TreatmentsService implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly events: DomainEvents,
  ) {}

  onModuleInit() {
    // Consulta vinculada a uma etapa: valida e marca a etapa como agendada.
    this.events.on('appointment.created', async (tx, e) => {
      const [a] = await tx.select().from(appointments).where(eq(appointments.id, e.appointmentId));
      if (!a?.treatmentItemId) return;
      const [item] = await tx
        .select({ item: treatmentItems, planStatus: treatmentPlans.status, patientId: treatmentPlans.patientId })
        .from(treatmentItems)
        .innerJoin(treatmentPlans, eq(treatmentPlans.id, treatmentItems.planId))
        .where(and(eq(treatmentItems.id, a.treatmentItemId), eq(treatmentItems.organizationId, e.organizationId)));
      if (!item || item.patientId !== a.patientId) throw new AppError('validation_failed', 'A etapa do plano não pertence a este paciente.');
      if (!['approved', 'in_progress'].includes(item.planStatus)) throw new AppError('invalid_transition', 'Só é possível agendar etapas de planos aprovados.');
      if (['done', 'cancelled'].includes(item.item.status)) throw new AppError('invalid_transition', 'Esta etapa já foi concluída ou cancelada.');
      await tx.update(treatmentItems).set({ status: 'scheduled' }).where(eq(treatmentItems.id, item.item.id));
    });
    // Consulta cancelada ou falta: a etapa volta a "planejada" se não houver outra consulta ativa para ela.
    this.events.on('appointment.status_changed', async (tx, e) => {
      if (e.to !== 'cancelled' && e.to !== 'no_show') return;
      const [a] = await tx.select({ itemId: appointments.treatmentItemId }).from(appointments).where(eq(appointments.id, e.appointmentId));
      if (!a?.itemId) return;
      const others = await tx.select({ id: appointments.id }).from(appointments).where(and(eq(appointments.treatmentItemId, a.itemId), inArray(appointments.status, ['scheduled', 'confirmed', 'arrived', 'in_progress']), ne(appointments.id, e.appointmentId)));
      if (!others.length) await tx.update(treatmentItems).set({ status: 'planned' }).where(and(eq(treatmentItems.id, a.itemId), eq(treatmentItems.status, 'scheduled')));
    });
    // Procedimento registrado na evolução FINALIZADA conclui a etapa.
    this.events.on('treatment_item.done', async (tx, e) => this.markItemDone(tx, e.organizationId, e.itemId, e.patientId, e.actorUserId));
  }

  private async markItemDone(tx: Tx, organizationId: string, itemId: string, patientId: string, actorUserId: string | null) {
    const [item] = await tx.select().from(treatmentItems).where(and(eq(treatmentItems.id, itemId), eq(treatmentItems.organizationId, organizationId))).for('update');
    if (!item) throw new AppError('validation_failed', 'Etapa do plano não encontrada.');
    const [plan] = await tx.select().from(treatmentPlans).where(eq(treatmentPlans.id, item.planId));
    if (plan?.patientId !== patientId) throw new AppError('validation_failed', 'A etapa do plano pertence a outro paciente.');
    if (item.status === 'done' || item.status === 'cancelled') return;
    await tx.update(treatmentItems).set({ status: 'done', doneAt: this.clock.now() }).where(eq(treatmentItems.id, itemId));
    if (item.tooth && actorUserId) {
      await tx.update(odontogramEntries).set({ supersededAt: this.clock.now(), supersededBy: actorUserId }).where(and(eq(odontogramEntries.treatmentItemId, itemId), isNull(odontogramEntries.supersededAt)));
      const [svc] = item.serviceId ? await tx.select({ name: services.name }).from(services).where(eq(services.id, item.serviceId)) : [];
      await tx.insert(odontogramEntries).values({ organizationId, patientId: plan!.patientId, tooth: item.tooth, surfaces: item.surfaces, condition: this.conditionFor(svc?.name ?? item.description), status: 'done', notes: item.description, recordedBy: actorUserId, treatmentItemId: itemId });
    }
    const remaining = await tx.select({ id: treatmentItems.id }).from(treatmentItems).where(and(eq(treatmentItems.planId, item.planId), inArray(treatmentItems.status, ['planned', 'scheduled'])));
    const next = remaining.length ? 'in_progress' : 'completed';
    if (plan && ['approved', 'in_progress'].includes(plan.status) && plan.status !== next) {
      await tx.update(treatmentPlans).set({ status: next, updatedAt: this.clock.now() }).where(eq(treatmentPlans.id, plan.id));
    }
    await this.audit.record(tx, { organizationId, actorUserId, action: 'treatment.item_done', entityType: 'treatment_plan', entityId: item.planId, metadata: { itemId, planStatus: next } });
  }

  /** Associação simples para o odontograma; o profissional pode registrar outra condição manualmente. */
  private conditionFor(text: string): keyof typeof ODONTOGRAM_CONDITIONS {
    const t = text.toLowerCase();
    if (t.includes('canal')) return 'root_canal';
    if (t.includes('extra')) return 'missing';
    if (t.includes('implante')) return 'implant';
    if (t.includes('coroa')) return 'crown';
    if (t.includes('selante')) return 'sealant';
    if (t.includes('prótese') || t.includes('protese')) return 'prosthesis';
    if (t.includes('restaura')) return 'restoration';
    return 'other';
  }

  private async assertPatient(db: DbOrTx, tenant: TenantContext, patientId: string) {
    const [p] = await db.select({ id: patients.id, fullName: patients.fullName, socialName: patients.socialName }).from(patients).where(and(eq(patients.id, patientId), eq(patients.organizationId, tenant.organizationId)));
    if (!p) throw notFound('Paciente');
    return p;
  }

  // ------------------------------------------------------------- Odontograma

  async odontogram(tenant: TenantContext, patientId: string) {
    await this.assertPatient(this.db, tenant, patientId);
    const rows = await this.db
      .select({ id: odontogramEntries.id, tooth: odontogramEntries.tooth, surfaces: odontogramEntries.surfaces, condition: odontogramEntries.condition, status: odontogramEntries.status, notes: odontogramEntries.notes, createdAt: odontogramEntries.createdAt, supersededAt: odontogramEntries.supersededAt, recordedByName: users.name, treatmentItemId: odontogramEntries.treatmentItemId })
      .from(odontogramEntries)
      .innerJoin(users, eq(users.id, odontogramEntries.recordedBy))
      .where(and(eq(odontogramEntries.organizationId, tenant.organizationId), eq(odontogramEntries.patientId, patientId)))
      .orderBy(desc(odontogramEntries.createdAt));
    return { current: rows.filter((r) => !r.supersededAt), history: rows };
  }

  async addOdontogramEntry(auth: AuthContext, tenant: TenantContext, patientId: string, input: z.infer<typeof odontogramEntrySchema>, meta: RequestMeta) {
    await this.assertPatient(this.db, tenant, patientId);
    const whole = ODONTOGRAM_CONDITIONS[input.condition].wholeTooth;
    const surfaces = whole ? [] : input.surfaces;
    return this.db.transaction(async (tx) => {
      const family = input.status === 'planned' ? ['planned'] : ['existing', 'done'];
      const current = await tx
        .select()
        .from(odontogramEntries)
        .where(and(eq(odontogramEntries.organizationId, tenant.organizationId), eq(odontogramEntries.patientId, patientId), eq(odontogramEntries.tooth, input.tooth), isNull(odontogramEntries.supersededAt), inArray(odontogramEntries.status, family)));
      // Substitui apenas o que o novo registro cobre (mesma superfície, ou dente inteiro).
      const covered = current.filter((c) => whole || !c.surfaces.length || c.surfaces.some((s) => (surfaces as string[]).includes(s)));
      if (covered.length) {
        await tx.update(odontogramEntries).set({ supersededAt: this.clock.now(), supersededBy: auth.userId }).where(inArray(odontogramEntries.id, covered.map((c) => c.id)));
      }
      const [row] = await tx
        .insert(odontogramEntries)
        .values({ organizationId: tenant.organizationId, patientId, tooth: input.tooth, surfaces, condition: input.condition, status: input.status, notes: input.notes ?? null, recordedBy: auth.userId, clinicalRecordId: input.clinicalRecordId ?? null })
        .returning({ id: odontogramEntries.id });
      await this.audit.record(tx, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'odontogram.entry_added', entityType: 'patient', entityId: patientId, metadata: { tooth: input.tooth, status: input.status, superseded: covered.length }, meta });
      return { id: row!.id, superseded: covered.length };
    });
  }

  // ------------------------------------------------------------------ Planos

  private planSummary(organizationId: string) {
    return this.db
      .select({
        id: treatmentPlans.id,
        patientId: treatmentPlans.patientId,
        patientName: patients.fullName,
        unitId: treatmentPlans.unitId,
        title: treatmentPlans.title,
        objective: treatmentPlans.objective,
        status: treatmentPlans.status,
        sharedWithPatient: treatmentPlans.sharedWithPatient,
        responsibleProfessionalId: treatmentPlans.responsibleProfessionalId,
        responsibleName: professionals.displayName,
        createdAt: treatmentPlans.createdAt,
        updatedAt: treatmentPlans.updatedAt,
      })
      .from(treatmentPlans)
      .innerJoin(patients, eq(patients.id, treatmentPlans.patientId))
      .leftJoin(professionals, eq(professionals.id, treatmentPlans.responsibleProfessionalId))
      .where(eq(treatmentPlans.organizationId, organizationId))
      .$dynamic();
  }

  async listForPatient(tenant: TenantContext, patientId: string) {
    await this.assertPatient(this.db, tenant, patientId);
    return this.planSummary(tenant.organizationId).where(and(eq(treatmentPlans.organizationId, tenant.organizationId), eq(treatmentPlans.patientId, patientId), tenant.allUnits ? undefined : inArray(treatmentPlans.unitId, [...tenant.unitIds]))).orderBy(desc(treatmentPlans.createdAt));
  }

  async detail(tenant: TenantContext, planId: string) {
    const [plan] = await this.planSummary(tenant.organizationId).where(and(eq(treatmentPlans.organizationId, tenant.organizationId), eq(treatmentPlans.id, planId)));
    if (!plan || !canAccessUnit(tenant, plan.unitId)) throw notFound('Plano de tratamento');
    const [items, quoteRows, unit] = await Promise.all([
      this.db
        .select({ item: treatmentItems, serviceName: services.name, professionalName: professionals.displayName })
        .from(treatmentItems)
        .leftJoin(services, eq(services.id, treatmentItems.serviceId))
        .leftJoin(professionals, eq(professionals.id, treatmentItems.professionalId))
        .where(eq(treatmentItems.planId, planId))
        .orderBy(asc(treatmentItems.stage), asc(treatmentItems.sortOrder), asc(treatmentItems.createdAt)),
      this.db.select().from(quotes).where(eq(quotes.planId, planId)).orderBy(desc(quotes.createdAt)),
      this.db.select({ timezone: clinicUnits.timezone, name: clinicUnits.name }).from(clinicUnits).where(eq(clinicUnits.id, plan.unitId)),
    ]);
    const quoteIds = quoteRows.map((q) => q.id);
    const [versions, decisions, appts] = await Promise.all([
      quoteIds.length ? this.db.select({ v: quoteVersions, presentedByName: users.name }).from(quoteVersions).innerJoin(users, eq(users.id, quoteVersions.presentedBy)).where(inArray(quoteVersions.quoteId, quoteIds)).orderBy(desc(quoteVersions.version)) : [],
      quoteIds.length ? this.db.select({ d: quoteDecisions, decidedByName: users.name }).from(quoteDecisions).leftJoin(users, eq(users.id, quoteDecisions.decidedBy)).where(inArray(quoteDecisions.quoteId, quoteIds)).orderBy(asc(quoteDecisions.createdAt)) : [],
      items.length
        ? this.db.select({ id: appointments.id, treatmentItemId: appointments.treatmentItemId, startsAt: appointments.startsAt, status: appointments.status }).from(appointments).where(inArray(appointments.treatmentItemId, items.map((i) => i.item.id))).orderBy(asc(appointments.startsAt))
        : [],
    ]);
    const totalCents = items.filter((i) => i.item.status !== 'cancelled').reduce((s, i) => s + toCents(i.item.unitPrice) * 1, 0);
    return {
      plan: { ...plan, timezone: unit[0]?.timezone ?? 'America/Sao_Paulo', unitName: unit[0]?.name ?? '' },
      items: items.map((i) => ({ ...i.item, serviceName: i.serviceName, professionalName: i.professionalName, appointments: appts.filter((a) => a.treatmentItemId === i.item.id) })),
      totals: { itemsTotal: fromCents(totalCents) },
      quotes: quoteRows.map((q) => ({
        ...q,
        versions: versions.filter((v) => v.v.quoteId === q.id).map((v) => ({ ...v.v, presentedByName: v.presentedByName })),
        decisions: decisions.filter((d) => d.d.quoteId === q.id).map((d) => ({ ...d.d, decidedByName: d.decidedByName })),
      })),
    };
  }

  async createPlan(auth: AuthContext, tenant: TenantContext, patientId: string, input: z.infer<typeof planSchema>, meta: RequestMeta) {
    await this.assertPatient(this.db, tenant, patientId);
    if (!canAccessUnit(tenant, input.unitId)) throw notFound('Unidade');
    const [row] = await this.db
      .insert(treatmentPlans)
      .values({ organizationId: tenant.organizationId, patientId, unitId: input.unitId, title: input.title, objective: input.objective ?? null, responsibleProfessionalId: input.responsibleProfessionalId ?? null, createdBy: auth.userId })
      .returning({ id: treatmentPlans.id });
    await this.audit.record(this.db, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'treatment.plan_created', entityType: 'treatment_plan', entityId: row!.id, unitId: input.unitId, metadata: { patientId }, meta });
    return { id: row!.id };
  }

  private async lockPlan(tx: Tx, tenant: TenantContext, planId: string) {
    const [p] = await tx.select().from(treatmentPlans).where(and(eq(treatmentPlans.id, planId), eq(treatmentPlans.organizationId, tenant.organizationId))).for('update');
    if (!p || !canAccessUnit(tenant, p.unitId)) throw notFound('Plano de tratamento');
    return p;
  }

  /** Mudar o conteúdo de um plano apresentado o devolve para elaboração: a versão apresentada continua intacta. */
  private async touchContent(tx: Tx, plan: typeof treatmentPlans.$inferSelect) {
    if (['cancelled', 'completed'].includes(plan.status)) throw new AppError('invalid_transition', 'Plano encerrado não pode ser alterado.');
    const status = plan.status === 'presented' || plan.status === 'rejected' ? 'draft' : plan.status;
    await tx.update(treatmentPlans).set({ status, version: plan.version + 1, updatedAt: this.clock.now() }).where(eq(treatmentPlans.id, plan.id));
  }

  async updatePlan(auth: AuthContext, tenant: TenantContext, planId: string, input: z.infer<typeof planUpdateSchema>, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const plan = await this.lockPlan(tx, tenant, planId);
      const { sharedWithPatient, ...content } = input;
      if (Object.keys(content).length) await this.touchContent(tx, plan);
      await tx.update(treatmentPlans).set({ ...content, ...(sharedWithPatient !== undefined ? { sharedWithPatient } : {}), updatedAt: this.clock.now() }).where(eq(treatmentPlans.id, planId));
      await this.audit.record(tx, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'treatment.plan_updated', entityType: 'treatment_plan', entityId: planId, metadata: { fields: Object.keys(input) }, meta });
      return { ok: true };
    });
  }

  async cancelPlan(auth: AuthContext, tenant: TenantContext, planId: string, reason: string, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const plan = await this.lockPlan(tx, tenant, planId);
      if (['completed', 'cancelled'].includes(plan.status)) throw new AppError('invalid_transition', 'Plano já encerrado.');
      await tx.update(treatmentPlans).set({ status: 'cancelled', updatedAt: this.clock.now() }).where(eq(treatmentPlans.id, planId));
      await tx.update(treatmentItems).set({ status: 'cancelled' }).where(and(eq(treatmentItems.planId, planId), inArray(treatmentItems.status, ['planned'])));
      await this.audit.record(tx, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'treatment.plan_cancelled', entityType: 'treatment_plan', entityId: planId, metadata: { reason }, meta });
      return { ok: true };
    });
  }

  async addItem(auth: AuthContext, tenant: TenantContext, planId: string, input: z.infer<typeof itemSchema>, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const plan = await this.lockPlan(tx, tenant, planId);
      await this.validateItemRefs(tx, tenant, planId, input);
      await this.touchContent(tx, plan);
      const [row] = await tx
        .insert(treatmentItems)
        .values({ organizationId: tenant.organizationId, planId, description: input.description, serviceId: input.serviceId ?? null, tooth: input.tooth ?? null, surfaces: input.surfaces, stage: input.stage, priority: input.priority, professionalId: input.professionalId ?? null, dependsOnItemId: input.dependsOnItemId ?? null, sessionsPlanned: input.sessionsPlanned, unitPrice: input.unitPrice })
        .returning({ id: treatmentItems.id });
      if (input.tooth) {
        const [svc] = input.serviceId ? await tx.select({ name: services.name }).from(services).where(eq(services.id, input.serviceId)) : [];
        await tx.insert(odontogramEntries).values({ organizationId: tenant.organizationId, patientId: plan.patientId, tooth: input.tooth, surfaces: input.surfaces, condition: this.conditionFor(svc?.name ?? input.description), status: 'planned', notes: input.description, recordedBy: auth.userId, treatmentItemId: row!.id });
      }
      await this.audit.record(tx, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'treatment.item_added', entityType: 'treatment_plan', entityId: planId, metadata: { itemId: row!.id, unitPrice: input.unitPrice }, meta });
      return { id: row!.id };
    });
  }

  private async validateItemRefs(tx: Tx, tenant: TenantContext, planId: string, input: Partial<z.infer<typeof itemSchema>>, selfId?: string) {
    if (input.serviceId) {
      const [s] = await tx.select({ id: services.id }).from(services).where(and(eq(services.id, input.serviceId), eq(services.organizationId, tenant.organizationId)));
      if (!s) throw notFound('Serviço');
    }
    if (input.professionalId) {
      const [p] = await tx.select({ id: professionals.id }).from(professionals).where(and(eq(professionals.id, input.professionalId), eq(professionals.organizationId, tenant.organizationId)));
      if (!p) throw notFound('Profissional');
    }
    if (input.dependsOnItemId) {
      if (input.dependsOnItemId === selfId) throw new AppError('validation_failed', 'Uma etapa não pode depender de si mesma.');
      const [d] = await tx.select({ id: treatmentItems.id }).from(treatmentItems).where(and(eq(treatmentItems.id, input.dependsOnItemId), eq(treatmentItems.planId, planId)));
      if (!d) throw new AppError('validation_failed', 'A dependência precisa ser uma etapa do mesmo plano.');
    }
  }

  async updateItem(auth: AuthContext, tenant: TenantContext, itemId: string, input: Partial<z.infer<typeof itemSchema>>, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const [item] = await tx.select().from(treatmentItems).where(and(eq(treatmentItems.id, itemId), eq(treatmentItems.organizationId, tenant.organizationId))).for('update');
      if (!item) throw notFound('Etapa');
      if (item.status === 'done') throw new AppError('invalid_transition', 'Etapa realizada não pode ser alterada.');
      const plan = await this.lockPlan(tx, tenant, item.planId);
      await this.validateItemRefs(tx, tenant, item.planId, input, itemId);
      await this.touchContent(tx, plan);
      await tx.update(treatmentItems).set(input).where(eq(treatmentItems.id, itemId));
      await this.audit.record(tx, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'treatment.item_updated', entityType: 'treatment_plan', entityId: item.planId, metadata: { itemId, fields: Object.keys(input) }, meta });
      return { ok: true };
    });
  }

  async removeItem(auth: AuthContext, tenant: TenantContext, itemId: string, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const [item] = await tx.select().from(treatmentItems).where(and(eq(treatmentItems.id, itemId), eq(treatmentItems.organizationId, tenant.organizationId))).for('update');
      if (!item) throw notFound('Etapa');
      if (item.status !== 'planned') throw new AppError('invalid_transition', 'Só etapas ainda não agendadas podem ser removidas.');
      const plan = await this.lockPlan(tx, tenant, item.planId);
      await this.touchContent(tx, plan);
      // Etapa com orçamento já apresentado é cancelada (mantém o histórico); sem orçamento, removida.
      const presented = await tx.select({ id: quotes.id }).from(quotes).where(eq(quotes.planId, item.planId)).limit(1);
      if (presented.length) await tx.update(treatmentItems).set({ status: 'cancelled' }).where(eq(treatmentItems.id, itemId));
      else {
        await tx.update(odontogramEntries).set({ supersededAt: this.clock.now(), supersededBy: auth.userId }).where(and(eq(odontogramEntries.treatmentItemId, itemId), isNull(odontogramEntries.supersededAt)));
        await tx.update(treatmentItems).set({ dependsOnItemId: null }).where(eq(treatmentItems.dependsOnItemId, itemId));
        await tx.delete(treatmentItems).where(eq(treatmentItems.id, itemId));
      }
      await this.audit.record(tx, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'treatment.item_removed', entityType: 'treatment_plan', entityId: item.planId, metadata: { itemId }, meta });
      return { ok: true };
    });
  }

  // -------------------------------------------------------------- Orçamento

  /** Congela o plano numa versão imutável de orçamento e a apresenta. */
  async present(auth: AuthContext, tenant: TenantContext, planId: string, input: z.infer<typeof presentSchema>, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const plan = await this.lockPlan(tx, tenant, planId);
      if (!['draft', 'presented', 'rejected'].includes(plan.status)) throw new AppError('invalid_transition', 'Este plano não está em fase de orçamento.');
      const items = await tx
        .select({ item: treatmentItems, serviceName: services.name })
        .from(treatmentItems)
        .leftJoin(services, eq(services.id, treatmentItems.serviceId))
        .where(and(eq(treatmentItems.planId, planId), ne(treatmentItems.status, 'cancelled')))
        .orderBy(asc(treatmentItems.stage), asc(treatmentItems.sortOrder));
      if (!items.length) throw new AppError('validation_failed', 'Inclua ao menos uma etapa antes de apresentar.');
      const subtotal = items.reduce((s, i) => s + toCents(i.item.unitPrice), 0);
      const discount = toCents(input.discount);
      if (discount > subtotal) throw new AppError('validation_failed', 'O desconto é maior que o total.');
      if (discount > percentOf(subtotal, 10) && !tenant.permissions.has('quotes.discount')) {
        throw forbidden('Descontos acima de 10% precisam de autorização de gestor.');
      }
      if (discount > 0 && !input.discountReason) throw new AppError('validation_failed', 'Informe o motivo do desconto.', [{ path: 'discountReason', message: 'Obrigatório com desconto.' }]);
      if (input.validUntil < zonedParts(this.clock.now(), 'America/Sao_Paulo').date) throw new AppError('validation_failed', 'A validade não pode estar no passado.');

      let [quote] = await tx.select().from(quotes).where(and(eq(quotes.planId, planId), eq(quotes.status, 'presented'))).for('update');
      if (!quote) {
        [quote] = await tx.insert(quotes).values({ organizationId: tenant.organizationId, planId, patientId: plan.patientId }).returning();
      }
      const [{ v } = { v: 0 }] = await tx.select({ v: sql<number>`coalesce(max(${quoteVersions.version}), 0)` }).from(quoteVersions).where(eq(quoteVersions.quoteId, quote!.id));
      const [version] = await tx
        .insert(quoteVersions)
        .values({
          organizationId: tenant.organizationId,
          quoteId: quote!.id,
          version: Number(v) + 1,
          items: items.map((i) => ({ itemId: i.item.id, description: i.item.description, serviceName: i.serviceName, tooth: i.item.tooth, surfaces: i.item.surfaces, stage: i.item.stage, sessions: i.item.sessionsPlanned, price: i.item.unitPrice })),
          subtotal: fromCents(subtotal),
          discount: fromCents(discount),
          discountReason: input.discountReason ?? null,
          total: fromCents(subtotal - discount),
          paymentTerms: { installments: input.installments, method: input.method, firstDueDate: input.firstDueDate },
          validUntil: input.validUntil,
          presentedBy: auth.userId,
        })
        .returning();
      await tx.update(quotes).set({ currentVersionId: version!.id, status: 'presented', updatedAt: this.clock.now() }).where(eq(quotes.id, quote!.id));
      await tx.update(treatmentPlans).set({ status: 'presented', updatedAt: this.clock.now() }).where(eq(treatmentPlans.id, planId));
      await this.audit.record(tx, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'quote.presented', entityType: 'treatment_plan', entityId: planId, metadata: { quoteId: quote!.id, version: version!.version, total: version!.total, discount: version!.discount }, meta });
      return { quoteId: quote!.id, versionId: version!.id, version: version!.version, total: version!.total };
    });
  }

  /**
   * Aprovação ou recusa. Precisa apontar a versão vigente apresentada.
   * Aprovar NÃO registra consentimento clínico nem procedimento executado.
   */
  async decide(actor: { userId: string | null; via: 'clinic' | 'portal' }, organizationId: string, quoteId: string, input: z.infer<typeof decisionSchema>, meta: RequestMeta, tenant?: TenantContext) {
    return this.db.transaction(async (tx) => {
      const [quote] = await tx.select().from(quotes).where(and(eq(quotes.id, quoteId), eq(quotes.organizationId, organizationId))).for('update');
      if (!quote) throw notFound('Orçamento');
      if (tenant) {
        const [plan] = await tx.select({ unitId: treatmentPlans.unitId }).from(treatmentPlans).where(eq(treatmentPlans.id, quote.planId));
        if (!plan || !canAccessUnit(tenant, plan.unitId)) throw notFound('Orçamento');
      }
      if (quote.status !== 'presented') throw new AppError('invalid_transition', 'Este orçamento não está aguardando decisão.');
      if (quote.currentVersionId !== input.versionId) {
        throw new AppError('stale_version', 'Esta não é a versão vigente do orçamento. A decisão deve se referir à versão apresentada mais recente.', { currentVersionId: quote.currentVersionId });
      }
      const [version] = await tx.select().from(quoteVersions).where(eq(quoteVersions.id, input.versionId));
      const today = zonedParts(this.clock.now(), 'America/Sao_Paulo').date;
      if (input.decision === 'approved' && version!.validUntil < today) throw new AppError('invalid_transition', 'O orçamento está vencido. Apresente uma nova versão.');
      if (input.decision === 'rejected' && !input.reason) throw new AppError('validation_failed', 'Informe o motivo da recusa.', [{ path: 'reason', message: 'Obrigatório.' }]);

      await tx.insert(quoteDecisions).values({ organizationId, quoteId, versionId: input.versionId, decision: input.decision, reason: input.reason ?? null, via: actor.via, decidedBy: actor.userId, acknowledgedName: input.acknowledgedName ?? null, createdAt: this.clock.now() });
      await tx.update(quotes).set({ status: input.decision, lastContactAt: this.clock.now(), updatedAt: this.clock.now() }).where(eq(quotes.id, quoteId));
      await tx.update(treatmentPlans).set({ status: input.decision, updatedAt: this.clock.now() }).where(eq(treatmentPlans.id, quote.planId));
      await this.audit.record(tx, { organizationId, actorUserId: actor.userId, action: input.decision === 'approved' ? 'quote.approved' : 'quote.rejected', entityType: 'treatment_plan', entityId: quote.planId, metadata: { quoteId, versionId: input.versionId, via: actor.via, total: version!.total, reason: input.reason ?? null }, meta });

      if (input.decision === 'approved') {
        if (input.generateReceivables) await this.events.emit(tx, 'quote.approved', { organizationId, quoteId, actorUserId: actor.userId });
        if (input.createSchedulingTasks) {
          const firstItems = await tx.select().from(treatmentItems).where(and(eq(treatmentItems.planId, quote.planId), eq(treatmentItems.status, 'planned'), isNull(treatmentItems.dependsOnItemId)));
          const minStage = Math.min(...firstItems.map((i) => i.stage));
          const [p] = await tx.select({ name: patients.fullName, unitId: treatmentPlans.unitId }).from(treatmentPlans).innerJoin(patients, eq(patients.id, treatmentPlans.patientId)).where(eq(treatmentPlans.id, quote.planId));
          for (const item of firstItems.filter((i) => i.stage === minStage)) {
            await tx
              .insert(tasks)
              .values({ organizationId, unitId: p!.unitId, title: `Agendar: ${item.description} — ${p!.name}`, assigneeRoleKey: 'reception', origin: 'system', relatedType: 'treatment_plan', relatedId: quote.planId, dedupeKey: `schedule-item:${item.id}`, dueAt: this.clock.now() })
              .onConflictDoNothing();
          }
        }
      }
      return { status: input.decision };
    });
  }

  async markContact(auth: AuthContext, tenant: TenantContext, quoteId: string, meta: RequestMeta) {
    const r = await this.db.update(quotes).set({ lastContactAt: this.clock.now() }).where(and(eq(quotes.id, quoteId), eq(quotes.organizationId, tenant.organizationId))).returning({ planId: quotes.planId });
    if (!r.length) throw notFound('Orçamento');
    await this.audit.record(this.db, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'quote.contacted', entityType: 'treatment_plan', entityId: r[0]!.planId, meta });
    return { ok: true };
  }

  /** Orçamentos vencidos passam a "expirado" (tarefa diária). */
  async expireQuotes() {
    const today = zonedParts(this.clock.now(), 'America/Sao_Paulo').date;
    const expired = await this.db.execute<{ id: string }>(sql`
      update quotes q set status = 'expired', updated_at = now()
      from quote_versions v where v.id = q.current_version_id and q.status = 'presented' and v.valid_until < ${today}
      returning q.id`);
    return expired.rows.length;
  }

  // ------------------------------------------------ Continuidade do cuidado

  /**
   * Mapa de continuidade: cada plano em sua etapa e as pendências derivadas
   * de registros explícitos (nunca de inferência clínica).
   */
  async continuity(tenant: TenantContext) {
    const plans = await this.planSummary(tenant.organizationId)
      .where(and(eq(treatmentPlans.organizationId, tenant.organizationId), inArray(treatmentPlans.status, ['draft', 'presented', 'approved', 'in_progress', 'completed'])))
      .orderBy(desc(treatmentPlans.updatedAt))
      .limit(500);
    const visible = plans.filter((p) => canAccessUnit(tenant, p.unitId));
    const ids = visible.map((p) => p.id);
    if (!ids.length) return { plans: [], counts: {} };
    const now = this.clock.now();
    const [items, futureAppts, quoteRows] = await Promise.all([
      this.db.select({ id: treatmentItems.id, planId: treatmentItems.planId, status: treatmentItems.status }).from(treatmentItems).where(inArray(treatmentItems.planId, ids)),
      this.db
        .select({ planId: treatmentItems.planId, startsAt: appointments.startsAt })
        .from(appointments)
        .innerJoin(treatmentItems, eq(treatmentItems.id, appointments.treatmentItemId))
        // Só conta como "próxima sessão" consulta de etapa ainda não realizada.
        .where(and(inArray(treatmentItems.planId, ids), inArray(treatmentItems.status, ['planned', 'scheduled']), inArray(appointments.status, [...BLOCKING_STATUSES]), gt(appointments.startsAt, now))),
      this.db.select({ planId: quotes.planId, status: quotes.status, updatedAt: quotes.updatedAt, lastContactAt: quotes.lastContactAt }).from(quotes).where(inArray(quotes.planId, ids)),
    ]);
    const DAY = 86_400_000;
    const result = visible.map((p) => {
      const its = items.filter((i) => i.planId === p.id);
      const done = its.filter((i) => i.status === 'done').length;
      const active = its.filter((i) => i.status !== 'cancelled').length;
      const nextAppt = futureAppts.filter((a) => a.planId === p.id).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0];
      const quote = quoteRows.find((q) => q.planId === p.id && q.status === 'presented');
      const pending: { code: string; label: string }[] = [];
      let stage: (typeof CONTINUITY_STAGES)[number] = 'evaluation';
      if (p.status === 'presented') stage = 'presented';
      if (p.status === 'approved') stage = nextAppt ? 'scheduled' : 'approved';
      if (p.status === 'in_progress') stage = 'in_progress';
      if (p.status === 'completed') stage = 'completed';
      if (p.status === 'approved' && !nextAppt && done === 0) pending.push({ code: 'approved_without_session', label: 'Plano aprovado sem primeira sessão agendada' });
      if (p.status === 'in_progress' && !nextAppt && done < active) pending.push({ code: 'no_next_session', label: 'Tratamento em andamento sem próxima sessão agendada' });
      if (quote) {
        const last = (quote.lastContactAt ?? quote.updatedAt).getTime();
        const days = Math.floor((now.getTime() - last) / DAY);
        if (days >= 7) pending.push({ code: 'quote_no_contact', label: `Orçamento sem retorno há ${days} dias` });
      }
      return { ...p, stage, progress: { done, total: active }, nextSessionAt: nextAppt?.startsAt ?? null, pending };
    });
    const counts: Record<string, number> = {};
    for (const r of result) for (const x of r.pending) counts[x.code] = (counts[x.code] ?? 0) + 1;
    return { plans: result, counts };
  }
}
