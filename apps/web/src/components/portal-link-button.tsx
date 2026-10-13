'use client';

import { useMutation } from '@tanstack/react-query';
import { Check, Copy, KeyRound } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/feedback';
import { Input } from '@/components/ui/field';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/session';

const DELIVERY: Record<string, string> = {
  sent: 'Link enviado ao e-mail do paciente.',
  queued_retry: 'O e-mail falhou e será reenviado automaticamente.',
  logged_locally: 'E-mail não configurado neste ambiente (caixa de saída local).',
  not_allowed: 'O paciente recusou avisos por e-mail: envie por outro canal autorizado.',
  no_email: 'Paciente sem e-mail cadastrado.',
  not_requested: 'Copie o link e envie ao paciente.',
};

/** Gera o link de acesso ao portal (uso único, 7 dias). */
export function PortalLinkButton({ patientId }: { patientId: string }) {
  const { orgId, can } = useOrg();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const gen = useMutation({ mutationFn: (sendEmail: boolean) => api.post<{ url: string; emailDelivery: string }>(`/orgs/${orgId}/patients/${patientId}/portal-link`, { sendEmail }) });
  if (!can('patients.write')) return null;
  return (
    <>
      <Button variant="secondary" size="sm" icon={<KeyRound className="size-4" aria-hidden />} onClick={() => { setOpen(true); gen.reset(); setCopied(false); }}>Acesso ao portal</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Acesso ao portal do paciente" description="O link vale por 7 dias e funciona uma única vez. O paciente vê só consultas, planos e documentos que a clínica disponibilizou.">
        {!gen.data ? (
          <div className="flex gap-2">
            <Button loading={gen.isPending && gen.variables === true} onClick={() => gen.mutate(true)}>Enviar por e-mail</Button>
            <Button variant="secondary" loading={gen.isPending && gen.variables === false} onClick={() => gen.mutate(false)}>Só gerar link</Button>
          </div>
        ) : (
          <div className="space-y-3">
            <Notice tone="info">{DELIVERY[gen.data.emailDelivery] ?? ''}</Notice>
            <div className="flex gap-2">
              <Input readOnly value={gen.data.url} aria-label="Link do portal" onFocus={(e) => e.target.select()} />
              <Button variant="secondary" icon={copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />} onClick={async () => { await navigator.clipboard.writeText(gen.data!.url).catch(() => {}); setCopied(true); }}>{copied ? 'Copiado' : 'Copiar'}</Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
