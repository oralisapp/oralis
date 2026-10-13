import { Body, Controller, Get, Global, Headers, HttpCode, Module, Param, ParseUUIDPipe, Post, Req, Res, type OnModuleInit } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { parse } from '../../common/app-error';
import { AllowWhenInactive, type AppRequest, Auth, type AuthContext, Meta, Public, type RequestMeta, RequirePermission, SkipCsrf, Tenant, type TenantContext } from '../../common/request-context';
import { JobsService } from '../platform/jobs.service';
import { BillingService, changePlanSchema, checkoutSchema } from './billing.service';
import { EXPORT_SCOPES, ExportsService, exportSchema } from './exports.service';
import { StripeClient } from './stripe.client';

@Controller('orgs/:orgId/billing')
@AllowWhenInactive()
class BillingController {
  constructor(private readonly billing: BillingService) {}

  /** Visão da assinatura: qualquer membro vê o estado (para entender um bloqueio); só quem gerencia altera. */
  @Get()
  overview(@Tenant() t: TenantContext) {
    return this.billing.overview(t);
  }

  @Post('checkout')
  @RequirePermission('billing.manage')
  checkout(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Body() body: unknown, @Meta() m: RequestMeta) {
    return this.billing.checkout(a, t, parse(checkoutSchema, body), m);
  }

  @Post('change/preview')
  @RequirePermission('billing.manage')
  preview(@Tenant() t: TenantContext, @Body() body: unknown) {
    return this.billing.previewChange(t, parse(changePlanSchema, body));
  }

  @Post('change')
  @RequirePermission('billing.manage')
  change(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Body() body: unknown, @Meta() m: RequestMeta) {
    return this.billing.changePlan(a, t, parse(changePlanSchema, body), m);
  }

  @Post('cancel')
  @RequirePermission('billing.manage')
  cancel(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Body() body: unknown, @Meta() m: RequestMeta) {
    return this.billing.cancel(a, t, parse(z.object({ reason: z.string().trim().max(500).optional() }), body).reason, m);
  }

  @Post('resume')
  @RequirePermission('billing.manage')
  resume(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Meta() m: RequestMeta) {
    return this.billing.resume(a, t, m);
  }

  @Post('portal')
  @RequirePermission('billing.manage')
  portal(@Tenant() t: TenantContext) {
    return this.billing.portal(t);
  }
}

@Controller('orgs/:orgId/exports')
@AllowWhenInactive()
class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  @Get()
  @RequirePermission('data.export')
  list(@Tenant() t: TenantContext) {
    return this.exports.list(t);
  }

  @Get('scopes')
  @RequirePermission('data.export')
  scopes() {
    return EXPORT_SCOPES;
  }

  @Post()
  @RequirePermission('data.export')
  create(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Body() body: unknown, @Meta() m: RequestMeta) {
    return this.exports.request(a, t, parse(exportSchema, body).scope, m);
  }

  @Get(':id/download')
  @RequirePermission('data.export')
  async download(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() m: RequestMeta, @Res() res: Response) {
    const f = await this.exports.download(a, t, id, m);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${f.filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(f.content);
  }
}

@Controller()
class PublicBillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('public/plans')
  @Public()
  plans() {
    return this.billing.publicPlans();
  }

  /** Webhook do provedor: sem sessão e sem CSRF; autenticado pela assinatura HMAC. */
  @Post('billing/webhooks/stripe')
  @Public()
  @SkipCsrf()
  @HttpCode(200)
  webhook(@Req() req: AppRequest & { rawBody?: Buffer }, @Headers('stripe-signature') sig: string | undefined) {
    return this.billing.handleStripeWebhook(req.rawBody, sig);
  }
}

@Global()
@Module({
  controllers: [BillingController, ExportsController, PublicBillingController],
  providers: [BillingService, ExportsService, StripeClient],
  exports: [BillingService],
})
export class BillingModule implements OnModuleInit {
  constructor(
    private readonly jobs: JobsService,
    private readonly billing: BillingService,
  ) {}

  onModuleInit() {
    this.jobs.every({ name: 'billing.evaluate', everyMs: 60 * 60_000, run: () => this.billing.evaluate() });
  }
}
