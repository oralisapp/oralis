'use client';

import { fromCents, toCents } from '@oralis/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { PatientPicker } from '@/components/new-appointment-dialog';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, FormError, Input, Select } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';
import { fmtCivilDate, fmtMoney } from '@/lib/format';
import { type CashAccount, type Receivable, useFinance } from '@/lib/queries';
import { useOrg } from '@/lib/session';

export const METHOD_LABEL: Record<string, string> = { pix: 'PIX', cash: 'Dinheiro', card_credit: 'Cartão de crédito', card_debit: 'Cartão de débito', transfer: 'Transferência', boleto: 'Boleto', other: 'Outro' };

function parseMoney(v: string): number | null {
  const s = v.includes(',') ? v.replace(/\./g, '').replace(',', '.') : v;
  return /^\d+(\.\d{1,2})?$/.test(s.trim()) ? toCents(s.trim()) : null;
}

/**
 * Registro de recebimento: distribui o valor nas parcelas em aberto (mais
 * antigas primeiro) e envia uma chave de idempotência gerada ao abrir o
 * diálogo — clicar duas vezes não duplica o lançamento.
 */
export function PaymentDialog({ open, onClose, patient }: { open: boolean; onClose: () => void; patient?: { id: string; name: string } }) {
  const patientId = patient?.id;
  const patientName = patient?.name;
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [who, setWho] = useState<{ id: string; name: string } | null>(patient ?? null);
  const accounts = useFinance<CashAccount[]>('accounts', '/accounts', open);
  const recs = useFinance<Receivable[]>('receivables-patient', `/receivables?patientId=${who?.id ?? ''}&status=open`, open && !!who);
  const [amount, setAmount] = useState('');
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [f, setF] = useState({ cashAccountId: '', method: 'pix', receivedAt: '', notes: '' });
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setWho(patientId ? { id: patientId, name: patientName ?? '' } : null);
    setAmount('');
    setAlloc({});
    setError(null);
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    setF({ cashAccountId: '', method: 'pix', receivedAt: local, notes: '' });
    setKey(crypto.randomUUID());
  }, [open, patientId, patientName]);

  useEffect(() => {
    if (!f.cashAccountId && accounts.data?.[0]) setF((x) => ({ ...x, cashAccountId: accounts.data![0]!.id }));
  }, [accounts.data, f.cashAccountId]);

  // Preenche a distribuição automaticamente a partir das parcelas mais antigas.
  function autoAllocate(total: string) {
    setAmount(total);
    let left = parseMoney(total) ?? 0;
    const next: Record<string, string> = {};
    for (const r of recs.data ?? []) {
      if (left <= 0) break;
      const take = Math.min(left, toCents(r.balance));
      if (take > 0) next[r.id] = fromCents(take);
      left -= take;
    }
    setAlloc(next);
  }

  const allocatedCents = useMemo(() => Object.values(alloc).reduce((s, v) => s + (parseMoney(v) ?? 0), 0), [alloc]);
  const totalCents = parseMoney(amount) ?? 0;

  async function submit() {
    setPending(true);
    setError(null);
    try {
      const allocations = Object.entries(alloc)
        .filter(([, v]) => (parseMoney(v) ?? 0) > 0)
        .map(([receivableId, v]) => ({ receivableId, amount: fromCents(parseMoney(v)!) }));
      await api.post(`/orgs/${orgId}/finance/payments`, {
        cashAccountId: f.cashAccountId,
        patientId: who?.id,
        amount: fromCents(totalCents),
        method: f.method,
        receivedAt: new Date(f.receivedAt).toISOString(),
        notes: f.notes || undefined,
        allocations,
        idempotencyKey: key,
      });
      toast({ tone: 'success', title: 'Recebimento registrado' });
      await qc.invalidateQueries({ queryKey: ['org', orgId] });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível registrar.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Registrar recebimento"
      description="Registro interno do valor recebido. Não processa cartão nem emite nota fiscal."
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button loading={pending} disabled={totalCents <= 0 || (allocatedCents > 0 && allocatedCents !== totalCents)} onClick={submit}>Registrar {totalCents > 0 ? fmtMoney(fromCents(totalCents)) : ''}</Button></>}
    >
      <div className="space-y-4">
        <FormError message={error} />
        {!patient && (
          <div>
            <p className="mb-1.5 text-[13px] font-semibold">Paciente</p>
            <PatientPicker value={who} onChange={(v) => { setWho(v); setAlloc({}); }} />
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Valor recebido (R$)" required>{(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => autoAllocate(e.target.value)} placeholder="0,00" />}</Field>
          <Field label="Forma" required>{(p) => <Select {...p} value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{Object.entries(METHOD_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
          <Field label="Data e hora" required>{(p) => <Input {...p} type="datetime-local" value={f.receivedAt} onChange={(e) => setF({ ...f, receivedAt: e.target.value })} />}</Field>
          <Field label="Conta / caixa" required className="sm:col-span-2">{(p) => <Select {...p} value={f.cashAccountId} onChange={(e) => setF({ ...f, cashAccountId: e.target.value })}>{accounts.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>}</Field>
          <Field label="Observação">{(p) => <Input {...p} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />}</Field>
        </div>
        {who && (
          <section aria-labelledby="alloc">
            <h3 id="alloc" className="mb-2 text-[13px] font-semibold">Quitar parcelas em aberto</h3>
            {recs.data?.length === 0 && <p className="text-sm text-muted">Nenhuma parcela em aberto: o valor ficará registrado sem vínculo.</p>}
            <ul className="divide-y divide-border rounded-lg border border-border">
              {recs.data?.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                  <span className="flex-1">{r.description}<span className="block text-xs text-muted">Vence {fmtCivilDate(r.dueDate)} · saldo {fmtMoney(r.balance)}</span></span>
                  <Input aria-label={`Valor para ${r.description}`} className="!w-28" inputMode="decimal" value={alloc[r.id] ?? ''} onChange={(e) => setAlloc({ ...alloc, [r.id]: e.target.value })} placeholder="0,00" />
                </li>
              ))}
            </ul>
            {allocatedCents > 0 && allocatedCents !== totalCents && <p className="mt-2 text-xs font-semibold text-danger">Distribuído {fmtMoney(fromCents(allocatedCents))} de {fmtMoney(fromCents(totalCents))}. Os valores precisam fechar.</p>}
          </section>
        )}
      </div>
    </Dialog>
  );
}
