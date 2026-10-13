import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { parse } from '../../common/app-error';
import { Auth, type AuthContext, Meta, type RequestMeta, RequirePermission, Tenant, type TenantContext } from '../../common/request-context';
import { alertSchema, amendmentSchema, anamnesisResponseSchema, anamnesisTemplateSchema, ClinicalService, draftSchema } from './clinical.service';

@Controller('orgs/:orgId')
class ClinicalController {
  constructor(private readonly clinical: ClinicalService) {}

  @Get('appointments/:appointmentId/workspace')
  @RequirePermission('clinical.read')
  workspace(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('appointmentId', ParseUUIDPipe) id: string, @Meta() meta: RequestMeta) {
    return this.clinical.workspace(auth, tenant, id, meta);
  }

  @Put('clinical-records/:id')
  @RequirePermission('clinical.write')
  saveDraft(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.clinical.saveDraft(auth, tenant, id, parse(draftSchema, body));
  }

  @Post('clinical-records/:id/finalize')
  @RequirePermission('clinical.write')
  finalize(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.clinical.finalize(auth, tenant, id, parse(z.object({ version: z.number().int().min(1) }), body).version, meta);
  }

  @Post('clinical-records/:id/amendments')
  @RequirePermission('clinical.write')
  amend(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.clinical.amend(auth, tenant, id, parse(amendmentSchema, body).content, meta);
  }

  @Post('patients/:patientId/clinical-records')
  @RequirePermission('clinical.write')
  create(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('patientId', ParseUUIDPipe) patientId: string, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.clinical.createRecord(auth, tenant, patientId, parse(z.object({ unitId: z.uuid() }), body).unitId, meta);
  }

  @Get('patients/:patientId/clinical')
  @RequirePermission('clinical.read')
  history(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('patientId', ParseUUIDPipe) patientId: string, @Meta() meta: RequestMeta) {
    return this.clinical.patientHistory(auth, tenant, patientId, meta);
  }

  @Get('clinical/pending-drafts')
  @RequirePermission('clinical.write')
  pending(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext) {
    return this.clinical.pendingDrafts(auth, tenant);
  }

  @Post('patients/:patientId/clinical-alerts')
  @RequirePermission('clinical.write')
  addAlert(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('patientId', ParseUUIDPipe) patientId: string, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.clinical.addAlert(auth, tenant, patientId, parse(alertSchema, body), meta);
  }

  @Post('clinical-alerts/:id/resolve')
  @RequirePermission('clinical.write')
  resolveAlert(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() meta: RequestMeta) {
    return this.clinical.resolveAlert(auth, tenant, id, meta);
  }

  @Get('anamnesis-templates')
  @RequirePermission('clinical.read')
  templates(@Tenant() tenant: TenantContext) {
    return this.clinical.templates(tenant);
  }

  @Post('anamnesis-templates')
  @RequirePermission('clinical.write')
  createTemplate(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.clinical.createTemplate(auth, tenant, parse(anamnesisTemplateSchema, body), meta);
  }

  @Put('anamnesis-templates/:id')
  @RequirePermission('clinical.write')
  versionTemplate(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.clinical.newTemplateVersion(auth, tenant, id, parse(anamnesisTemplateSchema, body), meta);
  }

  @Post('patients/:patientId/anamnesis')
  @RequirePermission('clinical.write')
  anamnesis(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('patientId', ParseUUIDPipe) patientId: string, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.clinical.recordAnamnesis(auth, tenant, patientId, parse(anamnesisResponseSchema, body), 'staff', meta);
  }
}

@Module({ controllers: [ClinicalController], providers: [ClinicalService], exports: [ClinicalService] })
export class ClinicalModule {}
