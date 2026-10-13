import { Controller, Get, Inject, Injectable, Module, Query } from '@nestjs/common';
import { and, asc, count, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { parse } from '../../common/app-error';
import { RequirePermission, Tenant, type TenantContext } from '../../common/request-context';
import { DB, type Db } from '../../db/db';
import { appointments, clinicUnits, emailMessages, jobs, patients, professionals, services } from '../../db/schema';
import { todayInTz } from '@oralis/shared';

const inputSchema = z.object({ q: z.string().trim().min(2).max(100) });
const literal = (value: string) => value.replace(/[\\%_]/g, c => '\\' + c);
@Injectable()
export class WorkspaceService {
 constructor(@Inject(DB) private readonly db: Db) {}
 async search(tenant: TenantContext, q: string) {
  const normalized = q.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ');
  const pattern = '%' + literal(normalized) + '%';
  const digits = q.replace(/\D/g, '');
  const match = or(ilike(patients.searchName, pattern), ...(digits.length >= 4 ? [ilike(patients.phone, '%' + digits + '%'), eq(patients.cpf, digits)] : []));
  const [people, visits] = await Promise.all([
   tenant.permissions.has('patients.read') ? this.db.select({ id: patients.id, name: patients.fullName, socialName: patients.socialName }).from(patients).where(and(eq(patients.organizationId, tenant.organizationId), eq(patients.status, 'active'), match)).orderBy(asc(patients.searchName), asc(patients.id)).limit(8) : [],
   tenant.permissions.has('schedule.read') ? this.db.select({ id: appointments.id, patientName: patients.fullName, patientSocialName: patients.socialName, startsAt: appointments.startsAt, status: appointments.status, professionalName: professionals.displayName, unitId: appointments.unitId, unitName: clinicUnits.name, timezone: clinicUnits.timezone, serviceName: services.name }).from(appointments)
    .innerJoin(patients, and(eq(patients.id, appointments.patientId), eq(patients.organizationId, tenant.organizationId)))
    .innerJoin(professionals, eq(professionals.id, appointments.professionalId)).innerJoin(clinicUnits, eq(clinicUnits.id, appointments.unitId)).leftJoin(services, eq(services.id, appointments.serviceId))
    .where(and(eq(appointments.organizationId, tenant.organizationId), tenant.allUnits ? undefined : inArray(appointments.unitId, [...tenant.unitIds]), or(match, ilike(professionals.displayName, '%' + literal(q) + '%'), ilike(services.name, '%' + literal(q) + '%'))))
    .orderBy(desc(appointments.startsAt), asc(appointments.id)).limit(8) : [],
  ]);
  return {
   patients: people.map(p => ({ id: p.id, title: p.socialName || p.name, href: `/app/pacientes/${p.id}` })),
   appointments: visits.map(a => ({ ...a, href: `/app/agenda?data=${todayInTz(a.timezone, a.startsAt)}&consulta=${a.id}&unidade=${a.unitId}` })),
  };
 }
 async operations(tenant: TenantContext) {
  const [[dead], [stale], [failedMail]] = await Promise.all([
   this.db.select({ n: count() }).from(jobs).where(and(eq(jobs.organizationId, tenant.organizationId), eq(jobs.status, 'dead'))),
   this.db.select({ n: count() }).from(jobs).where(and(eq(jobs.organizationId, tenant.organizationId), eq(jobs.status, 'running'), sql`${jobs.lockedAt} < now() - interval '10 minutes'`)),
   this.db.select({ n: count() }).from(emailMessages).where(and(eq(emailMessages.organizationId, tenant.organizationId), eq(emailMessages.status, 'failed'))),
  ]);
  return { failedJobs: dead?.n ?? 0, staleJobs: stale?.n ?? 0, failedEmails: failedMail?.n ?? 0 };
 }
}
@Controller('orgs/:orgId')
class WorkspaceController {
 constructor(private readonly workspace: WorkspaceService) {}
 @Get('search')
 search(@Tenant() tenant: TenantContext, @Query() input: unknown) { return this.workspace.search(tenant, parse(inputSchema, input).q); }
 @Get('workspace/operations')
 @RequirePermission('audit.read')
 operations(@Tenant() tenant: TenantContext) { return this.workspace.operations(tenant); }
}
@Module({ controllers: [WorkspaceController], providers: [WorkspaceService] })
export class WorkspaceModule {}
