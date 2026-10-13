'use client';

import { ArrowUpRight, Mail, Phone, Search, UserPlus, Users, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { PatientFormDialog } from '@/components/patient-form-dialog';
import { PatientImport } from '@/components/patient-import';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, ErrorState, LoadingBlock, PageHeader } from '@/components/ui/feedback';
import { Input } from '@/components/ui/field';
import { ApiError } from '@/lib/api';
import { ageFrom, fmtCivilDate, fmtPhone } from '@/lib/format';
import { usePatients } from '@/lib/queries';
import { useOrg } from '@/lib/session';

function PatientsInner() {
  const { can, orgId } = useOrg();
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(params.get('novo') === '1');
  const list = usePatients(debounced, page);
  const today = new Date().toISOString().slice(0, 10);
  useEffect(() => { const timer = setTimeout(() => { setDebounced(q.trim()); setPage(1); }, 250); return () => clearTimeout(timer); }, [q]);
  if (!can('patients.read')) return <ErrorState error={new ApiError(403, 'forbidden', '')} />;
  const totalPages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;
  return <>
    <PageHeader eyebrow="Relacionamentos que importam" title="Pacientes" description="Cada nome, uma história. Tudo para um cuidado mais próximo." actions={can('patients.write') && <Button icon={<UserPlus className="size-4" aria-hidden />} onClick={() => setCreating(true)}>Novo paciente</Button>} />
    {can('patients.write') && <div className="mb-4"><PatientImport key={orgId} /></div>}
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border p-5">
        <div className="relative w-full sm:max-w-md"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden /><Input aria-label="Buscar pacientes" placeholder="Encontre por nome, telefone ou CPF..." value={q} onChange={e => setQ(e.target.value)} className="pl-10 pr-10" />{q && <button type="button" aria-label="Limpar busca" onClick={() => setQ('')} className="absolute right-2 top-2 rounded-lg p-1.5 text-muted hover:bg-surface-2"><X className="size-4" aria-hidden /></button>}</div>
        <span className="inline-flex items-center gap-2 rounded-full bg-primary-soft px-3 py-1.5 text-[11px] font-semibold text-primary-text" role="status"><Users className="size-3.5" aria-hidden />{list.data ? `${list.data.total} paciente${list.data.total === 1 ? '' : 's'} ${debounced ? 'na busca' : (list.data.total === 1 ? 'cadastrado' : 'cadastrados')}` : 'Seus pacientes'}</span>
      </div>
      {list.isLoading && <LoadingBlock rows={6} />}
      {list.error && <ErrorState error={list.error} onRetry={() => list.refetch()} />}
      {list.data && !list.data.items.length && <EmptyState icon={<Users className="size-6" aria-hidden />} title={debounced ? 'Não encontramos esse paciente.' : 'O primeiro de muitos sorrisos.'} description={debounced ? 'Tente outro nome, telefone ou CPF. Você também pode limpar a busca.' : 'Comece por quem tem consulta marcada. O cadastro reúne contato e histórico para facilitar os próximos atendimentos.'} action={debounced ? <Button variant="secondary" onClick={() => setQ('')}>Limpar busca</Button> : can('patients.write') ? <Button onClick={() => setCreating(true)}>Cadastrar primeiro paciente</Button> : undefined} />}
      {list.data && list.data.items.length > 0 && <>
        <div className="patient-row border-b border-border bg-surface-2/50 px-5 py-3 text-[9px] font-bold uppercase tracking-[.15em] text-muted" aria-hidden><span>Paciente</span><span className="patient-secondary">Contato</span><span className="patient-secondary">E-mail</span><span /></div>
        <ul className="divide-y divide-border">{list.data.items.map(p => {
          const age = ageFrom(p.birthDate, today);
          return <li key={p.id}><Link href={`/app/pacientes/${p.id}`} className="patient-row group px-5 py-5 transition-colors hover:bg-surface-2/70">
            <span className="flex min-w-0 items-center gap-3.5"><span className="avatar-tile size-11 text-xs" aria-hidden>{(p.socialName || p.fullName).split(' ').filter(Boolean).slice(0, 2).map(n => n[0]).join('')}</span><span className="min-w-0"><span className="block truncate text-sm font-bold group-hover:text-primary-text">{p.socialName || p.fullName}</span><span className="mt-1 block truncate text-[11px] text-muted">{p.socialName ? `${p.fullName} · ` : ''}{p.birthDate ? `${fmtCivilDate(p.birthDate)}${age !== null ? ` · ${age} anos` : ''}` : 'Nascimento não informado'}</span>{p.phone && <span className="mt-1 block text-[11px] text-muted sm:hidden">{fmtPhone(p.phone)}</span>}</span></span>
            <span className="patient-secondary flex items-center gap-2 text-xs text-muted"><Phone className="size-3.5 shrink-0" aria-hidden />{p.phone ? fmtPhone(p.phone) : 'Não informado'}</span>
            <span className="patient-secondary flex min-w-0 items-center gap-2 text-xs text-muted"><Mail className="size-3.5 shrink-0" aria-hidden /><span className="truncate">{p.email || 'Não informado'}</span></span>
            <ArrowUpRight className="size-4 text-muted transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden />
          </Link></li>;
        })}</ul>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface-2/30 px-5 py-4 text-xs text-muted"><span>{list.data.total} paciente{list.data.total === 1 ? '' : 's'}{debounced ? ' na busca' : ' na sua clínica'}</span>{totalPages > 1 && <div className="flex items-center gap-3"><Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</Button><span aria-live="polite">{page} de {totalPages}</span><Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Próxima</Button></div>}</div>
      </>}
    </Card>
    <PatientFormDialog open={creating} onClose={() => setCreating(false)} onSaved={id => router.push(`/app/pacientes/${id}`)} />
  </>;
}

export default function PatientsPage() {
  return <Suspense fallback={<LoadingBlock rows={5} />}><PatientsInner /></Suspense>;
}
