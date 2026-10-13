/**
 * Modelo de dados do incremento 1.
 *
 * Multi-tenancy: toda tabela de negócio tem `organization_id`. Referências
 * entre recursos de uma organização usam chave estrangeira COMPOSTA
 * (id, organization_id), de modo que o próprio banco recusa, por exemplo,
 * uma consulta da organização A apontando para um paciente da organização B.
 *
 * Restrições que o Drizzle não expressa (exclusion constraints da agenda,
 * gatilhos de somente-inserção, índice trigram) estão na migração
 * `drizzle/0001_integrity.sql`.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const timestamps = {
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
};

// ------------------------------------------------------------------ Identidade

export const users = pgTable('users', {
  id: uuid().primaryKey().defaultRandom(),
  /** Sempre gravado em minúsculas. */
  email: text().notNull().unique(),
  name: text().notNull(),
  /** argon2id. Nunca exposto pela API. */
  passwordHash: text().notNull(),
  disabledAt: timestamp({ withTimezone: true }),
  ...timestamps,
});

/** Sessões opacas e revogáveis. Só o hash SHA-256 do token é armazenado. */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text().notNull().unique(),
    ip: text(),
    userAgent: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.userId)],
);

// ---------------------------------------------------------------- Organização

export const organizations = pgTable(
  'organizations',
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    status: text().notNull().default('active'),
    /** Organização de demonstração: nunca envia comunicações reais. */
    isDemo: boolean().notNull().default(false),
    /** Exige MFA de proprietários e gestores para acessar a organização. */
    requireMfaPrivileged: boolean().notNull().default(false),
    createdBy: uuid().notNull().references(() => users.id),
    ...timestamps,
  },
  (t) => [check('organizations_status_ck', sql`${t.status} in ('active', 'suspended', 'archived')`)],
);

export const clinicUnits = pgTable(
  'clinic_units',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    name: text().notNull(),
    /** Fuso IANA usado para interpretar a agenda desta unidade. */
    timezone: text().notNull(),
    phone: text(),
    addressLine: text(),
    city: text(),
    state: text(),
    active: boolean().notNull().default(true),
    ...timestamps,
  },
  (t) => [unique('clinic_units_id_org_uq').on(t.id, t.organizationId), unique().on(t.organizationId, t.name)],
);

export const businessHours = pgTable(
  'business_hours',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull(),
    unitId: uuid().notNull(),
    weekday: smallint().notNull(),
    opensAt: text().notNull(),
    closesAt: text().notNull(),
  },
  (t) => [
    foreignKey({ columns: [t.unitId, t.organizationId], foreignColumns: [clinicUnits.id, clinicUnits.organizationId] }).onDelete('cascade'),
    check('business_hours_weekday_ck', sql`${t.weekday} between 0 and 6`),
    check('business_hours_range_ck', sql`${t.opensAt} < ${t.closesAt}`),
    index().on(t.unitId, t.weekday),
  ],
);

// -------------------------------------------------------- Papéis e permissões

export const roles = pgTable(
  'roles',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    /** Chave do papel de sistema (owner, manager…); null para papéis personalizados futuros. */
    key: text(),
    name: text().notNull(),
    description: text(),
    isSystem: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('roles_id_org_uq').on(t.id, t.organizationId), unique().on(t.organizationId, t.key)],
);

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid().notNull().references(() => roles.id, { onDelete: 'cascade' }),
    permission: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permission] })],
);

export const memberships = pgTable(
  'memberships',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    userId: uuid().notNull().references(() => users.id),
    roleId: uuid().notNull(),
    status: text().notNull().default('active'),
    /** true = atua em todas as unidades, inclusive as criadas no futuro. */
    allUnits: boolean().notNull().default(false),
    ...timestamps,
  },
  (t) => [
    unique('memberships_id_org_uq').on(t.id, t.organizationId),
    unique().on(t.organizationId, t.userId),
    foreignKey({ columns: [t.roleId, t.organizationId], foreignColumns: [roles.id, roles.organizationId] }),
    check('memberships_status_ck', sql`${t.status} in ('active', 'suspended', 'removed')`),
    index().on(t.userId),
  ],
);

export const membershipUnits = pgTable(
  'membership_units',
  {
    membershipId: uuid().notNull(),
    unitId: uuid().notNull(),
    organizationId: uuid().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.membershipId, t.unitId] }),
    foreignKey({ columns: [t.membershipId, t.organizationId], foreignColumns: [memberships.id, memberships.organizationId] }).onDelete('cascade'),
    foreignKey({ columns: [t.unitId, t.organizationId], foreignColumns: [clinicUnits.id, clinicUnits.organizationId] }),
  ],
);

