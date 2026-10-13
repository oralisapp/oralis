'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/session';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { Field, Input, Select, FormError } from './ui/field';

const fields = { fullName: 'Nome completo', socialName: 'Nome social', birthDate: 'Nascimento (AAAA-MM-DD)', cpf: 'CPF', phone: 'Telefone com DDD', email: 'E-mail', administrativeNotes: 'Observações administrativas' };
type Row = { row: number; status: string; message: string; patient?: { fullName: string } | null };

export function PatientImport() {
  const { orgId } = useOrg(); const qc = useQueryClient();
  const [open, setOpen] = useState(false); const [csv, setCsv] = useState(''); const [delimiter, setDelimiter] = useState(';');
  const [columns, setColumns] = useState<string[]>([]); const [mapping, setMapping] = useState<Record<string, number>>({});
  const [rows, setRows] = useState<Row[]>([]); const [done, setDone] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const base = `/orgs/${orgId}/patients/import`;
  async function inspect(file: File | undefined, separator = delimiter) {
    setRows([]); setColumns([]); setMapping({}); setDone(false); setError('');
    if (!file && !csv) return;
    setBusy(true);
    try {
      if (file && file.size > 100_000) throw new Error('O arquivo deve ter até 100 KB.');
      const text = file ? await file.text() : csv; setCsv(text);
      const result = await api.post<{ columns: string[] }>(`${base}/columns`, { csv: text, delimiter: separator }); setColumns(result.columns);
    } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível ler o arquivo.'); } finally { setBusy(false); }
  }
  async function run(commit: boolean) {
    setBusy(true); setError('');
    try {
      const result = await api.post<{ rows: Row[] }>(`${base}/${commit ? 'commit' : 'preview'}`, { csv, delimiter, mapping }); setRows(result.rows); setDone(commit);
      if (commit) await qc.invalidateQueries({ queryKey: ['org', orgId, 'patients'] });
    } catch (e) { setError(e instanceof Error ? e.message : 'Falha na importação.'); } finally { setBusy(false); }
  }
  return <><Button variant="secondary" onClick={() => setOpen(true)}>Importar CSV</Button><Dialog open={open} onClose={() => { if (!busy) setOpen(false); }} title="Importar pacientes" size="lg" description="Até 500 pacientes por arquivo UTF-8. Duplicados por CPF ou nome e nascimento serão ignorados. Nenhuma linha inválida será gravada.">
    <div className="space-y-4">
      <Field label="Separador" required>{p => <Select {...p} disabled={busy} value={delimiter} onChange={e => { setDelimiter(e.target.value); void inspect(undefined, e.target.value); }}><option value=";">Ponto e vírgula</option><option value=",">Vírgula</option><option value={'\t'}>Tabulação</option></Select>}</Field>
      <Field label="Arquivo CSV com cabeçalho" required>{p => <Input {...p} type="file" accept=".csv,text/csv" disabled={busy} onChange={e => void inspect(e.target.files?.[0])} />}</Field>
      {!!columns.length && <div className="grid gap-3 sm:grid-cols-2">{Object.entries(fields).map(([key, label]) => <Field key={key} label={label} required={key === 'fullName'}>{p => <Select {...p} disabled={busy || done} value={mapping[key] ?? ''} onChange={e => { const next = { ...mapping }; if (e.target.value === '') delete next[key]; else next[key] = Number(e.target.value); setMapping(next); setRows([]); }}><option value="">Não importar</option>{columns.map((c, i) => <option key={i} value={i}>{i + 1}. {c}</option>)}</Select>}</Field>)}</div>}
      <FormError message={error} />
      {!!rows.length && <div className="max-h-72 overflow-auto rounded-xl border border-border"><table className="w-full text-left text-sm"><thead><tr><th className="p-2">Linha</th><th>Paciente / resultado</th></tr></thead><tbody>{rows.map(r => <tr key={r.row}><td className="p-2">{r.row}</td><td className="p-2">{r.patient?.fullName && <strong className="block">{r.patient.fullName}</strong>}{r.message}</td></tr>)}</tbody></table></div>}
      {done ? <p role="status">Importação concluída: {rows.filter(r => r.status === 'imported').length} criados, {rows.filter(r => r.status === 'skipped').length} ignorados.</p> : <div className="flex gap-3"><Button disabled={busy || mapping.fullName === undefined} onClick={() => void run(false)}>Validar e visualizar</Button>{!!rows.length && <Button disabled={busy || rows.some(r => r.status === 'invalid') || !rows.some(r => r.status === 'ready')} onClick={() => void run(true)}>Confirmar importação</Button>}</div>}
    </div>
  </Dialog></>;
}
