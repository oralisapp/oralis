'use client';

import { BLOCKING_STATUSES } from '@oralis/shared';
import { ArrowLeft, CalendarDays, Mail, Pencil, Phone, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { PatientTimeline } from '@/components/patient-timeline';
import { PatientFormDialog } from '@/components/patient-form-dialog';
import { PatientConsolidation } from '@/components/patient-consolidation';
import { PatientRelationship } from '@/components/patient-relationship';
import { ClinicalHistory } from '@/components/clinical/clinical-history';
import { DocumentsPanel } from '@/components/documents-panel';
import { Odontogram } from '@/components/clinical/odontogram';
import { PatientPlans } from '@/components/patient-plans';
import { PatientFinance } from '@/components/finance/patient-finance';
import { PortalLinkButton } from '@/components/portal-link-button';
import { StatusBadge } from '@/components/status-badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card, CardHeader, EmptyState, ErrorState, LoadingBlock, Notice } from '@/components/ui/feedback';
import { ApiError } from '@/lib/api';
import { ageFrom, fmtCivilDate, fmtCpf, fmtDate, fmtDateTime, fmtPhone, fmtTime } from '@/lib/format';
import { type PatientDetail, usePatient } from '@/lib/queries';
import { useOrg } from '@/lib/session';

type Tab = 'resumo' | 'clinico' | 'odontograma' | 'tratamentos' | 'agendamentos' | 'documentos' | 'financeiro' | 'relacionamento';

function Summary({ data, onEdit }: { data: PatientDetail; onEdit?: () => void }) {
  const { can } = useOrg();
  const p = data.patient;
  const now = new Date();
  const next = data.appointments
    ?.filter((a) => new Date(a.startsAt) >= now && BLOCKING_STATUSES.includes(a.status))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];
  const last = data.appointments?.find((a) => a.status === 'completed');
  const missing = [!p.phone && 'telefone', !p.birthDate && 'data de nascimento', !p.email && 'e-mail'].filter(Boolean) as string[];

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <Card>
        <CardHeader title="Contato e identificação" actions={onEdit && <Button variant="secondary" size="sm" icon={<Pencil className="size-3.5" aria-hidden />} onClick={onEdit}>Editar</Button>} />
        <dl className="grid gap-x-6 gap-y-4 p-5 sm:grid-cols-2">
          {[
            ['Nome completo', p.fullName],
            ['Nome social', p.socialName || '—'],
            ['Nascimento', p.birthDate ? `${fmtCivilDate(p.birthDate)} (${ageFrom(p.birthDate, now.toISOString().slice(0, 10))} anos)` : '—'],
            ['CPF', fmtCpf(p.cpf)],
            ['Telefone', fmtPhone(p.phone)],
            ['E-mail', p.email || '—'],
          ].map(([k, v]) => (
            <div key={k}>
              <dt className="text-xs font-semibold text-muted">{k}</dt>
              <dd className="mt-0.5 break-words">{v}</dd>
            </div>
          ))}
          {p.administrativeNotes && (
            <div className="sm:col-span-2">
              <dt className="text-xs font-semibold text-muted">Observações administrativas</dt>
              <dd className="mt-0.5 whitespace-pre-line">{p.administrativeNotes}</dd>
            </div>
          )}
        </dl>
        {missing.length > 0 && can('patients.write') && (
          <div className="px-5 pb-5">
            <Notice tone="warning">Cadastro incompleto: falta {missing.join(', ')}.</Notice>
          </div>
        )}
      </Card>

      <div className="space-y-4">
        {data.appointments && (
          <Card className="p-5">
            <h2 className="text-sm font-bold">Próxima consulta</h2>
            {next ? (
              <div className="mt-2">
                <p className="text-lg font-bold">{fmtDate(next.startsAt, next.timezone, { weekday: 'short', day: '2-digit', month: 'short' })} · {fmtTime(next.startsAt, next.timezone)}</p>
                <p className="text-sm text-muted">{next.professionalName} · {next.unitName}</p>
                <div className="mt-2"><StatusBadge status={next.status} /></div>
              </div>
            ) : (
              <p className="mt-2 text-sm text-muted">Nenhuma consulta futura.</p>
            )}
            {last && <p className="mt-4 border-t border-border pt-3 text-xs text-muted">Último atendimento concluído: {fmtDateTime(last.startsAt, last.timezone)} com {last.professionalName}.</p>}
          </Card>
        )}
        <Card className="p-5 text-sm text-muted">
          <p className="flex items-center gap-2 font-semibold text-fg">
            <ShieldCheck className="size-4 text-primary" aria-hidden /> Acesso registrado
          </p>
          <p className="mt-1">A abertura desta ficha fica registrada na auditoria da clínica. Prontuário, documentos e financeiro respeitam as permissões do seu perfil.</p>
        </Card>
      </div>
    </div>
  );
}

