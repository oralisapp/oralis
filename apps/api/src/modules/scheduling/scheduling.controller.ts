import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  agendaQuerySchema,
  agendaRangeQuerySchema,
  createAppointmentSchema,
  rescheduleAppointmentSchema,
  scheduleBlockSchema,
  transitionAppointmentSchema,
  waitlistSchema,
} from '@oralis/shared';
import { z } from 'zod';
import { parse } from '../../common/app-error';
import { AuthThrottlerGuard } from '../../common/guards';
import { Auth, type AuthContext, Meta, Public, type RequestMeta, RequirePermission, Tenant, type TenantContext } from '../../common/request-context';
import { AppointmentLinksService, rescheduleRequestSchema } from './appointment-links.service';
import { SchedulingService } from './scheduling.service';
import { WaitlistService } from './waitlist.service';

@Controller('orgs/:orgId')
export class SchedulingController {
  constructor(
    private readonly scheduling: SchedulingService,
    private readonly waitlist: WaitlistService,
    private readonly links: AppointmentLinksService,
  ) {}

  /** Agenda de um dia de uma unidade (com recursos necessários para montar a grade). */
  @Get('agenda')
  @RequirePermission('schedule.read')
  agenda(@Tenant() tenant: TenantContext, @Query() query: unknown) {
    const q = parse(agendaQuerySchema, query);
    return this.scheduling.agenda(tenant, q.unitId, q.date);
  }

  @Get('agenda/range')
  @RequirePermission('schedule.read')
  range(@Tenant() tenant: TenantContext, @Query() query: unknown) {
    const q = parse(agendaRangeQuerySchema, query);
    return this.scheduling.range(tenant, q.unitId, q.from, q.to);
  }

  @Get('agenda/open-slots')
  @RequirePermission('schedule.read')
  openSlots(@Tenant() tenant: TenantContext, @Query() query: unknown) {
    const q = parse(agendaQuerySchema.extend({ minMinutes: z.coerce.number().int().min(5).max(480).default(30) }), query);
    return this.scheduling.openSlots(tenant, q.unitId, q.date, q.minMinutes);
  }

  @Post('appointments')
  @RequirePermission('schedule.write')
  create(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.scheduling.create(auth, tenant, parse(createAppointmentSchema, body), meta);
  }

  @Get('appointments/:id')
  @RequirePermission('schedule.read')
  detail(@Tenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.scheduling.detail(tenant, id);
  }

  @Put('appointments/:id/schedule')
  @RequirePermission('schedule.write')
  reschedule(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.scheduling.reschedule(auth, tenant, id, parse(rescheduleAppointmentSchema, body), meta);
  }

  /** A permissão específica depende da transição e é verificada no serviço. */
  @Post('appointments/:id/transitions')
  @RequirePermission('schedule.read')
  transition(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.scheduling.transition(auth, tenant, id, parse(transitionAppointmentSchema, body), meta);
  }

  @Post('appointments/:id/confirmation-link')
  @RequirePermission('schedule.confirm')
  confirmationLink(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.links.create(auth, tenant, id, parse(z.object({ sendEmail: z.boolean().default(false) }), body).sendEmail, meta);
  }

  @Post('schedule-blocks')
  @RequirePermission('schedule.write')
  createBlock(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.scheduling.createBlock(auth, tenant, parse(scheduleBlockSchema, body), meta);
  }

  @Delete('schedule-blocks/:id')
  @RequirePermission('schedule.write')
  deleteBlock(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Query('series') series: string | undefined, @Meta() meta: RequestMeta) {
    return this.scheduling.deleteBlock(auth, tenant, id, series === 'true', meta);
  }

  @Get('waitlist')
  @RequirePermission('schedule.read')
  waitlistList(@Tenant() tenant: TenantContext, @Query('status') status: string | undefined) {
    return this.waitlist.list(tenant, status === 'scheduled' || status === 'removed' ? status : 'active');
  }

  @Post('waitlist')
  @RequirePermission('schedule.write')
  waitlistAdd(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.waitlist.add(auth, tenant, parse(waitlistSchema, body), meta);
  }

  @Delete('waitlist/:id')
  @RequirePermission('schedule.write')
  waitlistRemove(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() meta: RequestMeta) {
    return this.waitlist.remove(auth, tenant, id, meta);
  }

  @Get('waitlist/suggestions')
  @RequirePermission('schedule.read')
  suggestions(@Tenant() tenant: TenantContext, @Query() query: unknown) {
    const q = parse(z.object({ unitId: z.uuid(), professionalId: z.uuid(), startsAt: z.iso.datetime({ offset: true }), endsAt: z.iso.datetime({ offset: true }) }), query);
    return this.waitlist.suggestions(tenant, q.unitId, q.professionalId, new Date(q.startsAt), new Date(q.endsAt));
  }
}

/** Rotas públicas do link de confirmação (sem sessão; o token é a credencial). */
@Controller('public/appointment-links')
@Public()
@UseGuards(AuthThrottlerGuard)
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class PublicAppointmentLinksController {
  constructor(private readonly links: AppointmentLinksService) {}

  @Get(':token')
  view(@Param('token') token: string) {
    return this.links.view(token);
  }

  @Post(':token/confirm')
  @HttpCode(200)
  confirm(@Param('token') token: string, @Meta() meta: RequestMeta) {
    return this.links.confirm(token, meta);
  }

  @Post(':token/reschedule-request')
  @HttpCode(200)
  reschedule(@Param('token') token: string, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.links.requestReschedule(token, parse(rescheduleRequestSchema, body).message, meta);
  }
}
