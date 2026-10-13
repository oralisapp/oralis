'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Circle, ClipboardList, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Badge, Card, EmptyState, ErrorState, LoadingBlock, PageHeader } from '@/components/ui/feedback';
import { Field, FormError, Input, Select, Textarea } from '@/components/ui/field';
import { ApiError, api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { type Task, useMembers, useTasks } from '@/lib/queries';
import { useOrg } from '@/lib/session';

const ORIGIN: Record<string, string> = { manual: 'Manual', system: 'Sistema', automation: 'Automação', patient_link: 'Paciente (link)', patient_portal: 'Portal do paciente' };

function relatedHref(t: Task): string | null {
  if (t.relatedType === 'appointment') return `/app/agenda`;
  if (t.relatedType === 'patient' && t.relatedId) return `/app/pacientes/${t.relatedId}`;
  if (t.relatedType === 'quote' || t.relatedType === 'treatment_plan') return `/app/tratamentos`;
  if (t.relatedType === 'receivable') return `/app/financeiro`;
  if (t.relatedType === 'inventory_item') return `/app/estoque`;
  if (t.relatedType === 'laboratory_order') return `/app/laboratorios`;
  return null;
}

function NewTask({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { orgId, can } = useOrg();
  const qc = useQueryClient();
  const members = useMembers(can('team.read'));
  const [f, setF] = useState({ title: '', description: '', dueAt: '', assigneeMembershipId: '' });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.post(`/orgs/${orgId}/tasks`, { ...f, dueAt: f.dueAt ? new Date(f.dueAt).toISOString() : undefined }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['org', orgId] });
      setF({ title: '', description: '', dueAt: '', assigneeMembershipId: '' });
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Erro ao salvar.'),
  });
  return (
    <Dialog open={open} onClose={onClose} title="Nova tarefa" footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button type="submit" form="task-form" loading={save.isPending}>Criar</Button></>}>
      <form id="task-form" noValidate className="space-y-4" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <FormError message={error} />
        <Field label="Título" required>{(p) => <Input {...p} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />}</Field>
        <Field label="Descrição">{(p) => <Textarea {...p} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Prazo">{(p) => <Input {...p} type="datetime-local" value={f.dueAt} onChange={(e) => setF({ ...f, dueAt: e.target.value })} />}</Field>
          <Field label="Responsável">{(p) => <Select {...p} value={f.assigneeMembershipId} onChange={(e) => setF({ ...f, assigneeMembershipId: e.target.value })}><option value="">Toda a equipe</option>{members.data?.map((m) => <option key={m.membershipId} value={m.membershipId}>{m.name}</option>)}</Select>}</Field>
        </div>
      </form>
    </Dialog>
  );
}

export default function TasksPage() {
  const { orgId, unit } = useOrg();
  const qc = useQueryClient();
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [status, setStatus] = useState<'open' | 'done'>('open');
  const [creating, setCreating] = useState(false);
  const q = useTasks(scope, status);
  const toggle = useMutation({
    mutationFn: (t: Task) => api.put(`/orgs/${orgId}/tasks/${t.id}/status`, { status: t.status === 'open' ? 'done' : 'open' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['org', orgId] }),
  });
  const tz = unit?.timezone ?? 'America/Sao_Paulo';
  const now = new Date();
  return (
    <>
      <PageHeader title="Tarefas" description="Pendências da equipe — criadas por pessoas, pelo sistema, por automações e por pedidos de pacientes." actions={<Button icon={<Plus className="size-4" aria-hidden />} onClick={() => setCreating(true)}>Nova tarefa</Button>} />
      <Card>
        <div className="flex flex-wrap gap-2 border-b border-border px-4 py-3">
          {(['mine', 'all'] as const).map((s) => <Button key={s} size="sm" variant={scope === s ? 'soft' : 'ghost'} onClick={() => setScope(s)}>{s === 'mine' ? 'Para mim e meu papel' : 'Todas'}</Button>)}
          <span className="mx-2 w-px bg-border" aria-hidden />
          {(['open', 'done'] as const).map((s) => <Button key={s} size="sm" variant={status === s ? 'soft' : 'ghost'} onClick={() => setStatus(s)}>{s === 'open' ? 'Abertas' : 'Concluídas'}</Button>)}
        </div>
        {q.isLoading && <LoadingBlock />}
        {q.error && <ErrorState error={q.error} />}
        {q.data && q.data.length === 0 && <EmptyState icon={<ClipboardList className="size-5" aria-hidden />} title={status === 'open' ? 'Nada pendente' : 'Nenhuma tarefa concluída'} />}
        <ul className="divide-y divide-border">
          {q.data?.map((t) => {
            const overdue = t.status === 'open' && t.dueAt && new Date(t.dueAt) < now;
            const href = relatedHref(t);
            return (
              <li key={t.id} className="flex items-start gap-3 px-5 py-3">
                <button type="button" onClick={() => toggle.mutate(t)} aria-label={t.status === 'open' ? `Concluir: ${t.title}` : `Reabrir: ${t.title}`} className="mt-0.5 text-muted hover:text-accent">
                  {t.status === 'open' ? <Circle className="size-5" aria-hidden /> : <CheckCircle2 className="size-5 text-accent" aria-hidden />}
                </button>
                <div className="min-w-0 flex-1">
                  <p className={`font-semibold ${t.status !== 'open' ? 'text-muted line-through' : ''}`}>{t.title}</p>
                  {t.description && <p className="whitespace-pre-line text-sm text-muted">{t.description}</p>}
                  <p className="mt-1 flex flex-wrap gap-2 text-xs text-subtle">
                    <Badge>{ORIGIN[t.origin] ?? t.origin}</Badge>
                    {t.assigneeName ? <span>Para {t.assigneeName}</span> : t.assigneeRoleKey ? <span>Para a recepção</span> : <span>Para a equipe</span>}
                    {t.dueAt && <span className={overdue ? 'font-semibold text-danger' : ''}>Prazo {fmtDateTime(t.dueAt, tz)}</span>}
                    {href && <Link href={href} className="font-semibold text-primary-text hover:underline">Abrir registro</Link>}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      </Card>
      <NewTask open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
