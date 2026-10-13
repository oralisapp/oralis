import { Inject, Injectable } from '@nestjs/common';
import { APPOINTMENT_STATUS_LABEL, type AppointmentStatus, type PatientInput } from '@oralis/shared';
import { and, asc, count, desc, eq, ilike, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import { AppError, notFound } from '../../common/app-error';
import { type AuthContext, type RequestMeta, type TenantContext } from '../../common/request-context';
import { DB, type Db, type DbOrTx, pgConstraint, pgErrorCode } from '../../db/db';
import { appointments, clinicUnits, patients, professionals, services } from '../../db/schema';
import { AuditService } from '../audit/audit.service';

/** Minúsculas e sem acentos, para busca tolerante ("joao" encontra "João"). */
export function normalizeName(name: string): string {
  return name.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function escapeLike(v: string): string {
  return v.replace(/[\\%_]/g, (c) => `\\${c}`);
}

@Injectable()
export class PatientsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async search(tenant: TenantContext, q: string | undefined, page: number, pageSize: number) {
    const filters: SQL[] = [eq(patients.organizationId, tenant.organizationId), eq(patients.status, 'active')];
    if (q) {
      const digits = q.replace(/\D+/g, '');
      const term = `%${escapeLike(normalizeName(q))}%`;
      const byName = ilike(patients.searchName, term);
      filters.push(digits.length >= 4 ? (or(byName, ilike(patients.phone, `%${digits}%`), eq(patients.cpf, digits)) as SQL) : byName);
    }
    const where = and(...filters);
    const [items, [total]] = await Promise.all([
      this.db
        .select({
          id: patients.id,
          fullName: patients.fullName,
          socialName: patients.socialName,
          birthDate: patients.birthDate,
          phone: patients.phone,
          email: patients.email,
          hasCpf: sql<boolean>`${patients.cpf} is not null`,
        })
        .from(patients)
        .where(where)
        .orderBy(asc(patients.searchName))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db.select({ n: count() }).from(patients).where(where),
    ]);
    return { items, total: total?.n ?? 0, page, pageSize };
  }

  /**
   * Possíveis duplicidades: mesmo CPF (bloqueia) ou mesmo nome + nascimento
   * (pede confirmação). Históricos consolidados mantêm sua identidade original.
   */
  private async findDuplicates(db: DbOrTx, tenant: TenantContext, input: PatientInput, exceptId?: string) {
    const conds: SQL[] = [];
    if (input.cpf) conds.push(eq(patients.cpf, input.cpf));
    if (input.birthDate) conds.push(and(eq(patients.searchName, normalizeName(input.fullName)), eq(patients.birthDate, input.birthDate)) as SQL);
    if (!conds.length) return [];
    return db
      .select({ id: patients.id, fullName: patients.fullName, birthDate: patients.birthDate, sameCpf: sql<boolean>`${patients.cpf} is not distinct from ${input.cpf ?? null}` })
      .from(patients)
      .where(and(eq(patients.organizationId, tenant.organizationId), or(...conds), exceptId ? ne(patients.id, exceptId) : undefined))
      .limit(5);
  }

  private values(input: PatientInput) {
    return {
      fullName: input.fullName,
      socialName: input.socialName ?? null,
      searchName: normalizeName(input.fullName),
      birthDate: input.birthDate ?? null,
      cpf: input.cpf ?? null,
      phone: input.phone ?? null,
      email: input.email ?? null,
      administrativeNotes: input.administrativeNotes ?? null,
    };
  }

  async create(auth: AuthContext, tenant: TenantContext, input: PatientInput, allowPossibleDuplicate: boolean, meta: RequestMeta) {
    try {
      return await this.db.transaction(async (tx) => {
        const dups = await this.findDuplicates(tx, tenant, input);
        if (dups.some((d) => d.sameCpf)) {
          throw new AppError('duplicate_patient', 'Já existe um paciente com este CPF.', { candidates: dups, blocking: true });
        }
        if (dups.length && !allowPossibleDuplicate) {
          throw new AppError('duplicate_patient', 'Encontramos um cadastro com o mesmo nome e data de nascimento.', { candidates: dups, blocking: false });
        }
        const [p] = await tx
          .insert(patients)
          .values({ organizationId: tenant.organizationId, createdBy: auth.userId, ...this.values(input) })
          .returning({ id: patients.id });
        await this.audit.record(tx, {
          organizationId: tenant.organizationId,
          actorUserId: auth.userId,
          action: 'patient.created',
          entityType: 'patient',
          entityId: p!.id,
          // Apenas os nomes dos campos preenchidos, nunca os valores.
          metadata: { fields: Object.entries(input).filter(([, v]) => v !== undefined).map(([k]) => k), possibleDuplicateAcknowledged: dups.length > 0 },
          meta,
        });
        return { id: p!.id };
      });
    } catch (err) {
      if (pgErrorCode(err) === '23505' && pgConstraint(err) === 'patients_org_cpf_uq') {
        throw new AppError('duplicate_patient', 'Já existe um paciente com este CPF.', { blocking: true });
      }
      throw err;
    }
  }

  async update(auth: AuthContext, tenant: TenantContext, id: string, input: PatientInput & { version: number }, meta: RequestMeta) {
    try {
      return await this.db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(patients)
          .where(and(eq(patients.id, id), eq(patients.organizationId, tenant.organizationId)))
          .for('update');
        if (!current) throw notFound('Paciente');
        if (current.status !== 'active') throw new AppError('conflict', 'Cadastro arquivado. Utilize o cadastro principal indicado na ficha.');
        if (current.version !== input.version) {
          throw new AppError('stale_version', 'Este cadastro foi alterado por outra pessoa. Recarregue para ver a versão atual.');
        }
        const dups = await this.findDuplicates(tx, tenant, input, id);
        if (dups.some((d) => d.sameCpf)) throw new AppError('duplicate_patient', 'Já existe outro paciente com este CPF.', { candidates: dups, blocking: true });

        const next = this.values(input);
        const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => k !== 'searchName' && current[k] !== next[k]);
        await tx
          .update(patients)
          .set({ ...next, version: current.version + 1, updatedAt: new Date() })
          .where(eq(patients.id, id));
        await this.audit.record(tx, {
          organizationId: tenant.organizationId,
          actorUserId: auth.userId,
          action: 'patient.updated',
          entityType: 'patient',
          entityId: id,
          metadata: { fields: changed },
          meta,
        });
        return { id, version: current.version + 1 };
      });
    } catch (err) {
      if (pgErrorCode(err) === '23505' && pgConstraint(err) === 'patients_org_cpf_uq') {
        throw new AppError('duplicate_patient', 'Já existe outro paciente com este CPF.', { blocking: true });
      }
      throw err;
    }
  }

  /** Ficha do paciente. O acesso é auditado (dado pessoal). */
  async detail(auth: AuthContext, tenant: TenantContext, id: string, meta: RequestMeta) {
    const [p] = await this.db
      .select()
      .from(patients)
      .where(and(eq(patients.id, id), eq(patients.organizationId, tenant.organizationId)));
    if (!p) throw notFound('Paciente');

    const unitFilter = tenant.allUnits ? undefined : inArray(appointments.unitId, [...tenant.unitIds]);
    const canSeeAgenda = tenant.permissions.has('schedule.read') && (tenant.allUnits || tenant.unitIds.size > 0);
    const history = canSeeAgenda
      ? await this.db
          .select({
            id: appointments.id,
            startsAt: appointments.startsAt,
            endsAt: appointments.endsAt,
            status: appointments.status,
            unitId: appointments.unitId,
            unitName: clinicUnits.name,
            timezone: clinicUnits.timezone,
            professionalName: professionals.displayName,
            serviceName: services.name,
          })
          .from(appointments)
          .innerJoin(clinicUnits, eq(clinicUnits.id, appointments.unitId))
          .innerJoin(professionals, eq(professionals.id, appointments.professionalId))
          .leftJoin(services, eq(services.id, appointments.serviceId))
          .where(and(eq(appointments.organizationId, tenant.organizationId), eq(appointments.patientId, id), unitFilter))
          .orderBy(desc(appointments.startsAt))
          .limit(100)
      : [];

    await this.audit.record(this.db, {
      organizationId: tenant.organizationId,
      actorUserId: auth.userId,
      action: 'patient.viewed',
      entityType: 'patient',
      entityId: id,
      meta,
    });

    const { searchName: _s, organizationId: _o, ...patient } = p;
    return {
      patient,
      appointments: canSeeAgenda
        ? history.map((a) => ({ ...a, statusLabel: APPOINTMENT_STATUS_LABEL[a.status as AppointmentStatus] }))
        : null,
    };
  }
}
