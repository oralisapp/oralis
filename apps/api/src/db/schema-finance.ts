/**
 * Financeiro da clínica (cobranças dos pacientes). Separado da assinatura do
 * SaaS: credenciais, conciliação e beneficiários não se misturam.
 *
 * Eventos distintos com semântica clara:
 * - contratado = orçamento aprovado; cobrado = conta a receber;
 * - recebido = pagamento alocado (menos estornos aprovados);
 * - reconhecido = etapa de tratamento realizada.
 * Valores em numeric(12,2); cálculos em centavos inteiros.
 */
import { sql } from 'drizzle-orm';
import { boolean, check, date, foreignKey, index, integer, numeric, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { clinicUnits, organizations, patients, professionals, users } from './schema';

export const financialCategories = pgTable(
  'financial_categories',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    name: text().notNull(),
    kind: text().notNull(),
    active: boolean().notNull().default(true),
  },
  (t) => [unique('financial_categories_id_org_uq').on(t.id, t.organizationId), unique().on(t.organizationId, t.kind, t.name), check('financial_categories_kind_ck', sql`${t.kind} in ('income', 'expense')`)],
);

export const cashAccounts = pgTable(
  'cash_accounts',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    unitId: uuid().notNull(),
    name: text().notNull(),
    kind: text().notNull(),
    active: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('cash_accounts_id_org_uq').on(t.id, t.organizationId),
    foreignKey({ columns: [t.unitId, t.organizationId], foreignColumns: [clinicUnits.id, clinicUnits.organizationId] }),
    check('cash_accounts_kind_ck', sql`${t.kind} in ('cash', 'bank', 'card_acquirer')`),
  ],
);

