'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, CreditCard, Download, ExternalLink, History, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Button, ButtonLink } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Badge, Card, CardHeader, ErrorState, LoadingBlock, Notice, PageHeader } from '@/components/ui/feedback';
import { Checkbox, FormError, Select, Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';
import { fmtDateTime, fmtMoney } from '@/lib/format';
import { meQueryKey, useOrg } from '@/lib/session';

interface Overview {
  subscription: { status: 'trial' | 'active' | 'past_due' | 'suspended' | 'cancelled'; statusReason: string | null; interval: 'monthly' | 'annual'; trialEndsAt: string | null; currentPeriodEnd: string | null; graceUntil: string | null; cancelAtPeriodEnd: boolean; readOnlyUntil: string | null; provider: string; pendingCheckout: boolean };
  plan: { key: string; name: string; price: string | null; limits: { units: number | null; users: number | null; storageMb: number }; features: { key: string; label: string }[] };
  usage: { units: number; users: number; storageMb: number };
  access: { level: 'full' | 'read_only'; reason: string };
  invoices: { id: string; amount: string; status: string; paidAt: string | null; createdAt: string; hostedUrl: string | null }[];
  history: { id: string; kind: string; createdAt: string; source: string; actorName: string | null; toState: Record<string, unknown> | null }[];
  providerConfigured: boolean;
  policy: { text: string; graceDays: number; readOnlyDays: number };
  termsVersion: string;
}
interface PublicPlan { key: string; name: string; description: string; priceMonthly: string | null; priceAnnual: string | null; maxUnits: number | null; maxUsers: number | null; storageMb: number; features: { key: string; label: string }[]; purchasable: boolean }
interface Preview { current: { name: string }; next: { name: string; price: string | null }; featuresGained: string[]; featuresLost: string[]; exceeding: { kind: string; usage: number; limit: number; action: string }[]; effective: string; dataNotice: string }

const STATUS: Record<Overview['subscription']['status'], { label: string; tone: 'accent' | 'info' | 'warning' | 'danger' | 'neutral' }> = {
  trial: { label: 'Em avaliação', tone: 'info' },
  active: { label: 'Ativa', tone: 'accent' },
  past_due: { label: 'Pagamento pendente', tone: 'warning' },
  suspended: { label: 'Suspensa (somente leitura)', tone: 'danger' },
  cancelled: { label: 'Cancelada', tone: 'neutral' },
};
const HISTORY: Record<string, string> = { trial_started: 'Avaliação iniciada', checkout_started: 'Contratação iniciada', plan_changed: 'Plano alterado', provider_update: 'Atualização do provedor', payment_failed: 'Falha de pagamento', regularized: 'Pagamento regularizado', suspended: 'Suspensa', cancelled: 'Cancelada' };

function Meter({ label, used, limit, unit = '' }: { label: string; used: number; limit: number | null; unit?: string }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div>
      <div className="flex justify-between text-sm"><span>{label}</span><span className="tabular-nums text-muted">{used}{unit} de {limit === null ? 'ilimitado' : `${limit}${unit}`}</span></div>
      {limit !== null && (
        <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
          <div className={`h-full rounded-full ${pct >= 100 ? 'bg-danger' : pct >= 80 ? 'bg-warning' : 'bg-primary'}`} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

function SubscriptionInner() {
  const { orgId, can } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const params = useSearchParams();
  const returned = params.get('retorno');
  const q = useQuery({ queryKey: ['org', orgId, 'billing'], queryFn: () => api.get<Overview>(`/orgs/${orgId}/billing`), refetchInterval: (query) => (returned === 'sucesso' && query.state.data?.subscription.pendingCheckout ? 3000 : false) });
  const plans = useQuery({ queryKey: ['public-plans'], queryFn: () => api.get<PublicPlan[]>('/public/plans') });
  const [target, setTarget] = useState<{ planKey: string; interval: 'monthly' | 'annual' } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [accept, setAccept] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const manage = can('billing.manage');
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['org', orgId] });
    await qc.invalidateQueries({ queryKey: meQueryKey });
  };

  useEffect(() => {
    if (!target) return;
    setPreview(null);
    setError(null);
    setAccept(false);
    api.post<Preview>(`/orgs/${orgId}/billing/change/preview`, target).then(setPreview, (e) => setError(e instanceof ApiError ? e.message : 'Erro'));
  }, [target, orgId]);

  const change = useMutation({ mutationFn: () => api.post(`/orgs/${orgId}/billing/change`, target), onSuccess: async () => { toast({ tone: 'success', title: 'Plano alterado' }); setTarget(null); await refresh(); }, onError: (e) => setError(e instanceof ApiError ? e.message : 'Erro') });
  const checkout = useMutation({ mutationFn: () => api.post<{ url: string }>(`/orgs/${orgId}/billing/checkout`, { ...target, acceptTerms: true }), onSuccess: (r) => { window.location.href = r.url; }, onError: (e) => setError(e instanceof ApiError ? e.message : 'Erro') });
  const cancel = useMutation({ mutationFn: () => api.post(`/orgs/${orgId}/billing/cancel`, { reason: reason || undefined }), onSuccess: async () => { toast({ tone: 'success', title: 'Cancelamento registrado' }); setCancelling(false); await refresh(); }, onError: (e) => setError(e instanceof ApiError ? e.message : 'Erro') });
  const resume = useMutation({ mutationFn: () => api.post(`/orgs/${orgId}/billing/resume`), onSuccess: refresh });
  const portal = useMutation({ mutationFn: () => api.post<{ url: string }>(`/orgs/${orgId}/billing/portal`), onSuccess: (r) => { window.location.href = r.url; } });

  if (q.isLoading) return <Card><LoadingBlock rows={5} /></Card>;
  if (q.error || !q.data) return <Card><ErrorState error={q.error} /></Card>;
  const b = q.data;
  const s = b.subscription;
  const tz = 'America/Sao_Paulo';
  const paidFlow = !!s.provider && s.provider !== 'none' && ['active', 'past_due'].includes(s.status);
  const endDate = s.status === 'trial' ? s.trialEndsAt : s.currentPeriodEnd;

  return (
    <>
      <PageHeader title="Assinatura" description="Contrato da clínica com o Oralis. Separado das cobranças dos seus pacientes." />
      {returned === 'sucesso' && (s.pendingCheckout ? (
        <div className="mb-4"><Notice tone="info" icon={<Loader2 className="size-5 animate-spin" aria-hidden />} title="Aguardando confirmação do provedor de pagamento">A assinatura só muda quando o provedor confirma o pagamento. Esta página atualiza sozinha.</Notice></div>
      ) : (
        <div className="mb-4"><Notice tone="accent" icon={<CheckCircle2 className="size-5" aria-hidden />} title="Retorno do pagamento recebido">Confira abaixo o estado confirmado da assinatura.</Notice></div>
      ))}
      {returned === 'cancelado' && <div className="mb-4"><Notice tone="warning">A contratação foi interrompida antes do pagamento. Você pode retomar quando quiser.</Notice></div>}
      {b.access.level === 'read_only' && <div className="mb-4"><Notice tone="danger" icon={<AlertTriangle className="size-5" aria-hidden />} title="Clínica em modo somente leitura">{b.access.reason} Os dados continuam disponíveis para consulta e <Link href="/app/exportacoes" className="underline">exportação</Link>.</Notice></div>}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-5">
          <Card className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm text-muted">Plano atual</p>
                <p className="text-2xl font-extrabold">{b.plan.name}</p>
                <p className="mt-1 text-sm text-muted">{b.plan.price ? `${fmtMoney(b.plan.price)} / ${s.interval === 'annual' ? 'ano' : 'mês'}` : 'Preço ainda não publicado'}</p>
              </div>
              <Badge tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Badge>
            </div>
            <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
              {s.status === 'trial' && s.trialEndsAt && <div><dt className="text-muted">Avaliação até</dt><dd className="font-semibold">{fmtDateTime(s.trialEndsAt, tz)}</dd></div>}
              {s.currentPeriodEnd && s.status !== 'trial' && <div><dt className="text-muted">{s.cancelAtPeriodEnd ? 'Acesso até' : 'Próxima renovação'}</dt><dd className="font-semibold">{fmtDateTime(s.currentPeriodEnd, tz)}</dd></div>}
              {s.graceUntil && s.status === 'past_due' && <div><dt className="text-muted">Carência até</dt><dd className="font-semibold">{fmtDateTime(s.graceUntil, tz)}</dd></div>}
              {s.readOnlyUntil && <div><dt className="text-muted">Leitura e exportação garantidas até</dt><dd className="font-semibold">{fmtDateTime(s.readOnlyUntil, tz)}</dd></div>}
              {s.statusReason && <div className="sm:col-span-2"><dt className="text-muted">Motivo</dt><dd>{s.statusReason}</dd></div>}
            </dl>
            <div className="mt-5 flex flex-wrap gap-2">
              {manage && paidFlow && <Button variant="secondary" icon={<CreditCard className="size-4" aria-hidden />} loading={portal.isPending} onClick={() => portal.mutate()}>Forma de pagamento e faturas</Button>}
              {manage && s.cancelAtPeriodEnd && <Button variant="secondary" loading={resume.isPending} onClick={() => resume.mutate()}>Desfazer cancelamento</Button>}
              {manage && !s.cancelAtPeriodEnd && s.status !== 'cancelled' && <Button variant="ghost" className="text-danger" onClick={() => { setCancelling(true); setError(null); }}>Cancelar assinatura</Button>}
            </div>
          </Card>

          <Card className="p-5">
            <h2 className="mb-4 font-bold">Consumo</h2>
            <div className="space-y-4">
              <Meter label="Unidades" used={b.usage.units} limit={b.plan.limits.units} />
              <Meter label="Usuários (inclui convites pendentes)" used={b.usage.users} limit={b.plan.limits.users} />
              <Meter label="Armazenamento" used={b.usage.storageMb} limit={b.plan.limits.storageMb} unit=" MB" />
            </div>
          </Card>

          <Card>
            <CardHeader title="Planos" description={b.providerConfigured ? 'Valores e condições vêm do catálogo central.' : 'A contratação paga ainda não está disponível neste ambiente: o provedor de pagamento não está configurado.'} />
            <div className="grid gap-3 p-5 md:grid-cols-3">
              {plans.data?.map((p) => (
                <div key={p.key} className={`rounded-xl border p-4 ${p.key === b.plan.key ? 'border-primary bg-primary-soft/30' : 'border-border'}`}>
                  <p className="font-bold">{p.name}</p>
                  <p className="text-xs text-muted">{p.description}</p>
                  <p className="mt-2 text-sm font-semibold">{p.priceMonthly ? `${fmtMoney(p.priceMonthly)}/mês` : 'Preço em definição'}</p>
                  <p className="text-xs text-muted">{p.maxUnits ?? '∞'} unidade(s) · {p.maxUsers ?? '∞'} usuários · {Math.round(p.storageMb / 1024)} GB</p>
                  {manage && p.key !== b.plan.key && <Button size="sm" variant="secondary" className="mt-3" onClick={() => setTarget({ planKey: p.key, interval: s.interval })}>Ver mudança</Button>}
                  {manage && p.key === b.plan.key && s.status === 'trial' && p.purchasable && <Button size="sm" className="mt-3" onClick={() => setTarget({ planKey: p.key, interval: 'monthly' })}>Contratar</Button>}
                </div>
              ))}
            </div>
          </Card>
        </div>

        <aside className="space-y-5">
          <Card className="p-5">
            <h2 className="mb-2 font-bold">Política de inadimplência e saída</h2>
            <p className="text-sm text-muted">{b.policy.text}</p>
            <ButtonLink href="/app/exportacoes" variant="ghost" size="sm" className="mt-3" icon={<Download className="size-4" aria-hidden />}>Exportar dados</ButtonLink>
          </Card>
          <Card className="p-5">
            <h2 className="mb-2 font-bold">Faturas</h2>
            {!b.invoices.length && <p className="text-sm text-muted">Nenhuma fatura.</p>}
            <ul className="space-y-2 text-sm">{b.invoices.map((i) => <li key={i.id} className="flex items-center justify-between gap-2"><span>{fmtDateTime(i.paidAt ?? i.createdAt, tz)}</span><span className="tabular-nums">{fmtMoney(i.amount)}</span><Badge tone={i.status === 'paid' ? 'accent' : 'warning'}>{i.status === 'paid' ? 'Paga' : 'Em aberto'}</Badge>{i.hostedUrl && <a href={i.hostedUrl} target="_blank" rel="noreferrer" aria-label="Abrir fatura"><ExternalLink className="size-4" aria-hidden /></a>}</li>)}</ul>
          </Card>
          <Card className="p-5">
            <h2 className="mb-2 flex items-center gap-2 font-bold"><History className="size-4" aria-hidden /> Histórico</h2>
            <ol className="space-y-2 text-sm">{b.history.map((h) => <li key={h.id}><span className="font-semibold">{HISTORY[h.kind] ?? h.kind}</span><span className="block text-xs text-muted">{fmtDateTime(h.createdAt, tz)} · {h.actorName ?? (h.source === 'webhook' ? 'provedor de pagamento' : 'sistema')}</span></li>)}</ol>
          </Card>
        </aside>
      </div>

      <Dialog
        open={!!target}
        onClose={() => setTarget(null)}
        size="lg"
        title={preview ? `${preview.current.name} → ${preview.next.name}` : 'Mudança de plano'}
        footer={
          preview && (
            <>
              <Button variant="ghost" onClick={() => setTarget(null)}>Voltar</Button>
              {s.status === 'trial' && !paidFlow && target?.planKey === b.plan.key ? null : (
                <Button loading={change.isPending} disabled={preview.exceeding.length > 0} onClick={() => change.mutate()}>Confirmar troca</Button>
              )}
              {s.status === 'trial' && plans.data?.find((p) => p.key === target?.planKey)?.purchasable && (
                <Button loading={checkout.isPending} disabled={!accept || preview.exceeding.length > 0} onClick={() => checkout.mutate()}>Ir para pagamento</Button>
              )}
            </>
          )
        }
      >
        <FormError message={error} />
        {!preview && !error && <LoadingBlock rows={3} />}
        {preview && target && (
          <div className="space-y-4 text-sm">
            <div className="flex items-center gap-3">
              <span className="font-semibold">Periodicidade</span>
              <Select aria-label="Periodicidade" className="!w-40" value={target.interval} onChange={(e) => setTarget({ ...target, interval: e.target.value as 'monthly' | 'annual' })}><option value="monthly">Mensal</option><option value="annual">Anual</option></Select>
            </div>
            <p><span className="text-muted">Valor:</span> {preview.next.price ? fmtMoney(preview.next.price) : 'preço em definição'}</p>
            <p><span className="text-muted">Vigência:</span> {preview.effective}</p>
            {preview.featuresGained.length > 0 && <div><p className="font-semibold">Passa a incluir</p><ul className="list-disc pl-5">{preview.featuresGained.map((f) => <li key={f}>{f}</li>)}</ul></div>}
            {preview.featuresLost.length > 0 && <div><p className="font-semibold">Deixa de incluir</p><ul className="list-disc pl-5">{preview.featuresLost.map((f) => <li key={f}>{f}</li>)}</ul></div>}
            {preview.exceeding.length > 0 && (
              <Notice tone="warning" title="Adequação necessária antes da troca">
                <ul className="mt-1 space-y-1">{preview.exceeding.map((x) => <li key={x.kind}><strong>{x.usage}</strong> em uso para limite de <strong>{x.limit}</strong>. {x.action}</li>)}</ul>
              </Notice>
            )}
            <p className="text-muted">{preview.dataNotice}</p>
            {s.status === 'trial' && plans.data?.find((p) => p.key === target.planKey)?.purchasable && (
              <div className="space-y-2 rounded-xl border border-border p-3">
                <p>A cobrança é recorrente e renova automaticamente até o cancelamento. Cancelando, o acesso continua até o fim do período pago. Os dados do cartão ficam com o provedor de pagamento, nunca no Oralis.</p>
                <Checkbox label={`Li e aceito os termos de contratação (versão ${b.termsVersion}, preliminar)`} description="Comunicações de marketing não fazem parte deste aceite." checked={accept} onChange={(e) => setAccept(e.target.checked)} />
                <Link href="/termos" target="_blank" className="text-xs underline">Ler os termos</Link>
              </div>
            )}
          </div>
        )}
      </Dialog>

      <Dialog
        open={cancelling}
        onClose={() => setCancelling(false)}
        title="Cancelar assinatura"
        footer={<><Button variant="ghost" onClick={() => setCancelling(false)}>Manter assinatura</Button><Button variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate()}>Confirmar cancelamento</Button></>}
      >
        <div className="space-y-3 text-sm">
          <FormError message={error} />
          <p><strong>Acesso completo até:</strong> {endDate ? fmtDateTime(endDate, tz) : 'agora (sem período pago)'}.</p>
          <p><strong>Cobrança:</strong> {paidFlow ? 'não haverá novas cobranças após o fim do período atual.' : 'não há cobrança em andamento.'}</p>
          <p><strong>Depois disso:</strong> leitura e exportação por pelo menos {b.policy.readOnlyDays} dias. Registros clínicos não são apagados automaticamente; a exclusão segue a política de retenção e prazos legais.</p>
          <p><strong>Integrações:</strong> lembretes e automações deixam de ser enviados quando o acesso terminar.</p>
          <ButtonLink href="/app/exportacoes" variant="secondary" size="sm" icon={<Download className="size-4" aria-hidden />}>Exportar dados antes</ButtonLink>
          <label htmlFor="cancel-reason" className="block font-semibold">Quer contar o motivo? (opcional)</label>
          <Textarea id="cancel-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      </Dialog>
    </>
  );
}

export default function SubscriptionPage() {
  return (
    <Suspense>
      <SubscriptionInner />
    </Suspense>
  );
}
