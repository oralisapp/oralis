import { Controller, Get, Inject, Query } from '@nestjs/common';
import { auditQuerySchema } from '@oralis/shared';
import { and, count, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { parse } from '../../common/app-error';
import { RequirePermission, Tenant, type TenantContext } from '../../common/request-context';
import { DB, type Db } from '../../db/db';
import { auditEvents, users } from '../../db/schema';

const ACTION_LABEL: Record<string, string> = {
  'auth.signup': 'Conta criada',
  'org.created': 'Organização criada',
  'unit.created': 'Unidade criada',
  'unit.updated': 'Unidade alterada',
  'unit.hours_updated': 'Horário de funcionamento alterado',
  'invitation.created': 'Convite criado',
  'invitation.accepted': 'Convite aceito',
  'invitation.revoked': 'Convite revogado',
  'membership.updated': 'Papel ou unidades de membro alterados',
  'membership.removed': 'Membro removido',
  'professional.created': 'Profissional cadastrado',
  'professional.updated': 'Profissional alterado',
  'chair.created': 'Cadeira/sala cadastrada',
  'chair.updated': 'Cadeira/sala alterada',
  'service.created': 'Serviço cadastrado',
  'service.updated': 'Serviço alterado',
  'patient.created': 'Paciente cadastrado',
  'patient.updated': 'Cadastro do paciente alterado',
  'patient.viewed': 'Ficha do paciente acessada',
  'appointment.created': 'Consulta agendada',
  'appointment.rescheduled': 'Consulta reagendada',
  'appointment.status_changed': 'Status da consulta alterado',
};

@Controller('orgs/:orgId/audit')
export class AuditController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @RequirePermission('audit.read')
  async list(@Tenant() tenant: TenantContext, @Query() query: unknown) {
    const q = parse(auditQuerySchema, query);
    const filters: SQL[] = [eq(auditEvents.organizationId, tenant.organizationId)];
    if (q.entityType) filters.push(eq(auditEvents.entityType, q.entityType));
    if (q.entityId) filters.push(eq(auditEvents.entityId, q.entityId));
    if (q.action) filters.push(eq(auditEvents.action, q.action));
    const where = and(...filters);

    const [rows, [total]] = await Promise.all([
      this.db
        .select({
          id: auditEvents.id,
          action: auditEvents.action,
          entityType: auditEvents.entityType,
          entityId: auditEvents.entityId,
          unitId: auditEvents.unitId,
          metadata: auditEvents.metadata,
          ip: auditEvents.ip,
          createdAt: auditEvents.createdAt,
          actorUserId: auditEvents.actorUserId,
        })
        .from(auditEvents)
        .where(where)
        .orderBy(desc(auditEvents.createdAt))
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize),
      this.db.select({ n: count() }).from(auditEvents).where(where),
    ]);

    const actorIds = [...new Set(rows.map((r) => r.actorUserId).filter((v): v is string => !!v))];
    const actors = actorIds.length
      ? await this.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, actorIds))
      : [];
    const actorName = new Map(actors.map((a) => [a.id, a.name]));

    return {
      total: total?.n ?? 0,
      page: q.page,
      pageSize: q.pageSize,
      items: rows.map((r) => ({
        ...r,
        actionLabel: ACTION_LABEL[r.action] ?? r.action,
        actorName: r.actorUserId ? (actorName.get(r.actorUserId) ?? null) : null,
      })),
    };
  }
}
