import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { AppError, forbidden, notFound } from '../../common/app-error';
import { Clock } from '../../common/clock';
import { type AuthContext, type RequestMeta, type TenantContext, canAccessUnit } from '../../common/request-context';
import { DB, type Db, type Tx } from '../../db/db';
import {
  anamnesisResponses,
  anamnesisTemplates,
  appointments,
  treatmentItems,
  treatmentPlans,
  clinicalAlerts,
  clinicalRecordAmendments,
  clinicalRecords,
  clinicUnits,
  documents,
  encounters,
  patients,
  professionals,
  services,
  users,
} from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { DomainEvents } from '../platform/domain-events';

export const procedureSchema = z.object({
  description: z.string().trim().min(2).max(200),
  serviceId: z.uuid().optional(),
  tooth: z.number().int().min(11).max(85).optional(),
  surfaces: z.array(z.enum(['M', 'D', 'O', 'V', 'L'])).max(5).optional(),
  treatmentItemId: z.uuid().optional(),
});
export const draftSchema = z.object({
  content: z.string().max(50_000),
  procedures: z.array(procedureSchema).max(50).default([]),
  version: z.number().int().min(1),
});
export const amendmentSchema = z.object({ content: z.string().trim().min(3, { error: 'Descreva o adendo.' }).max(20_000) });
export const alertSchema = z.object({
  kind: z.enum(['allergy', 'medication', 'condition', 'other']),
  description: z.string().trim().min(2).max(300),
  severity: z.enum(['info', 'attention', 'critical']).default('attention'),
});
export const anamnesisQuestionSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().trim().min(2).max(200),
  type: z.enum(['yesno', 'text', 'choice']),
  options: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
  /** Resposta "sim" sinaliza a pergunta para o profissional (não gera alerta automático). */
  flagWhenYes: z.boolean().optional(),
});
export const anamnesisTemplateSchema = z.object({ name: z.string().trim().min(2).max(120), questions: z.array(anamnesisQuestionSchema).min(1).max(60) });
export const anamnesisResponseSchema = z.object({ templateId: z.uuid(), answers: z.record(z.string(), z.union([z.string().max(1000), z.boolean(), z.null()])), reviewOfId: z.uuid().optional() });

export const DEFAULT_ANAMNESIS: z.infer<typeof anamnesisTemplateSchema> = {
  name: 'Anamnese odontológica (modelo inicial)',
  questions: [
    { id: 'tratamento_medico', label: 'Está em tratamento médico atualmente?', type: 'yesno', flagWhenYes: true },
    { id: 'medicamentos', label: 'Usa algum medicamento? Quais?', type: 'text' },
    { id: 'alergia', label: 'Tem alergia a medicamento, anestésico, látex ou outro material?', type: 'yesno', flagWhenYes: true },
    { id: 'alergia_qual', label: 'Se sim, a quê?', type: 'text' },
    { id: 'cardiaco', label: 'Tem problema cardíaco ou pressão alta?', type: 'yesno', flagWhenYes: true },
    { id: 'diabetes', label: 'Tem diabetes?', type: 'yesno', flagWhenYes: true },
    { id: 'coagulacao', label: 'Tem problema de coagulação ou sangramento excessivo?', type: 'yesno', flagWhenYes: true },
    { id: 'gestante', label: 'Está grávida ou amamentando?', type: 'yesno', flagWhenYes: true },
    { id: 'fumante', label: 'Fuma?', type: 'yesno' },
    { id: 'queixa', label: 'Qual o motivo da consulta?', type: 'text' },
  ],
};

function hashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Prontuário e workspace de atendimento.
 * - Atendimento (encounter) é criado ao iniciar a consulta, com um rascunho de evolução.
 * - Rascunho: salvamento com controle de versão (detecta edição simultânea).
 * - Finalização: hash SHA-256 + autoria; depois disso só adendos (o banco impede edição).
 */
