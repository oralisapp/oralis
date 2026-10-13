/**
 * Agenda avançada: bloqueios, lista de espera, links de confirmação,
 * preferências de comunicação e tarefas operacionais.
 */
import { sql } from 'drizzle-orm';
import { boolean, check, date, foreignKey, index, integer, pgTable, smallint, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { appointments, chairs, clinicUnits, memberships, organizations, patients, professionals, services, users } from './schema';

/** Bloqueio de agenda (folga, férias, reunião, manutenção de cadeira). Ocorrências recorrentes compartilham `seriesId`. */
export const scheduleBlocks = pgTable(
  'schedule_blocks',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    unitId: uuid().notNull(),
    /** Nulo = vale para toda a unidade. */
    professionalId: uuid(),
    chairId: uuid(),
    kind: text().notNull().default('block'),
    reason: text(),
    startsAt: timestamp({ withTimezone: true }).notNull(),
    endsAt: timestamp({ withTimezone: true }).notNull(),
    seriesId: uuid(),
    createdBy: uuid().notNull().references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.unitId, t.organizationId], foreignColumns: [clinicUnits.id, clinicUnits.organizationId] }),
    foreignKey({ columns: [t.professionalId, t.organizationId], foreignColumns: [professionals.id, professionals.organizationId] }),
    foreignKey({ columns: [t.chairId, t.organizationId], foreignColumns: [chairs.id, chairs.organizationId] }),
    check('schedule_blocks_range_ck', sql`${t.endsAt} > ${t.startsAt}`),
    check('schedule_blocks_kind_ck', sql`${t.kind} in ('block', 'vacation', 'break', 'maintenance')`),
    index().on(t.organizationId, t.unitId, t.startsAt),
  ],
);

export const waitlistEntries = pgTable(
  'waitlist_entries',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    patientId: uuid().notNull(),
    /** Nulos = qualquer unidade/profissional/serviço. */
    unitId: uuid(),
    professionalId: uuid(),
    serviceId: uuid(),
    durationMinutes: integer().notNull(),
    /** Dias da semana aceitos (0 = domingo). Vazio = qualquer dia. */
    weekdays: smallint().array().notNull().default(sql`'{}'::smallint[]`),
    period: text().notNull().default('any'),
    earliestDate: date({ mode: 'string' }),
    latestDate: date({ mode: 'string' }),
    priority: smallint().notNull().default(0),
    notes: text(),
    status: text().notNull().default('active'),
    scheduledAppointmentId: uuid(),
    createdBy: uuid().notNull().references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('waitlist_id_org_uq').on(t.id, t.organizationId),
    foreignKey({ columns: [t.patientId, t.organizationId], foreignColumns: [patients.id, patients.organizationId] }),
    foreignKey({ columns: [t.unitId, t.organizationId], foreignColumns: [clinicUnits.id, clinicUnits.organizationId] }),
    foreignKey({ columns: [t.professionalId, t.organizationId], foreignColumns: [professionals.id, professionals.organizationId] }),
    foreignKey({ columns: [t.serviceId, t.organizationId], foreignColumns: [services.id, services.organizationId] }),
    check('waitlist_period_ck', sql`${t.period} in ('any', 'morning', 'afternoon', 'evening')`),
    check('waitlist_status_ck', sql`${t.status} in ('active', 'scheduled', 'removed')`),
    index().on(t.organizationId, t.status),
  ],
);

/** Link seguro para o paciente confirmar ou pedir reagendamento sem fazer login. */
export const appointmentLinks = pgTable(
  'appointment_links',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    appointmentId: uuid().notNull(),
    tokenHash: text().notNull().unique(),
    /** Versão da consulta quando o link foi criado: se ela mudar, o link deixa de valer. */
    appointmentVersion: integer().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    usedAt: timestamp({ withTimezone: true }),
    usedAction: text(),
    createdBy: uuid().references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [foreignKey({ columns: [t.appointmentId, t.organizationId], foreignColumns: [appointments.id, appointments.organizationId] })],
);

/**
 * Autorização de comunicação por canal e categoria.
 * Transacional (lembretes, confirmações) vale por padrão salvo recusa;
 * relacionamento e promocional exigem autorização explícita.
 */
export const communicationPreferences = pgTable(
  'communication_preferences',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    patientId: uuid().notNull(),
    channel: text().notNull(),
    category: text().notNull(),
    allowed: boolean().notNull(),
    source: text().notNull(),
    updatedBy: uuid().references(() => users.id),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.patientId, t.channel, t.category),
    foreignKey({ columns: [t.patientId, t.organizationId], foreignColumns: [patients.id, patients.organizationId] }),
    check('comm_pref_channel_ck', sql`${t.channel} in ('email', 'sms', 'whatsapp')`),
    check('comm_pref_category_ck', sql`${t.category} in ('transactional', 'relationship', 'promotional')`),
  ],
);

/** Preferências de atendimento com finalidade definida (sem classificações depreciativas). */
export const patientPreferences = pgTable('patient_preferences', {
  patientId: uuid().primaryKey().references(() => patients.id),
  organizationId: uuid().notNull().references(() => organizations.id),
  preferredChannel: text(),
  preferredPeriod: text(),
  accessibilityNeeds: text(),
  welcomeNotes: text(),
  updatedBy: uuid().references(() => users.id),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const patientRepresentatives = pgTable(
  'patient_representatives',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    patientId: uuid().notNull(),
    fullName: text().notNull(),
    relationship: text().notNull(),
    cpf: text(),
    phone: text(),
    email: text(),
    isLegalGuardian: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [foreignKey({ columns: [t.patientId, t.organizationId], foreignColumns: [patients.id, patients.organizationId] })],
);

/** Tarefas da equipe — manuais ou geradas por automações e pelo portal. */
export const tasks = pgTable(
  'tasks',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    unitId: uuid(),
    title: text().notNull(),
    description: text(),
    dueAt: timestamp({ withTimezone: true }),
    assigneeMembershipId: uuid(),
    /** Papel destinatário quando não há pessoa definida (ex.: recepção). */
    assigneeRoleKey: text(),
    status: text().notNull().default('open'),
    origin: text().notNull().default('manual'),
    relatedType: text(),
    relatedId: uuid(),
    /** Impede duplicar a mesma tarefa automática. */
    dedupeKey: text(),
    createdBy: uuid().references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp({ withTimezone: true }),
    completedBy: uuid().references(() => users.id),
  },
  (t) => [
    foreignKey({ columns: [t.assigneeMembershipId, t.organizationId], foreignColumns: [memberships.id, memberships.organizationId] }),
    check('tasks_status_ck', sql`${t.status} in ('open', 'done', 'cancelled')`),
    unique('tasks_org_dedupe_uq').on(t.organizationId, t.dedupeKey),
    index().on(t.organizationId, t.status, t.dueAt),
  ],
);
