/**
 * Operação: relacionamento (CRM), comunicações, automações, estoque e laboratórios.
 */
import { sql } from 'drizzle-orm';
import { boolean, check, date, foreignKey, index, integer, jsonb, numeric, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { clinicUnits, memberships, organizations, patients, professionals, services, users } from './schema';

// ---------------------------------------------------------------------- CRM

export const crmLeads = pgTable(
  'crm_leads',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    unitId: uuid(),
    name: text().notNull(),
    phone: text(),
    email: text(),
    source: text().notNull(),
    stage: text().notNull().default('contact'),
    ownerMembershipId: uuid(),
    patientId: uuid(),
    lostReason: text(),
    notes: text(),
    stageChangedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid().references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.patientId, t.organizationId], foreignColumns: [patients.id, patients.organizationId] }),
    foreignKey({ columns: [t.ownerMembershipId, t.organizationId], foreignColumns: [memberships.id, memberships.organizationId] }),
    check('crm_leads_stage_ck', sql`${t.stage} in ('contact', 'evaluation_scheduled', 'evaluation_done', 'quote_sent', 'approved', 'in_treatment', 'follow_up', 'lost')`),
    check('crm_leads_source_ck', sql`${t.source} in ('referral', 'instagram', 'google', 'website', 'walk_in', 'phone', 'partnership', 'other')`),
    index().on(t.organizationId, t.stage),
  ],
);

export const crmInteractions = pgTable(
  'crm_interactions',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    leadId: uuid().references(() => crmLeads.id),
    patientId: uuid(),
    kind: text().notNull(),
    summary: text().notNull(),
    createdBy: uuid().notNull().references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('crm_interactions_kind_ck', sql`${t.kind} in ('call', 'whatsapp', 'email', 'visit', 'note')`), index().on(t.organizationId, t.patientId)],
);

// ------------------------------------------------------------ Comunicações

/** Modelo de mensagem. Editar cria nova versão (mesma chave). */
export const messageTemplates = pgTable(
  'message_templates',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    key: uuid().notNull(),
    version: integer().notNull(),
    name: text().notNull(),
    category: text().notNull(),
    channel: text().notNull(),
    subject: text(),
    body: text().notNull(),
    active: boolean().notNull().default(true),
    createdBy: uuid().references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.key, t.version),
    check('message_templates_category_ck', sql`${t.category} in ('transactional', 'relationship', 'promotional')`),
    check('message_templates_channel_ck', sql`${t.channel} in ('email', 'sms', 'whatsapp')`),
  ],
);

/**
 * Registro de cada comunicação. O estado vem do provedor quando ele o
 * informa; NUNCA se registra "lida" sem confirmação do provedor.
 */
export const communicationEvents = pgTable(
  'communication_events',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    patientId: uuid(),
    channel: text().notNull(),
    category: text().notNull(),
    templateId: uuid(),
    templateVersion: integer(),
    subject: text(),
    body: text().notNull(),
    status: text().notNull(),
    statusDetail: text(),
    providerMessageId: text(),
    sentBy: uuid().references(() => users.id),
    automationId: uuid(),
    campaignId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('communication_events_status_ck', sql`${t.status} in ('queued', 'sent', 'logged_locally', 'failed', 'not_configured', 'blocked_consent', 'blocked_frequency', 'blocked_demo')`),
    index().on(t.organizationId, t.createdAt),
    index().on(t.organizationId, t.patientId),
  ],
);

