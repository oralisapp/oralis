'use client';

import { ArrowLeft, Printer } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Logo } from '@/components/brand';
import { TreatmentJourney } from '@/components/treatment-journey';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingBlock } from '@/components/ui/feedback';
import { fmtCivilDate, fmtMoney } from '@/lib/format';
import { usePlan } from '@/lib/queries';
import { useOrg } from '@/lib/session';

const METHOD: Record<string, string> = { to_define: 'a combinar', pix: 'PIX', card_credit: 'cartão de crédito', card_debit: 'cartão de débito', cash: 'dinheiro', boleto: 'boleto', transfer: 'transferência' };

/**
 * Apresentação do tratamento ao paciente: linguagem simples, etapas, valores e
 * próximos passos. Sem imagens ilustrativas e sem promessa de resultado.
 */
export default function PresentationPage() {
  const { id } = useParams<{ id: string }>();
  const { membership } = useOrg();
  const q = usePlan(id);
  if (q.isLoading) return <LoadingBlock rows={6} />;
  if (q.error || !q.data) return <ErrorState error={q.error} />;
  const { plan, items, quotes } = q.data;
  const quote = quotes[0];
  const v = quote?.versions.find((x) => x.id === quote.currentVersionId);
  const tz = plan.timezone;
  const stages = [...new Set(items.filter((i) => i.status !== 'cancelled').map((i) => i.stage))].sort((a, b) => a - b);
  const installmentValue = v ? (Number(v.total) / v.paymentTerms.installments).toFixed(2) : null;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-center justify-between print:hidden">
        <Link href={`/app/tratamentos/${id}`} className="inline-flex items-center gap-1 text-sm font-semibold text-muted hover:text-fg"><ArrowLeft className="size-4" aria-hidden /> Voltar ao plano</Link>
        <Button variant="secondary" icon={<Printer className="size-4" aria-hidden />} onClick={() => window.print()}>Imprimir / PDF</Button>
      </div>
      <article className="rounded-3xl border border-border bg-surface p-8 shadow-card print:border-0 print:shadow-none sm:p-12">
        <header className="mb-8 flex items-center justify-between">
          <Logo />
          <span className="text-sm text-muted">{membership.organizationName}</span>
        </header>
        <p className="text-sm font-semibold text-primary-text">Plano de tratamento para {plan.patientName.split(' ')[0]}</p>
        <h1 className="mt-1 text-3xl font-extrabold tracking-tight">{plan.title}</h1>
        {plan.responsibleName && <p className="mt-1 text-muted">Profissional responsável: {plan.responsibleName}</p>}

        {plan.objective && (
          <section className="mt-8">
            <h2 className="text-lg font-bold">O que vamos fazer e por quê</h2>
            <p className="mt-2 whitespace-pre-wrap text-[15px] leading-relaxed">{plan.objective}</p>
          </section>
        )}

        <section className="mt-8">
          <h2 className="text-lg font-bold">Etapas</h2>
          <ol className="mt-3 space-y-4">
            {stages.map((s) => (
              <li key={s} className="rounded-2xl bg-surface-2 p-4">
                <p className="font-bold">Etapa {s}</p>
                <ul className="mt-2 space-y-1 text-[15px]">
                  {items.filter((i) => i.stage === s && i.status !== 'cancelled').map((i) => (
                    <li key={i.id} className="flex justify-between gap-4">
                      <span>{i.description}{i.tooth ? ` — dente ${i.tooth}` : ''} <span className="text-sm text-muted">({i.sessionsPlanned} sessão{i.sessionsPlanned > 1 ? 'ões' : ''} prevista{i.sessionsPlanned > 1 ? 's' : ''})</span></span>
                      <span className="shrink-0 tabular-nums">{fmtMoney(i.unitPrice)}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
          <p className="mt-2 text-xs text-muted">Número de sessões e prazos são estimativas e podem mudar conforme a avaliação em cada consulta.</p>
        </section>

        {['approved', 'in_progress', 'completed'].includes(plan.status) && (
          <section className="mt-8">
            <h2 className="text-lg font-bold">Seu progresso</h2>
            <div className="mt-3"><TreatmentJourney items={items} tz={tz} compact /></div>
          </section>
        )}

        {v && (
          <section className="mt-8 rounded-2xl border border-border p-5">
            <h2 className="text-lg font-bold">Investimento</h2>
            <dl className="mt-3 space-y-1 text-[15px]">
              <div className="flex justify-between"><dt>Valor dos procedimentos</dt><dd className="tabular-nums">{fmtMoney(v.subtotal)}</dd></div>
              {v.discount !== '0.00' && <div className="flex justify-between"><dt>Desconto</dt><dd className="tabular-nums">− {fmtMoney(v.discount)}</dd></div>}
              <div className="flex justify-between border-t border-border pt-2 text-xl font-extrabold"><dt>Total</dt><dd className="tabular-nums">{fmtMoney(v.total)}</dd></div>
            </dl>
            <p className="mt-2 text-sm text-muted">
              {v.paymentTerms.installments > 1 ? `Em ${v.paymentTerms.installments} parcelas de cerca de ${fmtMoney(installmentValue)}` : 'À vista'} · {METHOD[v.paymentTerms.method] ?? v.paymentTerms.method} · primeiro vencimento em {fmtCivilDate(v.paymentTerms.firstDueDate)}. Proposta válida até {fmtCivilDate(v.validUntil)} (versão {v.version}).
            </p>
          </section>
        )}

        <section className="mt-8">
          <h2 className="text-lg font-bold">Próximos passos</h2>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-[15px]">
            <li>Tire suas dúvidas com o profissional — este plano pode ser ajustado.</li>
            <li>Ao aprovar, a clínica agenda a primeira etapa com você.</li>
            <li>Antes dos procedimentos, você receberá as orientações e os termos necessários.</li>
          </ol>
        </section>

        <footer className="mt-10 border-t border-border pt-4 text-xs text-muted">
          Este documento descreve um plano proposto e seus valores. Resultados clínicos dependem de fatores individuais e não são garantidos. A aprovação deste orçamento não substitui o termo de consentimento para os procedimentos.
        </footer>
      </article>
    </div>
  );
}
