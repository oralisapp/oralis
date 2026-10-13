/**
 * Plataforma: recuperação de senha, MFA, e-mails, limite de tentativas e
 * fila de tarefas persistente (substitui Redis enquanto houver um só banco).
 */
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations, users } from './schema';

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text().notNull().unique(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    usedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.userId)],
);

/** Segredo TOTP cifrado (AES-256-GCM). `enabledAt` nulo = cadastro iniciado e não confirmado. */
export const userMfa = pgTable('user_mfa', {
  userId: uuid().primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  secretEncrypted: text().notNull(),
  enabledAt: timestamp({ withTimezone: true }),
  /** Último passo de 30 s aceito: impede reutilizar o mesmo código. */
  lastUsedStep: integer(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const mfaRecoveryCodes = pgTable(
  'mfa_recovery_codes',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text().notNull(),
    usedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.userId)],
);

/** Segunda etapa do login: senha correta, aguardando o código. */
export const mfaChallenges = pgTable('mfa_challenges', {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text().notNull().unique(),
  attempts: integer().notNull().default(0),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  usedAt: timestamp({ withTimezone: true }),
});

/**
 * Registro de todo e-mail. Com SMTP configurado o corpo é apagado após o
 * envio (pode conter links com token). Sem SMTP (só fora de produção) a
 * mensagem fica na caixa de saída local para o desenvolvedor.
 */
export const emailMessages = pgTable(
  'email_messages',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().references(() => organizations.id),
    toAddress: text().notNull(),
    subject: text().notNull(),
    bodyText: text(),
    bodyHtml: text(),
    category: text().notNull().default('transactional'),
    status: text().notNull().default('pending'),
    attempts: integer().notNull().default(0),
    lastError: text(),
    providerMessageId: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp({ withTimezone: true }),
    nextAttemptAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    check('email_messages_status_ck', sql`${t.status} in ('pending', 'sent', 'failed', 'logged')`),
    index().on(t.status, t.nextAttemptAt),
  ],
);

export const rateLimits = pgTable('rate_limits', {
  key: text().primaryKey(),
  hits: integer().notNull(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
});

/** Fila de tarefas assíncronas com tentativas controladas e registro de falhas. */
export const jobs = pgTable(
  'jobs',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().references(() => organizations.id),
    kind: text().notNull(),
    payload: jsonb().notNull().default({}),
    status: text().notNull().default('queued'),
    attempts: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(5),
    runAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp({ withTimezone: true }),
    lastError: text(),
    result: jsonb(),
    /** Evita enfileirar duas vezes a mesma tarefa lógica. */
    dedupeKey: text().unique(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    check('jobs_status_ck', sql`${t.status} in ('queued', 'running', 'done', 'failed', 'dead')`),
    index().on(t.status, t.runAt),
  ],
);

