/**
 * Prontuário. Separado dos dados administrativos e financeiros; acesso
 * exige permissões `clinical.*`. Registros finalizados são imutáveis no
 * banco (gatilho) — correções entram como adendos.
 */
import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { appointments, clinicUnits, organizations, patients, professionals, users } from './schema';

/** Atendimento: nasce quando a consulta passa para "em atendimento". */
export const encounters = pgTable(
  'encounters',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    unitId: uuid().notNull(),
    appointmentId: uuid().notNull(),
    patientId: uuid().notNull(),
    professionalId: uuid().notNull(),
    startedAt: timestamp({ withTimezone: true }).notNull(),
    endedAt: timestamp({ withTimezone: true }),
    startedBy: uuid().references(() => users.id),
  },
  (t) => [
    unique('encounters_id_org_uq').on(t.id, t.organizationId),
    unique('encounters_appointment_uq').on(t.appointmentId),
    foreignKey({ columns: [t.appointmentId, t.organizationId], foreignColumns: [appointments.id, appointments.organizationId] }),
    foreignKey({ columns: [t.patientId, t.organizationId], foreignColumns: [patients.id, patients.organizationId] }),
    foreignKey({ columns: [t.professionalId, t.organizationId], foreignColumns: [professionals.id, professionals.organizationId] }),
    foreignKey({ columns: [t.unitId, t.organizationId], foreignColumns: [clinicUnits.id, clinicUnits.organizationId] }),
  ],
);

/** Evolução clínica. `contentHash` = SHA-256 do conteúdo canônico no momento da finalização. */
export const clinicalRecords = pgTable(
  'clinical_records',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    unitId: uuid().notNull(),
    patientId: uuid().notNull(),
    professionalId: uuid().notNull(),
    encounterId: uuid(),
    authorUserId: uuid().notNull().references(() => users.id),
    kind: text().notNull().default('evolution'),
    status: text().notNull().default('draft'),
    content: text().notNull().default(''),
    /** Procedimentos registrados na sessão: [{ description, serviceId?, tooth?, surfaces?, treatmentItemId? }]. */
    procedures: jsonb().notNull().default([]),
    version: integer().notNull().default(1),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid().references(() => users.id),
    finalizedAt: timestamp({ withTimezone: true }),
    finalizedBy: uuid().references(() => users.id),
    contentHash: text(),
  },
  (t) => [
    unique('clinical_records_id_org_uq').on(t.id, t.organizationId),
    foreignKey({ columns: [t.patientId, t.organizationId], foreignColumns: [patients.id, patients.organizationId] }),
    foreignKey({ columns: [t.professionalId, t.organizationId], foreignColumns: [professionals.id, professionals.organizationId] }),
    foreignKey({ columns: [t.encounterId, t.organizationId], foreignColumns: [encounters.id, encounters.organizationId] }),
    check('clinical_records_status_ck', sql`${t.status} in ('draft', 'finalized')`),
    check('clinical_records_finalized_ck', sql`(${t.status} = 'finalized') = (${t.finalizedAt} is not null and ${t.contentHash} is not null)`),
    index().on(t.organizationId, t.patientId, t.createdAt),
  ],
);

export const clinicalRecordAmendments = pgTable(
  'clinical_record_amendments',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull(),
    recordId: uuid().notNull(),
    authorUserId: uuid().notNull().references(() => users.id),
    content: text().notNull(),
    contentHash: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [foreignKey({ columns: [t.recordId, t.organizationId], foreignColumns: [clinicalRecords.id, clinicalRecords.organizationId] })],
);

/** Modelo de anamnese. Editar cria nova versão (mesmo `templateKey`); respostas apontam a versão usada. */
export const anamnesisTemplates = pgTable(
  'anamnesis_templates',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    templateKey: uuid().notNull(),
    name: text().notNull(),
    version: integer().notNull(),
    /** [{ id, label, type: 'yesno'|'text'|'choice', options?, flagWhen?: 'yes' }] */
    questions: jsonb().notNull(),
    status: text().notNull().default('active'),
    createdBy: uuid().references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('anamnesis_templates_id_org_uq').on(t.id, t.organizationId),
    unique().on(t.templateKey, t.version),
    check('anamnesis_templates_status_ck', sql`${t.status} in ('active', 'archived')`),
  ],
);

