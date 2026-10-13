'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Loader2, MailCheck } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { Logo } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Card, Notice } from '@/components/ui/feedback';
import { Field, FormError, Input } from '@/components/ui/field';
import { ApiError, api } from '@/lib/api';

function Access() {
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const token = params.get('token');
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const tried = useRef(false);

  useEffect(() => {
    if (!token || tried.current) return;
    tried.current = true;
    api.post('/portal/access', { token }).then(
      async () => {
        await qc.invalidateQueries({ queryKey: ['portal'] });
        router.replace('/paciente/inicio');
      },
      (e) => setError(e instanceof ApiError ? e.message : 'Não foi possível entrar.'),
    );
  }, [token, router, qc]);

  async function request(e: FormEvent) {
    e.preventDefault();
    await api.post('/portal/request-link', { email }).catch(() => {});
    setSent(true);
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <Logo />
        <Card className="mt-6 p-6">
          <h1 className="text-xl font-extrabold">Portal do paciente</h1>
          {token && !error ? (
            <p className="mt-4 flex items-center gap-2 text-muted"><Loader2 className="size-4 animate-spin" aria-hidden /> Entrando…</p>
          ) : sent ? (
            <div className="mt-4"><Notice tone="accent" icon={<MailCheck className="size-5" aria-hidden />} title="Verifique seu e-mail">Se o seu e-mail estiver cadastrado em uma clínica, você receberá um link de acesso válido por 7 dias.</Notice></div>
          ) : (
            <form onSubmit={request} className="mt-4 space-y-4" noValidate>
              <FormError message={error} />
              <p className="text-sm text-muted">Informe o e-mail que você deixou na clínica para receber um link de acesso. Não é preciso senha.</p>
              <Field label="E-mail" required>{(p) => <Input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
              <Button type="submit" className="w-full" disabled={!email.includes('@')}>Receber link de acesso</Button>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}

export default function AccessPage() {
  return (
    <Suspense>
      <Access />
    </Suspense>
  );
}
