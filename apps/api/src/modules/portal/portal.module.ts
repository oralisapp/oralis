import { Body, type CanActivate, Controller, createParamDecorator, type ExecutionContext, Get, HttpCode, Injectable, Module, Param, ParseUUIDPipe, Post, Put, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { communicationPrefsSchema } from '@oralis/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { AppError, parse } from '../../common/app-error';
import { AuthThrottlerGuard } from '../../common/guards';
import { type AppRequest, Auth, type AuthContext, Meta, Public, type RequestMeta, RequirePermission, Tenant, type TenantContext } from '../../common/request-context';
import { ClinicalModule } from '../clinical/clinical.module';
import { DocumentsModule } from '../documents/documents.module';
import { FinanceModule } from '../finance/finance.module';
import { PatientsModule } from '../patients/patients.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { TreatmentsModule } from '../treatments/treatments.module';
import { PATIENT_COOKIE, type PatientCtx, PortalService, profileUpdateSchema } from './portal.service';

type PortalRequest = AppRequest & { patient?: PatientCtx };

/** Sessão do PACIENTE (cookie próprio). Não aceita sessão da equipe e vice-versa. */
@Injectable()
class PatientGuard implements CanActivate {
  constructor(private readonly portal: PortalService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<PortalRequest>();
    const token = (req.cookies as Record<string, string> | undefined)?.[PATIENT_COOKIE];
    const patient = await this.portal.resolve(token);
    if (!patient) throw new AppError('unauthenticated', 'Sua sessão do portal expirou. Peça um novo link de acesso.');
    req.patient = patient;
    return true;
  }
}

const Patient = createParamDecorator((_: unknown, ctx: ExecutionContext): PatientCtx => ctx.switchToHttp().getRequest<PortalRequest>().patient!);

@Controller('portal')
@Public()
class PortalAccessController {
  constructor(private readonly portal: PortalService) {}

  @Post('access')
  @HttpCode(200)
  @UseGuards(AuthThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  access(@Body() body: unknown, @Meta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    return this.portal.exchange(parse(z.object({ token: z.string().min(10).max(100) }), body).token, meta, res);
  }

  @Post('request-link')
  @HttpCode(200)
  @UseGuards(AuthThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async requestLink(@Body() body: unknown, @Meta() meta: RequestMeta) {
    await this.portal.requestLink(parse(z.object({ email: z.email() }), body).email, meta);
    return { ok: true };
  }
}

@Controller('portal')
@Public()
@UseGuards(PatientGuard)
class PortalController {
  constructor(private readonly portal: PortalService) {}

  @Get('me')
  me(@Patient() p: PatientCtx) {
    return this.portal.me(p);
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Patient() p: PatientCtx, @Res({ passthrough: true }) res: Response) {
    return this.portal.logout(p, res);
  }

  @Get('appointments')
  appointments(@Patient() p: PatientCtx) {
    return this.portal.appointments(p);
  }

  @Post('appointments/:id/confirm')
  @HttpCode(200)
  confirm(@Patient() p: PatientCtx, @Param('id', ParseUUIDPipe) id: string, @Meta() meta: RequestMeta) {
    return this.portal.confirm(p, id, meta);
  }

  @Post('appointments/:id/reschedule-request')
  @HttpCode(200)
  reschedule(@Patient() p: PatientCtx, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.portal.requestReschedule(p, id, parse(z.object({ message: z.string().trim().max(300).optional() }), body).message, meta);
  }

  @Get('plans')
  plans(@Patient() p: PatientCtx) {
    return this.portal.plans(p);
  }

  @Post('quotes/:id/approve')
  @HttpCode(200)
  approve(@Patient() p: PatientCtx, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Meta() meta: RequestMeta) {
    const input = parse(z.object({ versionId: z.uuid(), acknowledgedName: z.string().trim().min(3).max(160), accept: z.literal(true, { error: 'Confirme que leu o orçamento.' }) }), body);
    return this.portal.approveQuote(p, id, input, meta);
  }

  @Get('payments')
  payments(@Patient() p: PatientCtx) {
    return this.portal.payments(p);
  }

  @Get('documents')
  documents(@Patient() p: PatientCtx) {
    return this.portal.documents(p);
  }

  @Post('documents/:id/download')
  @HttpCode(200)
  download(@Patient() p: PatientCtx, @Param('id', ParseUUIDPipe) id: string, @Meta() meta: RequestMeta) {
    return this.portal.documentLink(p, id, meta);
  }

  @Get('forms')
  forms(@Patient() p: PatientCtx) {
    return this.portal.forms(p);
  }

  @Post('forms/anamnesis')
  anamnesis(@Patient() p: PatientCtx, @Body() body: unknown, @Meta() meta: RequestMeta) {
    const input = parse(z.object({ templateId: z.uuid(), answers: z.record(z.string(), z.union([z.string().max(1000), z.boolean(), z.null()])) }), body);
    return this.portal.submitAnamnesis(p, input, meta);
  }

  @Get('communication')
  communication(@Patient() p: PatientCtx) {
    return this.portal.communication(p);
  }

  @Put('communication')
  updateCommunication(@Patient() p: PatientCtx, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.portal.updateCommunication(p, parse(communicationPrefsSchema, body).preferences, meta);
  }

  @Post('profile-update')
  @HttpCode(200)
  profile(@Patient() p: PatientCtx, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.portal.requestProfileUpdate(p, parse(profileUpdateSchema, body), meta);
  }

  @Get('requests')
  requests(@Patient() p: PatientCtx) {
    return this.portal.requests(p);
  }
}

/** Lado da clínica: gerar/enviar o link de acesso ao portal. */
@Controller('orgs/:orgId/patients/:patientId/portal-link')
class PortalLinkController {
  constructor(private readonly portal: PortalService) {}

  @Post()
  @RequirePermission('patients.write')
  create(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('patientId', ParseUUIDPipe) patientId: string, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.portal.createLink(auth, tenant, patientId, parse(z.object({ sendEmail: z.boolean().default(false) }), body).sendEmail, meta);
  }
}

@Module({
  imports: [SchedulingModule, TreatmentsModule, FinanceModule, ClinicalModule, DocumentsModule, PatientsModule],
  controllers: [PortalAccessController, PortalController, PortalLinkController],
  providers: [PortalService, PatientGuard],
})
export class PortalModule {}
