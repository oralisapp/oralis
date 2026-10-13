/**
 * Portal do paciente: acesso separado da equipe. O paciente entra por um
 * link de uso único (escopo: um paciente de uma organização) que abre uma
 * sessão curta e revogável. Nunca compartilha cookie nem permissões com a equipe.
 */
import { foreignKey, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations, patients, users } from './schema';

export const patientPortalTokens = pgTable(
  'patient_portal_tokens',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    patientId: uuid().notNull(),
    tokenHash: text().notNull().unique(),
    createdBy: uuid().references(() => users.id),
    source: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    usedAt: timestamp({ withTimezone: true }),
  },
  (t) => [foreignKey({ columns: [t.patientId, t.organizationId], foreignColumns: [patients.id, patients.organizationId] })],
);

export const patientSessions = pgTable(
  'patient_sessions',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().notNull().references(() => organizations.id),
    patientId: uuid().notNull(),
    tokenHash: text().notNull().unique(),
    ip: text(),
    userAgent: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [foreignKey({ columns: [t.patientId, t.organizationId], foreignColumns: [patients.id, patients.organizationId] }), index().on(t.patientId)],
);
