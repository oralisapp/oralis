import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { patientSchema } from '@oralis/shared';
import { and, eq, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '../../common/app-error';
import type { AuthContext, RequestMeta, TenantContext } from '../../common/request-context';
import { DB, type Db, type DbOrTx } from '../../db/db';
import { patients } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { normalizeName } from './patients.service';

export const importSchema = z.object({
  csv: z.string().min(1).max(100_000).refine(v => Buffer.byteLength(v, 'utf8') <= 100_000, 'O arquivo deve ter até 100 KB.'),
  delimiter: z.enum([',', ';', '\t']).default(';'),
  mapping: z.object(Object.fromEntries(Object.keys(patientSchema.shape).map(k => [k, z.number().int().min(0).max(49).optional()])) as Record<keyof typeof patientSchema.shape, z.ZodOptional<z.ZodNumber>>),
});

/** RFC 4180 quoting, including escaped quotes and multiline fields. */
export function parsePatientCsv(csv: string, delimiter: string): string[][] {
  csv = csv.replace(/^\uFEFF/, '');
  const rows: string[][] = []; let row: string[] = []; let field = ''; let quoted = false; let closed = false;
  const push = () => { row.push(field.trim()); field = ''; closed = false; };
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i]!;
    if (quoted) { if (c === '"') { if (csv[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } } else field += c; continue; }
    if (c === delimiter) push();
    else if (c === '\n' || c === '\r') { if (c === '\r' && csv[i + 1] === '\n') i++; push(); if (row.some(Boolean)) rows.push(row); row = []; }
    else if (c === '"' && !field && !closed) quoted = true;
    else { if (closed || c === '"') throw new AppError('validation_failed', 'Aspas inválidas no CSV.'); field += c; }
    if (rows.length > 501 || row.length > 50) throw new AppError('validation_failed', 'Limite: 500 pacientes e 50 colunas.');
  }
  if (quoted) throw new AppError('validation_failed', 'O CSV contém aspas sem fechamento.');
  push(); if (row.some(Boolean)) rows.push(row);
  if (rows.length < 2 || rows.length > 501 || rows.some(r => r.length > 50)) throw new AppError('validation_failed', 'Use um cabeçalho e de 1 a 500 pacientes (até 50 colunas).');
  rows[0]![0] = rows[0]![0]!.replace(/^\uFEFF/, '');
  return rows;
}

@Injectable()
export class PatientImportService {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService) {}

  private async validate(db: DbOrTx, tenant: TenantContext, input: z.infer<typeof importSchema>) {
    const [headers, ...rows] = parsePatientCsv(input.csv, input.delimiter);
    const indices = Object.values(input.mapping).filter((v): v is number => v !== undefined);
    if (input.mapping.fullName === undefined || indices.some(i => i >= headers!.length) || new Set(indices).size !== indices.length) throw new AppError('validation_failed', 'Mapeie o nome completo e use uma coluna diferente para cada campo.');
    const seenCpf = new Set<string>(); const seenNames = new Set<string>();
    const report = [];
    for (const [index, row] of rows.entries()) {
      const values = Object.fromEntries(Object.entries(input.mapping).filter(([, i]) => i !== undefined).map(([field, i]) => [field, row[i!] ?? '']));
      const parsed = patientSchema.safeParse(values);
      if (!parsed.success || row.length !== headers!.length) {
        report.push({ row: index + 2, status: 'invalid' as const, message: row.length !== headers!.length ? 'Quantidade de colunas diferente do cabeçalho.' : parsed.error!.issues.map(i => i.message).join(' '), patient: null }); continue;
      }
      const p = parsed.data; const key = p.birthDate ? `${normalizeName(p.fullName)}|${p.birthDate}` : null;
      const [existing] = await db.select({ id: patients.id }).from(patients).where(and(eq(patients.organizationId, tenant.organizationId), or(p.cpf ? eq(patients.cpf, p.cpf) : sql`false`, key ? and(eq(patients.searchName, normalizeName(p.fullName)), eq(patients.birthDate, p.birthDate!)) : sql`false`))).limit(1);
      const duplicate = !!existing || !!(p.cpf && seenCpf.has(p.cpf)) || !!(key && seenNames.has(key));
      if (p.cpf) seenCpf.add(p.cpf); if (key) seenNames.add(key);
      report.push({ row: index + 2, status: duplicate ? 'duplicate' as const : 'ready' as const, message: duplicate ? 'CPF ou nome e nascimento já cadastrado ou repetido no arquivo; será ignorado.' : 'Pronto para importar.', patient: p });
    }
    return report;
  }

  async preview(tenant: TenantContext, input: z.infer<typeof importSchema>) { return { rows: await this.validate(this.db, tenant, input) }; }

  async commit(auth: AuthContext, tenant: TenantContext, input: z.infer<typeof importSchema>, meta: RequestMeta) {
    return this.db.transaction(async tx => {
      // Serialize against ordinary create/update as well as other imports. Revalidate inside the lock.
      await tx.execute(sql`LOCK TABLE patients IN SHARE ROW EXCLUSIVE MODE`);
      const fingerprint = createHash('sha256').update(JSON.stringify({ csv: input.csv, delimiter: input.delimiter, mapping: Object.entries(input.mapping).sort(([a], [b]) => a.localeCompare(b)) })).digest('hex');
      const prior = await tx.execute<{ result: { rows: { row: number }[] } }>(sql`SELECT result FROM patient_import_batches WHERE organization_id = ${tenant.organizationId}::uuid AND input_hash = ${fingerprint}`);
      if (prior.rows[0]) return { imported: 0, skipped: prior.rows[0].result.rows.length, rows: prior.rows[0].result.rows.map(r => ({ row: r.row, status: 'skipped', message: 'Este arquivo e mapeamento já foram importados.' })) };
      const rows = await this.validate(tx, tenant, input);
      if (rows.some(r => r.status === 'invalid')) throw new AppError('validation_failed', 'Corrija as linhas inválidas antes de importar. Nenhum paciente foi criado.', { rows });
      const results = [];
      for (const r of rows) {
        if (r.status !== 'ready' || !r.patient) { results.push({ row: r.row, status: 'skipped', message: r.message }); continue; }
        const [created] = await tx.insert(patients).values({ ...r.patient, organizationId: tenant.organizationId, createdBy: auth.userId, searchName: normalizeName(r.patient.fullName) }).returning({ id: patients.id });
        await this.audit.record(tx, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'patient.imported', entityType: 'patient', entityId: created!.id, metadata: { row: r.row }, meta });
        results.push({ row: r.row, status: 'imported', id: created!.id, message: 'Paciente importado.' });
      }
      const result = { rows: results, imported: results.filter(r => r.status === 'imported').length, skipped: results.filter(r => r.status === 'skipped').length };
      await tx.execute(sql`INSERT INTO patient_import_batches(organization_id, input_hash, actor_user_id, result) VALUES (${tenant.organizationId}::uuid, ${fingerprint}, ${auth.userId}::uuid, ${JSON.stringify(result)}::jsonb)`);
      return result;
    });
  }
}
