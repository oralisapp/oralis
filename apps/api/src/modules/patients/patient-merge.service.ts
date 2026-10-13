import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, forbidden, notFound } from '../../common/app-error';
import type { AuthContext, RequestMeta, TenantContext } from '../../common/request-context';
import { DB, type Db } from '../../db/db';
import { patients } from '../../db/schema';
import { AuditService } from '../audit/audit.service';

export const mergeSchema = z.object({ sourceId: z.uuid(), targetId: z.uuid(), sourceVersion: z.number().int().positive(), targetVersion: z.number().int().positive(), reason: z.string().trim().min(10).max(500) });

@Injectable()
export class PatientMergeService {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService) {}

  async links(tenant: TenantContext, id: string) {
    const r = await this.db.execute<{ id: string; fullName: string; direction: string }>(sql`
      SELECT p.id, p.full_name AS "fullName", CASE WHEN m.source_id = ${id}::uuid THEN 'canonical' ELSE 'history' END AS direction
      FROM patient_merges m JOIN patients p ON p.id = CASE WHEN m.source_id = ${id}::uuid THEN m.target_id ELSE m.source_id END
      WHERE m.organization_id = ${tenant.organizationId}::uuid AND (m.source_id = ${id}::uuid OR m.target_id = ${id}::uuid)`);
    return { items: r.rows };
  }

  async merge(auth: AuthContext, tenant: TenantContext, input: z.infer<typeof mergeSchema>, meta: RequestMeta) {
    if (!tenant.allUnits || !['owner', 'manager'].includes(tenant.roleKey ?? '')) throw forbidden('A consolidação exige proprietário ou gestor com acesso a todas as unidades.');
    if (input.sourceId === input.targetId) throw new AppError('validation_failed', 'Escolha dois pacientes diferentes.');
    return this.db.transaction(async tx => {
      const found = await tx.select().from(patients).where(and(eq(patients.organizationId, tenant.organizationId), inArray(patients.id, [input.sourceId, input.targetId]))).orderBy(patients.id).for('update');
      const source = found.find(p => p.id === input.sourceId); const target = found.find(p => p.id === input.targetId);
      if (!source || !target) throw notFound('Paciente');
      if (source.version !== input.sourceVersion || target.version !== input.targetVersion) throw new AppError('stale_version', 'Os cadastros foram alterados. Revise os dados antes de consolidar.');
      const existing = await tx.execute(sql`SELECT 1 FROM patient_merges WHERE source_id IN (${source.id}::uuid, ${target.id}::uuid) OR target_id = ${source.id}::uuid LIMIT 1`);
      if (existing.rows.length || source.status !== 'active' || target.status !== 'active') throw new AppError('conflict', 'O cadastro de origem já foi consolidado ou possui históricos associados.');
      if (source.cpf && target.cpf && source.cpf !== target.cpf) throw new AppError('conflict', 'Os CPFs são diferentes. Corrija a identificação antes de consolidar.');
      const pending = await tx.execute(sql`SELECT 1 FROM appointments WHERE patient_id = ${source.id}::uuid AND status IN ('scheduled','confirmed','arrived','in_progress') UNION ALL SELECT 1 FROM clinical_records WHERE patient_id = ${source.id}::uuid AND status = 'draft' UNION ALL SELECT 1 FROM treatment_plans WHERE patient_id = ${source.id}::uuid AND status NOT IN ('completed','cancelled','rejected') LIMIT 1`);
      if (pending.rows.length) throw new AppError('conflict', 'Conclua ou cancele os agendamentos, planos de tratamento e rascunhos clínicos do cadastro de origem antes de consolidar.');
      await tx.execute(sql`INSERT INTO patient_merges(source_id,target_id,organization_id,actor_user_id,reason) VALUES (${source.id}::uuid,${target.id}::uuid,${tenant.organizationId}::uuid,${auth.userId}::uuid,${input.reason})`);
      await tx.update(patients).set({ status: 'archived', version: source.version + 1, updatedAt: new Date() }).where(eq(patients.id, source.id));
      await tx.update(patients).set({ version: target.version + 1, updatedAt: new Date() }).where(eq(patients.id, target.id));
      await this.audit.record(tx, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'patient.consolidated', entityType: 'patient', entityId: target.id, metadata: { sourceId: source.id, sourceVersion: source.version, targetVersion: target.version }, meta });
      return { id: target.id };
    });
  }
}