export const invitations = pgTable(
  'invitations',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    email: text().notNull(),
    roleId: uuid().notNull(),
    allUnits: boolean().notNull().default(false),
    unitIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    /** Hash SHA-256 do token do link. O token em si é mostrado uma única vez. */
    tokenHash: text().notNull().unique(),
    invitedBy: uuid().notNull().references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    acceptedAt: timestamp({ withTimezone: true }),
    acceptedBy: uuid().references(() => users.id),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    foreignKey({ columns: [t.roleId, t.organizationId], foreignColumns: [roles.id, roles.organizationId] }),
    index().on(t.organizationId, t.email),
  ],
);

// ------------------------------------------------- Profissionais e recursos

export const professionals = pgTable(
  'professionals',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    /** Usuário vinculado (necessário para "iniciar os próprios atendimentos"). */
    membershipId: uuid(),
    displayName: text().notNull(),
    croNumber: text(),
    croUf: text(),
    specialties: text().array().notNull().default(sql`'{}'::text[]`),
    color: text().notNull(),
    active: boolean().notNull().default(true),
    ...timestamps,
  },
  (t) => [
    unique('professionals_id_org_uq').on(t.id, t.organizationId),
    unique().on(t.organizationId, t.membershipId),
    foreignKey({ columns: [t.membershipId, t.organizationId], foreignColumns: [memberships.id, memberships.organizationId] }),
  ],
);

export const professionalUnits = pgTable(
  'professional_units',
  {
    professionalId: uuid().notNull(),
    unitId: uuid().notNull(),
    organizationId: uuid().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.professionalId, t.unitId] }),
    foreignKey({ columns: [t.professionalId, t.organizationId], foreignColumns: [professionals.id, professionals.organizationId] }).onDelete('cascade'),
    foreignKey({ columns: [t.unitId, t.organizationId], foreignColumns: [clinicUnits.id, clinicUnits.organizationId] }),
  ],
);

/** Cadeiras e salas de atendimento (recurso físico da agenda). */
export const chairs = pgTable(
  'chairs',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    unitId: uuid().notNull(),
    name: text().notNull(),
    kind: text().notNull().default('chair'),
    active: boolean().notNull().default(true),
    ...timestamps,
  },
  (t) => [
    unique('chairs_id_org_uq').on(t.id, t.organizationId),
    unique().on(t.unitId, t.name),
    foreignKey({ columns: [t.unitId, t.organizationId], foreignColumns: [clinicUnits.id, clinicUnits.organizationId] }),
    check('chairs_kind_ck', sql`${t.kind} in ('chair', 'room')`),
  ],
);

export const services = pgTable(
  'services',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    name: text().notNull(),
    durationMinutes: integer().notNull(),
    /** Preço de referência (BRL). numeric evita erro de ponto flutuante. */
    price: numeric({ precision: 12, scale: 2 }),
    active: boolean().notNull().default(true),
    ...timestamps,
  },
  (t) => [
    unique('services_id_org_uq').on(t.id, t.organizationId),
    unique().on(t.organizationId, t.name),
    check('services_duration_ck', sql`${t.durationMinutes} between 5 and 480`),
    check('services_price_ck', sql`${t.price} is null or ${t.price} >= 0`),
  ],
);

// ------------------------------------------------------------------ Pacientes

export const patients = pgTable(
  'patients',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    fullName: text().notNull(),
    socialName: text(),
    /** Nome normalizado (minúsculas, sem acentos) para busca. */
    searchName: text().notNull(),
    birthDate: date({ mode: 'string' }),
    /** Dado pessoal: apenas dígitos. */
    cpf: text(),
    phone: text(),
    email: text(),
    administrativeNotes: text(),
    status: text().notNull().default('active'),
    version: integer().notNull().default(1),
    createdBy: uuid().notNull().references(() => users.id),
    ...timestamps,
  },
  (t) => [
    unique('patients_id_org_uq').on(t.id, t.organizationId),
    uniqueIndex('patients_org_cpf_uq').on(t.organizationId, t.cpf).where(sql`${t.cpf} is not null`),
    index().on(t.organizationId, t.birthDate),
    check('patients_status_ck', sql`${t.status} in ('active', 'archived')`),
  ],
);

/** Consolidação administrativa; nenhum registro clínico é reescrito. */
export const patientImportBatches = pgTable('patient_import_batches', {
  organizationId: uuid().notNull().references(() => organizations.id), inputHash: text().notNull(),
  actorUserId: uuid().notNull().references(() => users.id), result: jsonb().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.organizationId, t.inputHash] })]);

