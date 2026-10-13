'use client';

import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, CloudOff, Loader2, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/feedback';
import { FormError, Input, Select, Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';
import { fmtTime } from '@/lib/format';
import { useOrg } from '@/lib/session';

export interface Procedure {
  description: string;
  serviceId?: string;
  tooth?: number;
  surfaces?: ('M' | 'D' | 'O' | 'V' | 'L')[];
  treatmentItemId?: string;
}

export interface DraftRecord {
  id: string;
  content: string;
  procedures: Procedure[];
  version: number;
  updatedAt: string;
}

type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

const SURFACES = ['M', 'D', 'O', 'V', 'L'] as const;
const SURFACE_LABEL = { M: 'Mesial', D: 'Distal', O: 'Oclusal/Incisal', V: 'Vestibular', L: 'Lingual/Palatina' } as const;

interface Backup {
  content: string;
  procedures: Procedure[];
  baseVersion: number;
  at: number;
}

function readBackup(id: string): Backup | null {
  try {
    const raw = localStorage.getItem(`oralis.draft.${id}`);
    return raw ? (JSON.parse(raw) as Backup) : null;
  } catch {
    return null;
  }
}
function writeBackup(id: string, b: Backup | null) {
  try {
    if (b) localStorage.setItem(`oralis.draft.${id}`, JSON.stringify(b));
    else localStorage.removeItem(`oralis.draft.${id}`);
  } catch {
    // backup local é opcional
  }
}

/**
 * Editor da evolução clínica.
 * - Salva sozinho 2 s após parar de digitar e mostra o estado do salvamento.
 * - Guarda uma cópia local para recuperar edição interrompida (queda, aba fechada).
 * - Avisa ao sair com alterações não salvas.
 * - Edição em outra janela gera conflito explícito: a pessoa escolhe qual versão manter.
 * - Finalizar exige revisão; depois só adendos.
 */
export function RecordEditor({ record, services, tz, onFinalized, treatmentItems = [] }: { record: DraftRecord; services: { id: string; name: string }[]; tz: string; onFinalized: () => void; treatmentItems?: { id: string; description: string; tooth: number | null }[] }) {
  const { orgId, me } = useOrg();
  const backupId = `${orgId}.${me.user.id}.${record.id}`;
  const qc = useQueryClient();
  const toast = useToast();
  const [content, setContent] = useState(record.content);
  const [procedures, setProcedures] = useState<Procedure[]>(record.procedures ?? []);
  const [version, setVersion] = useState(record.version);
  const [state, setState] = useState<SaveState>('saved');
  const [savedAt, setSavedAt] = useState<string>(record.updatedAt);
  const [recovery, setRecovery] = useState<Backup | null>(null);
  const [conflict, setConflict] = useState<{ serverVersion: number; serverContent: string; serverProcedures: Procedure[]; serverUpdatedBy: string | null } | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [finalized, setFinalized] = useState(false);
  const finalizationLocked = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ content, procedures, version });
  const inFlight = useRef<Promise<number | false> | null>(null);
  const blocked = useRef(false);
  latest.current.content = content;
  latest.current.procedures = procedures;

  // Edição interrompida: cópia local mais nova que a do servidor.
  useEffect(() => {
    const b = readBackup(backupId);
    if (b && b.baseVersion === record.version && (b.content !== record.content || JSON.stringify(b.procedures) !== JSON.stringify(record.procedures))) setRecovery(b);
    else if (b) setRecovery(b);
  }, [backupId, record.id, record.version, record.content, record.procedures]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (state !== 'saved' || recovery) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [state, recovery]);

  const save = useCallback(
    async (override?: { version: number }): Promise<number | false> => {
      if (timer.current) clearTimeout(timer.current);
      if (inFlight.current) return inFlight.current;
      blocked.current = false;
      const task = (async (): Promise<number | false> => {
      setState('saving');
      try {
        if (override) latest.current.version = override.version;
        while (true) {
        const cur = { ...latest.current };
        const r = await api.put<{ version: number; updatedAt: string }>(`/orgs/${orgId}/clinical-records/${record.id}`, { content: cur.content, procedures: cur.procedures, version: cur.version });
        latest.current.version = r.version;
        setVersion(r.version);
        setSavedAt(r.updatedAt);
        if (latest.current.content === cur.content && latest.current.procedures === cur.procedures) {
          writeBackup(backupId, null);
          setState('saved');
          setError(null);
          return r.version;
        }
        writeBackup(backupId, { ...latest.current, baseVersion: r.version, at: Date.now() });
        }
      } catch (err) {
        blocked.current = true;
        if (err instanceof ApiError && err.code === 'stale_version') {
          setConflict(err.details as never);
          setState('conflict');
        } else {
          setState('error');
          setError(err instanceof ApiError ? err.message : 'Sem conexão. Suas alterações estão guardadas neste navegador.');
        }
        return false;
      }
      })();
      inFlight.current = task;
      try { return await task; } finally { inFlight.current = null; }
    },
    [orgId, record.id, backupId],
  );

  function change(nextContent: string, nextProcedures: Procedure[]) {
    if (finalizationLocked.current) return;
    latest.current = { ...latest.current, content: nextContent, procedures: nextProcedures };
    setContent(nextContent);
    setProcedures(nextProcedures);
    setState('dirty');
    setError(null);
    writeBackup(backupId, { content: nextContent, procedures: nextProcedures, baseVersion: latest.current.version, at: Date.now() });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { if (!blocked.current) void save(); }, 2000);
  }

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function finalize() {
    if (finalizationLocked.current) return;
    finalizationLocked.current = true;
    let completed = false;
    setFinalizing(true);
    setError(null);
    try {
      const savedVersion = state === 'saved' ? latest.current.version : await save();
      if (savedVersion === false) return;
      await api.post(`/orgs/${orgId}/clinical-records/${record.id}/finalize`, { version: savedVersion });
      completed = true;
      setFinalized(true);
      writeBackup(backupId, null);
      toast({ tone: 'success', title: 'Evolução finalizada', description: 'O registro agora é imutável. Complementos entram como adendo.' });
      setReviewing(false);
      await qc.invalidateQueries({ queryKey: ['org', orgId] });
      onFinalized();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível finalizar.');
    } finally {
      finalizationLocked.current = completed;
      setFinalizing(false);
    }
  }

  const status: Record<SaveState, React.ReactNode> = {
    saved: <span className="flex items-center gap-1 text-accent-text"><CheckCircle2 className="size-4" aria-hidden /> Rascunho salvo às {fmtTime(savedAt, tz)}</span>,
    dirty: <span className="flex items-center gap-1 text-muted">Alterações não salvas…</span>,
    saving: <span className="flex items-center gap-1 text-muted"><Loader2 className="size-4 animate-spin" aria-hidden /> Salvando…</span>,
    error: <span className="flex items-center gap-1 text-danger"><CloudOff className="size-4" aria-hidden /> Não salvo — cópia guardada neste navegador</span>,
    conflict: <span className="flex items-center gap-1 text-warning"><AlertTriangle className="size-4" aria-hidden /> Versão diferente em outra janela</span>,
  };

  const setProc = (i: number, p: Partial<Procedure>) => change(content, procedures.map((x, j) => (j === i ? { ...x, ...p } : x)));

  return (
    <div className="space-y-4" data-unsaved={state !== 'saved' || !!recovery}>
      {recovery && (
        <Notice tone="warning" title="Há uma edição não salva deste rascunho neste navegador">
          <p>Ela foi interrompida antes de chegar ao servidor.</p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={() => { if (recovery.baseVersion !== latest.current.version) { blocked.current = true; setConflict({ serverVersion: latest.current.version, serverContent: content, serverProcedures: procedures, serverUpdatedBy: null }); } change(recovery.content, recovery.procedures); if (blocked.current) setState('conflict'); setRecovery(null); }}>Recuperar edição</Button>
            <Button size="sm" variant="ghost" onClick={() => { writeBackup(backupId, null); setRecovery(null); }}>Descartar</Button>
          </div>
        </Notice>
      )}
      <FormError message={error} />

      <fieldset disabled={finalizing || finalized || reviewing || !!recovery} className="space-y-4">
      <div>
        <label htmlFor={`ev-${record.id}`} className="mb-1.5 block text-[13px] font-semibold">Evolução da sessão</label>
        <Textarea
          id={`ev-${record.id}`}
          value={content}
          onChange={(e) => change(e.target.value, procedures)}
          rows={12}
          className="font-[inherit] leading-relaxed"
          placeholder="Queixa, achados, conduta, orientações…"
        />
      </div>

      <section aria-labelledby={`proc-${record.id}`}>
        <div className="mb-2 flex items-center justify-between">
          <h3 id={`proc-${record.id}`} className="text-[13px] font-semibold">Procedimentos realizados nesta sessão</h3>
          <Button size="sm" variant="ghost" icon={<Plus className="size-4" aria-hidden />} onClick={() => change(content, [...procedures, { description: '' }])}>Adicionar</Button>
        </div>
        {procedures.length === 0 && <p className="text-sm text-subtle">Nenhum procedimento registrado.</p>}
        <ul className="space-y-2">
          {procedures.map((p, i) => (
            <li key={i} className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1fr_90px_auto]">
              <div className="space-y-2">
                <Select aria-label="Serviço" value={p.serviceId ?? ''} onChange={(e) => { const s = services.find((x) => x.id === e.target.value); setProc(i, { serviceId: e.target.value || undefined, description: s?.name ?? p.description }); }}>
                  <option value="">Outro (descrever)</option>
                  {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
                <Input aria-label="Descrição do procedimento" value={p.description} onChange={(e) => setProc(i, { description: e.target.value })} placeholder="Descrição" />
                {treatmentItems.length > 0 && (
                  <Select aria-label="Etapa do plano de tratamento" value={p.treatmentItemId ?? ''} onChange={(e) => setProc(i, { treatmentItemId: e.target.value || undefined })}>
                    <option value="">Não vinculado a plano</option>
                    {treatmentItems.map((t) => <option key={t.id} value={t.id}>Plano: {t.description}{t.tooth ? ` (dente ${t.tooth})` : ''}</option>)}
                  </Select>
                )}
                <div className="flex flex-wrap gap-1" role="group" aria-label="Superfícies">
                  {SURFACES.map((s) => (
                    <button key={s} type="button" title={SURFACE_LABEL[s]} aria-pressed={p.surfaces?.includes(s) ?? false} onClick={() => setProc(i, { surfaces: p.surfaces?.includes(s) ? p.surfaces.filter((x) => x !== s) : [...(p.surfaces ?? []), s] })} className={`h-7 min-w-8 rounded-md border px-2 text-xs font-bold ${p.surfaces?.includes(s) ? 'border-primary bg-primary-soft text-primary-text' : 'border-border text-muted'}`}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
              <Input aria-label="Dente (FDI)" inputMode="numeric" placeholder="Dente" value={p.tooth ?? ''} onChange={(e) => setProc(i, { tooth: e.target.value ? Number(e.target.value) : undefined })} />
              <button type="button" aria-label="Remover procedimento" onClick={() => change(content, procedures.filter((_, j) => j !== i))} className="self-start rounded p-2 text-muted hover:text-danger"><Trash2 className="size-4" aria-hidden /></button>
            </li>
          ))}
        </ul>
      </section>

      </fieldset>
      <div className="sticky bottom-0 -mx-5 flex flex-wrap items-center gap-3 border-t border-border bg-surface/95 px-5 py-3 backdrop-blur">
        <div className="text-sm" role="status" aria-live="polite">{status[state]}</div>
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" loading={state === 'saving'} disabled={finalizing || finalized || state === 'saved' || state === 'conflict'} onClick={() => void save()}>Salvar rascunho</Button>
          <Button icon={<ShieldCheck className="size-4" aria-hidden />} disabled={finalizing || finalized || !content.trim() || state === 'conflict' || !!recovery} onClick={() => setReviewing(true)}>Revisar e finalizar</Button>
        </div>
      </div>

      <Dialog
        open={!!conflict}
        onClose={() => setConflict(null)}
        size="lg"
        title="Este rascunho mudou em outra janela"
        description={conflict?.serverUpdatedBy ? `Última versão salva por ${conflict.serverUpdatedBy}.` : undefined}
        footer={
          <>
            <Button variant="secondary" onClick={() => { if (!conflict) return; latest.current = { content: conflict.serverContent, procedures: conflict.serverProcedures, version: conflict.serverVersion }; blocked.current = false; setContent(conflict.serverContent); setProcedures(conflict.serverProcedures); setVersion(conflict.serverVersion); writeBackup(backupId, null); setConflict(null); setState('saved'); }}>Usar a versão salva</Button>
            <Button onClick={() => { if (!conflict) return; const v = conflict.serverVersion; setVersion(v); setConflict(null); void save({ version: v }); }}>Manter a minha</Button>
          </>
        }
      >
        {conflict && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div><p className="mb-1 text-xs font-semibold text-muted">Versão salva</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-3 font-sans text-sm">{conflict.serverContent || '(vazio)'}</pre></div>
            <div><p className="mb-1 text-xs font-semibold text-muted">Sua versão (nesta janela)</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-primary-soft/40 p-3 font-sans text-sm">{content || '(vazio)'}</pre></div>
          </div>
        )}
      </Dialog>

      <Dialog
        open={reviewing}
        onClose={() => { if (!finalizationLocked.current) setReviewing(false); }}
        size="lg"
        title="Revisar antes de finalizar"
        description="Depois de finalizado, o registro não pode ser editado — apenas complementado por adendo."
        footer={<><Button variant="ghost" disabled={finalizing} onClick={() => setReviewing(false)}>Voltar a editar</Button><Button loading={finalizing} onClick={finalize}>Finalizar registro</Button></>}
      >
        <FormError message={error} />
        <pre className="whitespace-pre-wrap rounded-lg bg-surface-2 p-4 font-sans text-sm leading-relaxed">{content}</pre>
        {procedures.length > 0 && (
          <ul className="mt-4 list-disc pl-5 text-sm">
            {procedures.map((p, i) => <li key={i}>{p.description}{p.tooth ? ` — dente ${p.tooth}` : ''}{p.surfaces?.length ? ` (${p.surfaces.join(', ')})` : ''}</li>)}
          </ul>
        )}
      </Dialog>
    </div>
  );
}
