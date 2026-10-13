import { WorkspaceModule } from './modules/workspace/workspace.module';
import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { DB, type Db } from './db/db';
import { DbThrottlerStorage } from './modules/platform/db-throttler.storage';
import { PlatformModule } from './modules/platform/platform.module';
import { Clock } from './common/clock';
import { ErrorFilter } from './common/error.filter';
import { CsrfGuard, SessionGuard, TenantGuard } from './common/guards';
import { DbModule } from './db/db.module';
import { AuditModule } from './modules/audit/audit.module';
import { HealthController } from './health.controller';
import { IdentityModule } from './modules/identity/identity.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { PatientsModule } from './modules/patients/patients.module';
import { SchedulingModule } from './modules/scheduling/scheduling.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { ClinicalModule } from './modules/clinical/clinical.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { TreatmentsModule } from './modules/treatments/treatments.module';
import { FinanceModule } from './modules/finance/finance.module';
import { BillingModule } from './modules/billing/billing.module';
import { PortalModule } from './modules/portal/portal.module';
import { EngagementModule } from './modules/engagement/engagement.module';
import { OperationsModule } from './modules/operations/operations.module';

@Global()
@Module({ providers: [Clock], exports: [Clock] })
class ClockModule {}

/**
 * Monólito modular. Cada domínio fica em src/modules/<domínio> e conversa
 * com os demais por serviços exportados, nunca acessando controladores alheios.
 *
 * Ordem dos guards globais: CSRF → sessão → organização/permissões.
 */
@Module({
  imports: [
    ClockModule,
    WorkspaceModule,
    DbModule,
    // Contadores no PostgreSQL: valem entre instâncias e reinícios.
    ThrottlerModule.forRootAsync({
      inject: [DB],
      useFactory: (db: Db) => ({ throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }], storage: new DbThrottlerStorage(db) }),
    }),
    PlatformModule,
    AuditModule,
    IdentityModule,
    OrganizationsModule,
    PatientsModule,
    SchedulingModule,
    TasksModule,
    ClinicalModule,
    DocumentsModule,
    TreatmentsModule,
    FinanceModule,
    BillingModule,
    PortalModule,
    EngagementModule,
    OperationsModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: ErrorFilter },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
  ],
})
export class AppModule {}
