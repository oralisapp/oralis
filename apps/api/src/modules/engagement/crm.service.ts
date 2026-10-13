import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, notFound } from '../../common/app-error';
import { Clock } from '../../common/clock';
import { type AuthContext, type RequestMeta, type TenantContext } from '../../common/request-context';
import { DB, type Db } from '../../db/db';
import { crmInteractions, crmLeads, patients, users } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { normalizeName } from '../patients/patients.service';

export const CRM_STAGES = ['contact', 'evaluation_scheduled', 'evaluation_done', 'quote_sent', 'approved', 'in_treatment', 'follow_up', 'lost'] as const;
export const leadSchema = z.object({
  name: z.string().trim().min(2).max(160),
  phone: z.string().trim().max(30).optional(),
  email: z.string().trim().max(254).optional(),
  source: z.enum(['referral', 'instagram', 'google', 'website', 'walk_in', 'phone', 'partnership', 'other']),
  notes: z.string().trim().max(1000).optional(),
  ownerMembershipId: z.uuid().optional(),
  unitId: z.uuid().optional(),
});
export const moveSchema = z.object({ stage: z.enum(CRM_STAGES), lostReason: z.string().trim().max(300).optional() });
export const interactionSchema = z.object({ leadId: z.uuid().optional(), patientId: z.uuid().optional(), kind: z.enum(['call', 'whatsapp', 'email', 'visit', 'note']), summary: z.string().trim().min(2).max(1000) }).refine((v) => v.leadId || v.patientId, { error: 'Informe o contato ou o paciente.' });

/**
 * Funil de relacionamento: Contato → Avaliação agendada → Avaliação realizada →
 * Orçamento enviado → Tratamento aprovado → Em tratamento → Acompanhamento.
 * As etapas são movidas pela equipe; motivo é obrigatório ao marcar perda.
 */
