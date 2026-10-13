'use client';

import {
  DECIDUOUS_TEETH,
  ODONTOGRAM_CONDITIONS,
  ODONTOGRAM_STATUS_LABEL,
  type OdontogramCondition,
  PERMANENT_TEETH,
  SURFACE_LABEL,
  SURFACES,
  type Surface,
} from '@oralis/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingBlock, Notice } from '@/components/ui/feedback';
import { FormError, Input, Select } from '@/components/ui/field';
import { ApiError, api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useOrgQuery } from '@/lib/queries';
import { useOrg } from '@/lib/session';

interface Entry {
  id: string;
  tooth: number;
  surfaces: Surface[];
  condition: OdontogramCondition;
  status: 'existing' | 'planned' | 'done';
  notes: string | null;
  createdAt: string;
  supersededAt: string | null;
  recordedByName: string;
}

const COLOR: Record<OdontogramCondition, string> = {
  caries: '#c2410c',
  restoration: '#2563eb',
  sealant: '#15803d',
  fracture: '#a16207',
  crown: '#7c3aed',
  root_canal: '#be185d',
  implant: '#0f766e',
  missing: '#475569',
  extraction: '#b91c1c',
  prosthesis: '#7c3aed',
  other: '#64748b',
};

const CELL = 46;
const GAP = 6;

/** Lado mesial no desenho: quadrantes direitos do paciente (1, 4, 5, 8) ficam à esquerda da tela. */
function mesialOnRight(tooth: number) {
  return [1, 4, 5, 8].includes(Math.floor(tooth / 10));
}
function isUpper(tooth: number) {
  return [1, 2, 5, 6].includes(Math.floor(tooth / 10));
}

/** Polígono de cada superfície dentro da célula (topo/base/esquerda/direita/centro). */
function surfacePolygons(tooth: number): Record<Surface, string> {
  const s = CELL;
  const i = s * 0.3;
  const top = `0,0 ${s},0 ${s - i},${i} ${i},${i}`;
  const bottom = `${i},${s - i} ${s - i},${s - i} ${s},${s} 0,${s}`;
  const left = `0,0 ${i},${i} ${i},${s - i} 0,${s}`;
  const right = `${s},0 ${s},${s} ${s - i},${s - i} ${s - i},${i}`;
  const center = `${i},${i} ${s - i},${i} ${s - i},${s - i} ${i},${s - i}`;
  const upper = isUpper(tooth);
  const mRight = mesialOnRight(tooth);
  return { V: upper ? top : bottom, L: upper ? bottom : top, M: mRight ? right : left, D: mRight ? left : right, O: center };
}

