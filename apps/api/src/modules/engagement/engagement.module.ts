import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { parse } from '../../common/app-error';
import { env } from '../../config/env';
import { MobileMessageProvider } from './mobile-message-provider';
import { Auth, type AuthContext, Meta, type RequestMeta, RequireFeature, RequirePermission, Tenant, type TenantContext } from '../../common/request-context';
import { PatientsModule } from '../patients/patients.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { automationSchema, AutomationsService, simulateSchema } from './automations.service';
import { CrmService, interactionSchema, leadSchema, moveSchema } from './crm.service';
import { campaignCriteriaSchema, campaignSchema, MessagingService, sendSchema, templateSchema } from './messaging.service';

@Controller('orgs/:orgId/crm')
@RequireFeature('crm')
class CrmController {
  constructor(private readonly crm: CrmService) {}

  @Get('board')
  @RequirePermission('crm.read')
  board(@Tenant() t: TenantContext) {
    return this.crm.board(t);
  }

  @Post('leads')
  @RequirePermission('crm.write')
  create(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Body() b: unknown, @Meta() m: RequestMeta) {
    return this.crm.create(a, t, parse(leadSchema, b), m);
  }

  @Put('leads/:id/stage')
  @RequirePermission('crm.write')
  move(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown, @Meta() m: RequestMeta) {
    return this.crm.move(a, t, id, parse(moveSchema, b), m);
  }

  @Post('leads/:id/convert')
  @RequirePermission('crm.write')
  convert(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() m: RequestMeta) {
    return this.crm.convert(a, t, id, m);
  }

  @Get('interactions')
  @RequirePermission('crm.read')
  interactions(@Tenant() t: TenantContext, @Query() q: unknown) {
    return this.crm.interactions(t, parse(z.object({ leadId: z.uuid().optional(), patientId: z.uuid().optional() }), q));
  }

  @Post('interactions')
  @RequirePermission('crm.write')
  addInteraction(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Body() b: unknown) {
    return this.crm.addInteraction(a, t, parse(interactionSchema, b));
  }
}

@Controller('orgs/:orgId/messaging')
class MessagingController {
  constructor(private readonly m: MessagingService) {}

  @Get('templates')
  @RequirePermission('crm.read')
  templates(@Tenant() t: TenantContext) {
    return this.m.templates(t);
  }

  @Post('templates')
  @RequirePermission('crm.write')
  create(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Body() b: unknown, @Meta() meta: RequestMeta) {
    return this.m.saveTemplate(a, t, null, parse(templateSchema, b), meta);
  }

  @Put('templates/:id')
  @RequirePermission('crm.write')
  update(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown, @Meta() meta: RequestMeta) {
    return this.m.saveTemplate(a, t, id, parse(templateSchema, b), meta);
  }

  @Post('preview')
  @RequirePermission('crm.read')
  preview(@Tenant() t: TenantContext, @Body() b: unknown) {
    const i = parse(sendSchema, b);
    return this.m.preview(t, i.templateId, i.patientId, i.vars);
  }

  @Post('send')
  @RequirePermission('crm.write')
  send(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Body() b: unknown, @Meta() meta: RequestMeta) {
    return this.m.sendManual(a, t, parse(sendSchema, b), meta);
  }

  @Get('events')
  @RequirePermission('crm.read')
  events(@Tenant() t: TenantContext, @Query() q: unknown) {
    return this.m.events(t, parse(z.object({ patientId: z.uuid().optional(), category: z.string().optional(), status: z.string().optional() }), q));
  }

  @Post('campaigns/preview')
  @RequirePermission('crm.write')
  @RequireFeature('crm')
  campaignPreview(@Tenant() t: TenantContext, @Body() b: unknown) {
    const i = parse(z.object({ templateId: z.uuid(), criteria: campaignCriteriaSchema }), b);
    return this.m.previewCampaign(t, i.templateId, i.criteria);
  }

  @Post('campaigns')
  @RequirePermission('crm.write')
  @RequireFeature('crm')
  campaign(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Body() b: unknown, @Meta() meta: RequestMeta) {
    return this.m.sendCampaign(a, t, parse(campaignSchema, b), meta);
  }
}

@Controller('orgs/:orgId/automations')
@RequireFeature('automacoes')
class AutomationsController {
  constructor(private readonly a: AutomationsService) {}

  @Get()
  @RequirePermission('crm.read')
  list(@Tenant() t: TenantContext) {
    return this.a.list(t);
  }

  @Post()
  @RequirePermission('automations.manage')
  create(@Auth() au: AuthContext, @Tenant() t: TenantContext, @Body() b: unknown, @Meta() m: RequestMeta) {
    return this.a.save(au, t, null, parse(automationSchema, b), m);
  }

  @Put(':id')
  @RequirePermission('automations.manage')
  update(@Auth() au: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown, @Meta() m: RequestMeta) {
    return this.a.save(au, t, id, parse(automationSchema, b), m);
  }

  @Put(':id/status')
  @RequirePermission('automations.manage')
  status(@Auth() au: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown, @Meta() m: RequestMeta) {
    return this.a.setStatus(au, t, id, parse(z.object({ status: z.enum(['active', 'paused']) }), b).status, m);
  }

  @Get(':id/history')
  @RequirePermission('crm.read')
  history(@Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.a.history(t, id);
  }

  @Post('simulate')
  @RequirePermission('automations.manage')
  simulate(@Tenant() t: TenantContext, @Body() b: unknown) {
    return this.a.simulate(t, parse(simulateSchema, b));
  }
}

@Module({
  imports: [PatientsModule, SchedulingModule],
  controllers: [CrmController, MessagingController, AutomationsController],
  providers: [CrmService, MessagingService, AutomationsService, { provide: MobileMessageProvider, useFactory: () => new MobileMessageProvider(env()) }],
  exports: [MessagingService, AutomationsService],
})
export class EngagementModule {}