export const receivables = pgTable(
  'receivables',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    unitId: uuid().notNull(),
    patientId: uuid(),
    professionalId: uuid(),
    planId: uuid(),
    quoteVersionId: uuid(),
    categoryId: uuid(),
    description: text().notNull(),
    amount: numeric({ precision: 12, scale: 2 }).notNull(),
    dueDate: date({ mode: 'string' }).notNull(),
    groupId: uuid().notNull(),
    installmentNo: integer().notNull().default(1),
    installmentsTotal: integer().notNull().default(1),
    status: text().notNull().default('open'),
    /** Contestação ou acordo: suspende cobranças automáticas. */
    collectionHold: boolean().notNull().default(false),
    collectionHoldReason: text(),
    createdBy: uuid().references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    cancelledAt: timestamp({ withTimezone: true }),
    cancelledBy: uuid().references(() => users.id),
    cancelReason: text(),
  },
  (t) => [
    unique('receivables_id_org_uq').on(t.id, t.organizationId),
    foreignKey({ columns: [t.unitId, t.organizationId], foreignColumns: [clinicUnits.id, clinicUnits.organizationId] }),
    foreignKey({ columns: [t.patientId, t.organizationId], foreignColumns: [patients.id, patients.organizationId] }),
    foreignKey({ columns: [t.professionalId, t.organizationId], foreignColumns: [professionals.id, professionals.organizationId] }),
    foreignKey({ columns: [t.categoryId, t.organizationId], foreignColumns: [financialCategories.id, financialCategories.organizationId] }),
    check('receivables_amount_ck', sql`${t.amount} > 0`),
    check('receivables_status_ck', sql`${t.status} in ('open', 'paid', 'cancelled')`),
    check('receivables_cancel_ck', sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null)`),
    unique('receivables_quote_installment_uq').on(t.quoteVersionId, t.installmentNo),
    index().on(t.organizationId, t.status, t.dueDate),
    index().on(t.organizationId, t.patientId),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    unitId: uuid().notNull(),
    cashAccountId: uuid().notNull(),
    patientId: uuid(),
    amount: numeric({ precision: 12, scale: 2 }).notNull(),
    method: text().notNull(),
    receivedAt: timestamp({ withTimezone: true }).notNull(),
    reference: text(),
    notes: text(),
    createdBy: uuid().notNull().references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    reconciledAt: timestamp({ withTimezone: true }),
    reconciledBy: uuid().references(() => users.id),
  },
  (t) => [
    unique('payments_id_org_uq').on(t.id, t.organizationId),
    foreignKey({ columns: [t.cashAccountId, t.organizationId], foreignColumns: [cashAccounts.id, cashAccounts.organizationId] }),
    foreignKey({ columns: [t.patientId, t.organizationId], foreignColumns: [patients.id, patients.organizationId] }),
    check('payments_amount_ck', sql`${t.amount} > 0`),
    check('payments_method_ck', sql`${t.method} in ('cash', 'pix', 'card_credit', 'card_debit', 'transfer', 'boleto', 'other')`),
    index().on(t.organizationId, t.receivedAt),
  ],
);

/** Quanto de cada pagamento quitou cada parcela. Estorno aprovado entra como alocação negativa. */
export const paymentAllocations = pgTable(
  'payment_allocations',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull(),
    paymentId: uuid().notNull(),
    receivableId: uuid().notNull(),
    amount: numeric({ precision: 12, scale: 2 }).notNull(),
    refundId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.paymentId, t.organizationId], foreignColumns: [payments.id, payments.organizationId] }),
    foreignKey({ columns: [t.receivableId, t.organizationId], foreignColumns: [receivables.id, receivables.organizationId] }),
    check('payment_allocations_sign_ck', sql`(${t.refundId} is null and ${t.amount} > 0) or (${t.refundId} is not null and ${t.amount} < 0)`),
    index().on(t.receivableId),
    index().on(t.paymentId),
  ],
);

export const refunds = pgTable(
  'refunds',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull(),
    paymentId: uuid().notNull(),
    receivableId: uuid(),
    amount: numeric({ precision: 12, scale: 2 }).notNull(),
    reason: text().notNull(),
    status: text().notNull().default('requested'),
    requestedBy: uuid().notNull().references(() => users.id),
    decidedBy: uuid().references(() => users.id),
    decidedAt: timestamp({ withTimezone: true }),
    decisionNote: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.paymentId, t.organizationId], foreignColumns: [payments.id, payments.organizationId] }),
    check('refunds_amount_ck', sql`${t.amount} > 0`),
    check('refunds_status_ck', sql`${t.status} in ('requested', 'approved', 'rejected')`),
  ],
);

export const payables = pgTable(
  'payables',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    unitId: uuid().notNull(),
    categoryId: uuid(),
    supplierName: text(),
    description: text().notNull(),
    amount: numeric({ precision: 12, scale: 2 }).notNull(),
    dueDate: date({ mode: 'string' }).notNull(),
    status: text().notNull().default('open'),
    paidAt: timestamp({ withTimezone: true }),
    paidAmount: numeric({ precision: 12, scale: 2 }),
    cashAccountId: uuid(),
    seriesId: uuid(),
    createdBy: uuid().notNull().references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    reconciledAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    unique('payables_id_org_uq').on(t.id, t.organizationId),
    foreignKey({ columns: [t.unitId, t.organizationId], foreignColumns: [clinicUnits.id, clinicUnits.organizationId] }),
    foreignKey({ columns: [t.categoryId, t.organizationId], foreignColumns: [financialCategories.id, financialCategories.organizationId] }),
    foreignKey({ columns: [t.cashAccountId, t.organizationId], foreignColumns: [cashAccounts.id, cashAccounts.organizationId] }),
    check('payables_amount_ck', sql`${t.amount} > 0`),
    check('payables_status_ck', sql`${t.status} in ('open', 'paid', 'cancelled')`),
    check('payables_paid_ck', sql`(${t.status} = 'paid') = (${t.paidAt} is not null)`),
    index().on(t.organizationId, t.status, t.dueDate),
  ],
);

/** Linhas de extrato importadas para conciliação. */
export const bankStatementLines = pgTable(
  'bank_statement_lines',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull(),
    cashAccountId: uuid().notNull(),
    date: date({ mode: 'string' }).notNull(),
    description: text().notNull(),
    amount: numeric({ precision: 12, scale: 2 }).notNull(),
    /** Identificador estável da linha (do banco ou hash do conteúdo): impede importar duas vezes. */
    externalId: text().notNull(),
    status: text().notNull().default('unmatched'),
    matchedPaymentId: uuid(),
    matchedPayableId: uuid(),
    matchedBy: uuid().references(() => users.id),
    matchedAt: timestamp({ withTimezone: true }),
    importedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.cashAccountId, t.organizationId], foreignColumns: [cashAccounts.id, cashAccounts.organizationId] }),
    unique().on(t.cashAccountId, t.externalId),
    check('statement_status_ck', sql`${t.status} in ('unmatched', 'matched', 'ignored')`),
  ],
);

export const commissionRules = pgTable(
  'commission_rules',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull(),
    professionalId: uuid().notNull(),
    /** Percentual sobre o valor efetivamente recebido (líquido de estornos). */
    percent: numeric({ precision: 5, scale: 2 }).notNull(),
    active: boolean().notNull().default(true),
    createdBy: uuid().references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.professionalId, t.organizationId], foreignColumns: [professionals.id, professionals.organizationId] }),
    check('commission_percent_ck', sql`${t.percent} >= 0 and ${t.percent} <= 100`),
  ],
);
