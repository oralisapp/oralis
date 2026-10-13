import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Post, Put, Query, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { parse } from '../../common/app-error';
import { Auth, type AuthContext, Meta, type RequestMeta, RequireFeature, RequirePermission, Tenant, type TenantContext } from '../../common/request-context';
import { JobsService } from '../platform/jobs.service';
import { InventoryService, itemSchema, materialSchema, movementSchema, supplierSchema, transferSchema } from './inventory.service';
import { labSchema, LabsService, orderSchema, orderStatusSchema } from './labs.service';

@Controller('orgs/:orgId/inventory')
@RequireFeature('estoque')
class InventoryController {
  constructor(private readonly inv: InventoryService) {}

  @Get('items')
  @RequirePermission('inventory.read')
  items(@Tenant() t: TenantContext, @Query('unitId') unitId: string | undefined) {
    return this.inv.items(t, unitId);
  }

  @Post('items')
  @RequirePermission('inventory.write')
  createItem(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Body() b: unknown, @Meta() m: RequestMeta) {
    return this.inv.createItem(a, t, parse(itemSchema, b), m);
  }

  @Put('items/:id/minimum')
  @RequirePermission('inventory.write')
  minimum(@Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) {
    return this.inv.updateMin(t, id, parse(z.object({ minQuantity: z.string().regex(/^\d{1,9}(\.\d{1,3})?$/) }), b).minQuantity);
  }

  @Get('items/:id/movements')
  @RequirePermission('inventory.read')
  movements(@Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Query('unitId') unitId: string | undefined) {
    return this.inv.movements(t, id, unitId ? parse(z.uuid(), unitId) : undefined);
  }

  @Get('items/:id/lots')
  @RequirePermission('inventory.read')
  lots(@Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Query('unitId', ParseUUIDPipe) unitId: string) {
    return this.inv.lots(t, id, unitId);
  }

  @Post('movements')
  @RequirePermission('inventory.write')
  move(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Body() b: unknown, @Meta() m: RequestMeta) {
    return this.inv.move(a, t, parse(movementSchema, b), m);
  }

  @Post('transfers')
  @RequirePermission('inventory.write')
  transfer(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Body() b: unknown, @Meta() m: RequestMeta) {
    return this.inv.transfer(a, t, parse(transferSchema, b), m);
  }

  @Get('alerts')
  @RequirePermission('inventory.read')
  alerts(@Tenant() t: TenantContext) {
    return this.inv.alerts(t);
  }

  @Get('suppliers')
  @RequirePermission('inventory.read')
  suppliers(@Tenant() t: TenantContext) {
    return this.inv.suppliersList(t);
  }

  @Post('suppliers')
  @RequirePermission('inventory.write')
  createSupplier(@Tenant() t: TenantContext, @Body() b: unknown) {
    return this.inv.createSupplier(t, parse(supplierSchema, b));
  }

  @Get('materials')
  @RequirePermission('inventory.read')
  materials(@Tenant() t: TenantContext) {
    return this.inv.materials(t);
  }

  @Post('materials')
  @RequirePermission('inventory.write')
  setMaterial(@Tenant() t: TenantContext, @Body() b: unknown) {
    return this.inv.setMaterial(t, parse(materialSchema, b));
  }
}

@Controller('orgs/:orgId/labs')
@RequireFeature('laboratorios')
class LabsController {
  constructor(private readonly labs: LabsService) {}

  @Get()
  @RequirePermission('labs.read')
  list(@Tenant() t: TenantContext) {
    return this.labs.labs(t);
  }

  @Post()
  @RequirePermission('labs.write')
  create(@Tenant() t: TenantContext, @Body() b: unknown) {
    return this.labs.createLab(t, parse(labSchema, b));
  }

  @Get('orders')
  @RequirePermission('labs.read')
  orders(@Tenant() t: TenantContext, @Query('status') status: string | undefined, @Query('unitId') unitId: string | undefined) {
    return this.labs.orders(t, status, undefined, unitId ? parse(z.uuid(), unitId) : undefined);
  }

  @Post('orders')
  @RequirePermission('labs.write')
  createOrder(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Body() b: unknown, @Meta() m: RequestMeta) {
    return this.labs.create(a, t, parse(orderSchema, b), m);
  }

  @Get('orders/:id')
  @RequirePermission('labs.read')
  detail(@Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.labs.detail(t, id);
  }

  @Get('orders/:id/sheet')
  @RequirePermission('labs.read')
  sheet(@Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.labs.orderSheet(t, id);
  }

  @Post('orders/:id/status')
  @RequirePermission('labs.write')
  status(@Auth() a: AuthContext, @Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown, @Meta() m: RequestMeta) {
    return this.labs.setStatus(a, t, id, parse(orderStatusSchema, b), m);
  }
}

@Module({ controllers: [InventoryController, LabsController], providers: [InventoryService, LabsService], exports: [InventoryService, LabsService] })
export class OperationsModule implements OnModuleInit {
  constructor(
    private readonly jobs: JobsService,
    private readonly labs: LabsService,
  ) {}

  onModuleInit() {
    this.jobs.every({ name: 'labs.late', everyMs: 6 * 60 * 60_000, run: () => this.labs.flagLate() });
  }
}
