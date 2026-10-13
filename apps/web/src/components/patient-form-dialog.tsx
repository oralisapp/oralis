'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/feedback';
import { Field, FormError, Input, Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';
import { fmtCivilDate, fmtCpf, fmtPhone } from '@/lib/format';
import type { PatientDetail } from '@/lib/queries';
import { useOrg } from '@/lib/session';

interface Candidate {
  id: string;
  fullName: string;
  birthDate: string | null;
}

const EMPTY = { fullName: '', socialName: '', birthDate: '', cpf: '', phone: '', email: '', administrativeNotes: '' };

/**
 * Cadastro e edição do paciente. Detecta duplicidade: CPF igual bloqueia;
 * mesmo nome + nascimento pede confirmação explícita.
 */
export function PatientFormDialog({
  open,
  onClose,
  patient,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  patient?: PatientDetail['patient'];
  onSaved?: (id: string, fullName: string) => void;
}) {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<{ candidates: Candidate[]; blocking: boolean } | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setError(null);
    setDuplicates(null);
    setForm(
      patient
        ? {
            fullName: patient.fullName,
            socialName: patient.socialName ?? '',
            birthDate: patient.birthDate ?? '',
            cpf: patient.cpf ? fmtCpf(patient.cpf) : '',
            phone: patient.phone ? fmtPhone(patient.phone) : '',
            email: patient.email ?? '',
            administrativeNotes: patient.administrativeNotes ?? '',
          }
        : EMPTY,
    );
  }, [open, patient]);

  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function save(allowDuplicate: boolean) {
    setPending(true);
    setError(null);
    setErrors({});
    try {
      const result = patient
        ? await api.put<{ id: string }>(`/orgs/${orgId}/patients/${patient.id}`, { ...form, version: patient.version })
        : await api.post<{ id: string }>(`/orgs/${orgId}/patients${allowDuplicate ? '?allowPossibleDuplicate=true' : ''}`, form);
      await qc.invalidateQueries({ queryKey: ['org', orgId] });
      toast({ tone: 'success', title: patient ? 'Cadastro atualizado' : 'Paciente cadastrado' });
      onSaved?.(result.id, form.fullName.trim());
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'duplicate_patient') {
        const d = (err.details ?? {}) as { candidates?: Candidate[]; blocking?: boolean };
        setDuplicates({ candidates: d.candidates ?? [], blocking: !!d.blocking });
      } else if (err instanceof ApiError) {
        setErrors(err.fieldErrors);
        setError(Object.keys(err.fieldErrors).length ? null : err.message);
      } else setError('Não foi possível salvar.');
    } finally {
      setPending(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void save(false);
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={patient ? 'Editar cadastro' : 'Novo paciente'}
      description="Dados de identificação e contato. Informações clínicas ficam no prontuário."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="patient-form" loading={pending}>
            {patient ? 'Salvar alterações' : 'Cadastrar paciente'}
          </Button>
        </>
      }
    >
      <form id="patient-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <div className="sm:col-span-2 space-y-3">
          <FormError message={error} />
          {duplicates && (
            <Notice tone={duplicates.blocking ? 'danger' : 'warning'} title={duplicates.blocking ? 'Já existe um paciente com este CPF' : 'Possível cadastro duplicado'}>
              <ul className="mt-1 space-y-1">
                {duplicates.candidates.map((c) => (
                  <li key={c.id}>
                    <Link href={`/app/pacientes/${c.id}`} className="font-semibold underline" onClick={onClose}>
                      {c.fullName}
                    </Link>{' '}
                    · nascimento {fmtCivilDate(c.birthDate)}
                  </li>
                ))}
              </ul>
              {!duplicates.blocking && (
                <Button size="sm" variant="secondary" className="mt-2" loading={pending} onClick={() => save(true)}>
                  É outra pessoa — cadastrar mesmo assim
                </Button>
              )}
            </Notice>
          )}
        </div>
        <Field label="Nome completo" required error={errors.fullName} className="sm:col-span-2">
          {(p) => <Input {...p} autoComplete="off" value={form.fullName} onChange={set('fullName')} />}
        </Field>
        <Field label="Nome social" error={errors.socialName} hint="Quando informado, é o nome usado no atendimento.">
          {(p) => <Input {...p} value={form.socialName} onChange={set('socialName')} />}
        </Field>
        <Field label="Data de nascimento" error={errors.birthDate}>
          {(p) => <Input {...p} type="date" value={form.birthDate} onChange={set('birthDate')} />}
        </Field>
        <Field label="Celular / telefone" error={errors.phone}>
          {(p) => <Input {...p} type="tel" inputMode="tel" value={form.phone} onChange={set('phone')} placeholder="(11) 90000-0000" />}
        </Field>
        <Field label="E-mail" error={errors.email}>
          {(p) => <Input {...p} type="email" value={form.email} onChange={set('email')} />}
        </Field>
        <Field label="CPF" error={errors.cpf} hint="Usado para evitar cadastros duplicados.">
          {(p) => <Input {...p} inputMode="numeric" value={form.cpf} onChange={set('cpf')} placeholder="000.000.000-00" />}
        </Field>
        <Field label="Observações administrativas" error={errors.administrativeNotes} className="sm:col-span-2" hint="Ex.: preferências de horário. Não registre informações clínicas aqui.">
          {(p) => <Textarea {...p} value={form.administrativeNotes} onChange={set('administrativeNotes')} maxLength={1000} />}
        </Field>
      </form>
    </Dialog>
  );
}