@Injectable()
export class CrmService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  async board(tenant: TenantContext) {
    const rows = await this.db
      .select({ lead: crmLeads, ownerName: users.name, lastInteraction: sql<string | null>`(select max(i.created_at) from crm_interactions i where i.lead_id = ${crmLeads.id})` })
      .from(crmLeads)
      .leftJoin(sql`memberships m`, sql`m.id = ${crmLeads.ownerMembershipId}`)
      .leftJoin(users, sql`${users.id} = m.user_id`)
      .where(eq(crmLeads.organizationId, tenant.organizationId))
      .orderBy(desc(crmLeads.stageChangedAt))
      .limit(1000);
    const byStage = Object.fromEntries(CRM_STAGES.map((s) => [s, 0])) as Record<(typeof CRM_STAGES)[number], number>;
    for (const r of rows) byStage[r.lead.stage as (typeof CRM_STAGES)[number]]++;
    const total = rows.length;
    const won = rows.filter((r) => ['approved', 'in_treatment', 'follow_up'].includes(r.lead.stage)).length;
    return {
      leads: rows.map((r) => ({ ...r.lead, ownerName: r.ownerName, lastInteraction: r.lastInteraction })),
      counts: byStage,
      conversion: { total, won, rate: total ? Math.round((won / total) * 1000) / 10 : null, definition: 'Contatos que chegaram a "Tratamento aprovado" ou além, sobre todos os contatos registrados.' },
      lostReasons: rows.filter((r) => r.lead.stage === 'lost').reduce<Record<string, number>>((acc, r) => ((acc[r.lead.lostReason ?? 'Sem motivo'] = (acc[r.lead.lostReason ?? 'Sem motivo'] ?? 0) + 1), acc), {}),
    };
  }

  async create(auth: AuthContext, tenant: TenantContext, input: z.infer<typeof leadSchema>, meta: RequestMeta) {
    const [row] = await this.db.insert(crmLeads).values({ organizationId: tenant.organizationId, ...input, phone: input.phone ?? null, email: input.email ?? null, notes: input.notes ?? null, ownerMembershipId: input.ownerMembershipId ?? null, unitId: input.unitId ?? null, createdBy: auth.userId }).returning({ id: crmLeads.id });
    await this.audit.record(this.db, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'crm.lead_created', entityType: 'crm_lead', entityId: row!.id, metadata: { source: input.source }, meta });
    return { id: row!.id };
  }

  async move(auth: AuthContext, tenant: TenantContext, id: string, input: z.infer<typeof moveSchema>, meta: RequestMeta) {
    if (input.stage === 'lost' && !input.lostReason) throw new AppError('validation_failed', 'Informe o motivo da perda.');
    const r = await this.db
      .update(crmLeads)
      .set({ stage: input.stage, lostReason: input.stage === 'lost' ? input.lostReason! : null, stageChangedAt: this.clock.now() })
      .where(and(eq(crmLeads.id, id), eq(crmLeads.organizationId, tenant.organizationId)))
      .returning({ id: crmLeads.id });
    if (!r.length) throw notFound('Contato');
    await this.audit.record(this.db, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'crm.lead_moved', entityType: 'crm_lead', entityId: id, metadata: input, meta });
    return { ok: true };
  }

  /** Converte o contato em paciente (cadastro mínimo) e vincula. */
  async convert(auth: AuthContext, tenant: TenantContext, id: string, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const [lead] = await tx.select().from(crmLeads).where(and(eq(crmLeads.id, id), eq(crmLeads.organizationId, tenant.organizationId))).for('update');
      if (!lead) throw notFound('Contato');
      if (lead.patientId) return { patientId: lead.patientId };
      const [p] = await tx.insert(patients).values({ organizationId: tenant.organizationId, fullName: lead.name, searchName: normalizeName(lead.name), phone: lead.phone?.replace(/\D/g, '') || null, email: lead.email?.toLowerCase() || null, createdBy: auth.userId }).returning({ id: patients.id });
      await tx.update(crmLeads).set({ patientId: p!.id }).where(eq(crmLeads.id, id));
      await this.audit.record(tx, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'crm.lead_converted', entityType: 'crm_lead', entityId: id, metadata: { patientId: p!.id }, meta });
      return { patientId: p!.id };
    });
  }

  async interactions(tenant: TenantContext, q: { leadId?: string; patientId?: string }) {
    return this.db
      .select({ i: crmInteractions, byName: users.name })
      .from(crmInteractions)
      .innerJoin(users, eq(users.id, crmInteractions.createdBy))
      .where(and(eq(crmInteractions.organizationId, tenant.organizationId), q.leadId ? eq(crmInteractions.leadId, q.leadId) : undefined, q.patientId ? eq(crmInteractions.patientId, q.patientId) : undefined))
      .orderBy(desc(crmInteractions.createdAt))
      .limit(200);
  }

  async addInteraction(auth: AuthContext, tenant: TenantContext, input: z.infer<typeof interactionSchema>) {
    if (input.leadId) {
      const [l] = await this.db.select({ id: crmLeads.id }).from(crmLeads).where(and(eq(crmLeads.id, input.leadId), eq(crmLeads.organizationId, tenant.organizationId)));
      if (!l) throw notFound('Contato');
    }
    if (input.patientId) {
      const [p] = await this.db.select({ id: patients.id }).from(patients).where(and(eq(patients.id, input.patientId), eq(patients.organizationId, tenant.organizationId)));
      if (!p) throw notFound('Paciente');
    }
    const [row] = await this.db.insert(crmInteractions).values({ organizationId: tenant.organizationId, leadId: input.leadId ?? null, patientId: input.patientId ?? null, kind: input.kind, summary: input.summary, createdBy: auth.userId }).returning({ id: crmInteractions.id });
    return { id: row!.id };
  }

  async sourceStats(tenant: TenantContext) {
    return this.db.select({ source: crmLeads.source, total: count() }).from(crmLeads).where(eq(crmLeads.organizationId, tenant.organizationId)).groupBy(crmLeads.source);
  }
}
