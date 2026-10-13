'use client';

import { todayInTz } from '@oralis/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Banknote, CheckCircle2, Info, PauseCircle, Plus, Receipt, Upload } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { METHOD_LABEL, PaymentDialog } from '@/components/finance/payment-dialog';
import { PatientPicker } from '@/components/new-appointment-dialog';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Badge, Card, CardHeader, EmptyState, ErrorState, LoadingBlock, Notice, PageHeader } from '@/components/ui/feedback';
import { Field, FormError, Input, Select, Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';
import { fmtCivilDate, fmtDateTime, fmtMoney } from '@/lib/format';
import { type CashAccount, type FinanceCategory, type Payment, type Receivable, useFinance, useProfessionals } from '@/lib/queries';
import { useOrg } from '@/lib/session';

type Tab = 'resumo' | 'receber' | 'recebimentos' | 'pagar' | 'estornos' | 'conciliacao' | 'inadimplencia' | 'repasses' | 'config';
const TABS: { key: Tab; label: string }[] = [
  { key: 'resumo', label: 'Resumo' },
  { key: 'receber', label: 'A receber' },
  { key: 'recebimentos', label: 'Recebimentos' },
  { key: 'pagar', label: 'A pagar' },
  { key: 'estornos', label: 'Estornos' },
  { key: 'conciliacao', label: 'Conciliação' },
  { key: 'inadimplencia', label: 'Inadimplência' },
  { key: 'repasses', label: 'Repasses' },
  { key: 'config', label: 'Contas e categorias' },
];

const VIEW: Record<Receivable['view'], { label: string; tone: 'neutral' | 'primary' | 'accent' | 'warning' | 'danger' | 'info' }> = {
  open: { label: 'Em aberto', tone: 'neutral' },
  partial: { label: 'Parcial', tone: 'info' },
  overdue: { label: 'Vencida', tone: 'danger' },
  partial_overdue: { label: 'Parcial vencida', tone: 'danger' },
  paid: { label: 'Paga', tone: 'accent' },
  cancelled: { label: 'Cancelada', tone: 'neutral' },
};

const money = (v: string) => (v.includes(',') ? v.replace(/\./g, '').replace(',', '.') : v).trim();

function usePeriod() {
  const { unit } = useOrg();
  const today = todayInTz(unit?.timezone ?? 'America/Sao_Paulo');
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(() => {
    const [y, m] = today.split('-').map(Number);
    return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
  });
  const picker = (
    <div className="flex items-center gap-2 text-sm">
      <input type="date" aria-label="Início do período" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} className="h-8 rounded-lg border border-border bg-surface px-2" />
      <span className="text-muted">a</span>
      <input type="date" aria-label="Fim do período" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} className="h-8 rounded-lg border border-border bg-surface px-2" />
    </div>
  );
  return { from, to, picker };
}

interface Metric { value: string; definition: string }

