import { Inject, Injectable } from '@nestjs/common';
import { BLOCKING_STATUSES, zonedParts } from '@oralis/shared';
import { and, asc, desc, eq, gt, inArray, lt, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, notFound } from '../../common/app-error';
import { Clock } from '../../common/clock';
import { type AuthContext, type RequestMeta, type TenantContext, canAccessUnit } from '../../common/request-context';
import { DB, type Db } from '../../db/db';
import { appointments, clinicUnits, documents, laboratories, laboratoryOrderEvents, laboratoryOrders, patients, professionals, tasks, treatmentItems, treatmentPlans, users } from '../../db/schema';
import { AuditService } from '../audit/audit.service';

export const labSchema = z.object({ name: z.string().trim().min(2).max(120), phone: z.string().trim().max(30).optional(), email: z.string().trim().max(254).optional(), notes: z.string().trim().max(500).optional() });
export const orderSchema = z.object({
  unitId: z.uuid(),
  patientId: z.uuid(),
  laboratoryId: z.uuid(),
  professionalId: z.uuid().optional(),
  treatmentItemId: z.uuid().optional(),
  work: z.string().trim().min(3).max(200),
  instructions: z.string().trim().max(2000).optional(),
  shade: z.string().trim().max(40).optional(),
  dueDate: z.iso.date(),
  cost: z.string().regex(/^\d{1,9}(\.\d{1,2})?$/).optional(),
  documentIds: z.array(z.uuid()).max(10).default([]),
});
export const LAB_FLOW = ['requested', 'sent', 'in_production', 'received', 'delivered'] as const;
export const orderStatusSchema = z.object({ to: z.enum(['requested', 'sent', 'in_production', 'received', 'delivered', 'cancelled']), note: z.string().trim().max(500).optional(), rework: z.boolean().default(false) });

const ALLOWED: Record<string, string[]> = {
  requested: ['sent', 'cancelled'],
  sent: ['in_production', 'received', 'cancelled'],
  in_production: ['received', 'cancelled'],
  received: ['delivered', 'sent'], // "sent" a partir de recebido = retrabalho
  delivered: ['sent'],
  cancelled: [],
};

