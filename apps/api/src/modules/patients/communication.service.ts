import { Inject, Injectable } from '@nestjs/common';
import { COMMUNICATION_CATEGORIES, COMMUNICATION_CHANNELS } from '@oralis/shared';
import { and, eq } from 'drizzle-orm';
import { notFound } from '../../common/app-error';
import { type AuthContext, type RequestMeta, type TenantContext } from '../../common/request-context';
import { DB, type Db, type DbOrTx } from '../../db/db';
import { communicationPreferences, patients } from '../../db/schema';
import { AuditService } from '../audit/audit.service';

type Channel = (typeof COMMUNICATION_CHANNELS)[number];
type Category = (typeof COMMUNICATION_CATEGORIES)[number];

/**
 * Autorizações de contato. Regra: avisos transacionais valem salvo recusa
 * registrada; relacionamento e promoções só com autorização explícita.
 */
@Injectable()
export class CommunicationService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async canContact(organizationId: string, patientId: string, channel: Channel, category: Category, db: DbOrTx = this.db): Promise<boolean> {
    const [pref] = await db
      .select({ allowed: communicationPreferences.allowed })
      .from(communicationPreferences)
      .where(and(eq(communicationPreferences.organizationId, organizationId), eq(communicationPreferences.patientId, patientId), eq(communicationPreferences.channel, channel), eq(communicationPreferences.category, category)));
    if (pref) return pref.allowed;
    return category === 'transactional';
  }

  async matrix(tenant: TenantContext, patientId: string) {
    const rows = await this.db
      .select()
      .from(communicationPreferences)
      .where(and(eq(communicationPreferences.organizationId, tenant.organizationId), eq(communicationPreferences.patientId, patientId)));
    return COMMUNICATION_CHANNELS.flatMap((channel) =>
      COMMUNICATION_CATEGORIES.map((category) => {
        const r = rows.find((x) => x.channel === channel && x.category === category);
        return { channel, category, allowed: r ? r.allowed : category === 'transactional', explicit: !!r, source: r?.source ?? 'default', updatedAt: r?.updatedAt ?? null };
      }),
    );
  }

  async update(auth: AuthContext | null, tenant: { organizationId: string }, patientId: string, prefs: { channel: Channel; category: Category; allowed: boolean }[], source: 'clinic' | 'patient_portal', meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const [p] = await tx.select({ id: patients.id }).from(patients).where(and(eq(patients.id, patientId), eq(patients.organizationId, tenant.organizationId)));
      if (!p) throw notFound('Paciente');
      for (const pref of prefs) {
        await tx
          .insert(communicationPreferences)
          .values({ organizationId: tenant.organizationId, patientId, ...pref, source, updatedBy: auth?.userId ?? null })
          .onConflictDoUpdate({
            target: [communicationPreferences.patientId, communicationPreferences.channel, communicationPreferences.category],
            set: { allowed: pref.allowed, source, updatedBy: auth?.userId ?? null, updatedAt: new Date() },
          });
      }
      await this.audit.record(tx, {
        organizationId: tenant.organizationId,
        actorUserId: auth?.userId ?? null,
        action: 'patient.communication_updated',
        entityType: 'patient',
        entityId: patientId,
        metadata: { source, preferences: prefs },
        meta,
      });
      return { ok: true };
    });
  }
}