export const campaigns = pgTable('campaigns', {
  id: uuid().primaryKey().defaultRandom(),
  organizationId: uuid().notNull().references(() => organizations.id),
  name: text().notNull(),
  templateId: uuid().notNull(),
  criteria: jsonb().notNull(),
  recipientCount: integer().notNull(),
  status: text().notNull().default('sent'),
  createdBy: uuid().notNull().references(() => users.id),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

// -------------------------------------------------------------- Automações

export const automations = pgTable(
  'automations',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    unitId: uuid(),
    templateKey: text().notNull(),
    name: text().notNull(),
    description: text(),
    config: jsonb().notNull(),
    channel: text(),
    messageTemplateId: uuid(),
    windowStart: text().notNull().default('08:00'),
    windowEnd: text().notNull().default('20:00'),
    timezone: text().notNull().default('America/Sao_Paulo'),
    /** Intervalo mínimo entre ações da automação para o mesmo paciente. */
    frequencyLimitHours: integer().notNull().default(72),
    status: text().notNull().default('paused'),
    version: integer().notNull().default(1),
    ownerUserId: uuid().notNull().references(() => users.id),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('automations_status_ck', sql`${t.status} in ('active', 'paused')`),
    check('automations_template_ck', sql`${t.templateKey} in ('confirmation', 'vacancy', 'quote_followup', 'continuity', 'stock_minimum', 'overdue_receivable')`),
  ],
);

export const automationVersions = pgTable('automation_versions', {
  id: uuid().primaryKey().defaultRandom(),
  automationId: uuid().notNull().references(() => automations.id),
  version: integer().notNull(),
  snapshot: jsonb().notNull(),
  changedBy: uuid().notNull().references(() => users.id),
  changedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const automationExecutions = pgTable(
  'automation_executions',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull(),
    automationId: uuid().notNull().references(() => automations.id),
    entityType: text().notNull(),
    entityId: uuid().notNull(),
    patientId: uuid(),
    /** Uma ação lógica por entidade e situação: impede duplicidade. */
    dedupeKey: text().notNull().unique(),
    status: text().notNull(),
    reason: text(),
    action: text(),
    result: jsonb(),
    executedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('automation_exec_status_ck', sql`${t.status} in ('done', 'skipped', 'failed')`), index().on(t.automationId, t.executedAt)],
);

// ------------------------------------------------------------------ Estoque

export const suppliers = pgTable('suppliers', {
  id: uuid().primaryKey().defaultRandom(),
  organizationId: uuid().notNull().references(() => organizations.id),
  name: text().notNull(),
  contact: text(),
  phone: text(),
  email: text(),
  active: boolean().notNull().default(true),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const inventoryItems = pgTable(
  'inventory_items',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    name: text().notNull(),
    category: text(),
    unitMeasure: text().notNull(),
    minQuantity: numeric({ precision: 12, scale: 3 }).notNull().default('0'),
    active: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('inventory_items_id_org_uq').on(t.id, t.organizationId), unique().on(t.organizationId, t.name)],
);

export const inventoryLots = pgTable(
  'inventory_lots',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull(),
    itemId: uuid().notNull(),
    lotCode: text().notNull(),
    expiresOn: date({ mode: 'string' }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('inventory_lots_id_org_uq').on(t.id, t.organizationId), unique().on(t.itemId, t.lotCode), foreignKey({ columns: [t.itemId, t.organizationId], foreignColumns: [inventoryItems.id, inventoryItems.organizationId] })],
);

/** Movimentação (somente-inserção). Quantidade sempre positiva; o tipo define o sinal. */
export const stockMovements = pgTable(
  'stock_movements',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull(),
    itemId: uuid().notNull(),
    lotId: uuid(),
    unitId: uuid().notNull(),
    type: text().notNull(),
    quantity: numeric({ precision: 12, scale: 3 }).notNull(),
    unitCost: numeric({ precision: 12, scale: 2 }),
    reason: text(),
    supplierId: uuid(),
    appointmentId: uuid(),
    transferId: uuid(),
    createdBy: uuid().references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.itemId, t.organizationId], foreignColumns: [inventoryItems.id, inventoryItems.organizationId] }),
    foreignKey({ columns: [t.lotId, t.organizationId], foreignColumns: [inventoryLots.id, inventoryLots.organizationId] }),
    foreignKey({ columns: [t.unitId, t.organizationId], foreignColumns: [clinicUnits.id, clinicUnits.organizationId] }),
    check('stock_movements_type_ck', sql`${t.type} in ('in', 'out', 'adjust_in', 'adjust_out', 'transfer_in', 'transfer_out', 'consumption')`),
    check('stock_movements_qty_ck', sql`${t.quantity} > 0`),
    check('stock_movements_reason_ck', sql`${t.type} not in ('adjust_in', 'adjust_out') or (${t.reason} is not null and length(${t.reason}) >= 3)`),
    index().on(t.organizationId, t.itemId, t.unitId),
  ],
);

/** Materiais consumidos por um serviço (baixa automática ao concluir a consulta). */
export const serviceMaterials = pgTable(
  'service_materials',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull(),
    serviceId: uuid().notNull(),
    itemId: uuid().notNull(),
    quantity: numeric({ precision: 12, scale: 3 }).notNull(),
  },
  (t) => [
    unique().on(t.serviceId, t.itemId),
    foreignKey({ columns: [t.serviceId, t.organizationId], foreignColumns: [services.id, services.organizationId] }),
    foreignKey({ columns: [t.itemId, t.organizationId], foreignColumns: [inventoryItems.id, inventoryItems.organizationId] }),
  ],
);

// -------------------------------------------------------------- Laboratórios

export const laboratories = pgTable('laboratories', {
  id: uuid().primaryKey().defaultRandom(),
  organizationId: uuid().notNull().references(() => organizations.id),
  name: text().notNull(),
  phone: text(),
  email: text(),
  notes: text(),
  active: boolean().notNull().default(true),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const laboratoryOrders = pgTable(
  'laboratory_orders',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    unitId: uuid().notNull(),
    patientId: uuid().notNull(),
    laboratoryId: uuid().notNull().references(() => laboratories.id),
    professionalId: uuid(),
    treatmentItemId: uuid(),
    work: text().notNull(),
    instructions: text(),
    shade: text(),
    dueDate: date({ mode: 'string' }).notNull(),
    cost: numeric({ precision: 12, scale: 2 }),
    status: text().notNull().default('requested'),
    reworkCount: integer().notNull().default(0),
    documentIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    createdBy: uuid().notNull().references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.patientId, t.organizationId], foreignColumns: [patients.id, patients.organizationId] }),
    foreignKey({ columns: [t.professionalId, t.organizationId], foreignColumns: [professionals.id, professionals.organizationId] }),
    foreignKey({ columns: [t.unitId, t.organizationId], foreignColumns: [clinicUnits.id, clinicUnits.organizationId] }),
    check('laboratory_orders_status_ck', sql`${t.status} in ('requested', 'sent', 'in_production', 'received', 'delivered', 'cancelled')`),
    index().on(t.organizationId, t.status, t.dueDate),
  ],
);

export const laboratoryOrderEvents = pgTable('laboratory_order_events', {
  id: uuid().primaryKey().defaultRandom(),
  organizationId: uuid().notNull(),
  orderId: uuid().notNull().references(() => laboratoryOrders.id),
  fromStatus: text(),
  toStatus: text().notNull(),
  rework: boolean().notNull().default(false),
  note: text(),
  createdBy: uuid().notNull().references(() => users.id),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