function Summary() {
  const router = useRouter();
  const { from, to, picker } = usePeriod();
  const s = useFinance<Record<string, Metric>>('summary', `/reports/summary?from=${from}&to=${to}`);
  const flow = useFinance<{ date: string; expectedIn: string; expectedOut: string; actualIn: string; actualOut: string }[]>('cashflow', `/reports/cashflow?from=${from}&to=${to}`);
  const tiles: { key: string; label: string }[] = [
    { key: 'contracted', label: 'Contratado' },
    { key: 'charged', label: 'Cobrado (vencimentos)' },
    { key: 'received', label: 'Recebido líquido' },
    { key: 'recognized', label: 'Reconhecido (etapas realizadas)' },
    { key: 'overdueBalance', label: 'Vencido em aberto' },
    { key: 'openBalance', label: 'Total em aberto' },
    { key: 'expensesPaid', label: 'Despesas pagas' },
    { key: 'cashResult', label: 'Resultado de caixa' },
  ];
  const totals = (flow.data ?? []).reduce((acc, d) => ({ ei: acc.ei + Number(d.expectedIn), eo: acc.eo + Number(d.expectedOut), ai: acc.ai + Number(d.actualIn), ao: acc.ao + Number(d.actualOut) }), { ei: 0, eo: 0, ai: 0, ao: 0 });
  return (
    <div className="space-y-5">
      <div className="flex justify-end">{picker}</div>
      {s.error && <ErrorState error={s.error} onRetry={() => s.refetch()} />}
      {flow.error && <ErrorState error={flow.error} onRetry={() => flow.refetch()} />}
      {s.isLoading && <LoadingBlock rows={2} />}
      {s.data && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {tiles.map((t) => (
            <Card key={t.key} as="div" className="p-4">
              <p className="text-xs font-semibold text-muted">{t.label}</p>
              <p className={`mt-1 text-xl font-extrabold tabular-nums ${t.key === 'overdueBalance' && s.data![t.key]!.value !== '0.00' ? 'text-danger' : ''}`}>{fmtMoney(s.data[t.key]!.value)}</p>
              <p className="mt-1 text-[11px] leading-snug text-subtle" title={s.data[t.key]!.definition}>{s.data[t.key]!.definition}</p>
              {['overdueBalance', 'openBalance', 'received', 'expensesPaid'].includes(t.key) && <Button size="sm" variant="ghost" className="mt-2" onClick={() => router.push(t.key === 'overdueBalance' ? '/app/financeiro?aba=receber&status=overdue' : t.key === 'openBalance' ? '/app/financeiro?aba=receber' : t.key === 'received' ? '/app/financeiro?aba=recebimentos' : '/app/financeiro?aba=pagar')}>Ver lançamentos →</Button>}
            </Card>
          ))}
        </div>
      )}
      <Card className="flex flex-wrap items-center justify-between gap-4 p-5">
        <div><p className="text-sm font-semibold text-muted">Saldo previsto no período</p><p className="text-2xl font-bold">{flow.data ? fmtMoney((totals.ei - totals.eo).toFixed(2)) : '—'}</p><p className="text-xs text-muted">Entradas previstas menos saídas previstas. Não é o saldo bancário.</p></div>
        <Button variant="secondary" onClick={() => router.push('/app/financeiro?aba=conciliacao')}>Revisar conciliação</Button>
      </Card>
      <Card>
        <CardHeader title="Fluxo de caixa: previsto × realizado" description="Previsto = saldo das parcelas e despesas em aberto pelo vencimento. Realizado = recebimentos (menos estornos) e despesas pagas pela data." />
        {flow.isLoading && <LoadingBlock rows={3} />}
        {flow.data && flow.data.length === 0 && <p className="px-5 py-4 text-sm text-muted">Sem movimentos no período.</p>}
        {flow.data && flow.data.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm tabular-nums">
              <thead><tr className="border-b border-border text-left text-xs text-muted"><th className="px-5 py-2 font-semibold">Dia</th><th className="px-3 py-2 text-right font-semibold">Entrada prevista</th><th className="px-3 py-2 text-right font-semibold">Saída prevista</th><th className="px-3 py-2 text-right font-semibold">Entrada realizada</th><th className="px-3 py-2 text-right font-semibold">Saída realizada</th></tr></thead>
              <tbody>
                {flow.data.map((d) => (
                  <tr key={d.date} className="border-b border-border">
                    <td className="px-5 py-2">{fmtCivilDate(d.date)}</td>
                    <td className="px-3 py-2 text-right">{d.expectedIn !== '0.00' ? fmtMoney(d.expectedIn) : '—'}</td>
                    <td className="px-3 py-2 text-right">{d.expectedOut !== '0.00' ? fmtMoney(d.expectedOut) : '—'}</td>
                    <td className="px-3 py-2 text-right">{d.actualIn !== '0.00' ? fmtMoney(d.actualIn) : '—'}</td>
                    <td className="px-3 py-2 text-right">{d.actualOut !== '0.00' ? fmtMoney(d.actualOut) : '—'}</td>
                  </tr>
                ))}
                <tr className="font-bold"><td className="px-5 py-2">Total</td><td className="px-3 py-2 text-right">{fmtMoney(totals.ei.toFixed(2))}</td><td className="px-3 py-2 text-right">{fmtMoney(totals.eo.toFixed(2))}</td><td className="px-3 py-2 text-right">{fmtMoney(totals.ai.toFixed(2))}</td><td className="px-3 py-2 text-right">{fmtMoney(totals.ao.toFixed(2))}</td></tr>
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Notice tone="info" icon={<Info className="size-5" aria-hidden />} title="Nota fiscal de serviço">
        A emissão de NFS-e não está disponível: depende de um emissor homologado no seu município e de validação contábil. Os comprovantes do sistema não têm valor fiscal.
      </Notice>
    </div>
  );
}

function NewReceivable({ open, onClose, initialPatient }: { open: boolean; onClose: () => void; initialPatient?: { id: string; name: string } }) {
  const { orgId, unit } = useOrg();
  const qc = useQueryClient();
  const profs = useProfessionals();
  const cats = useFinance<FinanceCategory[]>('categories', '/categories', open);
  const [patient, setPatient] = useState<{ id: string; name: string } | null>(initialPatient ?? null);
  useEffect(() => { if (open) setPatient(initialPatient ?? null); }, [open, initialPatient?.id, initialPatient?.name]);
  const [f, setF] = useState({ description: '', amount: '', firstDueDate: todayInTz(unit?.timezone ?? 'America/Sao_Paulo'), installments: 1, professionalId: '', categoryId: '' });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.post(`/orgs/${orgId}/finance/receivables`, { ...f, amount: money(f.amount), unitId: unit?.id, patientId: patient?.id, professionalId: f.professionalId || undefined, categoryId: f.categoryId || undefined }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['org', orgId] }); onClose(); },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Erro'),
  });
  return (
    <Dialog open={open} onClose={onClose} size="lg" title="Nova cobrança" footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button loading={save.isPending} onClick={() => save.mutate()}>Criar</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2"><FormError message={error} /></div>
        <div className="sm:col-span-2"><p className="mb-1.5 text-[13px] font-semibold">Paciente</p><PatientPicker value={patient} onChange={setPatient} /></div>
        <Field label="Descrição" required className="sm:col-span-2">{(p) => <Input {...p} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</Field>
        <Field label="Valor total (R$)" required>{(p) => <Input {...p} inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />}</Field>
        <Field label="Parcelas" hint="Arredondamento na 1ª parcela.">{(p) => <Input {...p} type="number" min={1} max={36} value={f.installments} onChange={(e) => setF({ ...f, installments: Number(e.target.value) })} />}</Field>
        <Field label="1º vencimento" required>{(p) => <Input {...p} type="date" value={f.firstDueDate} onChange={(e) => setF({ ...f, firstDueDate: e.target.value })} />}</Field>
        <Field label="Profissional (repasse)">{(p) => <Select {...p} value={f.professionalId} onChange={(e) => setF({ ...f, professionalId: e.target.value })}><option value="">—</option>{profs.data?.map((x) => <option key={x.id} value={x.id}>{x.displayName}</option>)}</Select>}</Field>
        <Field label="Categoria">{(p) => <Select {...p} value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}><option value="">—</option>{cats.data?.filter((c) => c.kind === 'income').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}</Field>
      </div>
    </Dialog>
  );
}

