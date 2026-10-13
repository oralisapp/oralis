'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ClipboardList } from 'lucide-react';
import { useState } from 'react';
import { usePortal } from '@/components/portal-context';
import { Button } from '@/components/ui/button';
import { Badge, Card, EmptyState, LoadingBlock, Notice } from '@/components/ui/feedback';
import { Checkbox, Field, FormError, Input } from '@/components/ui/field';
import { ApiError, api } from '@/lib/api';
import { fmtCivilDate, fmtMoney } from '@/lib/format';
import { type PortalPlan, usePortalPlans } from '@/lib/portal';

function Approve({ plan }: { plan: PortalPlan }) {
  const me = usePortal();
  const qc = useQueryClient();
  const [name, setName] = useState(me.patient.fullName);
  const [accept, setAccept] = useState(false);
  const q = plan.quote!;
  const approve = useMutation({ mutationFn: () => api.post(`/portal/quotes/${q.id}/approve`, { versionId: q.versionId, acknowledgedName: name, accept: true }), onSuccess: () => qc.invalidateQueries({ queryKey: ['portal'] }) });
  return (
    <div className="mt-4 space-y-3 rounded-xl border border-border p-4">
      <FormError message={approve.error instanceof ApiError ? approve.error.message : null} />
      <p className="text-sm">Ao aprovar, a clínica agenda as etapas com você e registra as parcelas combinadas. A aprovação do orçamento não substitui os termos de consentimento, que serão apresentados antes dos procedimentos.</p>
      <Field label="Seu nome completo" required>{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <Checkbox label={`Li o plano e aprovo o orçamento (versão ${q.version}) no valor de ${fmtMoney(q.total)}`} checked={accept} onChange={(e) => setAccept(e.target.checked)} />
      <Button disabled={!accept || name.trim().length < 3} loading={approve.isPending} onClick={() => approve.mutate()}>Aprovar orçamento</Button>
    </div>
  );
}

export default function PortalPlans() {
  const q = usePortalPlans();
  if (q.isLoading) return <LoadingBlock rows={3} />;
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-extrabold">Seus tratamentos</h1>
      {q.data?.length === 0 && <Card><EmptyState icon={<ClipboardList className="size-5" aria-hidden />} title="Nenhum plano disponível" description="Quando a clínica compartilhar um plano de tratamento com você, ele aparecerá aqui." /></Card>}
      {q.data?.map((p) => {
        const stages = [...new Set(p.items.map((i) => i.stage))].sort((a, b) => a - b);
        const done = p.items.filter((i) => i.status === 'done').length;
        return (
          <Card key={p.id} className="p-5">
            <h2 className="text-lg font-bold">{p.title}</h2>
            {p.responsibleName && <p className="text-sm text-muted">Profissional: {p.responsibleName}</p>}
            {p.objective && <p className="mt-3 whitespace-pre-wrap text-[15px]">{p.objective}</p>}
            <p className="mt-3 text-sm font-semibold">{done} de {p.items.length} etapas realizadas</p>
            <ol className="mt-2 space-y-2">
              {stages.map((s) => (
                <li key={s} className="rounded-lg bg-surface-2 p-3 text-sm">
                  <p className="font-semibold">Etapa {s}</p>
                  <ul className="mt-1 space-y-0.5">{p.items.filter((i) => i.stage === s).map((i, k) => <li key={k} className="flex justify-between gap-3"><span>{i.description}{i.tooth ? ` (dente ${i.tooth})` : ''} {i.status === 'done' && <Badge tone="accent">realizado</Badge>}</span><span className="tabular-nums">{fmtMoney(i.unitPrice)}</span></li>)}</ul>
                </li>
              ))}
            </ol>
            {p.quote && (
              <div className="mt-4 text-sm">
                <p className="text-lg font-extrabold">Total: {fmtMoney(p.quote.total)}</p>
                <p className="text-muted">{p.quote.paymentTerms.installments}x · primeiro vencimento em {fmtCivilDate(p.quote.paymentTerms.firstDueDate)} · válido até {fmtCivilDate(p.quote.validUntil)}</p>
                {p.quote.status === 'presented' && <Approve plan={p} />}
                {p.quote.status === 'approved' && <div className="mt-3"><Notice tone="accent">Orçamento aprovado. A clínica vai combinar as datas com você.</Notice></div>}
                {p.quote.status === 'expired' && <div className="mt-3"><Notice tone="warning">Este orçamento venceu. Fale com a clínica para receber uma nova versão.</Notice></div>}
              </div>
            )}
            <p className="mt-4 text-xs text-subtle">Prazos e número de sessões são estimativas. Resultados de tratamento dependem de fatores individuais.</p>
          </Card>
        );
      })}
    </div>
  );
}
