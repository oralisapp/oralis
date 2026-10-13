import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Pool } from 'pg';
import { env } from '../config/env';
import { DB, DB_POOL, createDb, createPool } from './db';

@Global()
@Module({
  providers: [
    { provide: DB_POOL, useFactory: () => createPool(env().DATABASE_URL) },
    { provide: DB, inject: [DB_POOL], useFactory: (pool: Pool) => createDb(pool) },
  ],
  exports: [DB, DB_POOL],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
