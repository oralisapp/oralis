import { Injectable } from '@nestjs/common';
import type { DbOrTx } from '../../db/db';
import { auditEvents } from '../../db/schema';
import type { RequestMeta } from '../../common/request-context';

export interface AuditEntry {
  organizationId: string | null;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  unitId?: string | null;
  /** Somente identificadores e dados administrativos — nunca conteúdo clínico. */
  metadata?: Record<string, unknown>;
  meta?: RequestMeta;
}

@Injectable()
export class AuditService {
  /**
   * Grava o evento na mesma transação da operação auditada: se a operação
   * falhar, o evento não é gravado; se o evento falhar, a operação é desfeita.
   */
  async record(db: DbOrTx, entry: AuditEntry): Promise<void> {
    await db.insert(auditEvents).values({
      organizationId: entry.organizationId,
      actorUserId: entry.actorUserId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      unitId: entry.unitId ?? null,
      metadata: entry.metadata ?? {},
      ip: entry.meta?.ip ?? null,
      userAgent: entry.meta?.userAgent ?? null,
    });
  }
}
