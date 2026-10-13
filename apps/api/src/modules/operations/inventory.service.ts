import { randomUUID } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { zonedParts } from '@oralis/shared';
import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, notFound } from '../../common/app-error';
import { Clock } from '../../common/clock';
import { type AuthContext, type RequestMeta, type TenantContext, canAccessUnit } from '../../common/request-context';
import { DB, type Db, type Tx } from '../../db/db';
import { appointments, clinicUnits, inventoryItems, inventoryLots, serviceMaterials, services, stockMovements, suppliers, tasks, users } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { DomainEvents } from '../platform/domain-events';

const qty = z.string().regex(/^\d{1,9}(\.\d{1,3})?$/, { error: 'Quantidade inválida.' }).refine((v) => Number(v) > 0, { error: 'Quantidade deve ser maior que zero.' });
export const itemSchema = z.object({ name: z.string().trim().min(2).max(120), category: z.string().trim().max(60).optional(), unitMeasure: z.string().trim().min(1).max(20), minQuantity: z.string().regex(/^\d{1,9}(\.\d{1,3})?$/).default('0') });
export const supplierSchema = z.object({ name: z.string().trim().min(2).max(120), contact: z.string().trim().max(120).optional(), phone: z.string().trim().max(30).optional(), email: z.string().trim().max(254).optional() });
export const movementSchema = z
  .object({
    itemId: z.uuid(),
    unitId: z.uuid(),
    type: z.enum(['in', 'out', 'adjust_in', 'adjust_out']),
    quantity: qty,
    lotCode: z.string().trim().max(60).optional(),
    expiresOn: z.iso.date().optional(),
    lotId: z.uuid().optional(),
    unitCost: z.string().regex(/^\d{1,9}(\.\d{1,2})?$/).optional(),
    supplierId: z.uuid().optional(),
    reason: z.string().trim().max(300).optional(),
  })
  .refine((v) => !v.type.startsWith('adjust') || (v.reason && v.reason.length >= 3), { error: 'Ajustes exigem motivo.', path: ['reason'] });
export const transferSchema = z.object({ itemId: z.uuid(), fromUnitId: z.uuid(), toUnitId: z.uuid(), quantity: qty, lotId: z.uuid().optional(), reason: z.string().trim().max(300).optional() });
export const materialSchema = z.object({ serviceId: z.uuid(), itemId: z.uuid(), quantity: qty });

const SIGN: Record<string, 1 | -1> = { in: 1, adjust_in: 1, transfer_in: 1, out: -1, adjust_out: -1, transfer_out: -1, consumption: -1 };

