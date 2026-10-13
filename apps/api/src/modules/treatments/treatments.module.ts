import { Body, Controller, Delete, Get, Module, Param, ParseUUIDPipe, Post, Put, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { parse } from '../../common/app-error';
import { Auth, type AuthContext, Meta, type RequestMeta, RequirePermission, Tenant, type TenantContext } from '../../common/request-context';
import { JobsService } from '../platform/jobs.service';
import { decisionSchema, itemSchema, odontogramEntrySchema, planSchema, planUpdateSchema, presentSchema, TreatmentsService } from './treatments.service';

@Controller('orgs/:orgId')
class TreatmentsController {
  constructor(private readonly t: TreatmentsService) {}

  @Get('patients/:patientId/odontogram')
  @RequirePermission('clinical.read')
  odontogram(@Tenant() tenant: TenantContext, @Param('patientId', ParseUUIDPipe) patientId: string) {
    return this.t.odontogram(tenant, patientId);
  }

  @Post('patients/:patientId/odontogram')
  @RequirePermission('clinical.write')
  addEntry(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('patientId', ParseUUIDPipe) patientId: string, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.t.addOdontogramEntry(auth, tenant, patientId, parse(odontogramEntrySchema, body), meta);
  }

  @Get('patients/:patientId/treatment-plans')
  @RequirePermission('treatments.read')
  plansOf(@Tenant() tenant: TenantContext, @Param('patientId', ParseUUIDPipe) patientId: string) {
    return this.t.listForPatient(tenant, patientId);
  }

  @Post('patients/:patientId/treatment-plans')
  @RequirePermission('treatments.write')
  createPlan(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('patientId', ParseUUIDPipe) patientId: string, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.t.createPlan(auth, tenant, patientId, parse(planSchema, body), meta);
  }

  @Get('treatment-plans/continuity')
  @RequirePermission('treatments.read')
  continuity(@Tenant() tenant: TenantContext) {
    return this.t.continuity(tenant);
  }

  @Get('treatment-plans/:id')
  @RequirePermission('treatments.read')
  detail(@Tenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.t.detail(tenant, id);
  }

  @Put('treatment-plans/:id')
  @RequirePermission('treatments.write')
  update(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.t.updatePlan(auth, tenant, id, parse(planUpdateSchema, body), meta);
  }

  @Post('treatment-plans/:id/cancel')
  @RequirePermission('treatments.write')
  cancel(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.t.cancelPlan(auth, tenant, id, parse(z.object({ reason: z.string().trim().min(3).max(300) }), body).reason, meta);
  }

  @Post('treatment-plans/:id/items')
  @RequirePermission('treatments.write')
  addItem(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.t.addItem(auth, tenant, id, parse(itemSchema, body), meta);
  }

  @Put('treatment-items/:id')
  @RequirePermission('treatments.write')
  updateItem(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.t.updateItem(auth, tenant, id, parse(itemSchema.partial(), body), meta);
  }

  @Delete('treatment-items/:id')
  @RequirePermission('treatments.write')
  removeItem(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() meta: RequestMeta) {
    return this.t.removeItem(auth, tenant, id, meta);
  }

  @Post('treatment-plans/:id/present')
  @RequirePermission('quotes.present')
  present(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.t.present(auth, tenant, id, parse(presentSchema, body), meta);
  }

  @Post('quotes/:id/decision')
  @RequirePermission('quotes.approve')
  decide(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.t.decide({ userId: auth.userId, via: 'clinic' }, tenant.organizationId, id, parse(decisionSchema, body), meta, tenant);
  }

  @Post('quotes/:id/contact')
  @RequirePermission('treatments.read')
  contact(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() meta: RequestMeta) {
    return this.t.markContact(auth, tenant, id, meta);
  }
}

@Module({ controllers: [TreatmentsController], providers: [TreatmentsService], exports: [TreatmentsService] })
export class TreatmentsModule implements OnModuleInit {
  constructor(
    private readonly jobs: JobsService,
    private readonly t: TreatmentsService,
  ) {}

  onModuleInit() {
    this.jobs.every({ name: 'quotes.expire', everyMs: 60 * 60_000, run: () => this.t.expireQuotes() });
  }
}
