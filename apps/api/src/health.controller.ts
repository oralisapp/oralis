import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { Pool } from 'pg';
import { Public } from './common/request-context';
import { DB_POOL } from './db/db';

@Controller('health')
export class HealthController {
 constructor(@Inject(DB_POOL) private readonly pool: Pool) {}
 @Get('live')
 @Public()
 live() { return { status: 'ok' }; }
 @Get()
 @Public()
 check() { return this.ready(); }
 @Get('ready')
 @Public()
 async ready() {
  try { const query = { text: 'select 1', query_timeout: 3000 }; await this.pool.query(query); return { status: 'ok' }; }
  catch { throw new ServiceUnavailableException('Serviço temporariamente indisponível.'); }
 }
}
