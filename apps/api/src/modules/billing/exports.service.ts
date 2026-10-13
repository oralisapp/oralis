import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, asc, desc, eq, lt } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { AppError, forbidden, notFound } from '../../common/app-error';
import { Clock } from '../../common/clock';
import { type AuthContext, type RequestMeta, type TenantContext } from '../../common/request-context';
import { DB, type Db } from '../../db/db';
import { appointments, clinicUnits, dataExports, patients, payments, professionals, receivables, services, treatmentItems, treatmentPlans, users } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { JobsService } from '../platform/jobs.service';

export const EXPORT_SCOPES = { patients: 'Pacientes (cadastro)', appointments: 'Agenda (consultas)', financial: 'Financeiro (parcelas e recebimentos)', treatments: 'Tratamentos (planos e etapas)' } as const;
export const exportSchema = z.object({ scope: z.enum(Object.keys(EXPORT_SCOPES) as [keyof typeof EXPORT_SCOPES, ...(keyof typeof EXPORT_SCOPES)[]]) });

const TTL_MS = 24 * 60 * 60_000;

function csv(rows: (string | number | null | undefined)[][]): Buffer {
  const esc = (v: string | number | null | undefined) => {
    let s = v === null || v === undefined ? '' : String(v);
    // Somente campos textuais: valores numéricos negativos continuam numéricos.
    // Espaços/controles iniciais não devem permitir esconder uma fórmula.
    if (typeof v === 'string' && (/^[\s\u0000-\u001f]*[=+@-]/u.test(v) || /^[\t\r\n]/.test(v))) s = "'" + s;
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // BOM para o Excel abrir acentos corretamente; separador ";" (padrão brasileiro).
  return Buffer.from(`﻿${rows.map((r) => r.map(esc).join(';')).join('\r\n')}`, 'utf8');
}

/**
 * Exportação tabular controlada: permissão própria, processamento em fila,
 * download autenticado e arquivo que expira em 24 h. Fica disponível mesmo
 * com a assinatura suspensa ou cancelada (sem bloqueio abusivo).
 */
@Injectable()
export class ExportsService implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jobs: JobsService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    this.jobs.register('export.generate', async (payload) => this.generate(String(payload.exportId)));
    this.jobs.every({ name: 'exports.expire', everyMs: 60 * 60_000, run: () => this.expire() });
  }

  private requireOrganizationAccess(tenant: TenantContext) {
    if (!tenant.allUnits) throw forbidden('A exportação reúne dados de todas as unidades. Solicite o arquivo a um responsável com acesso a toda a organização.');
  }

  async request(auth: AuthContext, tenant: TenantContext, scope: keyof typeof EXPORT_SCOPES, meta: RequestMeta) {
    this.requireOrganizationAccess(tenant);
    const [row] = await this.db.insert(dataExports).values({ organizationId: tenant.organizationId, scope, requestedBy: auth.userId }).returning({ id: dataExports.id });
    await this.jobs.enqueue('export.generate', { exportId: row!.id }, { organizationId: tenant.organizationId });
    await this.audit.record(this.db, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'data.export_requested', entityType: 'data_export', entityId: row!.id, metadata: { scope }, meta });
    return { id: row!.id, status: 'queued' };
  }

  async list(tenant: TenantContext) {
    this.requireOrganizationAccess(tenant);
    return this.db
      .select({ id: dataExports.id, scope: dataExports.scope, status: dataExports.status, filename: dataExports.filename, rowCount: dataExports.rowCount, createdAt: dataExports.createdAt, expiresAt: dataExports.expiresAt, error: dataExports.error, requestedByName: users.name })
      .from(dataExports)
      .innerJoin(users, eq(users.id, dataExports.requestedBy))
      .where(eq(dataExports.organizationId, tenant.organizationId))
      .orderBy(desc(dataExports.createdAt))
      .limit(50);
  }

  async download(auth: AuthContext, tenant: TenantContext, id: string, meta: RequestMeta) {
    this.requireOrganizationAccess(tenant);
    const [e] = await this.db.select().from(dataExports).where(and(eq(dataExports.id, id), eq(dataExports.organizationId, tenant.organizationId)));
    if (!e) throw notFound('Exportação');
    if (e.status !== 'ready' || !e.content || (e.expiresAt && e.expiresAt < this.clock.now())) throw new AppError('invalid_transition', 'O arquivo não está disponível (ainda em processamento ou expirado).');
    await this.audit.record(this.db, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'data.export_downloaded', entityType: 'data_export', entityId: id, metadata: { scope: e.scope, rows: e.rowCount }, meta });
    return { filename: e.filename!, content: e.content };
  }

  private async generate(id: string) {
    const [e] = await this.db.select().from(dataExports).where(eq(dataExports.id, id));
    if (!e || e.status !== 'queued') return { skipped: true };
    const org = e.organizationId;
    let rows: (string | number | null)[][] = [];
    if (e.scope === 'patients') {
      const data = await this.db.select().from(patients).where(eq(patients.organizationId, org)).orderBy(asc(patients.fullName));
      rows = [['id', 'nome_completo', 'nome_social', 'nascimento', 'cpf', 'telefone', 'email', 'situacao', 'criado_em'], ...data.map((p) => [p.id, p.fullName, p.socialName, p.birthDate, p.cpf, p.phone, p.email, p.status, p.createdAt.toISOString()])];
    } else if (e.scope === 'appointments') {
      const data = await this.db
        .select({ a: appointments, patient: patients.fullName, prof: professionals.displayName, unit: clinicUnits.name, service: services.name })
        .from(appointments)
        .innerJoin(patients, eq(patients.id, appointments.patientId))
        .innerJoin(professionals, eq(professionals.id, appointments.professionalId))
        .innerJoin(clinicUnits, eq(clinicUnits.id, appointments.unitId))
        .leftJoin(services, eq(services.id, appointments.serviceId))
        .where(eq(appointments.organizationId, org))
        .orderBy(asc(appointments.startsAt));
      rows = [['id', 'inicio_utc', 'fim_utc', 'unidade', 'profissional', 'paciente', 'servico', 'status', 'motivo_cancelamento'], ...data.map((r) => [r.a.id, r.a.startsAt.toISOString(), r.a.endsAt.toISOString(), r.unit, r.prof, r.patient, r.service, r.a.status, r.a.cancellationReason])];
    } else if (e.scope === 'financial') {
      const p2 = alias(patients, 'p2');
      const recs = await this.db.select({ r: receivables, patient: patients.fullName }).from(receivables).leftJoin(patients, eq(patients.id, receivables.patientId)).where(eq(receivables.organizationId, org)).orderBy(asc(receivables.dueDate));
      const pays = await this.db.select({ p: payments, patient: p2.fullName }).from(payments).leftJoin(p2, eq(p2.id, payments.patientId)).where(eq(payments.organizationId, org)).orderBy(asc(payments.receivedAt));
      rows = [
        ['tipo', 'id', 'data', 'paciente', 'descricao_ou_forma', 'valor', 'situacao'],
        ...recs.map((x) => ['parcela', x.r.id, x.r.dueDate, x.patient, x.r.description, x.r.amount, x.r.status]),
        ...pays.map((x) => ['recebimento', x.p.id, x.p.receivedAt.toISOString(), x.patient, x.p.method, x.p.amount, x.p.reconciledAt ? 'conciliado' : 'nao_conciliado']),
      ];
    } else if (e.scope === 'treatments') {
      const data = await this.db.select({ i: treatmentItems, plan: treatmentPlans, patient: patients.fullName }).from(treatmentItems).innerJoin(treatmentPlans, eq(treatmentPlans.id, treatmentItems.planId)).innerJoin(patients, eq(patients.id, treatmentPlans.patientId)).where(eq(treatmentItems.organizationId, org)).orderBy(asc(treatmentPlans.createdAt), asc(treatmentItems.stage));
      rows = [['plano_id', 'paciente', 'plano', 'situacao_plano', 'etapa', 'procedimento', 'dente', 'valor', 'situacao_etapa', 'realizado_em'], ...data.map((r) => [r.plan.id, r.patient, r.plan.title, r.plan.status, r.i.stage, r.i.description, r.i.tooth, r.i.unitPrice, r.i.status, r.i.doneAt?.toISOString() ?? null])];
    }
    const now = this.clock.now();
    await this.db
      .update(dataExports)
      .set({ status: 'ready', content: csv(rows), rowCount: Math.max(0, rows.length - 1), filename: `oralis-${e.scope}-${now.toISOString().slice(0, 10)}.csv`, finishedAt: now, expiresAt: new Date(now.getTime() + TTL_MS) })
      .where(eq(dataExports.id, id));
    return { rows: rows.length - 1 };
  }

  async expire() {
    const r = await this.db.update(dataExports).set({ status: 'expired', content: null }).where(and(eq(dataExports.status, 'ready'), lt(dataExports.expiresAt, this.clock.now()))).returning({ id: dataExports.id });
    return r.length;
  }
}