@Injectable()
export class LabsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  private today() {
    return zonedParts(this.clock.now(), 'America/Sao_Paulo').date;
  }

  async labs(tenant: TenantContext) {
    return this.db.select().from(laboratories).where(eq(laboratories.organizationId, tenant.organizationId)).orderBy(asc(laboratories.name));
  }

  async createLab(tenant: TenantContext, input: z.infer<typeof labSchema>) {
    const [r] = await this.db.insert(laboratories).values({ organizationId: tenant.organizationId, name: input.name, phone: input.phone ?? null, email: input.email ?? null, notes: input.notes ?? null }).returning({ id: laboratories.id });
    return { id: r!.id };
  }

  async orders(tenant: TenantContext, status?: string, id?: string, unitId?: string) {
    if (unitId && !canAccessUnit(tenant, unitId)) throw notFound('Unidade');
    const rows = await this.db
      .select({ o: laboratoryOrders, patientName: patients.fullName, labName: laboratories.name, professionalName: professionals.displayName })
      .from(laboratoryOrders)
      .innerJoin(patients, eq(patients.id, laboratoryOrders.patientId))
      .innerJoin(laboratories, eq(laboratories.id, laboratoryOrders.laboratoryId))
      .leftJoin(professionals, eq(professionals.id, laboratoryOrders.professionalId))
      .where(and(eq(laboratoryOrders.organizationId, tenant.organizationId), id ? eq(laboratoryOrders.id, id) : undefined, unitId ? eq(laboratoryOrders.unitId, unitId) : undefined, tenant.allUnits ? undefined : inArray(laboratoryOrders.unitId, [...tenant.unitIds]), status === 'open' ? notInArray(laboratoryOrders.status, ['delivered', 'cancelled']) : status ? eq(laboratoryOrders.status, status) : undefined))
      .orderBy(asc(laboratoryOrders.dueDate))
      .limit(500);
    const today = this.today();
    return rows
      .filter((r) => canAccessUnit(tenant, r.o.unitId))
      .map((r) => ({ ...r.o, patientName: r.patientName, labName: r.labName, professionalName: r.professionalName, late: !['received', 'delivered', 'cancelled'].includes(r.o.status) && r.o.dueDate < today }));
  }

  async create(auth: AuthContext, tenant: TenantContext, input: z.infer<typeof orderSchema>, meta: RequestMeta) {
    if (!canAccessUnit(tenant, input.unitId)) throw notFound('Unidade');
    return this.db.transaction(async (tx) => {
      const [unit] = await tx.select({ id: clinicUnits.id }).from(clinicUnits).where(and(eq(clinicUnits.id, input.unitId), eq(clinicUnits.organizationId, tenant.organizationId)));
      if (!unit) throw notFound('Unidade');
      if (input.professionalId) {
        const [professional] = await tx.select({ id: professionals.id }).from(professionals).where(and(eq(professionals.id, input.professionalId), eq(professionals.organizationId, tenant.organizationId)));
        if (!professional) throw notFound('Profissional');
      }
      if (input.treatmentItemId) {
        const [item] = await tx.select({ id: treatmentItems.id }).from(treatmentItems).innerJoin(treatmentPlans, eq(treatmentPlans.id, treatmentItems.planId)).where(and(eq(treatmentItems.id, input.treatmentItemId), eq(treatmentItems.organizationId, tenant.organizationId), eq(treatmentPlans.patientId, input.patientId), eq(treatmentPlans.unitId, input.unitId)));
        if (!item) throw notFound('Etapa de tratamento');
      }
      if (input.documentIds.length) {
        const found = await tx.select({ id: documents.id }).from(documents).where(and(inArray(documents.id, input.documentIds), eq(documents.organizationId, tenant.organizationId), eq(documents.patientId, input.patientId)));
        if (found.length !== new Set(input.documentIds).size) throw notFound('Documento');
      }
      const [lab] = await tx.select({ id: laboratories.id }).from(laboratories).where(and(eq(laboratories.id, input.laboratoryId), eq(laboratories.organizationId, tenant.organizationId)));
      if (!lab) throw notFound('Laboratório');
      const [p] = await tx.select({ id: patients.id }).from(patients).where(and(eq(patients.id, input.patientId), eq(patients.organizationId, tenant.organizationId)));
      if (!p) throw notFound('Paciente');
      const [o] = await tx
        .insert(laboratoryOrders)
        .values({ organizationId: tenant.organizationId, ...input, professionalId: input.professionalId ?? null, treatmentItemId: input.treatmentItemId ?? null, instructions: input.instructions ?? null, shade: input.shade ?? null, cost: input.cost ?? null, createdBy: auth.userId })
        .returning({ id: laboratoryOrders.id });
      await tx.insert(laboratoryOrderEvents).values({ organizationId: tenant.organizationId, orderId: o!.id, toStatus: 'requested', createdBy: auth.userId });
      await this.audit.record(tx, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'lab.order_created', entityType: 'laboratory_order', entityId: o!.id, unitId: input.unitId, metadata: { laboratoryId: input.laboratoryId, dueDate: input.dueDate }, meta });
      return { id: o!.id };
    });
  }

  async detail(tenant: TenantContext, id: string) {
    const [o] = await this.orders(tenant, undefined, id);
    if (!o) throw notFound('Trabalho de laboratório');
    const events = await this.db.select({ e: laboratoryOrderEvents, byName: users.name }).from(laboratoryOrderEvents).innerJoin(users, eq(users.id, laboratoryOrderEvents.createdBy)).where(eq(laboratoryOrderEvents.orderId, id)).orderBy(asc(laboratoryOrderEvents.createdAt));
    return { order: o, events: events.map((x) => ({ ...x.e, byName: x.byName })) };
  }

  /**
   * Avança o status. Ao receber um trabalho ligado a uma etapa do plano sem
   * sessão futura agendada, cria tarefa para agendar a instalação (jornada E).
   */
  async setStatus(auth: AuthContext, tenant: TenantContext, id: string, input: z.infer<typeof orderStatusSchema>, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const [o] = await tx.select().from(laboratoryOrders).where(and(eq(laboratoryOrders.id, id), eq(laboratoryOrders.organizationId, tenant.organizationId))).for('update');
      if (!o || !canAccessUnit(tenant, o.unitId)) throw notFound('Trabalho de laboratório');
      if (!ALLOWED[o.status]!.includes(input.to)) throw new AppError('invalid_transition', 'Mudança de situação não permitida.');
      const rework = input.rework || ((o.status === 'received' || o.status === 'delivered') && input.to === 'sent');
      await tx.update(laboratoryOrders).set({ status: input.to, reworkCount: rework ? o.reworkCount + 1 : o.reworkCount, updatedAt: this.clock.now() }).where(eq(laboratoryOrders.id, id));
      await tx.insert(laboratoryOrderEvents).values({ organizationId: tenant.organizationId, orderId: id, fromStatus: o.status, toStatus: input.to, rework, note: input.note ?? null, createdBy: auth.userId });
      if (input.to === 'received' && o.treatmentItemId) {
        const future = await tx.select({ id: appointments.id }).from(appointments).where(and(eq(appointments.treatmentItemId, o.treatmentItemId), inArray(appointments.status, [...BLOCKING_STATUSES]), gt(appointments.startsAt, this.clock.now())));
        if (!future.length) {
          const [item] = await tx.select({ description: treatmentItems.description }).from(treatmentItems).where(eq(treatmentItems.id, o.treatmentItemId));
          const [p] = await tx.select({ fullName: patients.fullName }).from(patients).where(eq(patients.id, o.patientId));
          await tx.insert(tasks).values({ organizationId: tenant.organizationId, unitId: o.unitId, title: `Trabalho recebido — agendar: ${item?.description ?? o.work} (${p!.fullName})`, assigneeRoleKey: 'reception', origin: 'system', relatedType: 'laboratory_order', relatedId: id, dedupeKey: `lab-received:${id}:${o.reworkCount}`, dueAt: this.clock.now() }).onConflictDoNothing();
        }
      }
      await this.audit.record(tx, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'lab.order_status', entityType: 'laboratory_order', entityId: id, metadata: { from: o.status, to: input.to, rework }, meta });
      return { status: input.to };
    });
  }

  /** Trabalhos com prazo vencido e ainda não recebidos (tarefa diária, uma por pedido e dia). */
  async flagLate() {
    const today = this.today();
    const late = await this.db.select().from(laboratoryOrders).where(and(lt(laboratoryOrders.dueDate, today), inArray(laboratoryOrders.status, ['requested', 'sent', 'in_production'])));
    for (const o of late) {
      await this.db.insert(tasks).values({ organizationId: o.organizationId, unitId: o.unitId, title: `Laboratório atrasado: ${o.work}`, description: `Prazo era ${o.dueDate.split('-').reverse().join('/')}.`, assigneeRoleKey: 'reception', origin: 'system', relatedType: 'laboratory_order', relatedId: o.id, dedupeKey: `lab-late:${o.id}:${today}` }).onConflictDoNothing();
    }
    return late.length;
  }

  async orderSheet(tenant: TenantContext, id: string) {
    const { order } = await this.detail(tenant, id);
    const names = order.patientName.split(' ');
    // Minimização: o laboratório recebe só o necessário (iniciais, trabalho, instruções, cor, prazo).
    return { patient: `${names[0]} ${names.slice(1).map((n) => `${n[0]}.`).join(' ')}`, work: order.work, instructions: order.instructions, shade: order.shade, dueDate: order.dueDate, lab: order.labName, professional: order.professionalName };
  }

  async history(tenant: TenantContext, patientId: string) {
    return this.db.select().from(laboratoryOrders).where(and(eq(laboratoryOrders.organizationId, tenant.organizationId), eq(laboratoryOrders.patientId, patientId), tenant.allUnits ? undefined : inArray(laboratoryOrders.unitId, [...tenant.unitIds]))).orderBy(desc(laboratoryOrders.createdAt));
  }
}