/** Resposta de anamnese (somente-inserção). Respostas do paciente ficam pendentes de revisão profissional. */
export const anamnesisResponses = pgTable(
  'anamnesis_responses',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull(),
    patientId: uuid().notNull(),
    templateId: uuid().notNull(),
    answers: jsonb().notNull(),
    source: text().notNull().default('staff'),
    recordedBy: uuid().references(() => users.id),
    reviewedBy: uuid().references(() => users.id),
    reviewOfId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.patientId, t.organizationId], foreignColumns: [patients.id, patients.organizationId] }),
    foreignKey({ columns: [t.templateId, t.organizationId], foreignColumns: [anamnesisTemplates.id, anamnesisTemplates.organizationId] }),
    check('anamnesis_source_ck', sql`${t.source} in ('staff', 'patient_portal')`),
    index().on(t.patientId, t.createdAt),
  ],
);

/** Alertas clínicos registrados por profissional (alergias, medicamentos, condições). */
export const clinicalAlerts = pgTable(
  'clinical_alerts',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull(),
    patientId: uuid().notNull(),
    kind: text().notNull(),
    description: text().notNull(),
    severity: text().notNull().default('attention'),
    active: boolean().notNull().default(true),
    createdBy: uuid().notNull().references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp({ withTimezone: true }),
    resolvedBy: uuid().references(() => users.id),
  },
  (t) => [
    foreignKey({ columns: [t.patientId, t.organizationId], foreignColumns: [patients.id, patients.organizationId] }),
    check('clinical_alerts_kind_ck', sql`${t.kind} in ('allergy', 'medication', 'condition', 'other')`),
    check('clinical_alerts_severity_ck', sql`${t.severity} in ('info', 'attention', 'critical')`),
  ],
);

/** Documentos e anexos do paciente. O arquivo fica no armazenamento privado; aqui só metadados. */
export const documents = pgTable(
  'documents',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    patientId: uuid().notNull(),
    category: text().notNull(),
    title: text().notNull(),
    currentVersion: integer().notNull().default(1),
    /** Disponível no portal do paciente (decisão da clínica). */
    sharedWithPatient: boolean().notNull().default(false),
    encounterId: uuid(),
    createdBy: uuid().references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    unique('documents_id_org_uq').on(t.id, t.organizationId),
    foreignKey({ columns: [t.patientId, t.organizationId], foreignColumns: [patients.id, patients.organizationId] }),
    check('documents_category_ck', sql`${t.category} in ('exam', 'photo', 'clinical_document', 'orientation', 'consent', 'administrative', 'other')`),
    index().on(t.organizationId, t.patientId),
  ],
);

export const documentVersions = pgTable(
  'document_versions',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull(),
    documentId: uuid().notNull(),
    version: integer().notNull(),
    storageKey: text().notNull(),
    filename: text().notNull(),
    mimeType: text().notNull(),
    sizeBytes: integer().notNull(),
    sha256: text().notNull(),
    uploadedBy: uuid().references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.documentId, t.version),
    foreignKey({ columns: [t.documentId, t.organizationId], foreignColumns: [documents.id, documents.organizationId] }),
  ],
);

/** Modelos de orientações e documentos clínicos com campos substituíveis. */
export const documentTemplates = pgTable('document_templates', {
  id: uuid().primaryKey().defaultRandom(),
  organizationId: uuid().notNull().references(() => organizations.id),
  name: text().notNull(),
  category: text().notNull().default('orientation'),
  body: text().notNull(),
  active: boolean().notNull().default(true),
  createdBy: uuid().references(() => users.id),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