@Injectable()
export class InventoryService implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
  ) {}

  onModuleInit() {
    // Consulta concluída: baixa os materiais configurados para o serviço (FIFO por validade).
    this.events.on('appointment.status_changed', async (tx, e) => {
      if (e.to !== 'completed') return;
      const [a] = await tx.select({ serviceId: appointments.serviceId, unitId: appointments.unitId }).from(appointments).where(eq(appointments.id, e.appointmentId));
      if (!a?.serviceId) return;
      const mats = await tx.select().from(serviceMaterials).where(eq(serviceMaterials.serviceId, a.serviceId));
      for (const m of mats) await this.consume(tx, e.organizationId, m.itemId, a.unitId, Number(m.quantity), e.appointmentId, e.actorUserId);
    });
  }

  private balanceExpr() {
    return sql<string>`coalesce(sum(case when ${stockMovements.type} in ('in','adjust_in','transfer_in') then ${stockMovements.quantity} else -${stockMovements.quantity} end), 0)`;
  }

  async balance(db: Db | Tx, organizationId: string, itemId: string, unitId: string, lotId?: string | null) {
    const [r] = await db.select({ b: this.balanceExpr() }).from(stockMovements).where(and(eq(stockMovements.organizationId, organizationId), eq(stockMovements.itemId, itemId), eq(stockMovements.unitId, unitId), lotId ? eq(stockMovements.lotId, lotId) : undefined));
    return Number(r?.b ?? 0);
  }

  /** Serializa movimentações do mesmo item/unidade: o saldo nunca fica negativo. */
  private async lock(tx: Tx, itemId: string, unitId: string) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`stock:${itemId}:${unitId}`}, 0))`);
  }

  async lots(tenant: TenantContext, itemId: string, unitId: string) {
    if (!canAccessUnit(tenant, unitId)) throw notFound('Unidade');
    return this.db.select({ id: stockMovements.lotId, lotCode: inventoryLots.lotCode, expiresOn: inventoryLots.expiresOn, balance: this.balanceExpr() }).from(stockMovements)
      .leftJoin(inventoryLots, eq(inventoryLots.id, stockMovements.lotId))
      .where(and(eq(stockMovements.organizationId, tenant.organizationId), eq(stockMovements.itemId, itemId), eq(stockMovements.unitId, unitId)))
      .groupBy(stockMovements.lotId, inventoryLots.lotCode, inventoryLots.expiresOn)
      .having(sql`${this.balanceExpr()} > 0`).orderBy(sql`${inventoryLots.expiresOn} asc nulls last`);
  }

  /** Allocate an unspecified withdrawal across actual balances; never invent a negative untracked lot. */
  private async allocate(tx: Tx, organizationId: string, itemId: string, unitId: string, quantity: string, lotId?: string | null) {
    const rows = await tx.select({ lotId: stockMovements.lotId, balance: this.balanceExpr() }).from(stockMovements)
      .leftJoin(inventoryLots, eq(inventoryLots.id, stockMovements.lotId))
      .where(and(eq(stockMovements.organizationId, organizationId), eq(stockMovements.itemId, itemId), eq(stockMovements.unitId, unitId), lotId ? eq(stockMovements.lotId, lotId) : undefined))
      .groupBy(stockMovements.lotId, inventoryLots.expiresOn).orderBy(sql`${inventoryLots.expiresOn} asc nulls last`);
    let left = Math.round(Number(quantity) * 1000);
    const result: { lotId: string | null; quantity: string }[] = [];
    for (const row of rows) {
      const take = Math.min(left, Math.max(0, Math.round(Number(row.balance) * 1000)));
      if (take > 0) result.push({ lotId: row.lotId, quantity: (take / 1000).toFixed(3) });
      left -= take;
      if (left === 0) break;
    }
    if (left > 0) throw new AppError('validation_failed', 'Saldo insuficiente para esta movimentação.');
    return result;
  }

  private async consume(tx: Tx, organizationId: string, itemId: string, unitId: string, needed: number, appointmentId: string, actor: string | null) {
    await this.lock(tx, itemId, unitId);
    const lots = await tx
      .select({ lotId: stockMovements.lotId, expiresOn: inventoryLots.expiresOn, b: this.balanceExpr() })
      .from(stockMovements)
      .leftJoin(inventoryLots, eq(inventoryLots.id, stockMovements.lotId))
      .where(and(eq(stockMovements.organizationId, organizationId), eq(stockMovements.itemId, itemId), eq(stockMovements.unitId, unitId)))
      .groupBy(stockMovements.lotId, inventoryLots.expiresOn)
      .orderBy(sql`${inventoryLots.expiresOn} asc nulls last`);
    let left = needed;
    for (const l of lots) {
      const avail = Number(l.b);
      if (avail <= 0 || left <= 0) continue;
      const take = Math.min(avail, left);
      await tx.insert(stockMovements).values({ organizationId, itemId, lotId: l.lotId, unitId, type: 'consumption', quantity: take.toFixed(3), appointmentId, createdBy: actor, reason: 'Consumo do procedimento' });
      left -= take;
    }
    if (left > 0.0005) {
      // Falta de material não bloqueia o atendimento: vira alerta para a equipe.
      const [item] = await tx.select({ name: inventoryItems.name }).from(inventoryItems).where(eq(inventoryItems.id, itemId));
      await tx.insert(tasks).values({ organizationId, unitId, title: `Estoque insuficiente: ${item?.name}`, description: `Faltaram ${left.toFixed(3)} para a baixa automática de um atendimento. Confira o estoque e registre a entrada.`, origin: 'system', relatedType: 'inventory_item', relatedId: itemId, dedupeKey: `stock-short:${itemId}:${appointmentId}` }).onConflictDoNothing();
    }
    await this.events.emit(tx, 'stock.moved', { organizationId, itemId, unitId });
  }

  async items(tenant: TenantContext, unitId?: string) {
    const rows = await this.db.select().from(inventoryItems).where(eq(inventoryItems.organizationId, tenant.organizationId)).orderBy(asc(inventoryItems.name));
    const units = (await this.db.select({ id: clinicUnits.id, name: clinicUnits.name }).from(clinicUnits).where(eq(clinicUnits.organizationId, tenant.organizationId))).filter((u) => canAccessUnit(tenant, u.id) && (!unitId || u.id === unitId));
    const balances = await this.db
      .select({ itemId: stockMovements.itemId, unitId: stockMovements.unitId, b: this.balanceExpr() })
      .from(stockMovements)
      .where(eq(stockMovements.organizationId, tenant.organizationId))
      .groupBy(stockMovements.itemId, stockMovements.unitId);
    return rows.map((i) => {
      const perUnit = units.map((u) => {
        const b = Number(balances.find((x) => x.itemId === i.id && x.unitId === u.id)?.b ?? 0);
        return { unitId: u.id, unitName: u.name, balance: b, belowMin: b < Number(i.minQuantity) };
      });
      return { ...i, perUnit, belowMin: perUnit.some((p) => p.belowMin) };
    });
  }

  async createItem(auth: AuthContext, tenant: TenantContext, input: z.infer<typeof itemSchema>, meta: RequestMeta) {
    const [r] = await this.db.insert(inventoryItems).values({ organizationId: tenant.organizationId, ...input, category: input.category ?? null }).returning({ id: inventoryItems.id });
    await this.audit.record(this.db, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'inventory.item_created', entityType: 'inventory_item', entityId: r!.id, meta });
    return { id: r!.id };
  }

  async updateMin(tenant: TenantContext, id: string, minQuantity: string) {
    const r = await this.db.update(inventoryItems).set({ minQuantity }).where(and(eq(inventoryItems.id, id), eq(inventoryItems.organizationId, tenant.organizationId))).returning({ id: inventoryItems.id });
    if (!r.length) throw notFound('Item');
    return { ok: true };
  }

  async suppliersList(tenant: TenantContext) {
    return this.db.select().from(suppliers).where(eq(suppliers.organizationId, tenant.organizationId)).orderBy(asc(suppliers.name));
  }

  async createSupplier(tenant: TenantContext, input: z.infer<typeof supplierSchema>) {
    const [r] = await this.db.insert(suppliers).values({ organizationId: tenant.organizationId, name: input.name, contact: input.contact ?? null, phone: input.phone ?? null, email: input.email ?? null }).returning({ id: suppliers.id });
    return { id: r!.id };
  }

  async move(auth: AuthContext, tenant: TenantContext, input: z.infer<typeof movementSchema>, meta: RequestMeta) {
    if (!canAccessUnit(tenant, input.unitId)) throw notFound('Unidade');
    return this.db.transaction(async (tx) => {
      const [unit] = await tx.select({ id: clinicUnits.id }).from(clinicUnits).where(and(eq(clinicUnits.id, input.unitId), eq(clinicUnits.organizationId, tenant.organizationId)));
      if (!unit) throw notFound('Unidade');
      if (input.supplierId) {
        const [supplier] = await tx.select({ id: suppliers.id }).from(suppliers).where(and(eq(suppliers.id, input.supplierId), eq(suppliers.organizationId, tenant.organizationId)));
        if (!supplier) throw notFound('Fornecedor');
      }
      if (input.lotId) {
        const [lot] = await tx.select({ id: inventoryLots.id }).from(inventoryLots).where(and(eq(inventoryLots.id, input.lotId), eq(inventoryLots.organizationId, tenant.organizationId), eq(inventoryLots.itemId, input.itemId)));
        if (!lot) throw notFound('Lote');
      }
      const [item] = await tx.select().from(inventoryItems).where(and(eq(inventoryItems.id, input.itemId), eq(inventoryItems.organizationId, tenant.organizationId)));
      if (!item) throw notFound('Item');
      await this.lock(tx, item.id, input.unitId);
      let lotId = input.lotId ?? null;
      if (!lotId && input.lotCode) {
        const [lot] = await tx.insert(inventoryLots).values({ organizationId: tenant.organizationId, itemId: item.id, lotCode: input.lotCode, expiresOn: input.expiresOn ?? null }).onConflictDoUpdate({ target: [inventoryLots.itemId, inventoryLots.lotCode], set: { lotCode: input.lotCode } }).returning({ id: inventoryLots.id });
        lotId = lot!.id;
      }
      if (SIGN[input.type] === -1) {
        const available = await this.balance(tx, tenant.organizationId, item.id, input.unitId, lotId);
        if (available < Number(input.quantity)) throw new AppError('validation_failed', `Saldo insuficiente (${available} ${item.unitMeasure} disponível${lotId ? ' neste lote' : ''}).`);
      }
      const allocations = SIGN[input.type] === -1 ? await this.allocate(tx, tenant.organizationId, item.id, input.unitId, input.quantity, lotId) : [{ lotId, quantity: input.quantity }];
      const [m] = await tx
        .insert(stockMovements)
        .values(allocations.map(allocation => ({ organizationId: tenant.organizationId, itemId: item.id, ...allocation, unitId: input.unitId, type: input.type, unitCost: input.unitCost ?? null, supplierId: input.supplierId ?? null, reason: input.reason ?? null, createdBy: auth.userId, createdAt: this.clock.now() })))
        .returning({ id: stockMovements.id });
      await this.audit.record(tx, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'inventory.moved', entityType: 'inventory_item', entityId: item.id, unitId: input.unitId, metadata: { type: input.type, quantity: input.quantity, reason: input.reason ?? null }, meta });
      await this.events.emit(tx, 'stock.moved', { organizationId: tenant.organizationId, itemId: item.id, unitId: input.unitId });
      return { id: m!.id };
    });
  }

  async transfer(auth: AuthContext, tenant: TenantContext, input: z.infer<typeof transferSchema>, meta: RequestMeta) {
    if (input.fromUnitId === input.toUnitId) throw new AppError('validation_failed', 'Escolha unidades diferentes.');
    if (!canAccessUnit(tenant, input.fromUnitId) || !canAccessUnit(tenant, input.toUnitId)) throw notFound('Unidade');
    return this.db.transaction(async (tx) => {
      const units = await tx.select({ id: clinicUnits.id }).from(clinicUnits).where(and(inArray(clinicUnits.id, [input.fromUnitId, input.toUnitId]), eq(clinicUnits.organizationId, tenant.organizationId)));
      if (units.length !== 2) throw notFound('Unidade');
      if (input.lotId) {
        const [lot] = await tx.select({ id: inventoryLots.id }).from(inventoryLots).where(and(eq(inventoryLots.id, input.lotId), eq(inventoryLots.organizationId, tenant.organizationId), eq(inventoryLots.itemId, input.itemId)));
        if (!lot) throw notFound('Lote');
      }
      const [item] = await tx.select().from(inventoryItems).where(and(eq(inventoryItems.id, input.itemId), eq(inventoryItems.organizationId, tenant.organizationId)));
      if (!item) throw notFound('Item');
      // Stable lock order also protects incoming transfers against concurrent withdrawals.
      for (const unitId of [input.fromUnitId, input.toUnitId].sort()) await this.lock(tx, item.id, unitId);
      const available = await this.balance(tx, tenant.organizationId, item.id, input.fromUnitId, input.lotId);
      if (available < Number(input.quantity)) throw new AppError('validation_failed', `Saldo insuficiente na origem (${available}).`);
      const transferId = randomUUID();
      const base = { organizationId: tenant.organizationId, itemId: item.id, lotId: input.lotId ?? null, quantity: input.quantity, transferId, reason: input.reason ?? 'Transferência entre unidades', createdBy: auth.userId };
      const allocations = await this.allocate(tx, tenant.organizationId, item.id, input.fromUnitId, input.quantity, input.lotId);
      await tx.insert(stockMovements).values(allocations.flatMap(allocation => [{ ...base, ...allocation, unitId: input.fromUnitId, type: 'transfer_out' }, { ...base, ...allocation, unitId: input.toUnitId, type: 'transfer_in' }]));
      await this.audit.record(tx, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'inventory.transferred', entityType: 'inventory_item', entityId: item.id, metadata: { from: input.fromUnitId, to: input.toUnitId, quantity: input.quantity }, meta });
      await this.events.emit(tx, 'stock.moved', { organizationId: tenant.organizationId, itemId: item.id, unitId: input.fromUnitId });
      return { transferId };
    });
  }

  async movements(tenant: TenantContext, itemId: string, unitId?: string) {
    if (unitId && !canAccessUnit(tenant, unitId)) throw notFound('Unidade');
    return this.db
      .select({ m: stockMovements, lotCode: inventoryLots.lotCode, expiresOn: inventoryLots.expiresOn, unitName: clinicUnits.name, byName: users.name })
      .from(stockMovements)
      .leftJoin(inventoryLots, eq(inventoryLots.id, stockMovements.lotId))
      .innerJoin(clinicUnits, eq(clinicUnits.id, stockMovements.unitId))
      .leftJoin(users, eq(users.id, stockMovements.createdBy))
      .where(and(eq(stockMovements.organizationId, tenant.organizationId), eq(stockMovements.itemId, itemId), unitId ? eq(stockMovements.unitId, unitId) : undefined, tenant.allUnits ? undefined : inArray(stockMovements.unitId, [...tenant.unitIds])))
      .orderBy(desc(stockMovements.createdAt))
      .limit(300);
  }

  /** Sugestões de reposição (nunca compra automática) e lotes perto do vencimento. */
  async alerts(tenant: TenantContext) {
    const items = await this.items(tenant);
    const reorder = items.flatMap((i) => i.perUnit.filter((u) => u.belowMin).map((u) => ({ itemId: i.id, name: i.name, unitId: u.unitId, unitName: u.unitName, balance: u.balance, min: Number(i.minQuantity), suggested: Math.max(0, Number(i.minQuantity) * 2 - u.balance), unitMeasure: i.unitMeasure })));
    const soon = new Date(this.clock.now().getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
    const expiring = await this.db
      .select({ lotId: inventoryLots.id, lotCode: inventoryLots.lotCode, expiresOn: inventoryLots.expiresOn, itemName: inventoryItems.name, unitId: stockMovements.unitId, b: this.balanceExpr() })
      .from(inventoryLots)
      .innerJoin(inventoryItems, eq(inventoryItems.id, inventoryLots.itemId))
      .innerJoin(stockMovements, eq(stockMovements.lotId, inventoryLots.id))
      .where(and(eq(inventoryLots.organizationId, tenant.organizationId), lte(inventoryLots.expiresOn, soon)))
      .groupBy(inventoryLots.id, inventoryLots.lotCode, inventoryLots.expiresOn, inventoryItems.name, stockMovements.unitId);
    const today = zonedParts(this.clock.now(), 'America/Sao_Paulo').date;
    return { reorder, expiring: expiring.filter((e) => Number(e.b) > 0 && canAccessUnit(tenant, e.unitId)).map((e) => ({ ...e, balance: Number(e.b), expired: (e.expiresOn ?? '') < today })) };
  }

  async materials(tenant: TenantContext) {
    return this.db.select({ id: serviceMaterials.id, serviceId: serviceMaterials.serviceId, serviceName: services.name, itemId: serviceMaterials.itemId, itemName: inventoryItems.name, quantity: serviceMaterials.quantity, unitMeasure: inventoryItems.unitMeasure }).from(serviceMaterials).innerJoin(services, eq(services.id, serviceMaterials.serviceId)).innerJoin(inventoryItems, eq(inventoryItems.id, serviceMaterials.itemId)).where(eq(serviceMaterials.organizationId, tenant.organizationId));
  }

  async setMaterial(tenant: TenantContext, input: z.infer<typeof materialSchema>) {
    const [service] = await this.db.select({ id: services.id }).from(services).where(and(eq(services.id, input.serviceId), eq(services.organizationId, tenant.organizationId)));
    const [item] = await this.db.select({ id: inventoryItems.id }).from(inventoryItems).where(and(eq(inventoryItems.id, input.itemId), eq(inventoryItems.organizationId, tenant.organizationId)));
    if (!service) throw notFound('Procedimento');
    if (!item) throw notFound('Item');
    await this.db.insert(serviceMaterials).values({ organizationId: tenant.organizationId, ...input }).onConflictDoUpdate({ target: [serviceMaterials.serviceId, serviceMaterials.itemId], set: { quantity: input.quantity } });
    return { ok: true };
  }
}
