'use client';

import { TREATMENT_PLAN_STATUS_LABEL } from '@oralis/shared';
import { useMutation } from '@tanstack/react-query';
import { ClipboardList, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Badge, Card, CardHeader, EmptyState, LoadingBlock } from '@/components/ui/feedback';
import { Field, FormError, Input, Select, Textarea } from '@/components/ui/field';
import { ApiError, api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { usePatientPlans, useProfessionals } from '@/lib/queries';
import { useOrg } from '@/lib/session';

export function PatientPlans({ patientId }: { patientId: string }) {
  const { orgId, can, unit, membership } = useOrg();
  const router = useRouter();
  const q = usePatientPlans(patientId, can('treatments.read'));
  const profs = useProfessionals();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ title: '', objective: '', responsibleProfessionalId: membership.professionalId ?? '' });
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>(`/orgs/${orgId}/patients/${patientId}/treatment-plans`, { ...f, unitId: unit?.id, responsibleProfessionalId: f.responsibleProfessionalId || undefined, objective: f.objective || undefined }),
    onSuccess: (r) => router.push(`/app/tratamentos/${r.id}`),
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Erro'),
  });
  const tz = unit?.timezone ?? 'America/Sao_Paulo';
  return (
    <Card>
      <CardHeader title="Planos de tratamento" actions={can('treatments.write') && <Button size="sm" icon={<Plus className="size-4" aria-hidden />} onClick={() => setOpen(true)}>Novo plano</Button>} />
      {q.isLoading && <LoadingBlock rows={2} />}
      {q.data && q.data.length === 0 && <EmptyState icon={<ClipboardList className="size-5" aria-hidden />} title="Nenhum plano de tratamento" />}
      <ul className="divide-y divide-border">
        {q.data?.map((p) => (
          <li key={p.id}>
            <Link href={`/app/tratamentos/${p.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-surface-2">
              <div className="flex-1"><p className="font-semibold">{p.title}</p><p className="text-xs text-muted">{fmtDateTime(p.createdAt, tz)}{p.responsibleName ? ` · ${p.responsibleName}` : ''}</p></div>
              <Badge>{TREATMENT_PLAN_STATUS_LABEL[p.status]}</Badge>
            </Link>
          </li>
        ))}
      </ul>
      <Dialog open={open} onClose={() => setOpen(false)} title="Novo plano de tratamento" footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancelar</Button><Button loading={create.isPending} onClick={() => create.mutate()}>Criar e montar etapas</Button></>}>
        <div className="space-y-4">
          <FormError message={error} />
          <Field label="Título" required>{(p) => <Input {...p} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Ex.: Reabilitação do lado esquerdo" />}</Field>
          <Field label="Objetivo (para o paciente)" hint="Linguagem simples; sem promessas de resultado.">{(p) => <Textarea {...p} rows={3} value={f.objective} onChange={(e) => setF({ ...f, objective: e.target.value })} />}</Field>
          <Field label="Profissional responsável">{(p) => <Select {...p} value={f.responsibleProfessionalId} onChange={(e) => setF({ ...f, responsibleProfessionalId: e.target.value })}><option value="">—</option>{profs.data?.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.displayName}</option>)}</Select>}</Field>
        </div>
      </Dialog>
    </Card>
  );
}
