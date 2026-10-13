'use client';

import { ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, ErrorState, LoadingBlock, PageHeader } from '@/components/ui/feedback';
import { Select } from '@/components/ui/field';
import { ApiError } from '@/lib/api';
import { qs } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useOrgQuery } from '@/lib/queries';
import { useOrg } from '@/lib/session';

interface AuditItem {
  id: string;
  action: string;
  actionLabel: string;
  entityType: string;
  entityId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
  actorName: string | null;
}

const ENTITY_LABEL: Record<string, string> = {
  organization: 'Organização',
  unit: 'Unidade',
  invitation: 'Convite',
  membership: 'Membro',
  professional: 'Profissional',
  chair: 'Cadeira/sala',
  service: 'Serviço',
  patient: 'Paciente',
  appointment: 'Consulta',
};

const FIELD_LABEL: Record<string, string> = {
  fullName: 'nome',
  socialName: 'nome social',
  birthDate: 'nascimento',
  cpf: 'CPF',
  phone: 'telefone',
  email: 'e-mail',
  administrativeNotes: 'observações',
};

/** Resumo legível do evento, sem expor valores de dados pessoais. */
function describe(item: AuditItem, tz: string): string | null {
  const m = item.metadata;
  if (Array.isArray(m.fields) && m.fields.length) return `Campos: ${(m.fields as string[]).map((f) => FIELD_LABEL[f] ?? f).join(', ')}`;
  if (item.action === 'appointment.status_changed') return `${m.from} → ${m.to}${m.reason ? ` (${m.reason})` : ''}`;
  if (item.action === 'appointment.rescheduled') {
    const b = m.before as { startsAt: string };
    const a = m.after as { startsAt: string };
    return `${fmtDateTime(b.startsAt, tz)} → ${fmtDateTime(a.startsAt, tz)}${m.confirmationReset ? ' · confirmação invalidada' : ''}`;
  }
  if (item.action === 'membership.updated') return `Papel: ${m.fromRole} → ${m.toRole}`;
  if (item.action === 'appointment.created') return `Início ${fmtDateTime(m.startsAt as string, tz)}`;
  return null;
}

export default function AuditPage() {
  const { can, unit } = useOrg();
  const [entityType, setEntityType] = useState('');
  const [page, setPage] = useState(1);
  const q = useOrgQuery<{ items: AuditItem[]; total: number; page: number; pageSize: number }>(['audit', entityType, page], `/audit${qs({ entityType, page })}`, can('audit.read'));
  const tz = unit?.timezone ?? 'America/Sao_Paulo';

  if (!can('audit.read')) return <ErrorState error={new ApiError(403, 'forbidden', '')} />;
  const pages = q.data ? Math.max(1, Math.ceil(q.data.total / q.data.pageSize)) : 1;

  return (
    <>
      <PageHeader
        title="Auditoria"
        description="Registro somente-inserção de ações relevantes: quem fez, quando e sobre qual registro. Não contém conteúdo clínico nem valores de dados pessoais."
      />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
          <label className="text-sm font-semibold" htmlFor="ent">
            Tipo de registro
          </label>
          <Select id="ent" className="!w-56" value={entityType} onChange={(e) => { setEntityType(e.target.value); setPage(1); }}>
            <option value="">Todos</option>
            {Object.entries(ENTITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </div>
        {q.isLoading && <LoadingBlock rows={8} />}
        {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
        {q.data && q.data.items.length === 0 && <EmptyState icon={<ShieldCheck className="size-5" aria-hidden />} title="Nenhum evento" />}
        {q.data && q.data.items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th scope="col" className="px-4 py-2 font-semibold">Quando</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Quem</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Ação</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Registro</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Detalhe</th>
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((i) => (
                  <tr key={i.id} className="border-b border-border last:border-0 align-top">
                    <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-muted">{fmtDateTime(i.createdAt, tz)}</td>
                    <td className="px-4 py-2.5">{i.actorName ?? 'Sistema'}</td>
                    <td className="px-4 py-2.5 font-medium">{i.actionLabel}</td>
                    <td className="px-4 py-2.5">
                      {i.entityType === 'patient' && i.entityId ? (
                        <Link href={`/app/pacientes/${i.entityId}`} className="text-primary-text hover:underline">{ENTITY_LABEL.patient}</Link>
                      ) : (
                        ENTITY_LABEL[i.entityType] ?? i.entityType
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-muted">{describe(i, tz) ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {q.data && pages > 1 && (
          <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3 text-sm text-muted">
            <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</Button>
            {page} / {pages}
            <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Próxima</Button>
          </div>
        )}
      </Card>
    </>
  );
}
