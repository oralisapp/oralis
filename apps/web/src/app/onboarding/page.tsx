'use client';

import { type BusinessHoursInput, UF_LIST } from '@oralis/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Building2, Clock } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { Logo, ThemeToggle } from '@/components/brand';
import { BR_TIMEZONES, DEFAULT_HOURS, HoursEditor } from '@/components/hours-editor';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/feedback';
import { Field, FormError, Input, Select } from '@/components/ui/field';
import { ApiError, api } from '@/lib/api';
import { meQueryKey, useMe } from '@/lib/session';

/**
 * Primeiro passo depois do cadastro: dados da clínica, primeira unidade e
 * horário de funcionamento. As demais etapas aparecem no checklist
 * "Começar com o Oralis" da visão geral.
 */
export default function OnboardingPage() {
  return (
    <Suspense>
      <Onboarding />
    </Suspense>
  );
}

function Onboarding() {
  const router = useRouter();
  const params = useSearchParams();
  const planKey = params.get('plano') ?? undefined;
  const qc = useQueryClient();
  const me = useMe();
  const [name, setName] = useState('');
  const [unit, setUnit] = useState({ name: 'Unidade principal', timezone: 'America/Sao_Paulo', phone: '', city: '', state: '' });
  const [hours, setHours] = useState<BusinessHoursInput>(DEFAULT_HOURS);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) router.replace('/entrar?voltar=/onboarding');
  }, [me.error, router]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    setErrors({});
    try {
      const r = await api.post<{ organizationId: string }>('/orgs', { name, unit, businessHours: hours, planKey });
      try {
        localStorage.setItem('oralis.activeOrg', r.organizationId);
      } catch {
        // opcional
      }
      await qc.invalidateQueries({ queryKey: meQueryKey });
      router.replace('/app/visao-geral');
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fieldErrors);
        setError(err.message);
      } else setError('Não foi possível criar a clínica.');
      setPending(false);
    }
  }

  return (
    <div className="min-h-dvh">
      <header className="flex items-center justify-between border-b border-border bg-surface px-4 py-3 sm:px-8">
        <Logo />
        <ThemeToggle />
      </header>
      <main className="mx-auto max-w-3xl px-4 py-8 sm:py-12">
        <p className="text-sm font-semibold text-primary-text">Bem-vindo(a){me.data ? `, ${me.data.user.name.split(' ')[0]}` : ''}</p>
        <h1 className="mt-1 text-3xl font-extrabold tracking-tight">Vamos configurar a sua clínica</h1>
        <p className="mt-2 text-muted">Leva poucos minutos. Tudo pode ser alterado depois em Configurações.{planKey ? ` Plano escolhido: ${planKey} (começa em avaliação, sem cobrança).` : ''}</p>

        <form onSubmit={submit} className="mt-8 space-y-6" noValidate>
          <FormError message={error} />
          <Card className="p-5 sm:p-6">
            <div className="mb-5 flex items-center gap-2">
              <Building2 className="size-5 text-primary" aria-hidden />
              <h2 className="font-bold">Clínica e primeira unidade</h2>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Nome da clínica" required error={errors.name} className="sm:col-span-2">
                {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Clínica Sorriso Pleno" />}
              </Field>
              <Field label="Nome da unidade" required error={errors['unit.name']} hint="Útil quando houver mais de um endereço.">
                {(p) => <Input {...p} value={unit.name} onChange={(e) => setUnit({ ...unit, name: e.target.value })} />}
              </Field>
              <Field label="Fuso horário" required error={errors['unit.timezone']} hint="A agenda desta unidade usa este fuso.">
                {(p) => (
                  <Select {...p} value={unit.timezone} onChange={(e) => setUnit({ ...unit, timezone: e.target.value })}>
                    {BR_TIMEZONES.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Telefone da unidade" error={errors['unit.phone']}>
                {(p) => <Input {...p} type="tel" inputMode="tel" value={unit.phone} onChange={(e) => setUnit({ ...unit, phone: e.target.value })} placeholder="(11) 3000-0000" />}
              </Field>
              <div className="grid grid-cols-[1fr_90px] gap-3">
                <Field label="Cidade" error={errors['unit.city']}>
                  {(p) => <Input {...p} value={unit.city} onChange={(e) => setUnit({ ...unit, city: e.target.value })} />}
                </Field>
                <Field label="UF" error={errors['unit.state']}>
                  {(p) => (
                    <Select {...p} value={unit.state} onChange={(e) => setUnit({ ...unit, state: e.target.value })}>
                      <option value="">—</option>
                      {UF_LIST.map((uf) => (
                        <option key={uf}>{uf}</option>
                      ))}
                    </Select>
                  )}
                </Field>
              </div>
            </div>
          </Card>

          <Card className="p-5 sm:p-6">
            <div className="mb-1 flex items-center gap-2">
              <Clock className="size-5 text-primary" aria-hidden />
              <h2 className="font-bold">Horário de funcionamento</h2>
            </div>
            <p className="mb-4 text-sm text-muted">A agenda só aceita consultas dentro destes intervalos. Use dois intervalos para registrar o horário de almoço.</p>
            <HoursEditor value={hours} onChange={setHours} />
            {errors.businessHours && <p className="mt-2 text-sm text-danger">{errors.businessHours}</p>}
          </Card>

          <div className="flex justify-end">
            <Button type="submit" loading={pending}>
              Criar clínica e continuar
            </Button>
          </div>
        </form>
      </main>
    </div>
  );
}
