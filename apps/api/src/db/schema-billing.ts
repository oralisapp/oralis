/**
 * Assinatura do SaaS (a organização paga o Oralis). Totalmente separada das
 * cobranças dos pacientes: outras tabelas, outras credenciais, outro beneficiário.
 */
import { sql } from 'drizzle-orm';
import { boolean, check, customType, index, integer, jsonb, numeric, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { organizations, users } from './schema';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

/** Catálogo central: a página pública e a área de assinatura leem daqui. */
export const plans = pgTable(
  'plans',
  {
    id: uuid().primaryKey().defaultRandom(),
    key: text().notNull().unique(),
    name: text().notNull(),
    description: text().notNull(),
    /** Nulo = preço ainda não publicado (contratação paga indisponível). */
    priceMonthly: numeric({ precision: 10, scale: 2 }),
    priceAnnual: numeric({ precision: 10, scale: 2 }),
    currency: text().notNull().default('BRL'),
    /** Nulo = ilimitado. */
    maxUnits: integer(),
    maxUsers: integer(),
    storageMb: integer().notNull(),
    features: text().array().notNull().default(sql`'{}'::text[]`),
    trialDays: integer().notNull().default(14),
    commercialTerms: text(),
    stripePriceMonthly: text(),
    stripePriceAnnual: text(),
    active: boolean().notNull().default(true),
    sortOrder: integer().notNull().default(0),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
);

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().unique().references(() => organizations.id),
    planId: uuid().notNull().references(() => plans.id),
    interval: text().notNull().default('monthly'),
    status: text().notNull(),
    statusReason: text(),
    trialEndsAt: timestamp({ withTimezone: true }),
    currentPeriodEnd: timestamp({ withTimezone: true }),
    graceUntil: timestamp({ withTimezone: true }),
    cancelAtPeriodEnd: boolean().notNull().default(false),
    cancelledAt: timestamp({ withTimezone: true }),
    /** Fim do período de somente-leitura e exportação após cancelamento ou suspensão. */
    readOnlyUntil: timestamp({ withTimezone: true }),
    provider: text().notNull().default('none'),
    providerCustomerId: text(),
    providerSubscriptionId: text().unique(),
    pendingCheckout: boolean().notNull().default(false),
    /** Marca temporal do último evento do provedor aplicado (eventos fora de ordem são ignorados). */
    lastEventAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('subscriptions_status_ck', sql`${t.status} in ('trial', 'active', 'past_due', 'suspended', 'cancelled')`),
    check('subscriptions_interval_ck', sql`${t.interval} in ('monthly', 'annual')`),
  ],
);

export const subscriptionChanges = pgTable(
  'subscription_changes',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    kind: text().notNull(),
    fromState: jsonb(),
    toState: jsonb(),
    actorUserId: uuid().references(() => users.id),
    source: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.organizationId, t.createdAt)],
);

/** Todo webhook recebido. (provider, eventId) único = processamento idempotente. */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid().primaryKey().defaultRandom(),
    provider: text().notNull(),
    eventId: text().notNull(),
    type: text().notNull(),
    providerCreatedAt: timestamp({ withTimezone: true }),
    organizationId: uuid(),
    payload: jsonb().notNull(),
    status: text().notNull().default('received'),
    error: text(),
    receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp({ withTimezone: true }),
  },
  (t) => [unique().on(t.provider, t.eventId), check('webhook_status_ck', sql`${t.status} in ('received', 'processed', 'ignored', 'failed')`)],
);

export const billingInvoices = pgTable('billing_invoices', {
  id: uuid().primaryKey().defaultRandom(),
  organizationId: uuid().notNull().references(() => organizations.id),
  providerInvoiceId: text().notNull().unique(),
  amount: numeric({ precision: 10, scale: 2 }).notNull(),
  currency: text().notNull(),
  status: text().notNull(),
  periodStart: timestamp({ withTimezone: true }),
  periodEnd: timestamp({ withTimezone: true }),
  hostedUrl: text(),
  paidAt: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** Versão dos termos aceita por quem contratou (marketing NÃO faz parte). */
export const termsAcceptances = pgTable('terms_acceptances', {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid().notNull().references(() => users.id),
  organizationId: uuid().references(() => organizations.id),
  document: text().notNull(),
  version: text().notNull(),
  ip: text(),
  acceptedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** Arquivo de exportação gerado de forma assíncrona; expira e é apagado. */
export const dataExports = pgTable(
  'data_exports',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    scope: text().notNull(),
    status: text().notNull().default('queued'),
    filename: text(),
    content: bytea(),
    rowCount: integer(),
    requestedBy: uuid().notNull().references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }),
    error: text(),
  },
  (t) => [check('data_exports_status_ck', sql`${t.status} in ('queued', 'ready', 'failed', 'expired')`)],
);
