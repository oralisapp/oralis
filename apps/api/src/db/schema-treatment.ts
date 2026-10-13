/**
 * Odontograma, planos de tratamento e orçamentos.
 * - Odontograma: histórico temporal — cada registro novo substitui o anterior, nada é apagado.
 * - Orçamento: cada apresentação gera uma VERSÃO imutável; a aprovação aponta a versão apresentada.
 * - Aprovação comercial não é consentimento clínico nem registro de execução.
 */
import { sql } from 'drizzle-orm';
import { boolean, check, date, foreignKey, index, integer, jsonb, numeric, pgTable, smallint, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { clinicUnits, organizations, patients, professionals, services, users } from './schema';

export const odontogramEntries = pgTable(
  'odontogram_entries',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull(),
    patientId: uuid().notNull(),
    /** Notação FDI (ISO 3950): 11–48 permanentes, 51–85 decíduos. */
    tooth: smallint().notNull(),
    surfaces: text().array().notNull().default(sql`'{}'::text[]`),
    condition: text().notNull(),
    status: text().notNull(),
    notes: text(),
    recordedBy: uuid().notNull().references(() => users.id),
    clinicalRecordId: uuid(),
    treatmentItemId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    supersededAt: timestamp({ withTimezone: true }),
    supersededBy: uuid().references(() => users.id),
  },
  (t) => [
    foreignKey({ columns: [t.patientId, t.organizationId], foreignColumns: [patients.id, patients.organizationId] }),
    check('odontogram_tooth_ck', sql`(${t.tooth} between 11 and 18) or (${t.tooth} between 21 and 28) or (${t.tooth} between 31 and 38) or (${t.tooth} between 41 and 48) or (${t.tooth} between 51 and 55) or (${t.tooth} between 61 and 65) or (${t.tooth} between 71 and 75) or (${t.tooth} between 81 and 85)`),
    check('odontogram_status_ck', sql`${t.status} in ('existing', 'planned', 'done')`),
    index().on(t.organizationId, t.patientId, t.tooth),
  ],
);

export const treatmentPlans = pgTable(
  'treatment_plans',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    patientId: uuid().notNull(),
    unitId: uuid().notNull(),
    title: text().notNull(),
    /** Objetivo descrito pelo profissional, em linguagem para o paciente. */
    objective: text(),
    status: text().notNull().default('draft'),
    responsibleProfessionalId: uuid(),
    sharedWithPatient: boolean().notNull().default(false),
    version: integer().notNull().default(1),
    createdBy: uuid().notNull().references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('treatment_plans_id_org_uq').on(t.id, t.organizationId),
    foreignKey({ columns: [t.patientId, t.organizationId], foreignColumns: [patients.id, patients.organizationId] }),
    foreignKey({ columns: [t.unitId, t.organizationId], foreignColumns: [clinicUnits.id, clinicUnits.organizationId] }),
    foreignKey({ columns: [t.responsibleProfessionalId, t.organizationId], foreignColumns: [professionals.id, professionals.organizationId] }),
    check('treatment_plans_status_ck', sql`${t.status} in ('draft', 'presented', 'approved', 'rejected', 'in_progress', 'completed', 'cancelled')`),
    index().on(t.organizationId, t.patientId),
    index().on(t.organizationId, t.status),
  ],
);

export const treatmentItems = pgTable(
  'treatment_items',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull(),
    planId: uuid().notNull(),
    stage: smallint().notNull().default(1),
    sortOrder: integer().notNull().default(0),
    priority: text().notNull().default('normal'),
    description: text().notNull(),
    serviceId: uuid(),
    tooth: smallint(),
    surfaces: text().array().notNull().default(sql`'{}'::text[]`),
    professionalId: uuid(),
    /** Dependência registrada pelo profissional (informativa: o sistema não a infere). */
    dependsOnItemId: uuid(),
    sessionsPlanned: smallint().notNull().default(1),
    unitPrice: numeric({ precision: 12, scale: 2 }).notNull().default('0'),
    status: text().notNull().default('planned'),
    doneAt: timestamp({ withTimezone: true }),
    clinicalRecordId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('treatment_items_id_org_uq').on(t.id, t.organizationId),
    foreignKey({ columns: [t.planId, t.organizationId], foreignColumns: [treatmentPlans.id, treatmentPlans.organizationId] }).onDelete('cascade'),
    foreignKey({ columns: [t.serviceId, t.organizationId], foreignColumns: [services.id, services.organizationId] }),
    foreignKey({ columns: [t.professionalId, t.organizationId], foreignColumns: [professionals.id, professionals.organizationId] }),
    check('treatment_items_status_ck', sql`${t.status} in ('planned', 'scheduled', 'done', 'cancelled')`),
    check('treatment_items_priority_ck', sql`${t.priority} in ('low', 'normal', 'high')`),
    check('treatment_items_price_ck', sql`${t.unitPrice} >= 0`),
    index().on(t.planId),
  ],
);

export const quotes = pgTable(
  'quotes',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    planId: uuid().notNull(),
    patientId: uuid().notNull(),
    status: text().notNull().default('presented'),
    currentVersionId: uuid(),
    lastContactAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('quotes_id_org_uq').on(t.id, t.organizationId),
    foreignKey({ columns: [t.planId, t.organizationId], foreignColumns: [treatmentPlans.id, treatmentPlans.organizationId] }),
    check('quotes_status_ck', sql`${t.status} in ('presented', 'approved', 'rejected', 'expired')`),
    index().on(t.organizationId, t.status),
  ],
);

/** Versão apresentada do orçamento: fotografia imutável de itens, valores e condições. */
export const quoteVersions = pgTable(
  'quote_versions',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull(),
    quoteId: uuid().notNull(),
    version: integer().notNull(),
    items: jsonb().notNull(),
    subtotal: numeric({ precision: 12, scale: 2 }).notNull(),
    discount: numeric({ precision: 12, scale: 2 }).notNull().default('0'),
    discountReason: text(),
    total: numeric({ precision: 12, scale: 2 }).notNull(),
    /** { installments, method, firstDueDate } */
    paymentTerms: jsonb().notNull(),
    validUntil: date({ mode: 'string' }).notNull(),
    presentedBy: uuid().notNull().references(() => users.id),
    presentedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.quoteId, t.version),
    unique('quote_versions_id_org_uq').on(t.id, t.organizationId),
    foreignKey({ columns: [t.quoteId, t.organizationId], foreignColumns: [quotes.id, quotes.organizationId] }),
    check('quote_versions_total_ck', sql`${t.total} = ${t.subtotal} - ${t.discount} and ${t.discount} >= 0 and ${t.total} >= 0`),
  ],
);

export const quoteDecisions = pgTable(
  'quote_decisions',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull(),
    quoteId: uuid().notNull(),
    versionId: uuid().notNull(),
    decision: text().notNull(),
    reason: text(),
    /** clinic = registrado pela equipe; portal = aceite pelo paciente no portal. */
    via: text().notNull(),
    decidedBy: uuid().references(() => users.id),
    acknowledgedName: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.versionId, t.organizationId], foreignColumns: [quoteVersions.id, quoteVersions.organizationId] }),
    check('quote_decisions_decision_ck', sql`${t.decision} in ('approved', 'rejected')`),
    check('quote_decisions_via_ck', sql`${t.via} in ('clinic', 'portal')`),
  ],
);

