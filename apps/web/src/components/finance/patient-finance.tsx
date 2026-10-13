'use client';

import { Banknote } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardHeader, LoadingBlock } from '@/components/ui/feedback';
import { fmtCivilDate, fmtDateTime, fmtMoney } from '@/lib/format';
import { type Payment, type Receivable, useFinance } from '@/lib/queries';
import { useOrg } from '@/lib/session';
import { METHOD_LABEL, PaymentDialog } from './payment-dialog';

/** Aba Financeiro da ficha: cobranças, recebimentos e saldo — visível só para quem tem permissão financeira. */
export function PatientFinance({ patient }: { patient: { id: string; name: string } }) {
  const { can, unit } = useOrg();
  const q = useFinance<{ receivables: Receivable[]; payments: Payment[]; balance: string }>('patient-statement', `/patients/${patient.id}/statement`);
  const [paying, setPaying] = useState(false);
  const tz = unit?.timezone ?? 'America/Sao_Paulo';
  if (q.isLoading) return <Card><LoadingBlock rows={3} /></Card>;
  if (!q.data) return null;
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader title="Cobranças" description={`Saldo em aberto: ${fmtMoney(q.data.balance)}`} actions={can('finance.write') && <Button size="sm" icon={<Banknote className="size-4" aria-hidden />} onClick={() => setPaying(true)}>Registrar recebimento</Button>} />
        <ul className="divide-y divide-border">
          {q.data.receivables.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-5 py-2.5 text-sm">
              <span className="flex-1">{r.description}<span className="block text-xs text-muted">Vence {fmtCivilDate(r.dueDate)}</span></span>
              <span className="tabular-nums">{fmtMoney(r.balance)}</span>
              <Badge tone={r.view === 'paid' ? 'accent' : r.view.includes('overdue') ? 'danger' : 'neutral'}>{r.view === 'paid' ? 'Paga' : r.view.includes('overdue') ? 'Vencida' : r.view === 'cancelled' ? 'Cancelada' : 'Aberta'}</Badge>
            </li>
          ))}
          {!q.data.receivables.length && <li className="px-5 py-4 text-sm text-muted">Sem cobranças.</li>}
        </ul>
      </Card>
      <Card>
        <CardHeader title="Recebimentos" />
        <ul className="divide-y divide-border">
          {q.data.payments.map((p) => <li key={p.id} className="flex justify-between px-5 py-2.5 text-sm"><span>{fmtDateTime(p.receivedAt, tz)} · {METHOD_LABEL[p.method] ?? p.method}</span><span className="font-semibold tabular-nums">{fmtMoney(p.amount)}</span></li>)}
          {!q.data.payments.length && <li className="px-5 py-4 text-sm text-muted">Sem recebimentos.</li>}
        </ul>
      </Card>
      <PaymentDialog open={paying} onClose={() => setPaying(false)} patient={patient} />
    </div>
  );
}
