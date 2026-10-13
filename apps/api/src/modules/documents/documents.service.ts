import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, max } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, forbidden, notFound } from '../../common/app-error';
import { Clock } from '../../common/clock';
import { type AuthContext, type RequestMeta, type TenantContext } from '../../common/request-context';
import { DB, type Db } from '../../db/db';
import { documentTemplates, documentVersions, documents, organizations, patients, users } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { StorageService } from './storage.service';
import { assertWithinLimit } from '../billing/billing.service';

export const DOCUMENT_CATEGORIES = ['exam', 'photo', 'clinical_document', 'orientation', 'consent', 'administrative', 'other'] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

export const uploadMetaSchema = z.object({
  category: z.enum(DOCUMENT_CATEGORIES),
  title: z.string().trim().min(2).max(160),
  sharedWithPatient: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});
export const documentUpdateSchema = z.object({ title: z.string().trim().min(2).max(160).optional(), sharedWithPatient: z.boolean().optional() });
export const templateSchema = z.object({ name: z.string().trim().min(2).max(120), category: z.enum(['orientation', 'clinical_document', 'consent']).default('orientation'), body: z.string().trim().min(10).max(20_000), active: z.boolean().default(true) });

export interface UploadedFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

/**
 * Documentos do paciente. Documento administrativo segue a permissão de
 * cadastro; os demais (exames, fotos, documentos clínicos) exigem permissão
 * clínica. Download só por link assinado e temporário, gerado após checar a permissão.
 */