function ReceivablesTab() {
  const { orgId, can } = useOrg();
  const qc = useQueryClient();
  const params = useSearchParams();
  const router = useRouter();
  const status = ['open', 'overdue', 'paid', 'cancelled'].includes(params.get('status') ?? '') ? params.get('status')! : 'open';
  const patientId = params.get('paciente');
  const selected = useQuery({ queryKey: ['org', orgId, 'finance-patient', patientId], queryFn: () => api.get<{ patient: { id: string; fullName: string; socialName: string | null } }>(`/orgs/${orgId}/patients/${patientId}`), enabled: !!patientId && can('patients.read'), refetchOnWindowFocus: false });
  const selectedPatient = selected.data ? { id: selected.data.patient.id, name: selected.data.patient.socialName ?? selected.data.patient.fullName } : undefined;
  const [creating, setCreating] = useState(false);
  const [paying, setPaying] = useState<{ id: string; name: string } | null | undefined>(undefined);
  const q = useFinance<Receivable[]>('receivables', `/receivables?status=${status}${patientId ? `&patientId=${encodeURIComponent(patientId)}` : ''}`);
  const refresh = () => qc.invalidateQueries({ queryKey: ['org', orgId] });
  const cancel = useMutation({ mutationFn: ({ id, reason }: { id: string; reason: string }) => api.post(`/orgs/${orgId}/finance/receivables/${id}/cancel`, { reason }), onSuccess: refresh });
  const hold = useMutation({ mutationFn: ({ id, h, reason }: { id: string; h: boolean; reason?: string }) => api.put(`/orgs/${orgId}/finance/receivables/${id}/hold`, { hold: h, reason }), onSuccess: refresh });
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        {[['open', 'Em aberto'], ['overdue', 'Vencidas'], ['paid', 'Pagas'], ['cancelled', 'Canceladas']].map(([k, l]) => <Button key={k} size="sm" variant={status === k ? 'soft' : 'ghost'} onClick={() => router.replace(`/app/financeiro?aba=receber&status=${k}${patientId ? `&paciente=${encodeURIComponent(patientId)}` : ''}`)}>{l}</Button>)}
        {can('finance.write') && (
          <span className="ml-auto flex gap-2">
            <Button size="sm" variant="secondary" icon={<Banknote className="size-4" aria-hidden />} onClick={() => setPaying(selectedPatient ?? null)}>Registrar recebimento</Button>
            <Button size="sm" icon={<Plus className="size-4" aria-hidden />} onClick={() => setCreating(true)}>Nova cobrança</Button>
          </span>
        )}
      </div>
      {patientId && <div className="flex items-center justify-between gap-3 border-b border-border p-4 text-sm"><span>Cobranças de {selectedPatient?.name ?? 'paciente selecionado'}</span><Link href="/app/financeiro?aba=receber" className="font-semibold text-primary-text">Mostrar todos</Link></div>}
      <FormError message={cancel.error?.message ?? hold.error?.message ?? null} />
      {q.isLoading && <LoadingBlock />}
      {q.error && <ErrorState error={q.error} />}
      {q.data?.length === 0 && <EmptyState icon={<Receipt className="size-5" aria-hidden />} title="Nada por aqui" />}
      {q.data && q.data.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead><tr className="border-b border-border text-left text-xs text-muted"><th className="px-5 py-2 font-semibold">Vencimento</th><th className="px-3 py-2 font-semibold">Paciente</th><th className="px-3 py-2 font-semibold">Descrição</th><th className="px-3 py-2 text-right font-semibold">Valor</th><th className="px-3 py-2 text-right font-semibold">Saldo</th><th className="px-3 py-2 font-semibold">Situação</th><th className="px-3 py-2" /></tr></thead>
            <tbody>
              {q.data.map((r) => (
                <tr key={r.id} className="border-b border-border align-top last:border-0">
                  <td className="px-5 py-2.5 tabular-nums">{fmtCivilDate(r.dueDate)}</td>
                  <td className="px-3 py-2.5">{r.patientId ? <Link href={`/app/pacientes/${r.patientId}`} className="hover:underline">{r.patientName}</Link> : '—'}</td>
                  <td className="px-3 py-2.5">{r.description}{r.collectionHold && <span className="mt-1 block"><Badge tone="warning" icon={<PauseCircle className="size-3" aria-hidden />}>Cobrança suspensa{r.collectionHoldReason ? `: ${r.collectionHoldReason}` : ''}</Badge></span>}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{fmtMoney(r.amount)}</td>
                  <td className="px-3 py-2.5 text-right font-semibold tabular-nums">{fmtMoney(r.balance)}</td>
                  <td className="px-3 py-2.5"><Badge tone={VIEW[r.view].tone}>{VIEW[r.view].label}</Badge></td>
                  <td className="px-3 py-2.5 text-right">
                    {can('finance.write') && r.status === 'open' && (
                      <span className="flex justify-end gap-1">
                        {r.patientId && <Button size="sm" variant="ghost" onClick={() => setPaying({ id: r.patientId!, name: r.patientName ?? '' })}>Receber</Button>}
                        <Button size="sm" variant="ghost" onClick={() => (r.collectionHold ? hold.mutate({ id: r.id, h: false }) : (() => { const reason = window.prompt('Motivo da suspensão (contestação, acordo…)'); if (reason) hold.mutate({ id: r.id, h: true, reason }); })())}>{r.collectionHold ? 'Retomar cobrança' : 'Suspender cobrança'}</Button>
                        {r.paid === '0.00' && <Button size="sm" variant="ghost" className="text-danger" onClick={() => { const reason = window.prompt('Motivo do cancelamento'); if (reason) cancel.mutate({ id: r.id, reason }); }}>Cancelar</Button>}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <NewReceivable open={creating} onClose={() => setCreating(false)} initialPatient={selectedPatient} />
      <PaymentDialog open={paying !== undefined} onClose={() => setPaying(undefined)} patient={paying ?? undefined} />
    </Card>
  );
}

function PaymentsTab() {
  const { orgId, can, unit } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const { from, to, picker } = usePeriod();
  const q = useFinance<Payment[]>('payments', `/payments?from=${from}&to=${to}`);
  const [refunding, setRefunding] = useState<Payment | null>(null);
  const [rf, setRf] = useState({ amount: '', reason: '' });
  const [error, setError] = useState<string | null>(null);
  const tz = unit?.timezone ?? 'America/Sao_Paulo';
  const request = useMutation({
    mutationFn: () => api.post(`/orgs/${orgId}/finance/payments/${refunding!.id}/refunds`, { amount: money(rf.amount), reason: rf.reason }),
    onSuccess: async () => { toast({ tone: 'success', title: 'Estorno solicitado', description: 'Aguarda aprovação de outra pessoa.' }); setRefunding(null); await qc.invalidateQueries({ queryKey: ['org', orgId] }); },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Erro'),
  });
  return (
    <Card>
      <div className="flex justify-end border-b border-border px-4 py-3">{picker}</div>
      {q.isLoading && <LoadingBlock />}
      {q.data?.length === 0 && <p className="px-5 py-4 text-sm text-muted">Nenhum recebimento no período.</p>}
      <ul className="divide-y divide-border">
        {q.data?.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
            <div className="flex-1">
              <p className="font-semibold">{fmtMoney(p.amount)} · {METHOD_LABEL[p.method] ?? p.method} {p.reconciledAt && <Badge tone="accent" icon={<CheckCircle2 className="size-3" aria-hidden />}>Conciliado</Badge>}</p>
              <p className="text-xs text-muted">{p.patientName ?? 'Sem paciente'} · {fmtDateTime(p.receivedAt, tz)} · por {p.createdByName}{p.refunded !== '0.00' ? ` · estornado ${fmtMoney(p.refunded)}` : ''}{p.refundPending !== '0.00' ? ` · estorno pendente ${fmtMoney(p.refundPending)}` : ''}</p>
            </div>
            {can('finance.write') && <Button size="sm" variant="ghost" onClick={() => { setRefunding(p); setRf({ amount: '', reason: '' }); setError(null); }}>Solicitar estorno</Button>}
          </li>
        ))}
      </ul>
      <Dialog open={!!refunding} onClose={() => setRefunding(null)} title="Solicitar estorno" description="O estorno só vale depois de aprovado por outra pessoa com permissão." footer={<><Button variant="ghost" onClick={() => setRefunding(null)}>Cancelar</Button><Button loading={request.isPending} onClick={() => request.mutate()}>Solicitar</Button></>}>
        <div className="space-y-3"><FormError message={error} /><Field label="Valor (R$)" required>{(p) => <Input {...p} inputMode="decimal" value={rf.amount} onChange={(e) => setRf({ ...rf, amount: e.target.value })} />}</Field><Field label="Motivo" required>{(p) => <Textarea {...p} rows={2} value={rf.reason} onChange={(e) => setRf({ ...rf, reason: e.target.value })} />}</Field></div>
      </Dialog>
    </Card>
  );
}

interface PayableRow { id: string; unitId: string; description: string; supplierName: string | null; amount: string; dueDate: string; status: string; paidAt: string | null; categoryName: string | null }

function PayablesTab() {
  const { orgId, can, unit } = useOrg();
  const qc = useQueryClient();
  const [status, setStatus] = useState('open');
  const q = useFinance<PayableRow[]>('payables', `/payables?status=${status}`);
  const accounts = useFinance<CashAccount[]>('accounts', '/accounts');
  const cats = useFinance<FinanceCategory[]>('categories', '/categories');
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ description: '', supplierName: '', amount: '', dueDate: todayInTz(unit?.timezone ?? 'America/Sao_Paulo'), repeatMonths: 1, categoryId: '' });
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['org', orgId] });
  const create = useMutation({ mutationFn: () => api.post(`/orgs/${orgId}/finance/payables`, { ...f, amount: money(f.amount), unitId: unit?.id, categoryId: f.categoryId || undefined, supplierName: f.supplierName || undefined }), onSuccess: async () => { setOpen(false); await refresh(); }, onError: (e) => setError(e instanceof ApiError ? e.message : 'Erro') });
  const pay = useMutation({ mutationFn: (id: string) => api.post(`/orgs/${orgId}/finance/payables/${id}/pay`, { cashAccountId: accounts.data?.[0]?.id, paidAt: new Date().toISOString() }), onSuccess: refresh });
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        {[['open', 'Em aberto'], ['overdue', 'Vencidas'], ['paid', 'Pagas']].map(([k, l]) => <Button key={k} size="sm" variant={status === k ? 'soft' : 'ghost'} onClick={() => setStatus(k!)}>{l}</Button>)}
        {can('finance.write') && <Button size="sm" className="ml-auto" icon={<Plus className="size-4" aria-hidden />} onClick={() => setOpen(true)}>Nova despesa</Button>}
      </div>
      {q.data?.length === 0 && <p className="px-5 py-4 text-sm text-muted">Nada por aqui.</p>}
      <ul className="divide-y divide-border">
        {q.data?.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
            <div className="flex-1"><p className="font-semibold">{p.description}{p.supplierName ? ` · ${p.supplierName}` : ''}</p><p className="text-xs text-muted">Vence {fmtCivilDate(p.dueDate)}{p.categoryName ? ` · ${p.categoryName}` : ''}</p></div>
            <span className="font-semibold tabular-nums">{fmtMoney(p.amount)}</span>
            {p.status === 'open' && can('finance.write') && <Button size="sm" variant="secondary" loading={pay.isPending && pay.variables === p.id} onClick={() => pay.mutate(p.id)}>Marcar como paga</Button>}
          </li>
        ))}
      </ul>
      <Dialog open={open} onClose={() => setOpen(false)} title="Nova despesa" footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancelar</Button><Button loading={create.isPending} onClick={() => create.mutate()}>Criar</Button></>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2"><FormError message={error} /></div>
          <Field label="Descrição" required>{(p) => <Input {...p} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</Field>
          <Field label="Fornecedor">{(p) => <Input {...p} value={f.supplierName} onChange={(e) => setF({ ...f, supplierName: e.target.value })} />}</Field>
          <Field label="Valor (R$)" required>{(p) => <Input {...p} inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />}</Field>
          <Field label="Vencimento" required>{(p) => <Input {...p} type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />}</Field>
          <Field label="Repetir por (meses)" hint="1 = não repete.">{(p) => <Input {...p} type="number" min={1} max={36} value={f.repeatMonths} onChange={(e) => setF({ ...f, repeatMonths: Number(e.target.value) })} />}</Field>
          <Field label="Categoria">{(p) => <Select {...p} value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}><option value="">—</option>{cats.data?.filter((c) => c.kind === 'expense').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}</Field>
        </div>
      </Dialog>
    </Card>
  );
}

