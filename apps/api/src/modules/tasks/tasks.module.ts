import { Body, Controller, Get, Inject, Injectable, Module, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { taskSchema } from '@oralis/shared';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { notFound, parse } from '../../common/app-error';
import { Clock } from '../../common/clock';
import { Auth, type AuthContext, Meta, type RequestMeta, Tenant, type TenantContext, canAccessUnit } from '../../common/request-context';
import { DB, type Db } from '../../db/db';
import { clinicUnits, memberships, membershipUnits, tasks, users } from '../../db/schema';
import { AuditService } from '../audit/audit.service';

/** Tarefas da equipe: a "caixa de entrada" operacional de cada pessoa e papel. */
@Injectable()
export class TasksService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  private unitScope(tenant: TenantContext) {
    return tenant.allUnits ? undefined : or(isNull(tasks.unitId), inArray(tasks.unitId, [...tenant.unitIds]));
  }

  async list(tenant: TenantContext, scope: 'mine' | 'all', status: 'open' | 'done') {
    const visibleToMe = or(eq(tasks.assigneeMembershipId, tenant.membershipId), and(isNull(tasks.assigneeMembershipId), or(isNull(tasks.assigneeRoleKey), eq(tasks.assigneeRoleKey, tenant.roleKey ?? ''))));
    const rows = await this.db
      .select({
        id: tasks.id,
        unitId: tasks.unitId,
        title: tasks.title,
        description: tasks.description,
        dueAt: tasks.dueAt,
        status: tasks.status,
        origin: tasks.origin,
        relatedType: tasks.relatedType,
        relatedId: tasks.relatedId,
        assigneeMembershipId: tasks.assigneeMembershipId,
        assigneeRoleKey: tasks.assigneeRoleKey,
        assigneeName: users.name,
        createdAt: tasks.createdAt,
        completedAt: tasks.completedAt,
      })
      .from(tasks)
      .leftJoin(memberships, eq(memberships.id, tasks.assigneeMembershipId))
      .leftJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(tasks.organizationId, tenant.organizationId), eq(tasks.status, status), scope === 'mine' ? visibleToMe : undefined, this.unitScope(tenant)))
      .orderBy(status === 'open' ? sql`${tasks.dueAt} asc nulls last` : desc(tasks.completedAt), asc(tasks.createdAt))
      .limit(200);
    return rows;
  }

  async create(auth: AuthContext, tenant: TenantContext, input: z.infer<typeof taskSchema>, meta: RequestMeta) {
    if (input.unitId) {
      if (!canAccessUnit(tenant, input.unitId)) throw notFound('Unidade');
      const [unit] = await this.db.select({ id: clinicUnits.id }).from(clinicUnits)
        .where(and(eq(clinicUnits.id, input.unitId), eq(clinicUnits.organizationId, tenant.organizationId), eq(clinicUnits.active, true)));
      if (!unit) throw notFound('Unidade');
    }
    if (input.assigneeMembershipId) {
      const [assignee] = await this.db.select().from(memberships)
        .where(and(eq(memberships.id, input.assigneeMembershipId), eq(memberships.organizationId, tenant.organizationId), eq(memberships.status, 'active')));
      if (!assignee) throw notFound('Responsável');
      if (input.unitId && !assignee.allUnits) {
        const [access] = await this.db.select().from(membershipUnits)
          .where(and(eq(membershipUnits.membershipId, assignee.id), eq(membershipUnits.organizationId, tenant.organizationId), eq(membershipUnits.unitId, input.unitId)));
        if (!access) throw notFound('Responsável nesta unidade');
      }
    }
    const [row] = await this.db
      .insert(tasks)
      .values({
        organizationId: tenant.organizationId,
        unitId: input.unitId ?? null,
        title: input.title,
        description: input.description ?? null,
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
        assigneeMembershipId: input.assigneeMembershipId ?? null,
        origin: 'manual',
        createdBy: auth.userId,
      })
      .returning({ id: tasks.id });
    await this.audit.record(this.db, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'task.created', entityType: 'task', entityId: row!.id, meta });
    return { id: row!.id };
  }

  async setStatus(auth: AuthContext, tenant: TenantContext, id: string, status: 'open' | 'done' | 'cancelled') {
    const r = await this.db
      .update(tasks)
      .set({ status, completedAt: status === 'open' ? null : this.clock.now(), completedBy: status === 'open' ? null : auth.userId })
      .where(and(eq(tasks.id, id), eq(tasks.organizationId, tenant.organizationId), this.unitScope(tenant)))
      .returning({ id: tasks.id });
    if (!r.length) throw notFound('Tarefa');
    return { ok: true };
  }
}

@Controller('orgs/:orgId/tasks')
class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  list(@Tenant() tenant: TenantContext, @Query() q: unknown) {
    const p = parse(z.object({ scope: z.enum(['mine', 'all']).default('mine'), status: z.enum(['open', 'done']).default('open') }), q);
    return this.tasks.list(tenant, p.scope, p.status);
  }

  @Post()
  create(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.tasks.create(auth, tenant, parse(taskSchema, body), meta);
  }

  @Put(':id/status')
  status(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.tasks.setStatus(auth, tenant, id, parse(z.object({ status: z.enum(['open', 'done', 'cancelled']) }), body).status);
  }
}

@Module({ controllers: [TasksController], providers: [TasksService], exports: [TasksService] })
export class TasksModule {}
