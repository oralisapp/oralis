'use client';

import { Badge, Card, LoadingBlock, Notice } from '@/components/ui/feedback';
import { fmtCivilDate, fmtDateTime, fmtMoney } from '@/lib/format';
import { usePortalPayments } from '@/lib/portal';

const METHOD: Record<string, string> = { pix: 'PIX', cash: 'Dinheiro', card_credit: 'Cartão de crédito', card_debit: 'Cartão de débito', transfer: 'Transferência', boleto: 'Boleto', other: 'Outro' };

export default function PortalPayments() {
  const q = usePortalPayments();
  if (q.isLoading || !q.data) return <LoadingBlock rows={3} />;
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-extrabold">Pagamentos</h1>
      <Card className="p-5"><p className="text-sm text-muted">Saldo em aberto</p><p className="text-3xl font-extrabold tabular-nums">{fmtMoney(q.data.balance)}</p></Card>
      <Card className="p-5">
        <h2 className="mb-3 font-bold">Parcelas</h2>
        <ul className="divide-y divide-border text-sm">
          {q.data.receivables.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 py-2">
              <span className="flex-1">{r.description}<span className="block text-xs text-muted">Vencimento {fmtCivilDate(r.dueDate)}</span></span>
              <span className="tabular-nums">{fmtMoney(r.status === 'paid' ? r.amount : r.balance)}</span>
              <Badge tone={r.view === 'paid' ? 'accent' : r.view.includes('overdue') ? 'warning' : 'neutral'}>{r.view === 'paid' ? 'Pago' : r.view.includes('overdue') ? 'Vencido' : r.view === 'partial' ? 'Pago em parte' : 'A vencer'}</Badge>
            </li>
          ))}
          {!q.data.receivables.length && <li className="py-2 text-muted">Nenhuma parcela.</li>}
        </ul>
      </Card>
      <Card className="p-5">
        <h2 className="mb-3 font-bold">Comprovantes de pagamento</h2>
        <ul className="divide-y divide-border text-sm">{q.data.payments.map((p) => <li key={p.id} className="flex justify-between py-2"><span>{fmtDateTime(p.receivedAt, 'America/Sao_Paulo')} · {METHOD[p.method] ?? p.method}</span><span className="font-semibold tabular-nums">{fmtMoney(p.amount)}</span></li>)}</ul>
        {!q.data.payments.length && <p className="text-sm text-muted">Nenhum pagamento registrado.</p>}
      </Card>
      <Notice tone="info">Os pagamentos são feitos diretamente com a clínica. Comprovantes deste portal não substituem nota fiscal.</Notice>
    </div>
  );
}