export const patientMerges = pgTable('patient_merges', {
  sourceId: uuid().primaryKey(), targetId: uuid().notNull(), organizationId: uuid().notNull(),
  actorUserId: uuid().notNull().references(() => users.id), reason: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, t => [
  foreignKey({ columns: [t.sourceId, t.organizationId], foreignColumns: [patients.id, patients.organizationId] }),
  foreignKey({ columns: [t.targetId, t.organizationId], foreignColumns: [patients.id, patients.organizationId] }),
  check('patient_merges_different_ck', sql`${t.sourceId} <> ${t.targetId}`),
  index('patient_merges_target_idx').on(t.targetId, t.organizationId),
]);

// --------------------------------------------------------------------- Agenda

export const appointments = pgTable(
  'appointments',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    unitId: uuid().notNull(),
    patientId: uuid().notNull(),
    professionalId: uuid().notNull(),
    chairId: uuid(),
    serviceId: uuid(),
    startsAt: timestamp({ withTimezone: true }).notNull(),
    endsAt: timestamp({ withTimezone: true }).notNull(),
    status: text().notNull().default('scheduled'),
    cancellationReason: text(),
    /** Observação administrativa (não clínica). */
    notes: text(),
    /** Controle otimista de concorrência para reagendamentos e transições. */
    version: integer().notNull().default(1),
    /** Consultas criadas juntas por recorrência. */
    seriesId: uuid(),
    /** Agendada a partir da lista de espera. */
    waitlistEntryId: uuid(),
    /** Etapa do plano de tratamento atendida nesta consulta. */
    treatmentItemId: uuid(),
    createdBy: uuid().notNull().references(() => users.id),
    ...timestamps,
  },
  (t) => [
    unique('appointments_id_org_uq').on(t.id, t.organizationId),
    foreignKey({ columns: [t.unitId, t.organizationId], foreignColumns: [clinicUnits.id, clinicUnits.organizationId] }),
    foreignKey({ columns: [t.patientId, t.organizationId], foreignColumns: [patients.id, patients.organizationId] }),
    foreignKey({ columns: [t.professionalId, t.organizationId], foreignColumns: [professionals.id, professionals.organizationId] }),
    foreignKey({ columns: [t.chairId, t.organizationId], foreignColumns: [chairs.id, chairs.organizationId] }),
    foreignKey({ columns: [t.serviceId, t.organizationId], foreignColumns: [services.id, services.organizationId] }),
    check('appointments_range_ck', sql`${t.endsAt} > ${t.startsAt}`),
    check(
      'appointments_status_ck',
      sql`${t.status} in ('scheduled', 'confirmed', 'arrived', 'in_progress', 'completed', 'no_show', 'cancelled')`,
    ),
    check('appointments_cancel_reason_ck', sql`(${t.status} = 'cancelled') = (${t.cancellationReason} is not null)`),
    index().on(t.organizationId, t.unitId, t.startsAt),
    index().on(t.organizationId, t.patientId, t.startsAt),
    index().on(t.organizationId, t.professionalId, t.startsAt),
  ],
);

/** Histórico imutável de mudanças de status (gatilho impede UPDATE/DELETE). */
export const appointmentStatusHistory = pgTable(
  'appointment_status_history',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull(),
    appointmentId: uuid().notNull(),
    fromStatus: text(),
    toStatus: text().notNull(),
    reason: text(),
    note: text(),
    /** Nulo quando a mudança veio do paciente (link seguro / portal). */
    changedBy: uuid().references(() => users.id),
    /** staff | patient_link | patient_portal | automation */
    source: text().notNull().default('staff'),
    changedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.appointmentId, t.organizationId], foreignColumns: [appointments.id, appointments.organizationId] }),
    index().on(t.appointmentId, t.changedAt),
  ],
);

// ------------------------------------------------------------------ Auditoria

/**
 * Trilha de auditoria somente-inserção. `metadata` nunca recebe conteúdo
 * clínico nem valores de dados pessoais — apenas identificadores, nomes de
 * campos alterados e valores administrativos (ex.: horários).
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().references(() => organizations.id),
    actorUserId: uuid().references(() => users.id),
    action: text().notNull(),
    entityType: text().notNull(),
    entityId: uuid(),
    unitId: uuid(),
    metadata: jsonb().notNull().default({}),
    ip: text(),
    userAgent: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index().on(t.organizationId, t.createdAt),
    index().on(t.organizationId, t.entityType, t.entityId),
  ],
);

export * from './schema-platform';
export * from './schema-agenda';
export * from './schema-clinical';
export * from './schema-treatment';
export * from './schema-finance';
export * from './schema-billing';
export * from './schema-portal';
export * from './schema-ops';