function RefundsTab() {
  const { orgId, can, me, membership, unit } = useOrg();
  const qc = useQueryClient();
  const q = useFinance<{ id: string; amount: string; reason: string; status: string; createdAt: string; requestedBy: string; requestedByName: string; patientName: string | null }[]>('refunds', '/refunds');
  const decide = useMutation({ mutationFn: ({ id, approve }: { id: string; approve: boolean }) => api.post(`/orgs/${orgId}/finance/refunds/${id}/decision`, { approve }), onSuccess: () => qc.invalidateQueries({ queryKey: ['org', orgId] }) });
  const tz = unit?.timezone ?? 'America/Sao_Paulo';
  return (
    <Card>
      <CardHeader title="Estornos" description="Quem solicita não aprova (exceto o proprietário). Estorno aprovado reabre o saldo da parcela." />
      {q.data?.length === 0 && <p className="px-5 py-4 text-sm text-muted">Nenhum estorno.</p>}
      <ul className="divide-y divide-border">
        {q.data?.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
            <div className="flex-1"><p className="font-semibold">{fmtMoney(r.amount)} · {r.patientName ?? '—'}</p><p className="text-xs text-muted">{r.reason} · pedido por {r.requestedByName} em {fmtDateTime(r.createdAt, tz)}</p></div>
            {r.status === 'requested' ? (
              can('finance.approve') && (r.requestedBy !== me.user.id || membership.role.key === 'owner') ? (
                <span className="flex gap-1"><Button size="sm" onClick={() => decide.mutate({ id: r.id, approve: true })}>Aprovar</Button><Button size="sm" variant="ghost" onClick={() => decide.mutate({ id: r.id, approve: false })}>Recusar</Button></span>
              ) : <Badge tone="warning">Aguardando aprovação</Badge>
            ) : <Badge tone={r.status === 'approved' ? 'accent' : 'neutral'}>{r.status === 'approved' ? 'Aprovado' : 'Recusado'}</Badge>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

interface Line { id: string; date: string; description: string; amount: string; status: string; suggestions: { kind: 'payment' | 'payable'; id: string; label: string }[] }

function ReconciliationTab() {
  const { orgId, can } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const accounts = useFinance<CashAccount[]>('accounts', '/accounts');
  const [accountId, setAccountId] = useState('');
  const [onlyPending, setOnlyPending] = useState(true);
  const acc = accountId || accounts.data?.[0]?.id || '';
  const q = useFinance<{ lines: Line[]; pendingCount: number }>('reconciliation', `/accounts/${acc}/reconciliation`, !!acc);
  const [csv, setCsv] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['org', orgId] });
  const imp = useMutation({
    mutationFn: () => api.post<{ read: number; inserted: number; duplicates: number; errors: { line: number }[] }>(`/orgs/${orgId}/finance/accounts/${acc}/statement`, { csv }),
    onSuccess: async (r) => { toast({ tone: 'success', title: `${r.inserted} linha(s) importada(s)`, description: `${r.duplicates} já existiam · ${r.errors.length} com erro de formato` }); setCsv(''); await refresh(); },
    onError: (e) => toast({ tone: 'error', title: 'Falha na importação', description: e instanceof ApiError ? e.message : undefined }),
  });
  const match = useMutation({ mutationFn: ({ lineId, kind, id }: { lineId: string; kind: string; id?: string }) => api.post(`/orgs/${orgId}/finance/statement-lines/${lineId}/match`, { kind, id }), onSuccess: refresh });
  async function readFile(file: File) {
    setCsv(await file.text());
  }
  return (
    <div className="space-y-5">
      <Card className="p-5">
        <div className="flex flex-wrap items-center gap-3">
          <Select aria-label="Conta" className="!w-64" value={acc} onChange={(e) => setAccountId(e.target.value)}>{accounts.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>
          {q.data && <Badge tone={q.data.pendingCount ? 'warning' : 'accent'}>{q.data.pendingCount} pendente(s)</Badge>}
        </div>
        {can('finance.write') && (
          <div className="mt-4 space-y-2">
            <p className="text-sm font-semibold">Importar extrato (CSV)</p>
            <p className="text-xs text-muted">Formato: <code>data;descrição;valor</code> — ex.: <code>12/03/2030;PIX RECEBIDO;200,00</code>. Saídas com valor negativo. Reimportar o mesmo arquivo não duplica linhas.</p>
            <input type="file" accept=".csv,text/csv,text/plain" aria-label="Arquivo CSV do extrato" onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])} className="block text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-primary-soft file:px-3 file:py-2 file:font-semibold file:text-primary-text" />
            <Textarea aria-label="Conteúdo do CSV" rows={3} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder="Ou cole as linhas aqui" />
            <Button size="sm" icon={<Upload className="size-4" aria-hidden />} disabled={csv.trim().length < 5} loading={imp.isPending} onClick={() => imp.mutate()}>Importar</Button>
          </div>
        )}
      </Card>
      <Card>
        <CardHeader title="Conferência do extrato" actions={<Button variant="secondary" size="sm" onClick={() => setOnlyPending(!onlyPending)}>{onlyPending ? 'Mostrar todas' : 'Somente pendências'}</Button>} />
        {q.isLoading && acc && <LoadingBlock />}
        {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
        {accounts.error && <ErrorState error={accounts.error} />}
        <FormError message={match.error?.message ?? null} />
        {q.data && onlyPending && !q.data.pendingCount && <p className="p-5 text-sm text-muted">Tudo conferido nesta conta. Não há pendências.</p>}
        <ul className="divide-y divide-border">
          {q.data?.lines.filter((l) => !onlyPending || l.status === 'unmatched').map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
              <span className="w-24 tabular-nums">{fmtCivilDate(l.date)}</span>
              <span className="min-w-0 flex-1 truncate">{l.description}</span>
              <span className={`w-28 text-right font-semibold tabular-nums ${Number(l.amount) < 0 ? 'text-danger' : ''}`}>{fmtMoney(l.amount)}</span>
              {l.status === 'unmatched' ? (can('finance.write') ? (
                <span className="flex flex-wrap gap-1">
                  {l.suggestions.map((s) => <Button key={s.id} size="sm" variant="soft" disabled={match.isPending} onClick={() => match.mutate({ lineId: l.id, kind: s.kind, id: s.id })}>Vincular: {s.label}</Button>)}
                  {!l.suggestions.length && <span className="text-xs text-muted">Sem correspondência automática</span>}
                  <Button size="sm" variant="ghost" onClick={() => match.mutate({ lineId: l.id, kind: 'ignore' })}>Ignorar</Button>
                </span>
              ) : <Badge tone="warning">Pendente de conciliação</Badge>) : <Badge tone={l.status === 'matched' ? 'accent' : 'neutral'}>{l.status === 'matched' ? 'Conciliada' : 'Ignorada'}</Badge>}
            </li>
          ))}
          {q.data?.lines.length === 0 && <li className="px-5 py-4 text-sm text-muted">Nenhuma linha importada para esta conta.</li>}
        </ul>
      </Card>
    </div>
  );
}

