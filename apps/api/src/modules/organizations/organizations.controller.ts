import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  businessHoursSchema,
  chairSchema,
  createOrganizationSchema,
  inviteSchema,
  professionalSchema,
  serviceSchema,
  unitSchema,
} from '@oralis/shared';
import { z } from 'zod';
import { parse } from '../../common/app-error';
import { AuthThrottlerGuard } from '../../common/guards';
import { Auth, type AuthContext, Meta, Public, type RequestMeta, RequirePermission, Tenant, type TenantContext } from '../../common/request-context';
import { OrganizationsService } from './organizations.service';
import { ResourcesService } from './resources.service';
import { TeamService, updateMemberSchema } from './team.service';

const tokenSchema = z.object({ token: z.string().min(10).max(100) });
const unitWithHoursSchema = z.object({ unit: unitSchema, businessHours: businessHoursSchema });

@Controller('orgs')
export class OrganizationsController {
  constructor(private readonly orgs: OrganizationsService) {}

  @Post()
  create(@Auth() auth: AuthContext, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.orgs.create(auth, parse(createOrganizationSchema, body), meta);
  }

  @Get(':orgId')
  summary(@Tenant() tenant: TenantContext) {
    return this.orgs.summary(tenant);
  }

  @Put(':orgId/security')
  @RequirePermission('org.manage')
  security(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.orgs.updateSecurity(auth, tenant, parse(z.object({ requireMfaPrivileged: z.boolean() }), body).requireMfaPrivileged, meta);
  }

  @Get(':orgId/onboarding')
  onboarding(@Tenant() tenant: TenantContext) {
    return this.orgs.onboarding(tenant);
  }

  @Get(':orgId/units')
  units(@Tenant() tenant: TenantContext) {
    return this.orgs.listUnits(tenant);
  }

  @Post(':orgId/units')
  @RequirePermission('units.manage')
  createUnit(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Body() body: unknown, @Meta() meta: RequestMeta) {
    const input = parse(unitWithHoursSchema, body);
    return this.orgs.createUnit(auth, tenant, input.unit, input.businessHours, meta);
  }

  @Put(':orgId/units/:unitId')
  @RequirePermission('units.manage')
  updateUnit(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('unitId', ParseUUIDPipe) unitId: string, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.orgs.updateUnit(auth, tenant, unitId, parse(unitSchema, body), meta);
  }

  @Put(':orgId/units/:unitId/hours')
  @RequirePermission('units.manage')
  updateHours(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('unitId', ParseUUIDPipe) unitId: string, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.orgs.updateHours(auth, tenant, unitId, parse(businessHoursSchema, body), meta);
  }

  @Get(':orgId/roles')
  @RequirePermission('team.read')
  roles(@Tenant() tenant: TenantContext) {
    return this.orgs.listRoles(tenant);
  }
}

@Controller('orgs/:orgId')
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @Get('members')
  @RequirePermission('team.read')
  members(@Tenant() tenant: TenantContext) {
    return this.team.listMembers(tenant);
  }

  @Put('members/:membershipId')
  @RequirePermission('team.manage')
  updateMember(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('membershipId', ParseUUIDPipe) id: string, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.team.updateMember(auth, tenant, id, parse(updateMemberSchema, body), meta);
  }

  @Delete('members/:membershipId')
  @RequirePermission('team.manage')
  removeMember(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('membershipId', ParseUUIDPipe) id: string, @Meta() meta: RequestMeta) {
    return this.team.removeMember(auth, tenant, id, meta);
  }

  @Get('invitations')
  @RequirePermission('team.manage')
  invitations(@Tenant() tenant: TenantContext) {
    return this.team.listInvitations(tenant);
  }

  @Post('invitations')
  @RequirePermission('team.manage')
  invite(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.team.invite(auth, tenant, parse(inviteSchema, body), meta);
  }

  @Delete('invitations/:id')
  @RequirePermission('team.manage')
  revoke(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() meta: RequestMeta) {
    return this.team.revokeInvitation(auth, tenant, id, meta);
  }
}

/** Rotas de convite fora do contexto de organização (quem aceita ainda não é membro). */
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly team: TeamService) {}

  @Post('preview')
  @Public()
  @UseGuards(AuthThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  preview(@Body() body: unknown) {
    return this.team.preview(parse(tokenSchema, body).token);
  }

  @Post('accept')
  accept(@Auth() auth: AuthContext, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.team.accept(auth, parse(tokenSchema, body).token, meta);
  }
}

@Controller('orgs/:orgId')
export class ResourcesController {
  constructor(private readonly resources: ResourcesService) {}

  @Get('professionals')
  professionals(@Tenant() tenant: TenantContext) {
    return this.resources.listProfessionals(tenant);
  }

  @Post('professionals')
  @RequirePermission('professionals.manage')
  createProfessional(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.resources.saveProfessional(auth, tenant, null, parse(professionalSchema, body), meta);
  }

  @Put('professionals/:id')
  @RequirePermission('professionals.manage')
  updateProfessional(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.resources.saveProfessional(auth, tenant, id, parse(professionalSchema, body), meta);
  }

  @Get('chairs')
  chairs(@Tenant() tenant: TenantContext) {
    return this.resources.listChairs(tenant);
  }

  @Post('chairs')
  @RequirePermission('resources.manage')
  createChair(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.resources.saveChair(auth, tenant, null, parse(chairSchema, body), meta);
  }

  @Put('chairs/:id')
  @RequirePermission('resources.manage')
  updateChair(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.resources.saveChair(auth, tenant, id, parse(chairSchema, body), meta);
  }

  @Get('services')
  services(@Tenant() tenant: TenantContext) {
    return this.resources.listServices(tenant);
  }

  @Post('services')
  @RequirePermission('services.manage')
  createService(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.resources.saveService(auth, tenant, null, parse(serviceSchema, body), meta);
  }

  @Put('services/:id')
  @RequirePermission('services.manage')
  updateService(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.resources.saveService(auth, tenant, id, parse(serviceSchema, body), meta);
  }
}
