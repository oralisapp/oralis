import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { fromCents, percentOf, splitInstallments, toCents, zonedParts } from '@oralis/shared';
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, forbidden, notFound } from '../../common/app-error';
import { Clock } from '../../common/clock';
import { type AuthContext, type RequestMeta, type TenantContext, canAccessUnit } from '../../common/request-context';
import { DB, type Db, type DbOrTx, type Tx } from '../../db/db';
import {
  bankStatementLines,
  cashAccounts,
  clinicUnits,
  commissionRules,
  financialCategories,
  patients,
  payables,
  paymentAllocations,
  payments,
  professionals,
  quoteDecisions,
  quoteVersions,
  quotes,
  receivables,
  refunds,
  services,
  treatmentItems,
  treatmentPlans,
  users,
} from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { DomainEvents } from '../platform/domain-events';

const money = z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, { error: 'Valor inválido.' }).refine((v) => toCents(v) > 0, { error: 'O valor deve ser maior que zero.' });
const isoDate = z.iso.date({ error: 'Data inválida.' });

export const receivableSchema = z.object({
  unitId: z.uuid(),
  patientId: z.uuid().optional(),
  professionalId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  description: z.string().trim().min(2).max(200),
  amount: money,
  firstDueDate: isoDate,
  installments: z.number().int().min(1).max(36).default(1),
});
export const paymentSchema = z.object({
  cashAccountId: z.uuid(),
  patientId: z.uuid().optional(),
  amount: money,
  method: z.enum(['cash', 'pix', 'card_credit', 'card_debit', 'transfer', 'boleto', 'other']),
  receivedAt: z.iso.datetime({ offset: true }),
  reference: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(300).optional(),
  allocations: z.array(z.object({ receivableId: z.uuid(), amount: money })).max(50).default([]),
  /** Chave enviada pelo cliente para não registrar o mesmo recebimento duas vezes (duplo clique, reenvio). */
  idempotencyKey: z.string().min(8).max(80).optional(),
});
export const refundRequestSchema = z.object({ amount: money, reason: z.string().trim().min(5).max(300), receivableId: z.uuid().optional() });
export const refundDecisionSchema = z.object({ approve: z.boolean(), note: z.string().trim().max(300).optional() });
export const payableSchema = z.object({
  unitId: z.uuid(),
  categoryId: z.uuid().optional(),
  supplierName: z.string().trim().max(160).optional(),
  description: z.string().trim().min(2).max(200),
  amount: money,
  dueDate: isoDate,
  /** Despesa recorrente: repete mensalmente. */
  repeatMonths: z.number().int().min(1).max(36).default(1),
});
export const payPayableSchema = z.object({ cashAccountId: z.uuid(), paidAt: z.iso.datetime({ offset: true }), paidAmount: money.optional() });
export const cashAccountSchema = z.object({ unitId: z.uuid(), name: z.string().trim().min(2).max(80), kind: z.enum(['cash', 'bank', 'card_acquirer']) });
export const categorySchema = z.object({ name: z.string().trim().min(2).max(80), kind: z.enum(['income', 'expense']) });
export const commissionSchema = z.object({ professionalId: z.uuid(), percent: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/).refine((v) => Number(v) <= 100) });
export const periodSchema = z.object({ from: isoDate, to: isoDate, unitId: z.uuid().optional() });

const DEFAULT_CATEGORIES = [
  { kind: 'income', name: 'Tratamentos' },
  { kind: 'income', name: 'Consultas e avaliações' },
  { kind: 'income', name: 'Outras receitas' },
  { kind: 'expense', name: 'Aluguel e condomínio' },
  { kind: 'expense', name: 'Materiais odontológicos' },
  { kind: 'expense', name: 'Laboratório de prótese' },
  { kind: 'expense', name: 'Folha e pró-labore' },
  { kind: 'expense', name: 'Impostos e taxas' },
  { kind: 'expense', name: 'Outras despesas' },
] as const;

const TZ = 'America/Sao_Paulo';