function DelinquencyTab() {
  const q = useFinance<{ patientId: string | null; patientName: string | null; balance: string; daysOverdue: number; onHold: boolean; items: Receivable[] }[]>('delinquency', '/delinquency');
  return (
    <Card>
      <CardHeader icon={<AlertTriangle className="size-5" aria-hidden />} title="Inadimplência" description="Pacientes com parcelas vencidas e saldo em aberto. Use o histórico de contato e as automações com cobrança respeitosa — nunca exponha dívidas a terceiros." />
      {q.data?.length === 0 && <p className="px-5 py-4 text-sm text-muted">Nenhuma parcela vencida.</p>}
      <ul className="divide-y divide-border">
        {q.data?.map((d) => (
          <li key={d.patientId ?? 'none'} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
            <div className="flex-1">{d.patientId ? <Link href={`/app/pacientes/${d.patientId}`} className="font-semibold hover:underline">{d.patientName}</Link> : <span className="font-semibold">Sem paciente</span>}<p className="text-xs text-muted">{d.items.length} parcela(s) · mais antiga há {d.daysOverdue} dia(s){d.onHold ? ' · com cobrança suspensa' : ''}</p></div>
            <span className="font-bold tabular-nums text-danger">{fmtMoney(d.balance)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function CommissionsTab() {
  const { orgId, can } = useOrg();
  const qc = useQueryClient();
  const { from, to, picker } = usePeriod();
  const q = useFinance<{ professionalId: string | null; name: string; received: string; commissionPercent: string | null; commission: string | null }[]>('by-prof', `/reports/professionals?from=${from}&to=${to}`);
  const proc = useFinance<{ name: string; count: number; recognized: string }[]>('by-proc', `/reports/procedures?from=${from}&to=${to}`);
  const profs = useProfessionals();
  const [rule, setRule] = useState({ professionalId: '', percent: '' });
  const save = useMutation({ mutationFn: () => api.post(`/orgs/${orgId}/finance/commissions`, { ...rule, percent: rule.percent.replace(',', '.') }), onSuccess: async () => { setRule({ professionalId: '', percent: '' }); await qc.invalidateQueries({ queryKey: ['org', orgId] }); } });
  return (
    <div className="space-y-5">
      <div className="flex justify-end">{picker}</div>
      <Card>
        <CardHeader title="Recebido e repasse por profissional" description="Base: valores efetivamente recebidos no período, líquidos de estornos, vinculados ao profissional da cobrança." />
        <table className="w-full text-sm tabular-nums">
          <thead><tr className="border-b border-border text-left text-xs text-muted"><th className="px-5 py-2">Profissional</th><th className="px-3 py-2 text-right">Recebido</th><th className="px-3 py-2 text-right">%</th><th className="px-3 py-2 text-right">Repasse</th></tr></thead>
          <tbody>{q.data?.map((r) => <tr key={r.professionalId ?? 'none'} className="border-b border-border last:border-0"><td className="px-5 py-2">{r.name}</td><td className="px-3 py-2 text-right">{fmtMoney(r.received)}</td><td className="px-3 py-2 text-right">{r.commissionPercent ? `${r.commissionPercent}%` : '—'}</td><td className="px-3 py-2 text-right font-semibold">{r.commission ? fmtMoney(r.commission) : 'sem regra'}</td></tr>)}</tbody>
        </table>
        {can('finance.approve') && (
          <div className="flex flex-wrap items-end gap-2 border-t border-border p-4">
            <Field label="Profissional">{(p) => <Select {...p} className="!w-56" value={rule.professionalId} onChange={(e) => setRule({ ...rule, professionalId: e.target.value })}><option value="">Selecione…</option>{profs.data?.map((x) => <option key={x.id} value={x.id}>{x.displayName}</option>)}</Select>}</Field>
            <Field label="% de repasse">{(p) => <Input {...p} className="!w-24" inputMode="decimal" value={rule.percent} onChange={(e) => setRule({ ...rule, percent: e.target.value })} />}</Field>
            <Button loading={save.isPending} disabled={!rule.professionalId || !rule.percent} onClick={() => save.mutate()}>Definir regra</Button>
          </div>
        )}
      </Card>
      <Card>
        <CardHeader title="Reconhecido por procedimento" description="Etapas de tratamento realizadas no período, pelo preço da etapa." />
        <table className="w-full text-sm tabular-nums">
          <tbody>{proc.data?.map((r) => <tr key={r.name} className="border-b border-border last:border-0"><td className="px-5 py-2">{r.name}</td><td className="px-3 py-2 text-right">{r.count}</td><td className="px-3 py-2 text-right font-semibold">{fmtMoney(r.recognized)}</td></tr>)}</tbody>
        </table>
        {proc.data?.length === 0 && <p className="px-5 py-4 text-sm text-muted">Sem etapas realizadas no período.</p>}
      </Card>
    </div>
  );
}

function ConfigTab() {
  const { orgId, can, membership } = useOrg();
  const qc = useQueryClient();
  const accounts = useFinance<CashAccount[]>('accounts', '/accounts');
  const cats = useFinance<FinanceCategory[]>('categories', '/categories');
  const [acc, setAcc] = useState({ name: '', kind: 'bank', unitId: membership.units[0]?.id ?? '' });
  const [cat, setCat] = useState({ name: '', kind: 'expense' });
  const refresh = () => qc.invalidateQueries({ queryKey: ['org', orgId] });
  const addAcc = useMutation({ mutationFn: () => api.post(`/orgs/${orgId}/finance/accounts`, acc), onSuccess: refresh });
  const addCat = useMutation({ mutationFn: () => api.post(`/orgs/${orgId}/finance/categories`, cat), onSuccess: refresh });
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader title="Contas e caixas por unidade" description="Saldo = recebimentos − estornos aprovados − despesas pagas." />
        <ul className="divide-y divide-border">{accounts.data?.map((a) => <li key={a.id} className="flex items-center gap-3 px-5 py-3 text-sm"><span className="flex-1"><span className="font-semibold">{a.name}</span><span className="block text-xs text-muted">{a.unitName} · {a.kind === 'cash' ? 'Caixa' : a.kind === 'bank' ? 'Conta bancária' : 'Adquirente de cartão'}</span></span><span className="font-semibold tabular-nums">{fmtMoney(a.balance)}</span></li>)}</ul>
        {can('finance.approve') && (
          <div className="flex flex-wrap items-end gap-2 border-t border-border p-4">
            <Input aria-label="Nome da conta" className="!w-48" value={acc.name} onChange={(e) => setAcc({ ...acc, name: e.target.value })} placeholder="Ex.: Banco X" />
            <Select aria-label="Tipo" className="!w-40" value={acc.kind} onChange={(e) => setAcc({ ...acc, kind: e.target.value })}><option value="bank">Conta bancária</option><option value="cash">Caixa</option><option value="card_acquirer">Adquirente</option></Select>
            <Select aria-label="Unidade" className="!w-40" value={acc.unitId} onChange={(e) => setAcc({ ...acc, unitId: e.target.value })}>{membership.units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>
            <Button size="sm" disabled={acc.name.length < 2} onClick={() => addAcc.mutate()}>Adicionar</Button>
          </div>
        )}
      </Card>
      <Card>
        <CardHeader title="Categorias" />
        <ul className="divide-y divide-border">{cats.data?.map((c) => <li key={c.id} className="flex justify-between px-5 py-2 text-sm"><span>{c.name}</span><Badge tone={c.kind === 'income' ? 'accent' : 'neutral'}>{c.kind === 'income' ? 'Receita' : 'Despesa'}</Badge></li>)}</ul>
        {can('finance.approve') && (
          <div className="flex flex-wrap gap-2 border-t border-border p-4">
            <Input aria-label="Nome da categoria" className="!w-48" value={cat.name} onChange={(e) => setCat({ ...cat, name: e.target.value })} />
            <Select aria-label="Tipo" className="!w-32" value={cat.kind} onChange={(e) => setCat({ ...cat, kind: e.target.value })}><option value="expense">Despesa</option><option value="income">Receita</option></Select>
            <Button size="sm" disabled={cat.name.length < 2} onClick={() => addCat.mutate()}>Adicionar</Button>
          </div>
        )}
      </Card>
    </div>
  );
}

function FinanceInner() {
  const { can } = useOrg();
  const params = useSearchParams();
  const router = useRouter();
  const tab = (TABS.find((t) => t.key === params.get('aba'))?.key ?? 'resumo') as Tab;
  if (!can('finance.read')) return <ErrorState error={new ApiError(403, 'forbidden', '')} />;
  const content: Record<Tab, ReactNode> = {
    resumo: <Summary />,
    receber: <ReceivablesTab />,
    recebimentos: <PaymentsTab />,
    pagar: <PayablesTab />,
    estornos: <RefundsTab />,
    conciliacao: <ReconciliationTab />,
    inadimplencia: <DelinquencyTab />,
    repasses: <CommissionsTab />,
    config: <ConfigTab />,
  };
  return (
    <>
      <PageHeader title="Financeiro" description="Cobranças e recebimentos dos pacientes da clínica. A assinatura do Oralis fica separada, em Assinatura." />
      <div role="tablist" aria-label="Seções do financeiro" className="mb-5 flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((t) => (
          <button key={t.key} role="tab" type="button" aria-selected={tab === t.key} onClick={() => router.replace(`/app/financeiro?aba=${t.key}`)} className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-semibold ${tab === t.key ? 'border-primary text-primary-text' : 'border-transparent text-muted hover:text-fg'}`}>{t.label}</button>
        ))}
      </div>
      <div role="tabpanel">{content[tab]}</div>
    </>
  );
}

export default function FinancePage() {
  return (
    <Suspense>
      <FinanceInner />
    </Suspense>
  );
}
