'use client';

import { CalendarDays, ClipboardList, Wallet } from 'lucide-react';
import Link from 'next/link';
import { usePortal } from '@/components/portal-context';
import { Card, LoadingBlock } from '@/components/ui/feedback';
import { fmtDate, fmtMoney, fmtTime } from '@/lib/format';
import { usePortalAppointments, usePortalPayments, usePortalPlans, usePortalRequests } from '@/lib/portal';

export default function PortalHome() {
  const me = usePortal();
  const appts = usePortalAppointments();
  const plans = usePortalPlans();
  const pay = usePortalPayments();
  const reqs = usePortalRequests();
  const next = appts.data?.upcoming[0];
  const pendingQuote = plans.data?.find((p) => p.quote?.status === 'presented');
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-extrabold">Olá, {me.patient.firstName}!</h1>
      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="p-5">
          <CalendarDays className="mb-2 size-5 text-primary" aria-hidden />
          <p className="text-sm text-muted">Próxima consulta</p>
          {appts.isLoading ? <LoadingBlock rows={1} /> : next ? (
            <>
              <p className="mt-1 font-bold">{fmtDate(next.startsAt, next.timezone, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
              <p className="text-sm">{fmtTime(next.startsAt, next.timezone)} · {next.professionalName}</p>
              <Link href="/paciente/agendamentos" className="mt-2 inline-block text-sm font-semibold text-primary-text hover:underline">{next.status === 'scheduled' ? 'Confirmar presença' : 'Ver detalhes'}</Link>
            </>
          ) : <p className="mt-1 text-sm">Nenhuma consulta marcada.</p>}
        </Card>
        <Card className="p-5">
          <ClipboardList className="mb-2 size-5 text-primary" aria-hidden />
          <p className="text-sm text-muted">Tratamentos</p>
          {pendingQuote ? (
            <><p className="mt-1 font-bold">Orçamento aguardando você</p><Link href="/paciente/tratamentos" className="mt-2 inline-block text-sm font-semibold text-primary-text hover:underline">Ver plano</Link></>
          ) : <p className="mt-1 text-sm">{plans.data?.length ? `${plans.data.length} plano(s) disponível(is)` : 'Nada disponível no momento.'}</p>}
        </Card>
        <Card className="p-5">
          <Wallet className="mb-2 size-5 text-primary" aria-hidden />
          <p className="text-sm text-muted">Saldo em aberto</p>
          <p className="mt-1 text-xl font-extrabold tabular-nums">{pay.data ? fmtMoney(pay.data.balance) : '—'}</p>
          <Link href="/paciente/pagamentos" className="mt-2 inline-block text-sm font-semibold text-primary-text hover:underline">Ver pagamentos</Link>
        </Card>
      </div>
      {reqs.data && reqs.data.length > 0 && (
        <Card className="p-5">
          <h2 className="mb-3 font-bold">Suas solicitações</h2>
          <ul className="space-y-2 text-sm">{reqs.data.map((r) => <li key={r.id} className="flex justify-between gap-3"><span>{r.title.split(':')[0]}</span><span className={r.status === 'open' ? 'text-warning' : 'text-accent-text'}>{r.status === 'open' ? 'Em andamento' : 'Atendida'}</span></li>)}</ul>
        </Card>
      )}
      <Card className="p-5">
        <h2 className="mb-2 font-bold">Contato da clínica</h2>
        <ul className="space-y-1 text-sm">{me.clinic.units.map((u) => <li key={u.name}><strong>{u.name}</strong>{u.addressLine ? ` — ${u.addressLine}` : ''}{u.city ? `, ${u.city}` : ''}{u.phone ? ` · ${u.phone}` : ''}</li>)}</ul>
      </Card>
    </div>
  );
}