@Injectable()
export class ClinicalService implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly events: DomainEvents,
  ) {}

  onModuleInit() {
    this.events.on('appointment.status_changed', async (tx, e) => {
      if (e.to === 'in_progress') await this.startEncounter(tx, e.organizationId, e.appointmentId, e.actorUserId);
      if (e.to === 'completed') await tx.update(encounters).set({ endedAt: this.clock.now() }).where(eq(encounters.appointmentId, e.appointmentId));
    });
  }

  private async startEncounter(tx: Tx, organizationId: string, appointmentId: string, actorUserId: string | null) {
    const [existing] = await tx.select({ id: encounters.id }).from(encounters).where(eq(encounters.appointmentId, appointmentId));
    if (existing) return existing.id;
    const [a] = await tx.select().from(appointments).where(eq(appointments.id, appointmentId));
    const [enc] = await tx
      .insert(encounters)
      .values({ organizationId, unitId: a!.unitId, appointmentId, patientId: a!.patientId, professionalId: a!.professionalId, startedAt: this.clock.now(), startedBy: actorUserId })
      .returning({ id: encounters.id });
    if (actorUserId) {
      await tx.insert(clinicalRecords).values({ organizationId, unitId: a!.unitId, patientId: a!.patientId, professionalId: a!.professionalId, encounterId: enc!.id, authorUserId: actorUserId, updatedBy: actorUserId });
    }
    await this.audit.record(tx, { organizationId, actorUserId, action: 'encounter.started', entityType: 'encounter', entityId: enc!.id, unitId: a!.unitId, metadata: { appointmentId } });
    return enc!.id;
  }

  private async assertPatient(db: Db | Tx, tenant: TenantContext, patientId: string) {
    const [p] = await db
      .select({ id: patients.id, fullName: patients.fullName, socialName: patients.socialName, birthDate: patients.birthDate })
      .from(patients)
      .where(and(eq(patients.id, patientId), eq(patients.organizationId, tenant.organizationId)));
    if (!p) throw notFound('Paciente');
    return p;
  }

  private recordsQuery(organizationId: string) {
    const author = alias(users, 'author');
    const finalizer = alias(users, 'finalizer');
    return this.db
      .select({
        id: clinicalRecords.id,
        patientId: clinicalRecords.patientId,
        encounterId: clinicalRecords.encounterId,
        status: clinicalRecords.status,
        kind: clinicalRecords.kind,
        content: clinicalRecords.content,
        procedures: clinicalRecords.procedures,
        version: clinicalRecords.version,
        createdAt: clinicalRecords.createdAt,
        updatedAt: clinicalRecords.updatedAt,
        finalizedAt: clinicalRecords.finalizedAt,
        contentHash: clinicalRecords.contentHash,
        authorUserId: clinicalRecords.authorUserId,
        authorName: author.name,
        finalizedByName: finalizer.name,
        professionalName: professionals.displayName,
        croNumber: professionals.croNumber,
        croUf: professionals.croUf,
        unitName: clinicUnits.name,
        timezone: clinicUnits.timezone,
      })
      .from(clinicalRecords)
      .innerJoin(author, eq(author.id, clinicalRecords.authorUserId))
      .leftJoin(finalizer, eq(finalizer.id, clinicalRecords.finalizedBy))
      .innerJoin(professionals, eq(professionals.id, clinicalRecords.professionalId))
      .innerJoin(clinicUnits, eq(clinicUnits.id, clinicalRecords.unitId))
      .where(eq(clinicalRecords.organizationId, organizationId))
      .$dynamic();
  }

  private async amendmentsFor(recordIds: string[]) {
    if (!recordIds.length) return [];
    return this.db
      .select({ id: clinicalRecordAmendments.id, recordId: clinicalRecordAmendments.recordId, content: clinicalRecordAmendments.content, contentHash: clinicalRecordAmendments.contentHash, createdAt: clinicalRecordAmendments.createdAt, authorName: users.name })
      .from(clinicalRecordAmendments)
      .innerJoin(users, eq(users.id, clinicalRecordAmendments.authorUserId))
      .where(inArray(clinicalRecordAmendments.recordId, recordIds))
      .orderBy(asc(clinicalRecordAmendments.createdAt));
  }

  /** Dados do workspace de uma consulta em atendimento ou concluída. */
  async workspace(auth: AuthContext, tenant: TenantContext, appointmentId: string, meta: RequestMeta) {
    const [a] = await this.db
      .select({ appt: appointments, professionalName: professionals.displayName, professionalMembershipId: professionals.membershipId, serviceName: services.name, unitName: clinicUnits.name, timezone: clinicUnits.timezone })
      .from(appointments)
      .innerJoin(professionals, eq(professionals.id, appointments.professionalId))
      .innerJoin(clinicUnits, eq(clinicUnits.id, appointments.unitId))
      .leftJoin(services, eq(services.id, appointments.serviceId))
      .where(and(eq(appointments.id, appointmentId), eq(appointments.organizationId, tenant.organizationId)));
    if (!a || !canAccessUnit(tenant, a.appt.unitId)) throw notFound('Consulta');
    const patient = await this.assertPatient(this.db, tenant, a.appt.patientId);
    const [enc] = await this.db.select().from(encounters).where(eq(encounters.appointmentId, appointmentId));

    const [current, previous, alerts, anamnesis, docs] = await Promise.all([
      enc ? this.recordsQuery(tenant.organizationId).where(and(eq(clinicalRecords.organizationId, tenant.organizationId), eq(clinicalRecords.encounterId, enc.id))).orderBy(asc(clinicalRecords.createdAt)) : Promise.resolve([]),
      this.recordsQuery(tenant.organizationId)
        .where(and(eq(clinicalRecords.organizationId, tenant.organizationId), eq(clinicalRecords.patientId, patient.id), eq(clinicalRecords.status, 'finalized'), enc ? or(isNull(clinicalRecords.encounterId), ne(clinicalRecords.encounterId, enc.id)) : undefined))
        .orderBy(desc(clinicalRecords.finalizedAt))
        .limit(10),
      this.activeAlerts(tenant.organizationId, patient.id),
      this.latestAnamnesis(tenant.organizationId, patient.id),
      this.db.select({ id: documents.id, title: documents.title, category: documents.category, createdAt: documents.createdAt }).from(documents).where(and(eq(documents.organizationId, tenant.organizationId), eq(documents.patientId, patient.id), isNull(documents.archivedAt))).orderBy(desc(documents.createdAt)).limit(20),
    ]);
    const amendments = await this.amendmentsFor([...current, ...previous].map((r) => r.id));
    const planItems = await this.db
      .select({ id: treatmentItems.id, description: treatmentItems.description, tooth: treatmentItems.tooth, status: treatmentItems.status, stage: treatmentItems.stage, planId: treatmentPlans.id, planTitle: treatmentPlans.title })
      .from(treatmentItems)
      .innerJoin(treatmentPlans, eq(treatmentPlans.id, treatmentItems.planId))
      .where(and(eq(treatmentPlans.organizationId, tenant.organizationId), eq(treatmentPlans.patientId, patient.id), inArray(treatmentPlans.status, ['approved', 'in_progress']), inArray(treatmentItems.status, ['planned', 'scheduled'])))
      .orderBy(asc(treatmentItems.stage));
    await this.audit.record(this.db, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'clinical.viewed', entityType: 'patient', entityId: patient.id, unitId: a.appt.unitId, metadata: { appointmentId } });

    // Rascunhos de outros autores não são expostos; o autor vê e edita o seu.
    const visibleCurrent = current.filter((r) => r.status === 'finalized' || r.authorUserId === auth.userId);
    return {
      appointment: { id: a.appt.id, status: a.appt.status, startsAt: a.appt.startsAt, endsAt: a.appt.endsAt, version: a.appt.version, unitId: a.appt.unitId, unitName: a.unitName, timezone: a.timezone, professionalId: a.appt.professionalId, professionalName: a.professionalName, serviceName: a.serviceName, treatmentItemId: a.appt.treatmentItemId, isOwn: a.professionalMembershipId === tenant.membershipId },
      patient,
      encounter: enc ?? null,
      records: visibleCurrent.map((r) => ({ ...r, amendments: amendments.filter((x) => x.recordId === r.id) })),
      othersDrafting: current.some((r) => r.status === 'draft' && r.authorUserId !== auth.userId),
      previous: previous.map((r) => ({ ...r, amendments: amendments.filter((x) => x.recordId === r.id) })),
      alerts,
      anamnesis,
      documents: docs,
      treatmentItems: planItems,
      canWrite: tenant.permissions.has('clinical.write'),
    };
  }

  async activeAlerts(organizationId: string, patientId: string) {
    return this.db
      .select({ id: clinicalAlerts.id, kind: clinicalAlerts.kind, description: clinicalAlerts.description, severity: clinicalAlerts.severity, createdAt: clinicalAlerts.createdAt, createdByName: users.name })
      .from(clinicalAlerts)
      .innerJoin(users, eq(users.id, clinicalAlerts.createdBy))
      .where(and(eq(clinicalAlerts.organizationId, organizationId), eq(clinicalAlerts.patientId, patientId), eq(clinicalAlerts.active, true)))
      .orderBy(desc(clinicalAlerts.createdAt));
  }

  async latestAnamnesis(organizationId: string, patientId: string) {
    const rows = await this.db
      .select({ response: anamnesisResponses, template: anamnesisTemplates, recordedByName: users.name })
      .from(anamnesisResponses)
      .innerJoin(anamnesisTemplates, eq(anamnesisTemplates.id, anamnesisResponses.templateId))
      .leftJoin(users, eq(users.id, anamnesisResponses.recordedBy))
      .where(and(eq(anamnesisResponses.organizationId, organizationId), eq(anamnesisResponses.patientId, patientId)))
      .orderBy(desc(anamnesisResponses.createdAt))
      .limit(10);
    const latestStaff = rows.find((r) => r.response.source === 'staff');
    const pendingPatient = rows.find((r) => r.response.source === 'patient_portal' && !rows.some((x) => x.response.reviewOfId === r.response.id));
    const shape = (r: (typeof rows)[number] | undefined) =>
      r && {
        id: r.response.id,
        createdAt: r.response.createdAt,
        source: r.response.source,
        recordedByName: r.recordedByName,
        template: { id: r.template.id, name: r.template.name, version: r.template.version, questions: r.template.questions },
        answers: r.response.answers,
      };
    return { latest: shape(latestStaff) ?? null, pendingPatientResponse: shape(pendingPatient) ?? null, historyCount: rows.length };
  }

  private async lockRecord(tx: Tx, tenant: TenantContext, id: string) {
    const [r] = await tx.select().from(clinicalRecords).where(and(eq(clinicalRecords.id, id), eq(clinicalRecords.organizationId, tenant.organizationId))).for('update');
    if (!r || !canAccessUnit(tenant, r.unitId)) throw notFound('Registro clínico');
    return r;
  }

  /** Salvamento de rascunho com detecção de edição concorrente. */
  async saveDraft(auth: AuthContext, tenant: TenantContext, id: string, input: z.infer<typeof draftSchema>) {
    return this.db.transaction(async (tx) => {
      const r = await this.lockRecord(tx, tenant, id);
      if (r.status === 'finalized') throw new AppError('conflict', 'Este registro já foi finalizado. Use um adendo para complementar.');
      if (r.authorUserId !== auth.userId) throw forbidden('Somente o autor edita este rascunho.');
      if (r.version !== input.version) {
        const [u] = r.updatedBy ? await tx.select({ name: users.name }).from(users).where(eq(users.id, r.updatedBy)) : [];
        throw new AppError('stale_version', 'Este rascunho foi salvo em outra janela ou dispositivo.', {
          serverVersion: r.version,
          serverContent: r.content,
          serverProcedures: r.procedures,
          serverUpdatedAt: r.updatedAt,
          serverUpdatedBy: u?.name ?? null,
        });
      }
      const [row] = await tx
        .update(clinicalRecords)
        .set({ content: input.content, procedures: input.procedures, version: r.version + 1, updatedAt: this.clock.now(), updatedBy: auth.userId })
        .where(eq(clinicalRecords.id, id))
        .returning({ version: clinicalRecords.version, updatedAt: clinicalRecords.updatedAt });
      return row!;
    });
  }

  async finalize(auth: AuthContext, tenant: TenantContext, id: string, version: number, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const r = await this.lockRecord(tx, tenant, id);
      if (r.status === 'finalized') throw new AppError('conflict', 'Este registro já foi finalizado.');
      if (r.authorUserId !== auth.userId) throw forbidden('Somente o autor finaliza o próprio registro.');
      if (r.version !== version) throw new AppError('stale_version', 'Há uma versão mais recente deste rascunho. Revise antes de finalizar.', { serverVersion: r.version });
      if (!r.content.trim()) throw new AppError('validation_failed', 'A evolução está vazia.');
      const finalizedAt = this.clock.now();
      const contentHash = hashOf({ id: r.id, patientId: r.patientId, professionalId: r.professionalId, authorUserId: r.authorUserId, content: r.content, procedures: r.procedures, finalizedAt: finalizedAt.toISOString() });
      await tx.update(clinicalRecords).set({ status: 'finalized', finalizedAt, finalizedBy: auth.userId, contentHash, updatedAt: finalizedAt }).where(eq(clinicalRecords.id, id));
      await this.audit.record(tx, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'clinical.record_finalized', entityType: 'clinical_record', entityId: id, unitId: r.unitId, metadata: { patientId: r.patientId, contentHash, procedures: (r.procedures as unknown[]).length }, meta });
      for (const p of r.procedures as { treatmentItemId?: string }[]) {
        if (p.treatmentItemId) await this.events.emit(tx, 'treatment_item.done', { organizationId: tenant.organizationId, itemId: p.treatmentItemId, patientId: r.patientId, actorUserId: auth.userId });
      }
      return { id, status: 'finalized' as const, finalizedAt, contentHash };
    });
  }

  async amend(auth: AuthContext, tenant: TenantContext, id: string, content: string, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const r = await this.lockRecord(tx, tenant, id);
      if (r.status !== 'finalized') throw new AppError('invalid_transition', 'Adendos são para registros finalizados. Edite o rascunho diretamente.');
      const createdAt = this.clock.now();
      const contentHash = hashOf({ recordId: id, authorUserId: auth.userId, content, createdAt: createdAt.toISOString() });
      const [row] = await tx.insert(clinicalRecordAmendments).values({ organizationId: tenant.organizationId, recordId: id, authorUserId: auth.userId, content, contentHash, createdAt }).returning({ id: clinicalRecordAmendments.id });
      await this.audit.record(tx, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'clinical.amendment_added', entityType: 'clinical_record', entityId: id, unitId: r.unitId, metadata: { amendmentId: row!.id, contentHash }, meta });
      return { id: row!.id, contentHash };
    });
  }

  /** Evolução fora de uma consulta (ex.: contato telefônico). Exige ser profissional vinculado. */
  async createRecord(auth: AuthContext, tenant: TenantContext, patientId: string, unitId: string, meta: RequestMeta) {
    await this.assertPatient(this.db, tenant, patientId);
    if (!canAccessUnit(tenant, unitId)) throw notFound('Unidade');
    const [prof] = await this.db.select({ id: professionals.id }).from(professionals).where(and(eq(professionals.organizationId, tenant.organizationId), eq(professionals.membershipId, tenant.membershipId)));
    if (!prof) throw forbidden('Apenas profissionais cadastrados registram evoluções.');
    const [row] = await this.db
      .insert(clinicalRecords)
      .values({ organizationId: tenant.organizationId, unitId, patientId, professionalId: prof.id, authorUserId: auth.userId, updatedBy: auth.userId })
      .returning({ id: clinicalRecords.id, version: clinicalRecords.version });
    await this.audit.record(this.db, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'clinical.record_created', entityType: 'clinical_record', entityId: row!.id, unitId, metadata: { patientId }, meta });
    return row!;
  }

  /** Histórico clínico completo do paciente (leitura auditada). */
  async patientHistory(auth: AuthContext, tenant: TenantContext, patientId: string, meta: RequestMeta) {
    await this.assertPatient(this.db, tenant, patientId);
    const records = await this.recordsQuery(tenant.organizationId)
      .where(and(eq(clinicalRecords.organizationId, tenant.organizationId), eq(clinicalRecords.patientId, patientId), or(eq(clinicalRecords.status, 'finalized'), eq(clinicalRecords.authorUserId, auth.userId))))
      .orderBy(desc(clinicalRecords.createdAt));
    // O histórico clínico é do paciente (cadastro da organização), não da unidade:
    // continuidade do cuidado entre unidades para quem tem permissão clínica.
    const visible = records;
    const [amendments, alerts, anamnesis] = await Promise.all([this.amendmentsFor(visible.map((r) => r.id)), this.activeAlerts(tenant.organizationId, patientId), this.latestAnamnesis(tenant.organizationId, patientId)]);
    await this.audit.record(this.db, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'clinical.viewed', entityType: 'patient', entityId: patientId, meta });
    return { records: visible.map((r) => ({ ...r, amendments: amendments.filter((a) => a.recordId === r.id) })), alerts, anamnesis };
  }

  async pendingDrafts(auth: AuthContext, tenant: TenantContext) {
    return this.db
      .select({ id: clinicalRecords.id, patientId: clinicalRecords.patientId, patientName: patients.fullName, createdAt: clinicalRecords.createdAt, updatedAt: clinicalRecords.updatedAt, appointmentId: encounters.appointmentId })
      .from(clinicalRecords)
      .innerJoin(patients, eq(patients.id, clinicalRecords.patientId))
      .leftJoin(encounters, eq(encounters.id, clinicalRecords.encounterId))
      .where(and(eq(clinicalRecords.organizationId, tenant.organizationId), eq(clinicalRecords.authorUserId, auth.userId), eq(clinicalRecords.status, 'draft'), tenant.allUnits ? undefined : inArray(clinicalRecords.unitId, [...tenant.unitIds])))
      .orderBy(asc(clinicalRecords.createdAt))
      .limit(50);
  }

  // ---------------------------------------------------------------- Alertas

  async addAlert(auth: AuthContext, tenant: TenantContext, patientId: string, input: z.infer<typeof alertSchema>, meta: RequestMeta) {
    await this.assertPatient(this.db, tenant, patientId);
    const [row] = await this.db.insert(clinicalAlerts).values({ organizationId: tenant.organizationId, patientId, ...input, createdBy: auth.userId }).returning({ id: clinicalAlerts.id });
    await this.audit.record(this.db, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'clinical.alert_added', entityType: 'patient', entityId: patientId, metadata: { alertId: row!.id, kind: input.kind }, meta });
    return { id: row!.id };
  }

  async resolveAlert(auth: AuthContext, tenant: TenantContext, alertId: string, meta: RequestMeta) {
    const r = await this.db
      .update(clinicalAlerts)
      .set({ active: false, resolvedAt: this.clock.now(), resolvedBy: auth.userId })
      .where(and(eq(clinicalAlerts.id, alertId), eq(clinicalAlerts.organizationId, tenant.organizationId), eq(clinicalAlerts.active, true)))
      .returning({ patientId: clinicalAlerts.patientId });
    if (!r.length) throw notFound('Alerta');
    await this.audit.record(this.db, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'clinical.alert_resolved', entityType: 'patient', entityId: r[0]!.patientId, metadata: { alertId }, meta });
    return { ok: true };
  }

  // -------------------------------------------------------------- Anamnese

  async templates(tenant: TenantContext) {
    let rows = await this.db.select().from(anamnesisTemplates).where(and(eq(anamnesisTemplates.organizationId, tenant.organizationId), eq(anamnesisTemplates.status, 'active'))).orderBy(asc(anamnesisTemplates.name));
    if (!rows.length) {
      await this.db.insert(anamnesisTemplates).values({ organizationId: tenant.organizationId, templateKey: randomUUID(), name: DEFAULT_ANAMNESIS.name, version: 1, questions: DEFAULT_ANAMNESIS.questions });
      rows = await this.db.select().from(anamnesisTemplates).where(and(eq(anamnesisTemplates.organizationId, tenant.organizationId), eq(anamnesisTemplates.status, 'active')));
    }
    return rows;
  }

  async createTemplate(auth: AuthContext, tenant: TenantContext, input: z.infer<typeof anamnesisTemplateSchema>, meta: RequestMeta) {
    const [row] = await this.db.insert(anamnesisTemplates).values({ organizationId: tenant.organizationId, templateKey: randomUUID(), name: input.name, version: 1, questions: input.questions, createdBy: auth.userId }).returning({ id: anamnesisTemplates.id });
    await this.audit.record(this.db, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'anamnesis.template_created', entityType: 'anamnesis_template', entityId: row!.id, meta });
    return { id: row!.id };
  }

  /** Editar um modelo cria nova versão; a anterior é arquivada e respostas antigas continuam apontando para ela. */
  async newTemplateVersion(auth: AuthContext, tenant: TenantContext, id: string, input: z.infer<typeof anamnesisTemplateSchema>, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const [cur] = await tx.select().from(anamnesisTemplates).where(and(eq(anamnesisTemplates.id, id), eq(anamnesisTemplates.organizationId, tenant.organizationId))).for('update');
      if (!cur) throw notFound('Modelo de anamnese');
      if (cur.status !== 'active') throw new AppError('conflict', 'Edite a versão mais recente do modelo.');
      await tx.update(anamnesisTemplates).set({ status: 'archived' }).where(eq(anamnesisTemplates.id, id));
      const [row] = await tx.insert(anamnesisTemplates).values({ organizationId: tenant.organizationId, templateKey: cur.templateKey, name: input.name, version: cur.version + 1, questions: input.questions, createdBy: auth.userId }).returning({ id: anamnesisTemplates.id, version: anamnesisTemplates.version });
      await this.audit.record(tx, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'anamnesis.template_versioned', entityType: 'anamnesis_template', entityId: row!.id, metadata: { from: cur.version, to: row!.version }, meta });
      return row!;
    });
  }

  async recordAnamnesis(auth: AuthContext | null, tenant: { organizationId: string }, patientId: string, input: z.infer<typeof anamnesisResponseSchema>, source: 'staff' | 'patient_portal', meta: RequestMeta) {
    const [t] = await this.db.select().from(anamnesisTemplates).where(and(eq(anamnesisTemplates.id, input.templateId), eq(anamnesisTemplates.organizationId, tenant.organizationId)));
    if (!t) throw notFound('Modelo de anamnese');
    const valid = new Set((t.questions as { id: string }[]).map((q) => q.id));
    if (Object.keys(input.answers).some((k) => !valid.has(k))) throw new AppError('validation_failed', 'Há respostas para perguntas que não existem neste modelo.');
    const [p] = await this.db.select({ id: patients.id }).from(patients).where(and(eq(patients.id, patientId), eq(patients.organizationId, tenant.organizationId)));
    if (!p) throw notFound('Paciente');
    const [row] = await this.db
      .insert(anamnesisResponses)
      .values({ organizationId: tenant.organizationId, patientId, templateId: t.id, answers: input.answers, source, recordedBy: auth?.userId ?? null, reviewedBy: source === 'staff' && input.reviewOfId ? auth?.userId : null, reviewOfId: input.reviewOfId ?? null })
      .returning({ id: anamnesisResponses.id });
    await this.audit.record(this.db, { organizationId: tenant.organizationId, actorUserId: auth?.userId ?? null, action: 'anamnesis.recorded', entityType: 'patient', entityId: patientId, metadata: { responseId: row!.id, templateVersion: t.version, source }, meta });
    return { id: row!.id };
  }
}
