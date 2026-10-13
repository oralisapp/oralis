import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { env } from '../config/env';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Repositórios aceitam tanto a conexão quanto uma transação em andamento. */
export type DbOrTx = Db | Tx;

export const DB = Symbol('DB');
export const DB_POOL = Symbol('DB_POOL');

export function createPool(url: string): Pool {
  return new Pool({ connectionString: url, max: env().DATABASE_POOL_MAX, connectionTimeoutMillis: 10000, application_name: 'oralis-api' });
}

export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema, casing: 'snake_case' });
}

/** Extrai o código SQLSTATE de um erro do pg, mesmo quando encapsulado pelo Drizzle. */
export function pgErrorCode(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 3 && e && typeof e === 'object'; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

export function pgConstraint(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 3 && e && typeof e === 'object'; i++) {
    const c = (e as { constraint?: unknown }).constraint;
    if (typeof c === 'string') return c;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

export { schema };