@Injectable()
export class FinanceService implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly events: DomainEvents,
  ) {}

  onModuleInit() {
    // Orçamento aprovado com "gerar parcelas": cria as contas a receber da versão aprovada.
    this.events.on('quote.approved', async (tx, e) => this.receivablesFromQuote(tx, e.organizationId, e.quoteId, e.actorUserId));
  }

  private today() {
    return zonedParts(this.clock.now(), TZ).date;
  }

  async ensureDefaults(db: DbOrTx, organizationId: string) {
    const cats = await db.select({ id: financialCategories.id }).from(financialCategories).where(eq(financialCategories.organizationId, organizationId)).limit(1);
    if (!cats.length) await db.insert(financialCategories).values(DEFAULT_CATEGORIES.map((c) => ({ organizationId, ...c }))).onConflictDoNothing();
    const units = await db.select({ id: clinicUnits.id, name: clinicUnits.name }).from(clinicUnits).where(eq(clinicUnits.organizationId, organizationId));
    const accounts = await db.select({ unitId: cashAccounts.unitId }).from(cashAccounts).where(eq(cashAccounts.organizationId, organizationId));
    const missing = units.filter((u) => !accounts.some((a) => a.unitId === u.id));
    if (missing.length) await db.insert(cashAccounts).values(missing.map((u) => ({ organizationId, unitId: u.id, name: `Caixa — ${u.name}`, kind: 'cash' })));
  }

  private async receivablesFromQuote(tx: Tx, organizationId: string, quoteId: string, actorUserId: string | null) {
    const [row] = await tx
      .select({ quote: quotes, version: quoteVersions, plan: treatmentPlans })
      .from(quotes)
      .innerJoin(quoteVersions, eq(quoteVersions.id, quotes.currentVersionId))
      .innerJoin(treatmentPlans, eq(treatmentPlans.id, quotes.planId))
      .where(and(eq(quotes.id, quoteId), eq(quotes.organizationId, organizationId)));
    if (!row) return;
    await this.ensureDefaults(tx, organizationId);
    const [cat] = await tx.select({ id: financialCategories.id }).from(financialCategories).where(and(eq(financialCategories.organizationId, organizationId), eq(financialCategories.kind, 'income'), eq(financialCategories.name, 'Tratamentos')));
    const terms = row.version.paymentTerms as { installments: number; firstDueDate: string };
    const parts = splitInstallments(toCents(row.version.total), terms.installments);
    const groupId = randomUUID();
    const [y, m, d] = terms.firstDueDate.split('-').map(Number) as [number, number, number];
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === 0) continue;
      const due = new Date(Date.UTC(y, m - 1 + i, Math.min(d, 28))).toISOString().slice(0, 10);
      // A unique (quote_version_id, installment_no) torna a geração idempotente.
      await tx
        .insert(receivables)
        .values({
          organizationId,
          unitId: row.plan.unitId,
          patientId: row.plan.patientId,
          professionalId: row.plan.responsibleProfessionalId,
          planId: row.plan.id,
          quoteVersionId: row.version.id,
          categoryId: cat?.id ?? null,
          description: `${row.plan.title} — parcela ${i + 1}/${parts.length}`,
          amount: fromCents(parts[i]!),
          dueDate: d > 28 && i === 0 ? terms.firstDueDate : due,
          groupId,
          installmentNo: i + 1,
          installmentsTotal: parts.length,
          createdBy: actorUserId,
        })
        .onConflictDoNothing();
    }
    await this.audit.record(tx, { organizationId, actorUserId, action: 'finance.receivables_generated', entityType: 'treatment_plan', entityId: row.plan.id, metadata: { quoteVersionId: row.version.id, installments: parts.length, total: row.version.total } });
  }

  // ------------------------------------------------------- Cadastros básicos

  async categories(tenant: TenantContext) {
    await this.ensureDefaults(this.db, tenant.organizationId);
    return this.db.select().from(financialCategories).where(eq(financialCategories.organizationId, tenant.organizationId)).orderBy(asc(financialCategories.kind), asc(financialCategories.name));
  }

  async createCategory(tenant: TenantContext, input: z.infer<typeof categorySchema>) {
    const [r] = await this.db.insert(financialCategories).values({ organizationId: tenant.organizationId, ...input }).returning({ id: financialCategories.id });
    return { id: r!.id };
  }

  /** Contas de caixa visíveis, com saldo: recebimentos − estornos − despesas pagas. */
  async accounts(tenant: TenantContext) {
    await this.ensureDefaults(this.db, tenant.organizationId);
    const rows = await this.db
      .select({
        id: cashAccounts.id,
        unitId: cashAccounts.unitId,
        unitName: clinicUnits.name,
        name: cashAccounts.name,
        kind: cashAccounts.kind,
        active: cashAccounts.active,
        received: sql<string>`(select coalesce(sum(p.amount), 0) from payments p where p.cash_account_id = ${cashAccounts.id})`,
        refunded: sql<string>`(select coalesce(sum(r.amount), 0) from refunds r join payments p on p.id = r.payment_id where p.cash_account_id = ${cashAccounts.id} and r.status = 'approved')`,
        paidOut: sql<string>`(select coalesce(sum(coalesce(x.paid_amount, x.amount)), 0) from payables x where x.cash_account_id = ${cashAccounts.id} and x.status = 'paid')`,
      })
      .from(cashAccounts)
      .innerJoin(clinicUnits, eq(clinicUnits.id, cashAccounts.unitId))
      .where(eq(cashAccounts.organizationId, tenant.organizationId))
      .orderBy(asc(clinicUnits.name), asc(cashAccounts.name));
    return rows
      .filter((r) => canAccessUnit(tenant, r.unitId))
      .map((r) => ({ ...r, balance: fromCents(toCents(String(r.received)) - toCents(String(r.refunded)) - toCents(String(r.paidOut))) }));
  }

  async createAccount(auth: AuthContext, tenant: TenantContext, input: z.infer<typeof cashAccountSchema>, meta: RequestMeta) {
    if (!canAccessUnit(tenant, input.unitId)) throw notFound('Unidade');
    const [r] = await this.db.insert(cashAccounts).values({ organizationId: tenant.organizationId, ...input }).returning({ id: cashAccounts.id });
    await this.audit.record(this.db, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'finance.account_created', entityType: 'cash_account', entityId: r!.id, unitId: input.unitId, meta });
    return { id: r!.id };
  }

  async setCommission(auth: AuthContext, tenant: TenantContext, input: z.infer<typeof commissionSchema>, meta: RequestMeta) {
    await this.db.transaction(async (tx) => {
      await tx.update(commissionRules).set({ active: false }).where(and(eq(commissionRules.organizationId, tenant.organizationId), eq(commissionRules.professionalId, input.professionalId), eq(commissionRules.active, true)));
      await tx.insert(commissionRules).values({ organizationId: tenant.organizationId, professionalId: input.professionalId, percent: input.percent, createdBy: auth.userId });
      await this.audit.record(tx, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'finance.commission_set', entityType: 'professional', entityId: input.professionalId, metadata: { percent: input.percent }, meta });
    });
    return { ok: true };
  }

  async commissionRulesList(tenant: TenantContext) {
    return this.db
      .select({ id: commissionRules.id, professionalId: commissionRules.professionalId, professionalName: professionals.displayName, percent: commissionRules.percent, createdAt: commissionRules.createdAt })
      .from(commissionRules)
      .innerJoin(professionals, eq(professionals.id, commissionRules.professionalId))
      .where(and(eq(commissionRules.organizationId, tenant.organizationId), eq(commissionRules.active, true)));
  }

  // --------------------------------------------------------- Contas a receber

  private receivableQuery(organizationId: string) {
    return this.db
      .select({
        id: receivables.id,
        unitId: receivables.unitId,
        patientId: receivables.patientId,
        patientName: patients.fullName,
        professionalId: receivables.professionalId,
        planId: receivables.planId,
        description: receivables.description,
        amount: receivables.amount,
        dueDate: receivables.dueDate,
        installmentNo: receivables.installmentNo,
        installmentsTotal: receivables.installmentsTotal,
        status: receivables.status,
        collectionHold: receivables.collectionHold,
        collectionHoldReason: receivables.collectionHoldReason,
        cancelReason: receivables.cancelReason,
        createdAt: receivables.createdAt,
        paid: sql<string>`(select coalesce(sum(a.amount), 0) from payment_allocations a where a.receivable_id = ${receivables.id})`,
      })
      .from(receivables)
      .leftJoin(patients, eq(patients.id, receivables.patientId))
      .where(eq(receivables.organizationId, organizationId))
      .$dynamic();
  }

  private shapeReceivable<T extends { amount: string; paid: string; status: string; dueDate: string }>(r: T, today: string) {
    const balanceCents = toCents(r.amount) - toCents(String(r.paid));
    const view =
      r.status === 'cancelled' ? 'cancelled' : balanceCents <= 0 ? 'paid' : r.dueDate < today ? (toCents(String(r.paid)) > 0 ? 'partial_overdue' : 'overdue') : toCents(String(r.paid)) > 0 ? 'partial' : 'open';
    return { ...r, paid: fromCents(toCents(String(r.paid))), balance: fromCents(Math.max(0, balanceCents)), view };
  }

  async listReceivables(tenant: TenantContext, q: { status?: string; patientId?: string; from?: string; to?: string }) {
    const filters: SQL[] = [eq(receivables.organizationId, tenant.organizationId)];
    if (q.patientId) filters.push(eq(receivables.patientId, q.patientId));
    if (q.from) filters.push(gte(receivables.dueDate, q.from));
    if (q.to) filters.push(lte(receivables.dueDate, q.to));
    if (q.status === 'open' || q.status === 'overdue') filters.push(eq(receivables.status, 'open'));
    if (q.status === 'overdue') filters.push(lt(receivables.dueDate, this.today()));
    if (q.status === 'paid') filters.push(eq(receivables.status, 'paid'));
    if (q.status === 'cancelled') filters.push(eq(receivables.status, 'cancelled'));
    const rows = await this.receivableQuery(tenant.organizationId).where(and(...filters)).orderBy(asc(receivables.dueDate)).limit(500);
    const today = this.today();
    return rows.filter((r) => canAccessUnit(tenant, r.unitId)).map((r) => this.shapeReceivable(r, today));
  }

  async createReceivable(auth: AuthContext, tenant: TenantContext, input: z.infer<typeof receivableSchema>, meta: RequestMeta) {
    if (!canAccessUnit(tenant, input.unitId)) throw notFound('Unidade');
    return this.db.transaction(async (tx) => {
      if (input.patientId) {
        const [p] = await tx.select({ id: patients.id }).from(patients).where(and(eq(patients.id, input.patientId), eq(patients.organizationId, tenant.organizationId)));
        if (!p) throw notFound('Paciente');
      }
      const parts = splitInstallments(toCents(input.amount), input.installments);
      const groupId = randomUUID();
      const [y, m, d] = input.firstDueDate.split('-').map(Number) as [number, number, number];
      const ids: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        const due = i === 0 ? input.firstDueDate : new Date(Date.UTC(y, m - 1 + i, Math.min(d, 28))).toISOString().slice(0, 10);
        const [r] = await tx
          .insert(receivables)
          .values({ organizationId: tenant.organizationId, unitId: input.unitId, patientId: input.patientId ?? null, professionalId: input.professionalId ?? null, categoryId: input.categoryId ?? null, description: parts.length > 1 ? `${input.description} — parcela ${i + 1}/${parts.length}` : input.description, amount: fromCents(parts[i]!), dueDate: due, groupId, installmentNo: i + 1, installmentsTotal: parts.length, createdBy: auth.userId })
          .returning({ id: receivables.id });
        ids.push(r!.id);
      }
      await this.audit.record(tx, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'finance.receivable_created', entityType: 'receivable', entityId: ids[0], unitId: input.unitId, metadata: { amount: input.amount, installments: parts.length, patientId: input.patientId ?? null }, meta });
      return { ids, groupId };
    });
  }

  async cancelReceivable(auth: AuthContext, tenant: TenantContext, id: string, reason: string, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const [r] = await tx.select().from(receivables).where(and(eq(receivables.id, id), eq(receivables.organizationId, tenant.organizationId))).for('update');
      if (!r || !canAccessUnit(tenant, r.unitId)) throw notFound('Conta a receber');
      if (r.status === 'cancelled') throw new AppError('conflict', 'Já cancelada.');
      const [{ paid }] = (await tx.select({ paid: sql<string>`coalesce(sum(${paymentAllocations.amount}), 0)` }).from(paymentAllocations).where(eq(paymentAllocations.receivableId, id))) as [{ paid: string }];
      if (toCents(String(paid)) > 0) throw new AppError('invalid_transition', 'Há valores recebidos nesta parcela. Estorne o recebimento antes de cancelar.');
      await tx.update(receivables).set({ status: 'cancelled', cancelledAt: this.clock.now(), cancelledBy: auth.userId, cancelReason: reason }).where(eq(receivables.id, id));
      await this.audit.record(tx, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'finance.receivable_cancelled', entityType: 'receivable', entityId: id, unitId: r.unitId, metadata: { amount: r.amount, reason }, meta });
      return { ok: true };
    });
  }

  async setHold(auth: AuthContext, tenant: TenantContext, id: string, hold: boolean, reason: string | undefined, meta: RequestMeta) {
    const r = await this.db.update(receivables).set({ collectionHold: hold, collectionHoldReason: hold ? (reason ?? null) : null }).where(and(eq(receivables.id, id), eq(receivables.organizationId, tenant.organizationId))).returning({ id: receivables.id });
    if (!r.length) throw notFound('Conta a receber');
    await this.audit.record(this.db, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'finance.collection_hold', entityType: 'receivable', entityId: id, metadata: { hold, reason: reason ?? null }, meta });
    return { ok: true };
  }

  // ------------------------------------------------------------ Recebimentos

  /**
   * Registra um recebimento e o aloca às parcelas. O banco impede alocar
   * além do valor da parcela ou do pagamento. A chave de idempotência evita
   * duplicar o mesmo recebimento.
   */
  async registerPayment(auth: AuthContext, tenant: TenantContext, input: z.infer<typeof paymentSchema>, meta: RequestMeta) {
    const allocated = input.allocations.reduce((s, a) => s + toCents(a.amount), 0);
    if (allocated > toCents(input.amount)) throw new AppError('validation_failed', 'A soma das parcelas quitadas é maior que o valor recebido.');
    if (input.allocations.length && allocated !== toCents(input.amount)) {
      throw new AppError('validation_failed', 'Distribua todo o valor recebido entre as parcelas (ou registre sem vincular parcelas).');
    }
    return this.db.transaction(async (tx) => {
      const [acc] = await tx.select().from(cashAccounts).where(and(eq(cashAccounts.id, input.cashAccountId), eq(cashAccounts.organizationId, tenant.organizationId)));
      if (!acc || !canAccessUnit(tenant, acc.unitId)) throw notFound('Conta de caixa');
      if (input.idempotencyKey) {
        const [dup] = await tx.select({ id: payments.id }).from(payments).where(and(eq(payments.organizationId, tenant.organizationId), eq(payments.reference, `idem:${input.idempotencyKey}`)));
        if (dup) return { id: dup.id, duplicate: true };
      }
      const recIds = input.allocations.map((a) => a.receivableId);
      const recs = recIds.length ? await tx.select().from(receivables).where(and(eq(receivables.organizationId, tenant.organizationId), inArray(receivables.id, recIds))).for('update') : [];
      if (recs.length !== new Set(recIds).size) throw notFound('Parcela');
      if (recs.some((r) => r.status === 'cancelled')) throw new AppError('invalid_transition', 'Parcela cancelada não recebe pagamento.');
      const patientIds = new Set(recs.map((r) => r.patientId).filter(Boolean));
      if (patientIds.size > 1) throw new AppError('validation_failed', 'Um recebimento só pode quitar parcelas de um mesmo paciente.');

      const [p] = await tx
        .insert(payments)
        .values({
          organizationId: tenant.organizationId,
          unitId: acc.unitId,
          cashAccountId: acc.id,
          patientId: input.patientId ?? recs[0]?.patientId ?? null,
          amount: input.amount,
          method: input.method,
          receivedAt: new Date(input.receivedAt),
          reference: input.idempotencyKey ? `idem:${input.idempotencyKey}` : (input.reference ?? null),
          notes: [input.reference, input.notes].filter(Boolean).join(' · ') || null,
          createdBy: auth.userId,
        })
        .returning({ id: payments.id });
      for (const a of input.allocations) {
        try {
          await tx.insert(paymentAllocations).values({ organizationId: tenant.organizationId, paymentId: p!.id, receivableId: a.receivableId, amount: a.amount, createdAt: this.clock.now() });
        } catch (err) {
          throw new AppError('validation_failed', 'O valor alocado é maior que o saldo da parcela.', { receivableId: a.receivableId, cause: (err as Error).message });
        }
      }
      await this.refreshReceivableStatus(tx, recIds);
      await this.audit.record(tx, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'finance.payment_registered', entityType: 'payment', entityId: p!.id, unitId: acc.unitId, metadata: { amount: input.amount, method: input.method, allocations: input.allocations }, meta });
      return { id: p!.id, duplicate: false };
    });
  }

  private async refreshReceivableStatus(tx: Tx, ids: string[]) {
    if (!ids.length) return;
    await tx.execute(sql`
      update receivables r set status = case
        when (select coalesce(sum(a.amount), 0) from payment_allocations a where a.receivable_id = r.id) >= r.amount then 'paid' else 'open' end
      where r.id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) and r.status <> 'cancelled'`);
  }

  async listPayments(tenant: TenantContext, q: { from?: string; to?: string; patientId?: string }) {
    const filters: SQL[] = [eq(payments.organizationId, tenant.organizationId)];
    if (q.from) filters.push(gte(payments.receivedAt, new Date(`${q.from}T00:00:00-03:00`)));
    if (q.to) filters.push(lt(payments.receivedAt, new Date(new Date(`${q.to}T00:00:00-03:00`).getTime() + 86_400_000)));
    if (q.patientId) filters.push(eq(payments.patientId, q.patientId));
    const rows = await this.db
      .select({
        id: payments.id,
        unitId: payments.unitId,
        cashAccountId: payments.cashAccountId,
        patientId: payments.patientId,
        patientName: patients.fullName,
        amount: payments.amount,
        method: payments.method,
        receivedAt: payments.receivedAt,
        notes: payments.notes,
        reconciledAt: payments.reconciledAt,
        createdByName: users.name,
        refunded: sql<string>`(select coalesce(sum(r.amount), 0) from refunds r where r.payment_id = ${payments.id} and r.status = 'approved')`,
        refundPending: sql<string>`(select coalesce(sum(r.amount), 0) from refunds r where r.payment_id = ${payments.id} and r.status = 'requested')`,
      })
      .from(payments)
      .leftJoin(patients, eq(patients.id, payments.patientId))
      .innerJoin(users, eq(users.id, payments.createdBy))
      .where(and(...filters))
      .orderBy(desc(payments.receivedAt))
      .limit(500);
    return rows.filter((r) => canAccessUnit(tenant, r.unitId));
  }

  /** Comprovante simples do recebimento (não é documento fiscal). */
  async receipt(tenant: TenantContext, paymentId: string) {
    const [p] = await this.db
      .select({ payment: payments, patientName: patients.fullName, unitName: clinicUnits.name })
      .from(payments)
      .leftJoin(patients, eq(patients.id, payments.patientId))
      .innerJoin(clinicUnits, eq(clinicUnits.id, payments.unitId))
      .where(and(eq(payments.id, paymentId), eq(payments.organizationId, tenant.organizationId)));
    if (!p || !canAccessUnit(tenant, p.payment.unitId)) throw notFound('Recebimento');
    const allocs = await this.db.select({ amount: paymentAllocations.amount, description: receivables.description, refundId: paymentAllocations.refundId }).from(paymentAllocations).innerJoin(receivables, eq(receivables.id, paymentAllocations.receivableId)).where(eq(paymentAllocations.paymentId, paymentId));
    return { ...p, allocations: allocs };
  }

  // ---------------------------------------------------------------- Estornos

  async requestRefund(auth: AuthContext, tenant: TenantContext, paymentId: string, input: z.infer<typeof refundRequestSchema>, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const [p] = await tx.select().from(payments).where(and(eq(payments.id, paymentId), eq(payments.organizationId, tenant.organizationId))).for('update');
      if (!p || !canAccessUnit(tenant, p.unitId)) throw notFound('Recebimento');
      const [{ total }] = (await tx.select({ total: sql<string>`coalesce(sum(${refunds.amount}), 0)` }).from(refunds).where(and(eq(refunds.paymentId, paymentId), ne(refunds.status, 'rejected')))) as [{ total: string }];
      if (toCents(String(total)) + toCents(input.amount) > toCents(p.amount)) throw new AppError('validation_failed', 'O estorno ultrapassa o valor recebido (considerando estornos já pedidos).');
      if (input.receivableId) {
        const [{ alloc }] = (await tx.select({ alloc: sql<string>`coalesce(sum(${paymentAllocations.amount}), 0)` }).from(paymentAllocations).where(and(eq(paymentAllocations.paymentId, paymentId), eq(paymentAllocations.receivableId, input.receivableId)))) as [{ alloc: string }];
        if (toCents(input.amount) > toCents(String(alloc))) throw new AppError('validation_failed', 'O estorno é maior que o valor deste recebimento aplicado à parcela.');
      }
      const [r] = await tx.insert(refunds).values({ organizationId: tenant.organizationId, paymentId, receivableId: input.receivableId ?? null, amount: input.amount, reason: input.reason, requestedBy: auth.userId }).returning({ id: refunds.id });
      await this.audit.record(tx, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'finance.refund_requested', entityType: 'payment', entityId: paymentId, unitId: p.unitId, metadata: { refundId: r!.id, amount: input.amount, reason: input.reason }, meta });
      return { id: r!.id };
    });
  }

  /** Aprovação por outra pessoa (segregação de funções), exceto o proprietário. */
  async decideRefund(auth: AuthContext, tenant: TenantContext, refundId: string, input: z.infer<typeof refundDecisionSchema>, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const [r] = await tx.select().from(refunds).where(and(eq(refunds.id, refundId), eq(refunds.organizationId, tenant.organizationId))).for('update');
      if (!r) throw notFound('Estorno');
      if (r.status !== 'requested') throw new AppError('conflict', 'Este estorno já foi decidido.');
      if (r.requestedBy === auth.userId && tenant.roleKey !== 'owner') throw forbidden('O estorno precisa ser aprovado por outra pessoa.');
      await tx.update(refunds).set({ status: input.approve ? 'approved' : 'rejected', decidedBy: auth.userId, decidedAt: this.clock.now(), decisionNote: input.note ?? null }).where(eq(refunds.id, refundId));
      if (input.approve && r.receivableId) {
        await tx.insert(paymentAllocations).values({ organizationId: tenant.organizationId, paymentId: r.paymentId, receivableId: r.receivableId, amount: fromCents(-toCents(r.amount)), refundId, createdAt: this.clock.now() });
        await this.refreshReceivableStatus(tx, [r.receivableId]);
      }
      await this.audit.record(tx, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: input.approve ? 'finance.refund_approved' : 'finance.refund_rejected', entityType: 'payment', entityId: r.paymentId, metadata: { refundId, amount: r.amount, note: input.note ?? null }, meta });
      return { status: input.approve ? 'approved' : 'rejected' };
    });
  }

  async listRefunds(tenant: TenantContext, status?: string) {
    return this.db
      .select({ id: refunds.id, paymentId: refunds.paymentId, receivableId: refunds.receivableId, amount: refunds.amount, reason: refunds.reason, status: refunds.status, createdAt: refunds.createdAt, requestedBy: refunds.requestedBy, requestedByName: users.name, patientName: patients.fullName })
      .from(refunds)
      .innerJoin(users, eq(users.id, refunds.requestedBy))
      .innerJoin(payments, eq(payments.id, refunds.paymentId))
      .leftJoin(patients, eq(patients.id, payments.patientId))
      .where(and(eq(refunds.organizationId, tenant.organizationId), status ? eq(refunds.status, status) : undefined))
      .orderBy(desc(refunds.createdAt));
  }

  // ------------------------------------------------------- Contas a pagar

  async listPayables(tenant: TenantContext, q: { status?: string; from?: string; to?: string }) {
    const filters: SQL[] = [eq(payables.organizationId, tenant.organizationId)];
    if (q.status === 'open' || q.status === 'overdue') filters.push(eq(payables.status, 'open'));
    if (q.status === 'overdue') filters.push(lt(payables.dueDate, this.today()));
    if (q.status === 'paid') filters.push(eq(payables.status, 'paid'));
    if (q.from) filters.push(gte(payables.dueDate, q.from));
    if (q.to) filters.push(lte(payables.dueDate, q.to));
    const rows = await this.db
      .select({ payable: payables, categoryName: financialCategories.name })
      .from(payables)
      .leftJoin(financialCategories, eq(financialCategories.id, payables.categoryId))
      .where(and(...filters))
      .orderBy(asc(payables.dueDate))
      .limit(500);
    return rows.filter((r) => canAccessUnit(tenant, r.payable.unitId)).map((r) => ({ ...r.payable, categoryName: r.categoryName }));
  }

  async createPayable(auth: AuthContext, tenant: TenantContext, input: z.infer<typeof payableSchema>, meta: RequestMeta) {
    if (!canAccessUnit(tenant, input.unitId)) throw notFound('Unidade');
    const seriesId = input.repeatMonths > 1 ? randomUUID() : null;
    const [y, m, d] = input.dueDate.split('-').map(Number) as [number, number, number];
    const values = Array.from({ length: input.repeatMonths }, (_, i) => ({
      organizationId: tenant.organizationId,
      unitId: input.unitId,
      categoryId: input.categoryId ?? null,
      supplierName: input.supplierName ?? null,
      description: input.description,
      amount: input.amount,
      dueDate: i === 0 ? input.dueDate : new Date(Date.UTC(y, m - 1 + i, Math.min(d, 28))).toISOString().slice(0, 10),
      seriesId,
      createdBy: auth.userId,
    }));
    const rows = await this.db.insert(payables).values(values).returning({ id: payables.id });
    await this.audit.record(this.db, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'finance.payable_created', entityType: 'payable', entityId: rows[0]!.id, unitId: input.unitId, metadata: { amount: input.amount, occurrences: rows.length }, meta });
    return { ids: rows.map((r) => r.id) };
  }

  async payPayable(auth: AuthContext, tenant: TenantContext, id: string, input: z.infer<typeof payPayableSchema>, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const [p] = await tx.select().from(payables).where(and(eq(payables.id, id), eq(payables.organizationId, tenant.organizationId))).for('update');
      if (!p || !canAccessUnit(tenant, p.unitId)) throw notFound('Conta a pagar');
      if (p.status !== 'open') throw new AppError('invalid_transition', 'Esta conta não está em aberto.');
      const [acc] = await tx.select().from(cashAccounts).where(and(eq(cashAccounts.id, input.cashAccountId), eq(cashAccounts.organizationId, tenant.organizationId)));
      if (!acc) throw notFound('Conta de caixa');
      await tx.update(payables).set({ status: 'paid', paidAt: new Date(input.paidAt), paidAmount: input.paidAmount ?? p.amount, cashAccountId: acc.id }).where(eq(payables.id, id));
      await this.audit.record(tx, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'finance.payable_paid', entityType: 'payable', entityId: id, unitId: p.unitId, metadata: { amount: input.paidAmount ?? p.amount }, meta });
      return { ok: true };
    });
  }

  async cancelPayable(auth: AuthContext, tenant: TenantContext, id: string, meta: RequestMeta) {
    const r = await this.db.update(payables).set({ status: 'cancelled' }).where(and(eq(payables.id, id), eq(payables.organizationId, tenant.organizationId), eq(payables.status, 'open'))).returning({ id: payables.id });
    if (!r.length) throw notFound('Conta a pagar em aberto');
    await this.audit.record(this.db, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'finance.payable_cancelled', entityType: 'payable', entityId: id, meta });
    return { ok: true };
  }

  // ------------------------------------------------------------ Conciliação

  /**
   * Importa extrato em CSV (data;descrição;valor) — formato simples exportável
   * pelos bancos. Reimportar o mesmo arquivo não duplica linhas.
   */
  async importStatement(auth: AuthContext, tenant: TenantContext, cashAccountId: string, csv: string, meta: RequestMeta) {
    const [acc] = await this.db.select().from(cashAccounts).where(and(eq(cashAccounts.id, cashAccountId), eq(cashAccounts.organizationId, tenant.organizationId)));
    if (!acc || !canAccessUnit(tenant, acc.unitId)) throw notFound('Conta de caixa');
    const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const seen = new Map<string, number>();
    const parsed: { date: string; description: string; amount: string; externalId: string }[] = [];
    const errors: { line: number; message: string }[] = [];
    lines.forEach((line, idx) => {
      const cols = line.split(';').map((c) => c.trim().replace(/^"|"$/g, ''));
      if (idx === 0 && /data/i.test(cols[0] ?? '')) return;
      const [rawDate, description, rawAmount] = cols;
      const date = /^\d{2}\/\d{2}\/\d{4}$/.test(rawDate ?? '') ? rawDate!.split('/').reverse().join('-') : rawDate;
      const amountStr = (rawAmount ?? '').replace(/\./g, '').replace(',', '.').replace(/\s/g, '');
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !description || !/^-?\d+(\.\d{1,2})?$/.test(amountStr)) {
        errors.push({ line: idx + 1, message: 'Linha fora do formato data;descrição;valor' });
        return;
      }
      const base = createHash('sha256').update(`${date}|${description}|${amountStr}`).digest('hex').slice(0, 32);
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      parsed.push({ date, description: description.slice(0, 200), amount: fromCents(toCents(amountStr)), externalId: `${base}:${n}` });
    });
    const inserted = parsed.length
      ? await this.db.insert(bankStatementLines).values(parsed.map((p) => ({ organizationId: tenant.organizationId, cashAccountId, ...p }))).onConflictDoNothing().returning({ id: bankStatementLines.id })
      : [];
    await this.audit.record(this.db, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'finance.statement_imported', entityType: 'cash_account', entityId: cashAccountId, metadata: { lines: parsed.length, inserted: inserted.length, errors: errors.length }, meta });
    return { read: parsed.length, inserted: inserted.length, duplicates: parsed.length - inserted.length, errors };
  }

  /** Linhas pendentes com sugestões: mesmo valor e data em até 3 dias. */
  async reconciliation(tenant: TenantContext, cashAccountId: string) {
    const lines = await this.db.select().from(bankStatementLines).where(and(eq(bankStatementLines.organizationId, tenant.organizationId), eq(bankStatementLines.cashAccountId, cashAccountId))).orderBy(desc(bankStatementLines.date)).limit(300);
    const pending = lines.filter((l) => l.status === 'unmatched');
    const [pays, outs] = await Promise.all([
      this.db.select({ id: payments.id, amount: payments.amount, receivedAt: payments.receivedAt, method: payments.method, patientName: patients.fullName }).from(payments).leftJoin(patients, eq(patients.id, payments.patientId)).where(and(eq(payments.organizationId, tenant.organizationId), eq(payments.cashAccountId, cashAccountId), isNull(payments.reconciledAt))),
      this.db.select({ id: payables.id, amount: sql<string>`coalesce(${payables.paidAmount}, ${payables.amount})`, paidAt: payables.paidAt, description: payables.description }).from(payables).where(and(eq(payables.organizationId, tenant.organizationId), eq(payables.cashAccountId, cashAccountId), eq(payables.status, 'paid'), isNull(payables.reconciledAt))),
    ]);
    const near = (a: string, b: Date | null) => !!b && Math.abs(Date.parse(`${a}T12:00:00Z`) - b.getTime()) <= 3.5 * 86_400_000;
    return {
      lines: lines.map((l) => ({
        ...l,
        suggestions:
          l.status !== 'unmatched'
            ? []
            : toCents(l.amount) > 0
              ? pays.filter((p) => toCents(p.amount) === toCents(l.amount) && near(l.date, p.receivedAt)).map((p) => ({ kind: 'payment' as const, id: p.id, label: `${p.patientName ?? 'Recebimento'} · ${p.method}` }))
              : outs.filter((o) => toCents(String(o.amount)) === -toCents(l.amount) && near(l.date, o.paidAt)).map((o) => ({ kind: 'payable' as const, id: o.id, label: o.description })),
      })),
      pendingCount: pending.length,
    };
  }

  async matchLine(auth: AuthContext, tenant: TenantContext, lineId: string, target: { kind: 'payment' | 'payable' | 'ignore'; id?: string }, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const [l] = await tx.select().from(bankStatementLines).where(and(eq(bankStatementLines.id, lineId), eq(bankStatementLines.organizationId, tenant.organizationId))).for('update');
      if (!l) throw notFound('Linha do extrato');
      if (l.status !== 'unmatched') throw new AppError('conflict', 'Linha já conciliada.');
      if (target.kind === 'ignore') {
        await tx.update(bankStatementLines).set({ status: 'ignored', matchedBy: auth.userId, matchedAt: this.clock.now() }).where(eq(bankStatementLines.id, lineId));
      } else if (target.kind === 'payment') {
        const [p] = await tx.select().from(payments).where(and(eq(payments.id, target.id!), eq(payments.organizationId, tenant.organizationId), eq(payments.cashAccountId, l.cashAccountId))).for('update');
        if (!p || p.reconciledAt) throw new AppError('conflict', 'Recebimento indisponível para conciliação.');
        if (toCents(p.amount) !== toCents(l.amount)) throw new AppError('validation_failed', 'Valores diferentes entre extrato e recebimento.');
        await tx.update(payments).set({ reconciledAt: this.clock.now(), reconciledBy: auth.userId }).where(eq(payments.id, p.id));
        await tx.update(bankStatementLines).set({ status: 'matched', matchedPaymentId: p.id, matchedBy: auth.userId, matchedAt: this.clock.now() }).where(eq(bankStatementLines.id, lineId));
      } else {
        const [x] = await tx.select().from(payables).where(and(eq(payables.id, target.id!), eq(payables.organizationId, tenant.organizationId), eq(payables.status, 'paid'))).for('update');
        if (!x || x.reconciledAt) throw new AppError('conflict', 'Despesa indisponível para conciliação.');
        if (toCents(x.paidAmount ?? x.amount) !== -toCents(l.amount)) throw new AppError('validation_failed', 'Valores diferentes entre extrato e despesa.');
        await tx.update(payables).set({ reconciledAt: this.clock.now() }).where(eq(payables.id, x.id));
        await tx.update(bankStatementLines).set({ status: 'matched', matchedPayableId: x.id, matchedBy: auth.userId, matchedAt: this.clock.now() }).where(eq(bankStatementLines.id, lineId));
      }
      await this.audit.record(tx, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'finance.statement_matched', entityType: 'cash_account', entityId: l.cashAccountId, metadata: { lineId, target }, meta });
      return { ok: true };
    });
  }

  // -------------------------------------------------------------- Relatórios

  private unitFilter(tenant: TenantContext, column: typeof receivables.unitId | typeof payments.unitId | typeof payables.unitId, unitId?: string): SQL | undefined {
    if (unitId) {
      if (!canAccessUnit(tenant, unitId)) throw notFound('Unidade');
      return eq(column, unitId);
    }
    return tenant.allUnits ? undefined : inArray(column, [...tenant.unitIds]);
  }

  /**
   * Resumo do período com as quatro grandezas separadas e suas definições.
   */
  async summary(tenant: TenantContext, q: z.infer<typeof periodSchema>) {
    const org = tenant.organizationId;
    const start = new Date(`${q.from}T00:00:00-03:00`);
    const end = new Date(new Date(`${q.to}T00:00:00-03:00`).getTime() + 86_400_000);
    const n = (v: unknown) => toCents(String(v ?? '0'));
    const [[contracted], [charged], [received], [refunded], [recognized], [openBal], [overdueBal], [expenses]] = await Promise.all([
      this.db.select({ v: sql<string>`coalesce(sum(${quoteVersions.total}), 0)` }).from(quoteDecisions).innerJoin(quoteVersions, eq(quoteVersions.id, quoteDecisions.versionId)).innerJoin(quotes, eq(quotes.id, quoteDecisions.quoteId)).innerJoin(treatmentPlans, eq(treatmentPlans.id, quotes.planId)).where(and(eq(quoteDecisions.organizationId, org), eq(quoteDecisions.decision, 'approved'), gte(quoteDecisions.createdAt, start), lt(quoteDecisions.createdAt, end), this.unitFilter(tenant, treatmentPlans.unitId as never, q.unitId))),
      this.db.select({ v: sql<string>`coalesce(sum(${receivables.amount}), 0)` }).from(receivables).where(and(eq(receivables.organizationId, org), ne(receivables.status, 'cancelled'), gte(receivables.dueDate, q.from), lte(receivables.dueDate, q.to), this.unitFilter(tenant, receivables.unitId, q.unitId))),
      this.db.select({ v: sql<string>`coalesce(sum(${payments.amount}), 0)` }).from(payments).where(and(eq(payments.organizationId, org), gte(payments.receivedAt, start), lt(payments.receivedAt, end), this.unitFilter(tenant, payments.unitId, q.unitId))),
      this.db.select({ v: sql<string>`coalesce(sum(${refunds.amount}), 0)` }).from(refunds).innerJoin(payments, eq(payments.id, refunds.paymentId)).where(and(eq(refunds.organizationId, org), eq(refunds.status, 'approved'), gte(refunds.decidedAt, start), lt(refunds.decidedAt, end), this.unitFilter(tenant, payments.unitId, q.unitId))),
      this.db.select({ v: sql<string>`coalesce(sum(${treatmentItems.unitPrice}), 0)` }).from(treatmentItems).innerJoin(treatmentPlans, eq(treatmentPlans.id, treatmentItems.planId)).where(and(eq(treatmentItems.organizationId, org), eq(treatmentItems.status, 'done'), gte(treatmentItems.doneAt, start), lt(treatmentItems.doneAt, end), this.unitFilter(tenant, treatmentPlans.unitId as never, q.unitId))),
      this.db.select({ v: sql<string>`coalesce(sum(${receivables.amount} - (select coalesce(sum(a.amount),0) from payment_allocations a where a.receivable_id = ${receivables.id})), 0)` }).from(receivables).where(and(eq(receivables.organizationId, org), eq(receivables.status, 'open'), this.unitFilter(tenant, receivables.unitId, q.unitId))),
      this.db.select({ v: sql<string>`coalesce(sum(${receivables.amount} - (select coalesce(sum(a.amount),0) from payment_allocations a where a.receivable_id = ${receivables.id})), 0)` }).from(receivables).where(and(eq(receivables.organizationId, org), eq(receivables.status, 'open'), lt(receivables.dueDate, this.today()), this.unitFilter(tenant, receivables.unitId, q.unitId))),
      this.db.select({ v: sql<string>`coalesce(sum(coalesce(${payables.paidAmount}, ${payables.amount})), 0)` }).from(payables).where(and(eq(payables.organizationId, org), eq(payables.status, 'paid'), gte(payables.paidAt, start), lt(payables.paidAt, end), this.unitFilter(tenant, payables.unitId, q.unitId))),
    ]);
    const netReceived = n(received?.v) - n(refunded?.v);
    return {
      period: { from: q.from, to: q.to },
      contracted: { value: fromCents(n(contracted?.v)), definition: 'Soma dos orçamentos aprovados no período (versão aprovada).' },
      charged: { value: fromCents(n(charged?.v)), definition: 'Parcelas a receber com vencimento no período (exceto canceladas).' },
      received: { value: fromCents(netReceived), definition: 'Recebimentos registrados no período menos estornos aprovados no período.' },
      recognized: { value: fromCents(n(recognized?.v)), definition: 'Valor das etapas de tratamento realizadas no período (preço da etapa no plano).' },
      openBalance: { value: fromCents(n(openBal?.v)), definition: 'Saldo de todas as parcelas em aberto, independentemente do vencimento.' },
      overdueBalance: { value: fromCents(n(overdueBal?.v)), definition: 'Saldo das parcelas em aberto já vencidas.' },
      expensesPaid: { value: fromCents(n(expenses?.v)), definition: 'Despesas pagas no período.' },
      cashResult: { value: fromCents(netReceived - n(expenses?.v)), definition: 'Recebido líquido menos despesas pagas no período (regime de caixa).' },
    };
  }

  /** Fluxo de caixa diário previsto x realizado. */
  async cashflow(tenant: TenantContext, q: z.infer<typeof periodSchema>) {
    const start = new Date(`${q.from}T00:00:00-03:00`);
    const end = new Date(new Date(`${q.to}T00:00:00-03:00`).getTime() + 86_400_000);
    const day = (d: Date) => zonedParts(d, TZ).date;
    const [recs, pays, refs, outsOpen, outsPaid] = await Promise.all([
      this.db.select({ dueDate: receivables.dueDate, balance: sql<string>`${receivables.amount} - (select coalesce(sum(a.amount),0) from payment_allocations a where a.receivable_id = ${receivables.id})` }).from(receivables).where(and(eq(receivables.organizationId, tenant.organizationId), eq(receivables.status, 'open'), gte(receivables.dueDate, q.from), lte(receivables.dueDate, q.to), this.unitFilter(tenant, receivables.unitId, q.unitId))),
      this.db.select({ at: payments.receivedAt, amount: payments.amount }).from(payments).where(and(eq(payments.organizationId, tenant.organizationId), gte(payments.receivedAt, start), lt(payments.receivedAt, end), this.unitFilter(tenant, payments.unitId, q.unitId))),
      this.db.select({ at: refunds.decidedAt, amount: refunds.amount }).from(refunds).innerJoin(payments, eq(payments.id, refunds.paymentId)).where(and(eq(refunds.organizationId, tenant.organizationId), eq(refunds.status, 'approved'), gte(refunds.decidedAt, start), lt(refunds.decidedAt, end), this.unitFilter(tenant, payments.unitId, q.unitId))),
      this.db.select({ dueDate: payables.dueDate, amount: payables.amount }).from(payables).where(and(eq(payables.organizationId, tenant.organizationId), eq(payables.status, 'open'), gte(payables.dueDate, q.from), lte(payables.dueDate, q.to), this.unitFilter(tenant, payables.unitId, q.unitId))),
      this.db.select({ at: payables.paidAt, amount: sql<string>`coalesce(${payables.paidAmount}, ${payables.amount})` }).from(payables).where(and(eq(payables.organizationId, tenant.organizationId), eq(payables.status, 'paid'), gte(payables.paidAt, start), lt(payables.paidAt, end), this.unitFilter(tenant, payables.unitId, q.unitId))),
    ]);
    const days = new Map<string, { expectedIn: number; expectedOut: number; actualIn: number; actualOut: number }>();
    const get = (d: string) => days.get(d) ?? (days.set(d, { expectedIn: 0, expectedOut: 0, actualIn: 0, actualOut: 0 }), days.get(d)!);
    for (const r of recs) get(r.dueDate).expectedIn += Math.max(0, toCents(String(r.balance)));
    for (const o of outsOpen) get(o.dueDate).expectedOut += toCents(o.amount);
    for (const p of pays) get(day(p.at)).actualIn += toCents(p.amount);
    for (const r of refs) if (r.at) get(day(r.at)).actualIn -= toCents(r.amount);
    for (const o of outsPaid) if (o.at) get(day(o.at)).actualOut += toCents(String(o.amount));
    return [...days.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date, expectedIn: fromCents(v.expectedIn), expectedOut: fromCents(v.expectedOut), actualIn: fromCents(v.actualIn), actualOut: fromCents(v.actualOut) }));
  }

  /** Recebido por profissional e por procedimento + repasse calculado pelas regras ativas. */
  async byProfessional(tenant: TenantContext, q: z.infer<typeof periodSchema>) {
    const start = new Date(`${q.from}T00:00:00-03:00`);
    const end = new Date(new Date(`${q.to}T00:00:00-03:00`).getTime() + 86_400_000);
    const rows = await this.db
      .select({ professionalId: receivables.professionalId, name: professionals.displayName, total: sql<string>`coalesce(sum(${paymentAllocations.amount}), 0)` })
      .from(paymentAllocations)
      .innerJoin(receivables, eq(receivables.id, paymentAllocations.receivableId))
      .innerJoin(payments, eq(payments.id, paymentAllocations.paymentId))
      .leftJoin(professionals, eq(professionals.id, receivables.professionalId))
      .where(and(eq(paymentAllocations.organizationId, tenant.organizationId), gte(paymentAllocations.createdAt, start), lt(paymentAllocations.createdAt, end), this.unitFilter(tenant, receivables.unitId, q.unitId)))
      .groupBy(receivables.professionalId, professionals.displayName);
    const rules = await this.commissionRulesList(tenant);
    return rows.map((r) => {
      const rule = rules.find((x) => x.professionalId === r.professionalId);
      const cents = toCents(String(r.total));
      return { professionalId: r.professionalId, name: r.name ?? 'Sem profissional definido', received: fromCents(cents), commissionPercent: rule?.percent ?? null, commission: rule ? fromCents(percentOf(cents, Number(rule.percent))) : null };
    });
  }

  async byProcedure(tenant: TenantContext, q: z.infer<typeof periodSchema>) {
    const start = new Date(`${q.from}T00:00:00-03:00`);
    const end = new Date(new Date(`${q.to}T00:00:00-03:00`).getTime() + 86_400_000);
    return this.db
      .select({ serviceId: treatmentItems.serviceId, name: sql<string>`coalesce(${services.name}, 'Outros procedimentos')`, count: sql<number>`count(*)::int`, recognized: sql<string>`coalesce(sum(${treatmentItems.unitPrice}), 0)` })
      .from(treatmentItems)
      .innerJoin(treatmentPlans, eq(treatmentPlans.id, treatmentItems.planId))
      .leftJoin(services, eq(services.id, treatmentItems.serviceId))
      .where(and(eq(treatmentItems.organizationId, tenant.organizationId), eq(treatmentItems.status, 'done'), gte(treatmentItems.doneAt, start), lt(treatmentItems.doneAt, end), this.unitFilter(tenant, treatmentPlans.unitId as never, q.unitId)))
      .groupBy(treatmentItems.serviceId, services.name)
      .orderBy(desc(sql`sum(${treatmentItems.unitPrice})`));
  }

  /** Inadimplência: parcelas vencidas com saldo, agrupadas por paciente. */
  async delinquency(tenant: TenantContext) {
    const rows = await this.listReceivables(tenant, { status: 'overdue' });
    const today = this.today();
    const byPatient = new Map<string, { patientId: string | null; patientName: string | null; balance: number; oldestDueDate: string; items: typeof rows; onHold: boolean }>();
    for (const r of rows) {
      const k = r.patientId ?? 'none';
      const cur = byPatient.get(k) ?? { patientId: r.patientId, patientName: r.patientName, balance: 0, oldestDueDate: r.dueDate, items: [], onHold: false };
      cur.balance += toCents(r.balance);
      cur.oldestDueDate = r.dueDate < cur.oldestDueDate ? r.dueDate : cur.oldestDueDate;
      cur.onHold = cur.onHold || r.collectionHold;
      cur.items.push(r);
      byPatient.set(k, cur);
    }
    return [...byPatient.values()]
      .map((v) => ({ ...v, balance: fromCents(v.balance), daysOverdue: Math.floor((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${v.oldestDueDate}T12:00:00Z`)) / 86_400_000) }))
      .sort((a, b) => b.daysOverdue - a.daysOverdue);
  }

  async patientStatement(tenant: TenantContext, patientId: string) {
    const [recs, pays] = await Promise.all([this.listReceivables(tenant, { patientId }), this.listPayments(tenant, { patientId })]);
    const balance = recs.filter((r) => r.status !== 'cancelled').reduce((s, r) => s + toCents(r.balance), 0);
    return { receivables: recs, payments: pays, balance: fromCents(balance) };
  }

  // utilitário usado pelas automações e pelo portal
  async openForPatient(organizationId: string, patientId: string) {
    const today = this.today();
    const rows = await this.receivableQuery(organizationId).where(and(eq(receivables.organizationId, organizationId), eq(receivables.patientId, patientId), or(eq(receivables.status, 'open'), eq(receivables.status, 'paid')))).orderBy(asc(receivables.dueDate));
    return rows.map((r) => this.shapeReceivable(r, today));
  }
}