function Patterns() {
  return (
    <defs>
      {Object.entries(COLOR).map(([k, c]) => (
        <g key={k}>
          <pattern id={`p-dots-${k}`} width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill={`${c}33`} /><circle cx="3" cy="3" r="1.4" fill={c} /></pattern>
          <pattern id={`p-lines-${k}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill={`${c}33`} /><line x1="0" y1="0" x2="0" y2="6" stroke={c} strokeWidth="2" /></pattern>
          <pattern id={`p-cross-${k}`} width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill={`${c}33`} /><path d="M0 0L6 6M6 0L0 6" stroke={c} strokeWidth="1" /></pattern>
        </g>
      ))}
    </defs>
  );
}

function fillFor(condition: OdontogramCondition) {
  const pat = ODONTOGRAM_CONDITIONS[condition].pattern;
  if (pat === 'dots' || pat === 'lines' || pat === 'cross') return `url(#p-${pat}-${condition})`;
  return COLOR[condition];
}

function Tooth({ tooth, entries, selected, onSelect, x, y }: { tooth: number; entries: Entry[]; selected: boolean; onSelect: () => void; x: number; y: number }) {
  const polys = surfacePolygons(tooth);
  const whole = entries.filter((e) => ODONTOGRAM_CONDITIONS[e.condition].wholeTooth);
  const label = `Dente ${tooth}${entries.length ? `: ${entries.map((e) => `${ODONTOGRAM_CONDITIONS[e.condition].label} (${ODONTOGRAM_STATUS_LABEL[e.status]}${e.surfaces.length ? `, ${e.surfaces.join('')}` : ''})`).join('; ')}` : ': sem registros'}`;
  const surfaceEntry = (s: Surface) => entries.find((e) => !ODONTOGRAM_CONDITIONS[e.condition].wholeTooth && e.surfaces.includes(s) && e.status !== 'planned') ?? entries.find((e) => !ODONTOGRAM_CONDITIONS[e.condition].wholeTooth && e.surfaces.includes(s));
  return (
    <g
      transform={`translate(${x},${y})`}
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect())}
      className="cursor-pointer outline-none [&:focus-visible>rect.focus]:stroke-[var(--ring)]"
    >
      <title>{label}</title>
      {SURFACES.map((s) => {
        const e = surfaceEntry(s);
        return (
          <polygon
            key={s}
            points={polys[s]}
            fill={e ? fillFor(e.condition) : 'var(--surface)'}
            fillOpacity={e?.status === 'planned' ? 0.45 : 1}
            stroke="var(--border-strong)"
            strokeWidth={1}
            strokeDasharray={e?.status === 'planned' ? '3 2' : undefined}
          />
        );
      })}
      {whole.map((e) => (
        <g key={e.id} pointerEvents="none">
          {e.condition === 'missing' || e.condition === 'extraction' ? (
            <path d={e.condition === 'missing' ? `M4 4L${CELL - 4} ${CELL - 4}M${CELL - 4} 4L4 ${CELL - 4}` : `M4 ${CELL - 4}L${CELL - 4} 4`} stroke={COLOR[e.condition]} strokeWidth={3} strokeDasharray={e.status === 'planned' ? '4 3' : undefined} />
          ) : (
            <rect x={2} y={2} width={CELL - 4} height={CELL - 4} rx={8} fill="none" stroke={COLOR[e.condition]} strokeWidth={3} strokeDasharray={e.status === 'planned' ? '4 3' : undefined} />
          )}
        </g>
      ))}
      {entries.length > 0 && (
        <text x={CELL / 2} y={CELL / 2 + 4} textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--text)" pointerEvents="none" className="select-none">
          {[...new Set(entries.map((e) => ODONTOGRAM_CONDITIONS[e.condition].symbol))].join('')}
        </text>
      )}
      <rect className="focus" x={-3} y={-3} width={CELL + 6} height={CELL + 6} rx={6} fill="none" stroke={selected ? 'var(--primary)' : 'transparent'} strokeWidth={2.5} />
      <text x={CELL / 2} y={isUpper(tooth) ? -8 : CELL + 16} textAnchor="middle" fontSize="12" fontWeight={selected ? 800 : 600} fill={selected ? 'var(--primary)' : 'var(--text-muted)'}>
        {tooth}
      </text>
    </g>
  );
}

export function Odontogram({ patientId, canWrite }: { patientId: string; canWrite: boolean }) {
  const { orgId, unit } = useOrg();
  const qc = useQueryClient();
  const q = useOrgQuery<{ current: Entry[]; history: Entry[] }>(['odontogram', patientId], `/patients/${patientId}/odontogram`);
  const [dentition, setDentition] = useState<'permanent' | 'deciduous'>('permanent');
  const [selected, setSelected] = useState<number | null>(null);
  const [form, setForm] = useState<{ condition: OdontogramCondition; status: 'existing' | 'planned' | 'done'; surfaces: Surface[]; notes: string }>({ condition: 'caries', status: 'existing', surfaces: [], notes: '' });
  const [error, setError] = useState<string | null>(null);
  const tz = unit?.timezone ?? 'America/Sao_Paulo';
  const add = useMutation({
    mutationFn: () => api.post(`/orgs/${orgId}/patients/${patientId}/odontogram`, { tooth: selected, ...form, notes: form.notes || undefined }),
    onSuccess: async () => {
      setForm({ ...form, surfaces: [], notes: '' });
      setError(null);
      await qc.invalidateQueries({ queryKey: ['org', orgId, 'odontogram', patientId] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Erro'),
  });

  if (q.isLoading) return <LoadingBlock rows={4} />;
  if (q.error || !q.data) return <ErrorState error={q.error} />;

  const set = dentition === 'permanent' ? PERMANENT_TEETH : DECIDUOUS_TEETH;
  const perRow = set.upperRight.length * 2;
  const width = perRow * (CELL + GAP) + 24;
  const rowFor = (teeth: readonly number[], offset: number, y: number) => teeth.map((t, i) => ({ t, x: 12 + (offset + i) * (CELL + GAP) + (offset ? 12 : 0), y }));
  const n = set.upperRight.length;
  const layout = [...rowFor(set.upperRight, 0, 24), ...rowFor(set.upperLeft, n, 24), ...rowFor(set.lowerRight, 0, CELL + 70), ...rowFor(set.lowerLeft, n, CELL + 70)];
  const entriesOf = (t: number) => q.data!.current.filter((e) => e.tooth === t);
  const whole = ODONTOGRAM_CONDITIONS[form.condition].wholeTooth;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div role="radiogroup" aria-label="Dentição" className="flex rounded-lg bg-surface-2 p-0.5">
          {(['permanent', 'deciduous'] as const).map((d) => (
            <button key={d} role="radio" aria-checked={dentition === d} type="button" onClick={() => { setDentition(d); setSelected(null); }} className={`rounded-md px-3 py-1 text-sm font-semibold ${dentition === d ? 'bg-surface text-fg shadow-card' : 'text-muted'}`}>
              {d === 'permanent' ? 'Permanente' : 'Decídua'}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted">Notação FDI. Selecione um dente (clique ou Enter) para ver o histórico e registrar.</p>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border bg-surface-2/40 p-2">
        <svg viewBox={`0 0 ${width + 12} ${CELL * 2 + 100}`} className="mx-auto block min-w-[620px] max-w-full" role="group" aria-label={`Odontograma — dentição ${dentition === 'permanent' ? 'permanente' : 'decídua'}`}>
          <Patterns />
          <line x1={(width + 12) / 2} y1={4} x2={(width + 12) / 2} y2={CELL * 2 + 96} stroke="var(--border)" strokeDasharray="4 4" />
          <line x1={4} y1={CELL + 47} x2={width + 8} y2={CELL + 47} stroke="var(--border)" strokeDasharray="4 4" />
          {layout.map(({ t, x, y }) => (
            <Tooth key={t} tooth={t} x={x} y={y} entries={entriesOf(t)} selected={selected === t} onSelect={() => setSelected(t)} />
          ))}
        </svg>
      </div>

      <details className="rounded-xl border border-border p-3 text-sm" open>
        <summary className="cursor-pointer font-semibold">Legenda</summary>
        <ul className="mt-2 grid gap-2 sm:grid-cols-3">
          {Object.entries(ODONTOGRAM_CONDITIONS).map(([k, c]) => (
            <li key={k} className="flex items-center gap-2">
              <svg width="22" height="22" aria-hidden><rect width="22" height="22" rx="4" fill={fillFor(k as OdontogramCondition)} stroke="var(--border-strong)" /></svg>
              <span className="w-6 font-bold">{c.symbol}</span>
              {c.label}
            </li>
          ))}
          <li className="flex items-center gap-2 text-muted"><svg width="22" height="22" aria-hidden><rect x="1" y="1" width="20" height="20" rx="4" fill="none" stroke="var(--text-muted)" strokeDasharray="3 2" /></svg> Contorno tracejado = planejado</li>
        </ul>
      </details>

      {selected && (
        <div className="grid gap-4 rounded-xl border border-border p-4 lg:grid-cols-2">
          <div>
            <h3 className="mb-2 flex items-center gap-2 font-bold"><History className="size-4 text-subtle" aria-hidden /> Dente {selected}</h3>
            <ol className="space-y-2 text-sm">
              {q.data.history.filter((e) => e.tooth === selected).map((e) => (
                <li key={e.id} className={e.supersededAt ? 'text-subtle line-through decoration-1' : ''}>
                  <span className="font-semibold">{ODONTOGRAM_CONDITIONS[e.condition].label}</span> · {ODONTOGRAM_STATUS_LABEL[e.status]}{e.surfaces.length ? ` · ${e.surfaces.join(', ')}` : ''}
                  <span className="block text-xs text-muted">{e.recordedByName} · {fmtDateTime(e.createdAt, tz)}{e.notes ? ` · ${e.notes}` : ''}{e.supersededAt ? ' · substituído' : ''}</span>
                </li>
              ))}
              {!q.data.history.some((e) => e.tooth === selected) && <li className="text-muted">Sem registros neste dente.</li>}
            </ol>
          </div>
          {canWrite ? (
            <div className="space-y-3">
              <h3 className="font-bold">Novo registro</h3>
              <FormError message={error} />
              <div className="grid grid-cols-2 gap-2">
                <Select aria-label="Condição" value={form.condition} onChange={(e) => setForm({ ...form, condition: e.target.value as OdontogramCondition })}>
                  {Object.entries(ODONTOGRAM_CONDITIONS).map(([k, c]) => <option key={k} value={k}>{c.label}</option>)}
                </Select>
                <Select aria-label="Situação" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as Entry['status'] })}>
                  {Object.entries(ODONTOGRAM_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
              </div>
              {!whole && (
                <div className="flex flex-wrap gap-1" role="group" aria-label="Superfícies">
                  {SURFACES.map((s) => (
                    <button key={s} type="button" aria-pressed={form.surfaces.includes(s)} title={SURFACE_LABEL[s]} onClick={() => setForm({ ...form, surfaces: form.surfaces.includes(s) ? form.surfaces.filter((x) => x !== s) : [...form.surfaces, s] })} className={`h-8 rounded-md border px-2 text-xs font-bold ${form.surfaces.includes(s) ? 'border-primary bg-primary-soft text-primary-text' : 'border-border text-muted'}`}>
                      {s} · {SURFACE_LABEL[s]}
                    </button>
                  ))}
                </div>
              )}
              <Input aria-label="Observação" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Observação (opcional)" />
              <Button loading={add.isPending} disabled={!whole && form.surfaces.length === 0} onClick={() => add.mutate()}>Registrar no dente {selected}</Button>
              <Notice tone="info">O registro anterior equivalente fica no histórico como “substituído”. Nada é apagado.</Notice>
            </div>
          ) : (
            <p className="text-sm text-muted">Somente leitura para o seu papel.</p>
          )}
        </div>
      )}
    </div>
  );
}