@Injectable()
export class DocumentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  private canRead(tenant: TenantContext, category: string) {
    return category === 'administrative' ? tenant.permissions.has('patients.read') : tenant.permissions.has('clinical.read');
  }
  private canWrite(tenant: TenantContext, category: string) {
    return category === 'administrative' ? tenant.permissions.has('patients.write') : tenant.permissions.has('clinical.write');
  }

  async list(tenant: TenantContext, patientId: string) {
    const rows = await this.db
      .select({
        id: documents.id,
        category: documents.category,
        title: documents.title,
        currentVersion: documents.currentVersion,
        sharedWithPatient: documents.sharedWithPatient,
        createdAt: documents.createdAt,
        createdByName: users.name,
      })
      .from(documents)
      .leftJoin(users, eq(users.id, documents.createdBy))
      .where(and(eq(documents.organizationId, tenant.organizationId), eq(documents.patientId, patientId), isNull(documents.archivedAt)))
      .orderBy(desc(documents.createdAt));
    const visible = rows.filter((r) => this.canRead(tenant, r.category));
    const versions = visible.length
      ? await this.db.select({ id: documentVersions.id, documentId: documentVersions.documentId, version: documentVersions.version, filename: documentVersions.filename, mimeType: documentVersions.mimeType, sizeBytes: documentVersions.sizeBytes, createdAt: documentVersions.createdAt }).from(documentVersions).where(inArray(documentVersions.documentId, visible.map((d) => d.id)))
      : [];
    return visible.map((d) => ({ ...d, versions: versions.filter((v) => v.documentId === d.id).sort((a, b) => b.version - a.version) }));
  }

  private async store(tenant: TenantContext, file: UploadedFile) {
    const err = this.storage.validate(file.buffer, file.mimetype);
    if (err) throw new AppError('validation_failed', err);
    await assertWithinLimit(this.db, tenant.organizationId, 'storageMb', Math.ceil(file.size / 1024 / 1024));
    const key = `${tenant.organizationId}/${randomUUID()}`;
    const { sha256 } = await this.storage.put(key, file.buffer);
    return { key, sha256 };
  }

  async upload(auth: AuthContext, tenant: TenantContext, patientId: string, meta: z.infer<typeof uploadMetaSchema>, file: UploadedFile | undefined, reqMeta: RequestMeta) {
    if (!file) throw new AppError('validation_failed', 'Selecione um arquivo.');
    if (!this.canWrite(tenant, meta.category)) throw forbidden();
    const [p] = await this.db.select({ id: patients.id }).from(patients).where(and(eq(patients.id, patientId), eq(patients.organizationId, tenant.organizationId)));
    if (!p) throw notFound('Paciente');
    const { key, sha256 } = await this.store(tenant, file);
    try {
      return await this.db.transaction(async (tx) => {
        const [doc] = await tx.insert(documents).values({ organizationId: tenant.organizationId, patientId, category: meta.category, title: meta.title, sharedWithPatient: meta.sharedWithPatient, createdBy: auth.userId }).returning({ id: documents.id });
        await tx.insert(documentVersions).values({ organizationId: tenant.organizationId, documentId: doc!.id, version: 1, storageKey: key, filename: file.originalname.slice(0, 200), mimeType: file.mimetype, sizeBytes: file.size, sha256, uploadedBy: auth.userId });
        await this.audit.record(tx, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'document.uploaded', entityType: 'patient', entityId: patientId, metadata: { documentId: doc!.id, category: meta.category, sizeBytes: file.size, sha256 }, meta: reqMeta });
        return { id: doc!.id };
      });
    } catch (e) {
      await this.storage.remove(key);
      throw e;
    }
  }

  private async loadDoc(tenant: TenantContext, id: string) {
    const [d] = await this.db.select().from(documents).where(and(eq(documents.id, id), eq(documents.organizationId, tenant.organizationId)));
    if (!d || !this.canRead(tenant, d.category)) throw notFound('Documento');
    return d;
  }

  async addVersion(auth: AuthContext, tenant: TenantContext, id: string, file: UploadedFile | undefined, reqMeta: RequestMeta) {
    if (!file) throw new AppError('validation_failed', 'Selecione um arquivo.');
    const d = await this.loadDoc(tenant, id);
    if (!this.canWrite(tenant, d.category)) throw forbidden();
    const { key, sha256 } = await this.store(tenant, file);
    return this.db.transaction(async (tx) => {
      const [{ v } = { v: 0 }] = await tx.select({ v: max(documentVersions.version) }).from(documentVersions).where(eq(documentVersions.documentId, id));
      const version = (v ?? 0) + 1;
      await tx.insert(documentVersions).values({ organizationId: tenant.organizationId, documentId: id, version, storageKey: key, filename: file.originalname.slice(0, 200), mimeType: file.mimetype, sizeBytes: file.size, sha256, uploadedBy: auth.userId });
      await tx.update(documents).set({ currentVersion: version }).where(eq(documents.id, id));
      await this.audit.record(tx, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'document.version_added', entityType: 'patient', entityId: d.patientId, metadata: { documentId: id, version, sha256 }, meta: reqMeta });
      return { version };
    });
  }

  async update(auth: AuthContext, tenant: TenantContext, id: string, input: z.infer<typeof documentUpdateSchema>, reqMeta: RequestMeta) {
    const d = await this.loadDoc(tenant, id);
    if (!this.canWrite(tenant, d.category)) throw forbidden();
    await this.db.update(documents).set(input).where(eq(documents.id, id));
    await this.audit.record(this.db, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: input.sharedWithPatient !== undefined ? 'document.sharing_changed' : 'document.updated', entityType: 'patient', entityId: d.patientId, metadata: { documentId: id, ...input }, meta: reqMeta });
    return { ok: true };
  }

  async archive(auth: AuthContext, tenant: TenantContext, id: string, reqMeta: RequestMeta) {
    const d = await this.loadDoc(tenant, id);
    if (!this.canWrite(tenant, d.category)) throw forbidden();
    await this.db.update(documents).set({ archivedAt: this.clock.now(), sharedWithPatient: false }).where(eq(documents.id, id));
    await this.audit.record(this.db, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'document.archived', entityType: 'patient', entityId: d.patientId, metadata: { documentId: id }, meta: reqMeta });
    return { ok: true };
  }

  /** Gera um link de 5 minutos para baixar a versão pedida (ou a atual). Acesso auditado. */
  async downloadLink(auth: AuthContext, tenant: TenantContext, id: string, version: number | undefined, reqMeta: RequestMeta) {
    const d = await this.loadDoc(tenant, id);
    const [v] = await this.db.select().from(documentVersions).where(and(eq(documentVersions.documentId, id), eq(documentVersions.version, version ?? d.currentVersion)));
    if (!v) throw notFound('Versão');
    await this.audit.record(this.db, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'document.downloaded', entityType: 'patient', entityId: d.patientId, metadata: { documentId: id, version: v.version }, meta: reqMeta });
    return { url: this.storage.signedPath(v.id, 300, this.clock.now().getTime()), filename: v.filename };
  }

  /** Entrega o arquivo de um link assinado válido. */
  async serveSigned(versionId: string, exp: string, sig: string) {
    if (!/^[0-9a-f-]{36}$/.test(versionId) || !this.storage.verify(versionId, exp, sig, this.clock.now().getTime())) throw notFound('Arquivo');
    const [v] = await this.db.select().from(documentVersions).where(eq(documentVersions.id, versionId));
    if (!v) throw notFound('Arquivo');
    return { data: await this.storage.get(v.storageKey), mimeType: v.mimeType, filename: v.filename };
  }

  // ---------------------------------------------------------------- Modelos

  async templates(tenant: TenantContext) {
    return this.db.select().from(documentTemplates).where(eq(documentTemplates.organizationId, tenant.organizationId)).orderBy(documentTemplates.name);
  }

  async saveTemplate(auth: AuthContext, tenant: TenantContext, id: string | null, input: z.infer<typeof templateSchema>) {
    if (id) {
      const r = await this.db.update(documentTemplates).set(input).where(and(eq(documentTemplates.id, id), eq(documentTemplates.organizationId, tenant.organizationId))).returning({ id: documentTemplates.id });
      if (!r.length) throw notFound('Modelo');
      return { id };
    }
    const [row] = await this.db.insert(documentTemplates).values({ organizationId: tenant.organizationId, ...input, createdBy: auth.userId }).returning({ id: documentTemplates.id });
    return { id: row!.id };
  }

  /**
   * Gera um documento a partir de modelo, substituindo {{paciente}},
   * {{data}}, {{clinica}} e {{profissional}}. O texto final é revisável e salvo como arquivo de texto.
   */
  async fromTemplate(auth: AuthContext, tenant: TenantContext, patientId: string, templateId: string, sharedWithPatient: boolean, reqMeta: RequestMeta) {
    const [t] = await this.db.select().from(documentTemplates).where(and(eq(documentTemplates.id, templateId), eq(documentTemplates.organizationId, tenant.organizationId), eq(documentTemplates.active, true)));
    if (!t) throw notFound('Modelo');
    const [p] = await this.db.select({ fullName: patients.fullName, socialName: patients.socialName }).from(patients).where(and(eq(patients.id, patientId), eq(patients.organizationId, tenant.organizationId)));
    if (!p) throw notFound('Paciente');
    const [org] = await this.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, tenant.organizationId));
    const text = t.body
      .replaceAll('{{paciente}}', p.socialName || p.fullName)
      .replaceAll('{{data}}', new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long', timeZone: 'America/Sao_Paulo' }).format(this.clock.now()))
      .replaceAll('{{clinica}}', org!.name)
      .replaceAll('{{profissional}}', auth.name);
    const buffer = Buffer.from(text, 'utf8');
    return this.upload(auth, tenant, patientId, { category: t.category as DocumentCategory, title: t.name, sharedWithPatient }, { buffer, mimetype: 'text/plain', originalname: `${t.name}.txt`, size: buffer.length }, reqMeta);
  }
}
