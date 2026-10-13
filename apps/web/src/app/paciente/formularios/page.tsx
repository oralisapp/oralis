'use client';

import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, LoadingBlock, Notice } from '@/components/ui/feedback';
import { Field, FormError, Select, Textarea } from '@/components/ui/field';
import { ApiError, api } from '@/lib/api';
import { usePortalQuery } from '@/lib/portal';

interface Q { id: string; label: string; type: 'yesno' | 'text' | 'choice'; options?: string[] }

/** Formulário de saúde respondido pelo paciente: chega à clínica para revisão profissional. */
export default function PortalForms() {
  const q = usePortalQuery<{ id: string; name: string; questions: Q[] }[]>('forms', '/forms');
  const [answers, setAnswers] = useState<Record<string, string | boolean | null>>({});
  const [sent, setSent] = useState(false);
  const form = q.data?.[0];
  const send = useMutation({ mutationFn: () => api.post('/portal/forms/anamnesis', { templateId: form!.id, answers }), onSuccess: () => setSent(true) });
  if (q.isLoading || !form) return <LoadingBlock rows={4} />;
  if (sent) return <Notice tone="accent" title="Respostas enviadas">Obrigado! O profissional vai revisar suas respostas com você na consulta.</Notice>;
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-extrabold">{form.name}</h1>
      <Notice tone="info">Suas respostas ajudam no atendimento e só entram no prontuário depois de revisadas pelo profissional. Responda o que souber.</Notice>
      <Card className="space-y-4 p-5">
        <FormError message={send.error instanceof ApiError ? send.error.message : null} />
        {form.questions.map((qu) =>
          qu.type === 'yesno' ? (
            <fieldset key={qu.id}>
              <legend className="text-sm font-semibold">{qu.label}</legend>
              <div className="mt-1 flex gap-4 text-sm">{[true, false].map((v) => <label key={String(v)} className="flex items-center gap-1.5"><input type="radio" name={qu.id} checked={answers[qu.id] === v} onChange={() => setAnswers({ ...answers, [qu.id]: v })} className="accent-[var(--primary)]" />{v ? 'Sim' : 'Não'}</label>)}</div>
            </fieldset>
          ) : qu.type === 'choice' ? (
            <Field key={qu.id} label={qu.label}>{(p) => <Select {...p} value={(answers[qu.id] as string) ?? ''} onChange={(e) => setAnswers({ ...answers, [qu.id]: e.target.value || null })}><option value="">—</option>{qu.options?.map((o) => <option key={o}>{o}</option>)}</Select>}</Field>
          ) : (
            <Field key={qu.id} label={qu.label}>{(p) => <Textarea {...p} rows={2} value={(answers[qu.id] as string) ?? ''} onChange={(e) => setAnswers({ ...answers, [qu.id]: e.target.value || null })} />}</Field>
          ),
        )}
        <Button loading={send.isPending} onClick={() => send.mutate()}>Enviar respostas</Button>
      </Card>
    </div>
  );
}
