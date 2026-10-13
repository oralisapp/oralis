import { Body, Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { communicationPrefsSchema, patientPreferencesSchema, representativeSchema } from '@oralis/shared';
import { and, eq } from 'drizzle-orm';
import { notFound, parse } from '../../common/app-error';
import { Auth, type AuthContext, Meta, type RequestMeta, RequirePermission, Tenant, type TenantContext } from '../../common/request-context';
import { DB, type Db } from '../../db/db';
import { patientPreferences, patientRepresentatives, patients } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { CommunicationService } from './communication.service';

/** Autorizações de comunicação, preferências de atendimento e responsáveis legais. */
@Controller('orgs/:orgId/patients/:patientId')
export class PatientProfileController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly comms: CommunicationService,
    private readonly audit: AuditService,
  ) {}

  private async assertPatient(tenant: TenantContext, patientId: string) {
    const [p] = await this.db.select({ id: patients.id }).from(patients).where(and(eq(patients.id, patientId), eq(patients.organizationId, tenant.organizationId)));
    if (!p) throw notFound('Paciente');
  }

  @Get('communication')
  @RequirePermission('patients.read')
  async communication(@Tenant() tenant: TenantContext, @Param('patientId', ParseUUIDPipe) id: string) {
    await this.assertPatient(tenant, id);
    return this.comms.matrix(tenant, id);
  }

  @Put('communication')
  @RequirePermission('patients.write')
  updateCommunication(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('patientId', ParseUUIDPipe) id: string, @Body() body: unknown, @Meta() meta: RequestMeta) {
    return this.comms.update(auth, tenant, id, parse(communicationPrefsSchema, body).preferences, 'clinic', meta);
  }

  @Get('preferences')
  @RequirePermission('patients.read')
  async preferences(@Tenant() tenant: TenantContext, @Param('patientId', ParseUUIDPipe) id: string) {
    await this.assertPatient(tenant, id);
    const [row] = await this.db.select().from(patientPreferences).where(and(eq(patientPreferences.patientId, id), eq(patientPreferences.organizationId, tenant.organizationId)));
    return row ?? { preferredChannel: null, preferredPeriod: null, accessibilityNeeds: null, welcomeNotes: null };
  }

  @Put('preferences')
  @RequirePermission('patients.write')
  async updatePreferences(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('patientId', ParseUUIDPipe) id: string, @Body() body: unknown, @Meta() meta: RequestMeta) {
    await this.assertPatient(tenant, id);
    const input = parse(patientPreferencesSchema, body);
    const values = {
      preferredChannel: input.preferredChannel ?? null,
      preferredPeriod: input.preferredPeriod ?? null,
      accessibilityNeeds: input.accessibilityNeeds ?? null,
      welcomeNotes: input.welcomeNotes ?? null,
      updatedBy: auth.userId,
      updatedAt: new Date(),
    };
    await this.db.insert(patientPreferences).values({ patientId: id, organizationId: tenant.organizationId, ...values }).onConflictDoUpdate({ target: patientPreferences.patientId, set: values });
    await this.audit.record(this.db, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'patient.preferences_updated', entityType: 'patient', entityId: id, metadata: { fields: Object.keys(input) }, meta });
    return { ok: true };
  }

  @Get('representatives')
  @RequirePermission('patients.read')
  async representatives(@Tenant() tenant: TenantContext, @Param('patientId', ParseUUIDPipe) id: string) {
    await this.assertPatient(tenant, id);
    return this.db.select().from(patientRepresentatives).where(and(eq(patientRepresentatives.patientId, id), eq(patientRepresentatives.organizationId, tenant.organizationId)));
  }

  @Post('representatives')
  @RequirePermission('patients.write')
  async addRepresentative(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('patientId', ParseUUIDPipe) id: string, @Body() body: unknown, @Meta() meta: RequestMeta) {
    await this.assertPatient(tenant, id);
    const input = parse(representativeSchema, body);
    const [row] = await this.db
      .insert(patientRepresentatives)
      .values({ organizationId: tenant.organizationId, patientId: id, fullName: input.fullName, relationship: input.relationship, cpf: input.cpf ?? null, phone: input.phone ?? null, email: input.email ?? null, isLegalGuardian: input.isLegalGuardian })
      .returning({ id: patientRepresentatives.id });
    await this.audit.record(this.db, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'patient.representative_added', entityType: 'patient', entityId: id, meta });
    return { id: row!.id };
  }

  @Delete('representatives/:repId')
  @RequirePermission('patients.write')
  async removeRepresentative(@Auth() auth: AuthContext, @Tenant() tenant: TenantContext, @Param('patientId', ParseUUIDPipe) id: string, @Param('repId', ParseUUIDPipe) repId: string, @Meta() meta: RequestMeta) {
    const r = await this.db
      .delete(patientRepresentatives)
      .where(and(eq(patientRepresentatives.id, repId), eq(patientRepresentatives.patientId, id), eq(patientRepresentatives.organizationId, tenant.organizationId)))
      .returning({ id: patientRepresentatives.id });
    if (!r.length) throw notFound('Responsável');
    await this.audit.record(this.db, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'patient.representative_removed', entityType: 'patient', entityId: id, meta });
    return { ok: true };
  }
}
