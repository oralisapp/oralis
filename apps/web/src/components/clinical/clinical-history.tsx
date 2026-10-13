'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FilePlus2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, EmptyState, ErrorState, LoadingBlock } from '@/components/ui/feedback';
import { api } from '@/lib/api';
import { useOrgQuery, useServices } from '@/lib/queries';
import { useOrg } from '@/lib/session';
import { AlertsPanel, type AnamnesisState, AnamnesisPanel, type ClinicalAlert } from './clinical-panels';
import { type DraftRecord, RecordEditor } from './record-editor';
import { type ClinicalRecordView, RecordView } from './record-view';

interface History {
  records: (ClinicalRecordView & DraftRecord)[];
  alerts: ClinicalAlert[];
  anamnesis: AnamnesisState;
}

/** Histórico clínico do paciente na ficha (leitura auditada) + evolução avulsa. */
export function ClinicalHistory({ patientId }: { patientId: string }) {
  const { orgId, can, unit, membership } = useOrg();
  const qc = useQueryClient();
  const q = useOrgQuery<History>(['clinical-history', patientId], `/patients/${patientId}/clinical`, can('clinical.read'), false);
  const services = useServices();
  const [error, setError] = useState<string | null>(null);
  const tz = unit?.timezone ?? 'America/Sao_Paulo';
  const create = useMutation({
    mutationFn: () => api.post(`/orgs/${orgId}/patients/${patientId}/clinical-records`, { unitId: unit?.id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['org', orgId, 'clinical-history', patientId] }),
    onError: () => setError('Apenas profissionais cadastrados (com usuário vinculado) registram evoluções.'),
  });
  if (q.isLoading) return <Card><LoadingBlock rows={4} /></Card>;
  if (q.error || !q.data) return <Card><ErrorState error={q.error} /></Card>;
  const canWrite = can('clinical.write');
  const drafts = q.data.records.filter((r) => r.status === 'draft');
  const finalized = q.data.records.filter((r) => r.status === 'finalized');
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <Card>
        <CardHeader
          title="Evoluções"
          description="Registros finalizados de todas as unidades, do mais recente ao mais antigo."
          actions={canWrite && membership.professionalId && <Button size="sm" variant="secondary" icon={<FilePlus2 className="size-4" aria-hidden />} loading={create.isPending} onClick={() => create.mutate()}>Evolução avulsa</Button>}
        />
        <div className="space-y-4 p-5">
          {error && <p className="text-sm text-danger">{error}</p>}
          {drafts.map((r) => (
            <div key={r.id} className="rounded-xl border border-warning/40 p-4">
              <p className="mb-3 text-xs font-semibold text-warning">Seu rascunho</p>
              <RecordEditor record={r} services={services.data?.filter((s) => s.active) ?? []} tz={tz} onFinalized={() => qc.invalidateQueries({ queryKey: ['org', orgId, 'clinical-history', patientId] })} />
            </div>
          ))}
          {finalized.map((r) => <RecordView key={r.id} record={r} canAmend={canWrite} />)}
          {!q.data.records.length && <EmptyState icon={<FilePlus2 className="size-5" aria-hidden />} title="Nenhuma evolução registrada" />}
        </div>
      </Card>
      <div className="space-y-4">
        <Card className="p-5"><h2 className="mb-3 text-sm font-bold">Alertas clínicos</h2><AlertsPanel patientId={patientId} alerts={q.data.alerts} canWrite={canWrite} tz={tz} /></Card>
        <Card className="p-5"><h2 className="mb-3 text-sm font-bold">Anamnese</h2><AnamnesisPanel patientId={patientId} state={q.data.anamnesis} canWrite={canWrite} tz={tz} /></Card>
      </div>
    </div>
  );
}
