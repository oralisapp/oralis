import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { patientSchema, patientSearchSchema } from '@oralis/shared';
import { z } from 'zod';
import { parse } from '../../common/app-error';
import { Auth, type AuthContext, Meta, type RequestMeta, RequirePermission, Tenant, type TenantContext } from '../../common/request-context';
import { PatientsService } from './patients.service';
import { importSchema, parsePatientCsv, PatientImportService } from './patient-import.service';
import { mergeSchema, PatientMergeService } from './patient-merge.service';

const updatePatientSchema = z.object({ ...patientSchema.shape, version: z.number().int().min(1) });

@Controller('orgs/:orgId/patients')
export class PatientsController {
  constructor(private readonly patients: PatientsService, private readonly importer: PatientImportService, private readonly merger: PatientMergeService) {}

  @Post('import/columns')
  @RequirePermission('patients.read', 'patients.write')
  columns(@Body() body: unknown) {
    const input = parse(importSchema.pick({ csv: true, delimiter: true }), body);
    return { columns: parsePatientCsv(input.csv, input.delimiter)[0] };
  }

  @Post('import/preview')
  @RequirePermission('patients.read', 'patients.write')
  preview(@Tenant() tenant: TenantContext, @Body() body: unknown) { return this.importer.preview(tenant, parse(importSchema, body)); }

  @Post('import/commit')
  @RequirePermission('patients.read', 'patients.write')
  importPatients(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Body() body: unknown, @Meta() meta: RequestMeta) { return this.importer.commit(auth, tenant, parse(importSchema, body), meta); }

  @Post('consolidate')
  @RequirePermission('patients.read', 'patients.write')
  consolidate(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Body() body: unknown, @Meta() meta: RequestMeta) { return this.merger.merge(auth, tenant, parse(mergeSchema, body), meta); }

  @Get(':id/registrations')
  @RequirePermission('patients.read')
  registrations(@Tenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string) { return this.merger.links(tenant, id); }

  @Get()
  @RequirePermission('patients.read')
  search(@Tenant() tenant: TenantContext, @Query() query: unknown) {
    const q = parse(patientSearchSchema, query);
    return this.patients.search(tenant, q.q, q.page, q.pageSize);
  }

  @Post()
  @RequirePermission('patients.write')
  create(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Body() body: unknown, @Query('allowPossibleDuplicate') allow: string | undefined, @Meta() meta: RequestMeta) {
    return this.patients.create(auth, tenant, parse(patientSchema, body), allow === 'true', meta);
  }

  @Get(':id')
  @RequirePermission('patients.read')
  detail(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() meta: RequestMeta) {
    return this.patients.detail(auth, tenant, id, meta);
  }

  @Put(':id')
  @RequirePermission('patients.write')
  update(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.patients.update(auth, tenant, id, parse(updatePatientSchema, body), meta);
  }
}
