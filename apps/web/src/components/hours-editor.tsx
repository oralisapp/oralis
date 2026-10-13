'use client';

import { type BusinessHoursInput, WEEKDAY_LABEL } from '@oralis/shared';
import { Plus, Trash2 } from 'lucide-react';

export const BR_TIMEZONES: { id: string; label: string }[] = [
  { id: 'America/Sao_Paulo', label: 'Brasília (SP, RJ, MG, Sul, GO, DF…)' },
  { id: 'America/Bahia', label: 'Bahia' },
  { id: 'America/Fortaleza', label: 'Fortaleza (CE, RN, PB, PI, MA)' },
  { id: 'America/Recife', label: 'Recife (PE)' },
  { id: 'America/Maceio', label: 'Maceió (AL, SE)' },
  { id: 'America/Belem', label: 'Belém (PA leste, AP)' },
  { id: 'America/Araguaina', label: 'Araguaína (TO)' },
  { id: 'America/Manaus', label: 'Manaus (AM)' },
  { id: 'America/Cuiaba', label: 'Cuiabá (MT)' },
  { id: 'America/Campo_Grande', label: 'Campo Grande (MS)' },
  { id: 'America/Porto_Velho', label: 'Porto Velho (RO)' },
  { id: 'America/Boa_Vista', label: 'Boa Vista (RR)' },
  { id: 'America/Rio_Branco', label: 'Rio Branco (AC)' },
  { id: 'America/Noronha', label: 'Fernando de Noronha' },
];

export const DEFAULT_HOURS: BusinessHoursInput = [
  ...[1, 2, 3, 4, 5].flatMap((weekday) => [
    { weekday, opensAt: '08:00', closesAt: '12:00' },
    { weekday, opensAt: '13:00', closesAt: '18:00' },
  ]),
  { weekday: 6, opensAt: '08:00', closesAt: '12:00' },
];

const ORDER = [1, 2, 3, 4, 5, 6, 0];
const timeInput = 'h-9 w-[92px] rounded-lg border border-border-strong bg-surface px-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30';

/** Editor de horário de funcionamento: vários intervalos por dia (ex.: manhã e tarde). */
export function HoursEditor({ value, onChange }: { value: BusinessHoursInput; onChange: (v: BusinessHoursInput) => void }) {
  const byDay = (d: number) => value.map((h, i) => ({ ...h, i })).filter((h) => h.weekday === d);
  const update = (i: number, patch: Partial<BusinessHoursInput[number]>) => onChange(value.map((h, j) => (j === i ? { ...h, ...patch } : h)));
  const remove = (i: number) => onChange(value.filter((_, j) => j !== i));
  const add = (weekday: number) => {
    const last = byDay(weekday).at(-1);
    onChange([...value, last ? { weekday, opensAt: last.closesAt < '22:00' ? last.closesAt : '08:00', closesAt: '22:00' } : { weekday, opensAt: '08:00', closesAt: '18:00' }]);
  };

  return (
    <div className="divide-y divide-border rounded-xl border border-border">
      {ORDER.map((d) => {
        const rows = byDay(d);
        return (
          <fieldset key={d} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
            <legend className="sr-only">{WEEKDAY_LABEL[d]}</legend>
            <span className="w-20 text-sm font-semibold" aria-hidden>
              {WEEKDAY_LABEL[d]}
            </span>
            <div className="flex flex-1 flex-wrap items-center gap-2">
              {rows.length === 0 && <span className="text-sm text-subtle">Fechado</span>}
              {rows.map((h, n) => (
                <span key={h.i} className="flex items-center gap-1.5">
                  <input aria-label={`${WEEKDAY_LABEL[d]}, intervalo ${n + 1}, abertura`} type="time" step={900} value={h.opensAt} onChange={(e) => update(h.i, { opensAt: e.target.value })} className={timeInput} />
                  <span className="text-muted" aria-hidden>
                    –
                  </span>
                  <input aria-label={`${WEEKDAY_LABEL[d]}, intervalo ${n + 1}, fechamento`} type="time" step={900} value={h.closesAt} onChange={(e) => update(h.i, { closesAt: e.target.value })} className={timeInput} />
                  <button type="button" onClick={() => remove(h.i)} aria-label={`Remover intervalo ${n + 1} de ${WEEKDAY_LABEL[d]}`} className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-danger">
                    <Trash2 className="size-4" aria-hidden />
                  </button>
                </span>
              ))}
            </div>
            {rows.length < 3 && (
              <button type="button" onClick={() => add(d)} className="inline-flex items-center gap-1 text-sm font-semibold text-primary-text hover:underline">
                <Plus className="size-4" aria-hidden />
                {rows.length ? 'Intervalo' : 'Abrir'}
              </button>
            )}
          </fieldset>
        );
      })}
    </div>
  );
}
