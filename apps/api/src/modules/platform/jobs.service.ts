import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { and, eq, inArray, lt, lte, sql } from 'drizzle-orm';
import { Clock } from '../../common/clock';
import { env } from '../../config/env';
import { DB, type Db } from '../../db/db';
import { jobs, rateLimits } from '../../db/schema';

export type JobHandler = (payload: Record<string, unknown>, ctx: { jobId: string; organizationId: string | null }) => Promise<unknown>;
export type PeriodicTask = { name: string; everyMs: number; run: () => Promise<unknown> };

/**
 * Fila de tarefas no PostgreSQL (FOR UPDATE SKIP LOCKED): funciona com várias
 * instâncias da API sem Redis. Tentativas com espera exponencial; após o
 * limite, a tarefa fica "dead" com o erro registrado para a operação.
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Jobs');
  private readonly handlers = new Map<string, JobHandler>();
  private readonly periodic: PeriodicTask[] = [];
  private timer: NodeJS.Timeout | undefined;
  private lastRun = new Map<string, number>();
  private running = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  register(kind: string, handler: JobHandler) {
    this.handlers.set(kind, handler);
  }

  every(task: PeriodicTask) {
    this.periodic.push(task);
  }

  async enqueue(kind: string, payload: Record<string, unknown>, opts: { organizationId?: string | null; runAt?: Date; dedupeKey?: string; maxAttempts?: number } = {}) {
    const [row] = await this.db
      .insert(jobs)
      .values({ kind, payload, organizationId: opts.organizationId ?? null, runAt: opts.runAt ?? this.clock.now(), dedupeKey: opts.dedupeKey, maxAttempts: opts.maxAttempts ?? 5 })
      .onConflictDoNothing({ target: jobs.dedupeKey })
      .returning({ id: jobs.id });
    return row?.id ?? null;
  }

  onApplicationBootstrap() {
    if (!env().JOBS_ENABLED || env().APP_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick(), 15_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Um ciclo: tarefas periódicas vencidas + tarefas da fila. Os testes chamam diretamente. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.clock.now().getTime();
      for (const p of this.periodic) {
        if (now - (this.lastRun.get(p.name) ?? 0) < p.everyMs) continue;
        this.lastRun.set(p.name, now);
        await p.run().catch((err) => this.logger.error(`Tarefa periódica ${p.name} falhou: ${err instanceof Error ? err.message : err}`));
      }
      await this.drain();
      await this.db.delete(rateLimits).where(lt(rateLimits.expiresAt, this.clock.now()));
    } catch {
      // The interval does not await tick: infrastructure failures must not become
      // unhandled rejections that terminate the API process. Retry next cycle.
      this.logger.error('Ciclo da fila interrompido. Verifique a conexão com o banco; nova tentativa no próximo ciclo.');
    } finally {
      this.running = false;
    }
  }

  async drain(max = 50): Promise<number> {
    let done = 0;
    for (; done < max; done++) {
      const claimed = await this.db.transaction(async (tx) => {
        const rows = await tx.execute<{ id: string }>(sql`
          select id from jobs where status = 'queued' and run_at <= ${this.clock.now()}
          order by run_at limit 1 for update skip locked`);
        const id = rows.rows[0]?.id;
        if (!id) return null;
        const [job] = await tx.update(jobs).set({ status: 'running', lockedAt: this.clock.now(), attempts: sql`${jobs.attempts} + 1` }).where(eq(jobs.id, id)).returning();
        return job ?? null;
      });
      if (!claimed) break;
      const handler = this.handlers.get(claimed.kind);
      try {
        if (!handler) throw new Error(`Sem tratador para a tarefa ${claimed.kind}`);
        const result = await handler(claimed.payload as Record<string, unknown>, { jobId: claimed.id, organizationId: claimed.organizationId });
        await this.db.update(jobs).set({ status: 'done', result: (result ?? null) as never, finishedAt: this.clock.now(), lastError: null }).where(eq(jobs.id, claimed.id));
      } catch (err) {
        const message = err instanceof Error ? err.message.slice(0, 1000) : String(err);
        const dead = claimed.attempts >= claimed.maxAttempts;
        await this.db
          .update(jobs)
          .set({
            status: dead ? 'dead' : 'queued',
            lastError: message,
            runAt: new Date(this.clock.now().getTime() + 2 ** claimed.attempts * 30_000),
            finishedAt: dead ? this.clock.now() : null,
          })
          .where(eq(jobs.id, claimed.id));
        this.logger.warn(`Tarefa ${claimed.kind} falhou (tentativa ${claimed.attempts}): ${message}`);
      }
    }
    return done;
  }

  /** Tarefas presas em "running" (processo encerrado no meio) voltam para a fila. */
  async recoverStale() {
    await this.db
      .update(jobs)
      .set({ status: 'queued' })
      .where(and(eq(jobs.status, 'running'), lte(jobs.lockedAt, new Date(this.clock.now().getTime() - 10 * 60_000))));
  }

  async failures(limit = 50) {
    return this.db.select().from(jobs).where(inArray(jobs.status, ['dead', 'queued'])).orderBy(jobs.runAt).limit(limit);
  }
}