function Appointments({ data }: { data: PatientDetail }) {
  if (!data.appointments) return <ErrorState error={new ApiError(403, 'forbidden', '')} />;
  if (!data.appointments.length) {
    return <Card><EmptyState icon={<CalendarDays className="size-5" aria-hidden />} title="Sem consultas registradas" action={<ButtonLink href="/app/agenda" variant="secondary">Abrir agenda</ButtonLink>} /></Card>;
  }
  return (
    <Card>
      <ul className="divide-y divide-border">
        {data.appointments.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
            <span className="w-40 font-semibold tabular-nums">{fmtDateTime(a.startsAt, a.timezone)}</span>
            <span className="min-w-0 flex-1 text-sm">
              {a.professionalName}
              <span className="text-muted"> · {a.unitName}{a.serviceName ? ` · ${a.serviceName}` : ''}</span>
            </span>
            <StatusBadge status={a.status} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default function PatientPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useOrg();
  const q = usePatient(id);
  const params = useSearchParams();
  const router = useRouter();
  const requestedTab = params.get('aba') ?? 'resumo';
  const [editing, setEditing] = useState(false);

  const tabs: { key: Tab; label: string; show: boolean }[] = [
    { key: 'resumo', label: 'Resumo', show: true },
    { key: 'clinico', label: 'Histórico clínico', show: can('clinical.read') },
    { key: 'odontograma', label: 'Odontograma', show: can('clinical.read') },
    { key: 'tratamentos', label: 'Tratamentos', show: can('treatments.read') },
    { key: 'agendamentos', label: 'Agendamentos', show: can('schedule.read') },
    { key: 'documentos', label: 'Documentos', show: true },
    { key: 'financeiro', label: 'Financeiro', show: can('finance.read') },
    { key: 'relacionamento', label: 'Relacionamento', show: true },
  ];

  const tab = tabs.find(t => t.key === requestedTab && t.show)?.key ?? 'resumo';
  const setTab = (value: Tab) => router.replace(`/app/pacientes/${id}?aba=${value}`, { scroll: false });

  return (
    <>
      <Link href="/app/pacientes" className="mb-4 inline-flex items-center gap-1 text-sm font-semibold text-muted hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden /> Pacientes
      </Link>
      {q.isLoading && <Card><LoadingBlock rows={4} /></Card>}
      {q.error && <Card><ErrorState error={q.error} onRetry={() => q.refetch()} /></Card>}
      {q.data && (
        <>
          <header className="mb-5 flex flex-wrap items-center gap-4">
            <span className="flex size-14 items-center justify-center rounded-2xl bg-primary text-xl font-extrabold text-on-primary" aria-hidden>
              {(q.data.patient.socialName || q.data.patient.fullName).charAt(0)}
            </span>
            <div className="min-w-0 flex-1">
              <h1 className="text-2xl font-extrabold tracking-tight">{q.data.patient.socialName || q.data.patient.fullName}</h1>
              <p className="flex flex-wrap gap-x-4 text-sm text-muted">
                {q.data.patient.phone && <span className="inline-flex items-center gap-1"><Phone className="size-3.5" aria-hidden />{fmtPhone(q.data.patient.phone)}</span>}
                {q.data.patient.email && <span className="inline-flex items-center gap-1"><Mail className="size-3.5" aria-hidden />{q.data.patient.email}</span>}
              </p>
            </div>
            <PortalLinkButton patientId={id} />
          </header>

          <PatientConsolidation key={`${q.data.patient.id}:${q.data.patient.version}`} patient={q.data.patient} />
          <div role="tablist" aria-label="Seções do paciente" className="mb-4 flex gap-1 overflow-x-auto border-b border-border">
            {tabs.filter((t) => t.show).map((t) => (
              <button
                key={t.key}
                role="tab"
                type="button"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-semibold ${tab === t.key ? 'border-primary text-primary-text' : 'border-transparent text-muted hover:text-fg'}`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div role="tabpanel">
            {tab === 'resumo' && <><Summary data={q.data} onEdit={can('patients.write') && q.data.patient.status === 'active' ? () => setEditing(true) : undefined} /><PatientTimeline patientId={id} /></>}
            {tab === 'agendamentos' && <Appointments data={q.data} />}
            {tab === 'relacionamento' && <PatientRelationship patientId={id} />}
            {tab === 'clinico' && <ClinicalHistory patientId={id} />}
            {tab === 'odontograma' && <Card className="p-5"><Odontogram patientId={id} canWrite={can('clinical.write')} /></Card>}
            {tab === 'tratamentos' && <PatientPlans patientId={id} />}
            {tab === 'financeiro' && <PatientFinance patient={{ id, name: q.data.patient.fullName }} />}
            {tab === 'documentos' && <Card className="p-5"><DocumentsPanel patientId={id} tz="America/Sao_Paulo" /></Card>}
          </div>
          <PatientFormDialog open={editing} onClose={() => setEditing(false)} patient={q.data.patient} />
        </>
      )}
    </>
  );
}
