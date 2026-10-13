import type { ThrottlerStorage } from '@nestjs/throttler';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/db';

/**
 * Contadores de limite de tentativas no PostgreSQL: valem para todas as
 * instâncias da API e sobrevivem a reinícios.
 */
export class DbThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly db: Db) {}

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string) {
    const k = `${throttlerName}:${key}`.slice(0, 500);
    const window = Math.max(ttl, blockDuration);
    const r = await this.db.execute<{ hits: number; expires_at: Date }>(sql`
      insert into rate_limits (key, hits, expires_at)
      values (${k}, 1, now() + (${ttl} || ' milliseconds')::interval)
      on conflict (key) do update set
        hits = case when rate_limits.expires_at <= now() then 1 else rate_limits.hits + 1 end,
        expires_at = case
          when rate_limits.expires_at <= now() then now() + (${ttl} || ' milliseconds')::interval
          when rate_limits.hits + 1 > ${limit} then greatest(rate_limits.expires_at, now() + (${window} || ' milliseconds')::interval)
          else rate_limits.expires_at end
      returning hits, expires_at`);
    const row = r.rows[0]!;
    const msLeft = Math.max(0, new Date(row.expires_at).getTime() - Date.now());
    const blocked = Number(row.hits) > limit;
    return {
      totalHits: Number(row.hits),
      timeToExpire: Math.ceil(msLeft / 1000),
      isBlocked: blocked,
      timeToBlockExpire: blocked ? Math.ceil(msLeft / 1000) : 0,
    };
  }
}
