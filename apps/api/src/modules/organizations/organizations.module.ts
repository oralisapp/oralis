import { Inject, Injectable, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { SYSTEM_ROLES, type SystemRoleKey } from '@oralis/shared';
import { and, eq, isNotNull } from 'drizzle-orm';
import { DB, type Db } from '../../db/db';
import { rolePermissions, roles } from '../../db/schema';
import { InvitationsController, OrganizationsController, ResourcesController, TeamController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';
import { ResourcesService } from './resources.service';
import { TeamService } from './team.service';

/**
 * Ao subir, garante que os papéis de SISTEMA de cada organização tenham as
 * permissões padrão de módulos novos. Só adiciona — nunca remove permissões
 * (personalizações futuras ficam preservadas).
 */
@Injectable()
class SystemRolesSync implements OnApplicationBootstrap {
  constructor(@Inject(DB) private readonly db: Db) {}

  async onApplicationBootstrap() {
    const rows = await this.db.select({ id: roles.id, key: roles.key }).from(roles).where(and(eq(roles.isSystem, true), isNotNull(roles.key)));
    const values = rows.flatMap((r) => (SYSTEM_ROLES[r.key as SystemRoleKey]?.permissions ?? []).map((permission) => ({ roleId: r.id, permission })));
    for (let i = 0; i < values.length; i += 500) {
      await this.db.insert(rolePermissions).values(values.slice(i, i + 500)).onConflictDoNothing();
    }
  }
}

@Module({
  controllers: [OrganizationsController, TeamController, InvitationsController, ResourcesController],
  providers: [OrganizationsService, TeamService, ResourcesService, SystemRolesSync],
})
export class OrganizationsModule {}
