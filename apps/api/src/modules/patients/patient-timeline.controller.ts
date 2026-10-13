import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { notFound, parse } from '../../common/app-error';
import { Auth, type AuthContext, Meta, type RequestMeta, RequirePermission, Tenant, type TenantContext } from '../../common/request-context';
import { DB, type Db } from '../../db/db';
import { patients } from '../../db/schema';
import { AuditService } from '../audit/audit.service';

const cursorSchema = z.object({ before: z.string().datetime().optional(), beforeKey: z.string().max(100).optional() }).refine(v => !!v.before === !!v.beforeKey);

/** Each source is permission-filtered before the union and pagination. No draft content is exposed. */
@Controller('orgs/:orgId/patients/:patientId/timeline')
export class PatientTimelineController {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService) {}

  @Get()
  @RequirePermission('patients.read')
  async list(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('patientId', ParseUUIDPipe) patientId: string, @Query() query: unknown, @Meta() meta: RequestMeta) {
    const cursor = parse(cursorSchema, query);
    const [patient] = await this.db.select({ id: patients.id }).from(patients).where(and(eq(patients.id, patientId), eq(patients.organizationId, tenant.organizationId)));
    if (!patient) throw notFound('Paciente');
    const org = tenant.organizationId;
    const unitFilter = (alias: string) => tenant.allUnits ? sql`true` : tenant.unitIds.size ? sql`${sql.raw(alias)}.unit_id in (${sql.join([...tenant.unitIds].map(id => sql`${id}::uuid`), sql`, `)})` : sql`false`;
    const sources: SQL[] = [];
    if (tenant.permissions.has('schedule.read')) sources.push(sql`select 'appointment:' || a.id as key, 'appointment' as kind, a.id, a.starts_at as at, 'Consulta' as title, a.status, null::text as amount from appointments a where a.organization_id = ${org} and a.patient_id = ${patientId} and ${unitFilter('a')}`);
    if (tenant.permissions.has('clinical.read')) sources.push(sql`select 'clinical:' || c.id as key, 'clinical' as kind, c.id, c.finalized_at as at, 'Evolução finalizada' as title, c.status, null::text as amount from clinical_records c where c.organization_id = ${org} and c.patient_id = ${patientId} and c.status = 'finalized' and ${unitFilter('c')}`);
    sources.push(sql`select 'document:' || d.id as key, 'document' as kind, d.id, d.created_at as at, d.title, d.category as status, null::text as amount from documents d where d.organization_id = ${org} and d.patient_id = ${patientId} and d.archived_at is null and ${tenant.permissions.has('clinical.read') ? sql`true` : sql`d.category = 'administrative'`} and (d.encounter_id is null or exists (select 1 from encounters e where e.id = d.encounter_id and e.organization_id = ${org} and ${unitFilter('e')}))`);
    if (tenant.permissions.has('treatments.read')) sources.push(sql`select 'treatment:' || t.id as key, 'treatment' as kind, t.id, t.created_at as at, t.title, t.status, null::text as amount from treatment_plans t where t.organization_id = ${org} and t.patient_id = ${patientId} and ${unitFilter('t')}`);
    if (tenant.permissions.has('finance.read')) sources.push(sql`select 'payment:' || p.id as key, 'payment' as kind, p.id, p.received_at as at, 'Recebimento registrado' as title, p.method as status, p.amount::text as amount from payments p where p.organization_id = ${org} and p.patient_id = ${patientId} and ${unitFilter('p')}`);
    const result = await this.db.execute(sql`select * from (select key, kind, id, date_trunc('milliseconds', at) as at, title, status, amount from (${sql.join(sources, sql` union all `)}) sources) timeline where ${cursor.before ? sql`(at, key) < (${cursor.before}::timestamptz, ${cursor.beforeKey}::text)` : sql`true`} order by at desc, key desc limit 31`);
    const rows = result.rows as { key: string; kind: string; id: string; at: string | Date; title: string; status: string; amount: string | null }[];
    const items = rows.slice(0, 30).map(row => ({ ...row, at: new Date(row.at).toISOString() }));
    await this.audit.record(this.db, { organizationId: org, actorUserId: auth.userId, action: 'patient.timeline_viewed', entityType: 'patient', entityId: patientId, metadata: { clinicalAccess: tenant.permissions.has('clinical.read'), count: items.length }, meta });
    const last = items.at(-1);
    return { items, next: rows.length > 30 && last ? { before: last.at, beforeKey: last.key } : null };
  }
}
