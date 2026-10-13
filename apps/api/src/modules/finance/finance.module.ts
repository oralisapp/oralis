import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { parse } from '../../common/app-error';
import { Auth, type AuthContext, Meta, type RequestMeta, RequirePermission, Tenant, type TenantContext } from '../../common/request-context';
import {
  cashAccountSchema,
  categorySchema,
  commissionSchema,
  FinanceService,
  payableSchema,
  paymentSchema,
  payPayableSchema,
  periodSchema,
  receivableSchema,
  refundDecisionSchema,
  refundRequestSchema,
} from './finance.service';

const listQuery = z.object({ status: z.string().optional(), patientId: z.uuid().optional(), from: z.iso.date().optional(), to: z.iso.date().optional() });

@Controller('orgs/:orgId/finance')
class FinanceController {
  constructor(private readonly f: FinanceService) {}

  @Get('categories')
  @RequirePermission('finance.read')
  categories(@Tenant() t: TenantContext) {
    return this.f.categories(t);
  }

  @Post('categories')
  @RequirePermission('finance.approve')
  createCategory(@Tenant() t: TenantContext, @Body() body: unknown) {
    return this.f.createCategory(t, parse(categorySchema, body));
  }

  @Get('accounts')
  @RequirePermission('finance.read')
  accounts(@Tenant() t: TenantContext) {
    return this.f.accounts(t);
  }

  @Post('accounts')
  @RequirePermission('finance.approve')
  createAccount(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Body() body: unknown, @Meta() m: RequestMeta) {
    return this.f.createAccount(a, t, parse(cashAccountSchema, body), m);
  }

  @Get('receivables')
  @RequirePermission('finance.read')
  receivables(@Tenant() t: TenantContext, @Query() q: unknown) {
    return this.f.listReceivables(t, parse(listQuery, q));
  }

  @Post('receivables')
  @RequirePermission('finance.write')
  createReceivable(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Body() body: unknown, @Meta() m: RequestMeta) {
    return this.f.createReceivable(a, t, parse(receivableSchema, body), m);
  }

  @Post('receivables/:id/cancel')
  @RequirePermission('finance.write')
  cancelReceivable(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Meta() m: RequestMeta) {
    return this.f.cancelReceivable(a, t, id, parse(z.object({ reason: z.string().trim().min(3).max(300) }), body).reason, m);
  }

  @Put('receivables/:id/hold')
  @RequirePermission('finance.write')
  hold(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Meta() m: RequestMeta) {
    const i = parse(z.object({ hold: z.boolean(), reason: z.string().trim().max(300).optional() }), body);
    return this.f.setHold(a, t, id, i.hold, i.reason, m);
  }

  @Get('payments')
  @RequirePermission('finance.read')
  payments(@Tenant() t: TenantContext, @Query() q: unknown) {
    return this.f.listPayments(t, parse(listQuery, q));
  }

  @Post('payments')
  @RequirePermission('finance.write')
  pay(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Body() body: unknown, @Meta() m: RequestMeta) {
    return this.f.registerPayment(a, t, parse(paymentSchema, body), m);
  }

  @Get('payments/:id/receipt')
  @RequirePermission('finance.read')
  receipt(@Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.f.receipt(t, id);
  }

  @Post('payments/:id/refunds')
  @RequirePermission('finance.write')
  requestRefund(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Meta() m: RequestMeta) {
    return this.f.requestRefund(a, t, id, parse(refundRequestSchema, body), m);
  }

  @Get('refunds')
  @RequirePermission('finance.read')
  refunds(@Tenant() t: TenantContext, @Query('status') status: string | undefined) {
    return this.f.listRefunds(t, status);
  }

  @Post('refunds/:id/decision')
  @RequirePermission('finance.approve')
  decideRefund(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Meta() m: RequestMeta) {
    return this.f.decideRefund(a, t, id, parse(refundDecisionSchema, body), m);
  }

  @Get('payables')
  @RequirePermission('finance.read')
  payables(@Tenant() t: TenantContext, @Query() q: unknown) {
    return this.f.listPayables(t, parse(listQuery, q));
  }

  @Post('payables')
  @RequirePermission('finance.write')
  createPayable(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Body() body: unknown, @Meta() m: RequestMeta) {
    return this.f.createPayable(a, t, parse(payableSchema, body), m);
  }

  @Post('payables/:id/pay')
  @RequirePermission('finance.write')
  payPayable(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Meta() m: RequestMeta) {
    return this.f.payPayable(a, t, id, parse(payPayableSchema, body), m);
  }

  @Post('payables/:id/cancel')
  @RequirePermission('finance.write')
  cancelPayable(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Meta() m: RequestMeta) {
    return this.f.cancelPayable(a, t, id, m);
  }

  @Post('accounts/:id/statement')
  @RequirePermission('finance.write')
  importStatement(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Meta() m: RequestMeta) {
    return this.f.importStatement(a, t, id, parse(z.object({ csv: z.string().min(5).max(500_000) }), body).csv, m);
  }

  @Get('accounts/:id/reconciliation')
  @RequirePermission('finance.read')
  reconciliation(@Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.f.reconciliation(t, id);
  }

  @Post('statement-lines/:id/match')
  @RequirePermission('finance.write')
  match(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Meta() m: RequestMeta) {
    return this.f.matchLine(a, t, id, parse(z.object({ kind: z.enum(['payment', 'payable', 'ignore']), id: z.uuid().optional() }), body), m);
  }

  @Get('commissions')
  @RequirePermission('finance.read')
  commissions(@Tenant() t: TenantContext) {
    return this.f.commissionRulesList(t);
  }

  @Post('commissions')
  @RequirePermission('finance.approve')
  setCommission(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Body() body: unknown, @Meta() m: RequestMeta) {
    return this.f.setCommission(a, t, parse(commissionSchema, body), m);
  }

  @Get('reports/summary')
  @RequirePermission('finance.read')
  summary(@Tenant() t: TenantContext, @Query() q: unknown) {
    return this.f.summary(t, parse(periodSchema, q));
  }

  @Get('reports/cashflow')
  @RequirePermission('finance.read')
  cashflow(@Tenant() t: TenantContext, @Query() q: unknown) {
    return this.f.cashflow(t, parse(periodSchema, q));
  }

  @Get('reports/professionals')
  @RequirePermission('finance.read')
  byProfessional(@Tenant() t: TenantContext, @Query() q: unknown) {
    return this.f.byProfessional(t, parse(periodSchema, q));
  }

  @Get('reports/procedures')
  @RequirePermission('finance.read')
  byProcedure(@Tenant() t: TenantContext, @Query() q: unknown) {
    return this.f.byProcedure(t, parse(periodSchema, q));
  }

  @Get('delinquency')
  @RequirePermission('finance.read')
  delinquency(@Tenant() t: TenantContext) {
    return this.f.delinquency(t);
  }

  @Get('patients/:patientId/statement')
  @RequirePermission('finance.read')
  statement(@Tenant() t: TenantContext, @Param('patientId', ParseUUIDPipe) id: string) {
    return this.f.patientStatement(t, id);
  }
}

@Module({ controllers: [FinanceController], providers: [FinanceService], exports: [FinanceService] })
export class FinanceModule {}
