'use client';

import { type BusinessHoursInput, UF_LIST, WEEKDAY_LABEL } from '@oralis/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Armchair, Building2, Pencil, Plus, ShieldCheck, Stethoscope, Tag } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { BR_TIMEZONES, DEFAULT_HOURS, HoursEditor } from '@/components/hours-editor';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Badge, Card, EmptyState, ErrorState, LoadingBlock, PageHeader } from '@/components/ui/feedback';
import { Checkbox, Field, FormError, Input, Select } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';
import { fmtMoney, fmtPhone } from '@/lib/format';
import { type Chair, type Professional, type Service, type Unit, useChairs, useMembers, useOrgQuery, useProfessionals, useServices, useUnits } from '@/lib/queries';
import { useOrg } from '@/lib/session';

type Section = 'unidades' | 'profissionais' | 'cadeiras' | 'servicos' | 'seguranca';

/** Salva via API, trata erros por campo e invalida as consultas da organização. */
function useSaver() {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const reset = () => {
    setErrors({});
    setError(null);
  };
  async function run(fn: () => Promise<unknown>, successTitle: string, done: () => void) {
    setPending(true);
    reset();
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['org', orgId] });
      await qc.invalidateQueries({ queryKey: ['me'] });
      toast({ tone: 'success', title: successTitle });
      done();
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fieldErrors);
        setError(err.message);
      } else setError('Não foi possível salvar.');
    } finally {
      setPending(false);
    }
  }
  return { orgId, errors, error, pending, run, reset };
}

function hoursSummary(hours: BusinessHoursInput) {
  const days = [1, 2, 3, 4, 5, 6, 0].filter((d) => hours.some((h) => h.weekday === d));
  if (!days.length) return 'Sem horário configurado';
  return days.map((d) => `${WEEKDAY_LABEL[d]!.slice(0, 3)} ${hours.filter((h) => h.weekday === d).map((h) => `${h.opensAt}–${h.closesAt}`).join(', ')}`).join(' · ');
}

function SaveFooter({ onClose, pending, form }: { onClose: () => void; pending: boolean; form: string }) {
  return (
    <>
      <Button variant="ghost" onClick={onClose}>
        Cancelar
      </Button>
      <Button type="submit" form={form} loading={pending}>
        Salvar
      </Button>
    </>
  );
}

// ------------------------------------------------------------------ Unidades

function UnitDialog({ unit, open, onClose }: { unit: Unit | null; open: boolean; onClose: () => void }) {
  const s = useSaver();
  const [form, setForm] = useState({ name: '', timezone: 'America/Sao_Paulo', phone: '', addressLine: '', city: '', state: '' });
  const [hours, setHours] = useState<BusinessHoursInput>(DEFAULT_HOURS);
  useEffect(() => {
    if (!open) return;
    s.reset();
    setForm(unit ? { name: unit.name, timezone: unit.timezone, phone: unit.phone ? fmtPhone(unit.phone) : '', addressLine: unit.addressLine ?? '', city: unit.city ?? '', state: unit.state ?? '' } : { name: '', timezone: 'America/Sao_Paulo', phone: '', addressLine: '', city: '', state: '' });
    setHours(unit ? unit.businessHours : DEFAULT_HOURS);
  }, [open, unit]);

  const submit = () =>
    s.run(
      async () => {
        if (unit) {
          await api.put(`/orgs/${s.orgId}/units/${unit.id}`, form);
          await api.put(`/orgs/${s.orgId}/units/${unit.id}/hours`, hours);
        } else await api.post(`/orgs/${s.orgId}/units`, { unit: form, businessHours: hours });
      },
      unit ? 'Unidade atualizada' : 'Unidade criada',
      onClose,
    );

  return (
    <Dialog open={open} onClose={onClose} size="lg" title={unit ? `Unidade ${unit.name}` : 'Nova unidade'} footer={<SaveFooter onClose={onClose} pending={s.pending} form="unit-form" />}>
      <form id="unit-form" noValidate className="space-y-5" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <FormError message={s.error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nome" required error={s.errors.name ?? s.errors['unit.name']}>
            {(p) => <Input {...p} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}
          </Field>
          <Field label="Fuso horário" required>
            {(p) => (
              <Select {...p} value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
                {BR_TIMEZONES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Telefone" error={s.errors.phone ?? s.errors['unit.phone']}>
            {(p) => <Input {...p} type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />}
          </Field>
          <Field label="Endereço">
            {(p) => <Input {...p} value={form.addressLine} onChange={(e) => setForm({ ...form, addressLine: e.target.value })} />}
          </Field>
          <Field label="Cidade">
            {(p) => <Input {...p} value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />}
          </Field>
          <Field label="UF">
            {(p) => (
              <Select {...p} value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })}>
                <option value="">—</option>
                {UF_LIST.map((uf) => <option key={uf}>{uf}</option>)}
              </Select>
            )}
          </Field>
        </div>
        <div>
          <p className="mb-2 text-[13px] font-semibold">Horário de funcionamento</p>
          <HoursEditor value={hours} onChange={setHours} />
          <p className="mt-2 text-xs text-muted">Alterar o horário não move consultas já marcadas; novas consultas passam a respeitar o novo horário.</p>
        </div>
      </form>
    </Dialog>
  );
}

function UnitsSection() {
  const { can, membership } = useOrg();
  const units = useUnits();
  const [editing, setEditing] = useState<Unit | null | 'new'>(null);
  const manage = can('units.manage');
  return (
    <SectionCard
      title="Unidades e horários"
      action={manage && membership.allUnits ? <Button size="sm" icon={<Plus className="size-4" aria-hidden />} onClick={() => setEditing('new')}>Nova unidade</Button> : undefined}
      query={units}
      empty={<EmptyState icon={<Building2 className="size-5" aria-hidden />} title="Nenhuma unidade" />}
    >
      {units.data?.map((u) => (
        <li key={u.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{u.name}</p>
            <p className="text-sm text-muted">{hoursSummary(u.businessHours)}</p>
            <p className="text-xs text-subtle">Fuso: {BR_TIMEZONES.find((t) => t.id === u.timezone)?.label ?? u.timezone}</p>
          </div>
          {manage && <Button variant="secondary" size="sm" icon={<Pencil className="size-3.5" aria-hidden />} onClick={() => setEditing(u)}>Editar</Button>}
        </li>
      ))}
      <UnitDialog open={editing !== null} unit={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
    </SectionCard>
  );
}

// -------------------------------------------------------------- Profissionais

const COLORS = ['#0f766e', '#2563eb', '#9333ea', '#c2410c', '#be185d', '#4d7c0f', '#0369a1', '#a16207'];

function ProfessionalDialog({ prof, open, onClose }: { prof: Professional | null; open: boolean; onClose: () => void }) {
  const s = useSaver();
  const { can } = useOrg();
  const units = useUnits();
  const members = useMembers(can('team.read'));
  const [form, setForm] = useState({ displayName: '', membershipId: '', croNumber: '', croUf: '', specialties: '', color: COLORS[0]!, unitIds: [] as string[], active: true });
  useEffect(() => {
    if (!open) return;
    s.reset();
    setForm(
      prof
        ? { displayName: prof.displayName, membershipId: prof.membershipId ?? '', croNumber: prof.croNumber ?? '', croUf: prof.croUf ?? '', specialties: prof.specialties.join(', '), color: prof.color, unitIds: prof.unitIds, active: prof.active }
        : { displayName: '', membershipId: '', croNumber: '', croUf: '', specialties: '', color: COLORS[Math.floor(Math.random() * COLORS.length)]!, unitIds: units.data?.length === 1 ? [units.data[0]!.id] : [], active: true },
    );
  }, [open, prof]);

  const submit = () =>
    s.run(
      () => {
        const body = { ...form, specialties: form.specialties.split(',').map((x) => x.trim()).filter(Boolean) };
        return prof ? api.put(`/orgs/${s.orgId}/professionals/${prof.id}`, body) : api.post(`/orgs/${s.orgId}/professionals`, body);
      },
      prof ? 'Profissional atualizado' : 'Profissional cadastrado',
      onClose,
    );

  return (
    <Dialog open={open} onClose={onClose} size="lg" title={prof ? prof.displayName : 'Novo profissional'} footer={<SaveFooter onClose={onClose} pending={s.pending} form="prof-form" />}>
      <form id="prof-form" noValidate className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="sm:col-span-2"><FormError message={s.error} /></div>
        <Field label="Nome de exibição" required error={s.errors.displayName} className="sm:col-span-2">
          {(p) => <Input {...p} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="Ex.: Dra. Ana Lima" />}
        </Field>
        <Field label="Usuário vinculado" hint="Necessário para a pessoa iniciar os próprios atendimentos.">
          {(p) => (
            <Select {...p} value={form.membershipId} onChange={(e) => setForm({ ...form, membershipId: e.target.value })}>
              <option value="">Sem usuário (só agenda)</option>
              {members.data?.map((m) => <option key={m.membershipId} value={m.membershipId}>{m.name} · {m.roleName}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Especialidades" hint="Separe por vírgula.">
          {(p) => <Input {...p} value={form.specialties} onChange={(e) => setForm({ ...form, specialties: e.target.value })} />}
        </Field>
        <Field label="Número do CRO" error={s.errors.croNumber}>
          {(p) => <Input {...p} inputMode="numeric" value={form.croNumber} onChange={(e) => setForm({ ...form, croNumber: e.target.value })} />}
        </Field>
        <Field label="UF do CRO" error={s.errors.croUf}>
          {(p) => (
            <Select {...p} value={form.croUf} onChange={(e) => setForm({ ...form, croUf: e.target.value })}>
              <option value="">—</option>
              {UF_LIST.map((uf) => <option key={uf}>{uf}</option>)}
            </Select>
          )}
        </Field>
        <fieldset className="sm:col-span-2">
          <legend className="mb-2 text-[13px] font-semibold">Cor na agenda</legend>
          <div className="flex flex-wrap gap-2">
            {COLORS.map((c) => (
              <button key={c} type="button" onClick={() => setForm({ ...form, color: c })} aria-label={`Cor ${c}`} aria-pressed={form.color === c} className={`size-8 rounded-full ring-offset-2 ring-offset-surface ${form.color === c ? 'ring-2 ring-fg' : ''}`} style={{ background: c }} />
            ))}
          </div>
        </fieldset>
        <fieldset className="space-y-1.5 sm:col-span-2">
          <legend className="mb-1 text-[13px] font-semibold">Atende nas unidades <span className="text-danger">*</span></legend>
          {units.data?.map((u) => (
            <Checkbox key={u.id} label={u.name} checked={form.unitIds.includes(u.id)} onChange={(e) => setForm({ ...form, unitIds: e.target.checked ? [...form.unitIds, u.id] : form.unitIds.filter((x) => x !== u.id) })} />
          ))}
          {s.errors.unitIds && <p className="text-xs text-danger">{s.errors.unitIds}</p>}
        </fieldset>
        <div className="sm:col-span-2">
          <Checkbox label="Ativo" description="Profissionais inativos não recebem novos agendamentos; o histórico é preservado." checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
        </div>
      </form>
    </Dialog>
  );
}

function ProfessionalsSection() {
  const { can } = useOrg();
  const profs = useProfessionals();
  const units = useUnits();
  const [editing, setEditing] = useState<Professional | null | 'new'>(null);
  const manage = can('professionals.manage');
  return (
    <SectionCard
      title="Profissionais"
      action={manage ? <Button size="sm" icon={<Plus className="size-4" aria-hidden />} onClick={() => setEditing('new')}>Novo profissional</Button> : undefined}
      query={profs}
      empty={<EmptyState icon={<Stethoscope className="size-5" aria-hidden />} title="Nenhum profissional" description="Cada consulta da agenda pertence a um profissional." action={manage ? <Button onClick={() => setEditing('new')}>Cadastrar profissional</Button> : undefined} />}
    >
      {profs.data?.map((p) => (
        <li key={p.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
          <span className="size-3 rounded-full" style={{ background: p.color }} aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{p.displayName} {!p.active && <Badge>Inativo</Badge>}</p>
            <p className="text-sm text-muted">
              {[p.specialties.join(', '), p.croNumber && `CRO ${p.croNumber}${p.croUf ? `/${p.croUf}` : ''}`, p.unitIds.map((id) => units.data?.find((u) => u.id === id)?.name).filter(Boolean).join(', ')].filter(Boolean).join(' · ')}
            </p>
          </div>
          {p.membershipId ? <Badge tone="accent">Com acesso</Badge> : <Badge>Sem usuário</Badge>}
          {manage && <Button variant="secondary" size="sm" icon={<Pencil className="size-3.5" aria-hidden />} onClick={() => setEditing(p)}>Editar</Button>}
        </li>
      ))}
      <ProfessionalDialog open={editing !== null} prof={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
    </SectionCard>
  );
}

// ------------------------------------------------------------------ Cadeiras

function ChairDialog({ chair, open, onClose }: { chair: Chair | null; open: boolean; onClose: () => void }) {
  const s = useSaver();
  const { unit } = useOrg();
  const units = useUnits();
  const [form, setForm] = useState({ unitId: '', name: '', kind: 'chair' as 'chair' | 'room', active: true });
  useEffect(() => {
    if (!open) return;
    s.reset();
    setForm(chair ? { unitId: chair.unitId, name: chair.name, kind: chair.kind, active: chair.active } : { unitId: unit?.id ?? '', name: '', kind: 'chair', active: true });
  }, [open, chair]);
  const submit = () => s.run(() => (chair ? api.put(`/orgs/${s.orgId}/chairs/${chair.id}`, form) : api.post(`/orgs/${s.orgId}/chairs`, form)), chair ? 'Recurso atualizado' : 'Recurso cadastrado', onClose);
  return (
    <Dialog open={open} onClose={onClose} title={chair ? chair.name : 'Nova cadeira ou sala'} footer={<SaveFooter onClose={onClose} pending={s.pending} form="chair-form" />}>
      <form id="chair-form" noValidate className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <FormError message={s.error} />
        <Field label="Unidade" required error={s.errors.unitId}>
          {(p) => (
            <Select {...p} value={form.unitId} onChange={(e) => setForm({ ...form, unitId: e.target.value })}>
              {units.data?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Nome" required error={s.errors.name}>
          {(p) => <Input {...p} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ex.: Cadeira 1" />}
        </Field>
        <Field label="Tipo" required>
          {(p) => (
            <Select {...p} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as 'chair' | 'room' })}>
              <option value="chair">Cadeira odontológica</option>
              <option value="room">Sala</option>
            </Select>
          )}
        </Field>
        <Checkbox label="Ativo" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
      </form>
    </Dialog>
  );
}

function ChairsSection() {
  const { can } = useOrg();
  const chairs = useChairs();
  const units = useUnits();
  const [editing, setEditing] = useState<Chair | null | 'new'>(null);
  const manage = can('resources.manage');
  return (
    <SectionCard
      title="Cadeiras e salas"
      action={manage ? <Button size="sm" icon={<Plus className="size-4" aria-hidden />} onClick={() => setEditing('new')}>Novo recurso</Button> : undefined}
      query={chairs}
      empty={<EmptyState icon={<Armchair className="size-5" aria-hidden />} title="Nenhuma cadeira ou sala" description="Opcional, mas evita que duas consultas usem o mesmo recurso ao mesmo tempo." action={manage ? <Button onClick={() => setEditing('new')}>Cadastrar</Button> : undefined} />}
    >
      {chairs.data?.map((c) => (
        <li key={c.id} className="flex items-center gap-3 px-5 py-3">
          <div className="flex-1">
            <p className="font-semibold">{c.name} {!c.active && <Badge>Inativa</Badge>}</p>
            <p className="text-sm text-muted">{c.kind === 'room' ? 'Sala' : 'Cadeira'} · {units.data?.find((u) => u.id === c.unitId)?.name}</p>
          </div>
          {manage && <Button variant="secondary" size="sm" icon={<Pencil className="size-3.5" aria-hidden />} onClick={() => setEditing(c)}>Editar</Button>}
        </li>
      ))}
      <ChairDialog open={editing !== null} chair={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
    </SectionCard>
  );
}

// ------------------------------------------------------------------ Serviços

function ServiceDialog({ service, open, onClose }: { service: Service | null; open: boolean; onClose: () => void }) {
  const s = useSaver();
  const [form, setForm] = useState({ name: '', durationMinutes: 30, price: '', active: true });
  useEffect(() => {
    if (!open) return;
    s.reset();
    setForm(service ? { name: service.name, durationMinutes: service.durationMinutes, price: service.price ?? '', active: service.active } : { name: '', durationMinutes: 30, price: '', active: true });
  }, [open, service]);
  const submit = () => {
    // Aceita 1.234,56 (formato brasileiro) ou 1234.56.
    const price = form.price.includes(',') ? form.price.replace(/\./g, '').replace(',', '.') : form.price;
    const body = { ...form, price };
    return s.run(() => (service ? api.put(`/orgs/${s.orgId}/services/${service.id}`, body) : api.post(`/orgs/${s.orgId}/services`, body)), service ? 'Serviço atualizado' : 'Serviço cadastrado', onClose);
  };
  return (
    <Dialog open={open} onClose={onClose} title={service ? service.name : 'Novo serviço'} footer={<SaveFooter onClose={onClose} pending={s.pending} form="service-form" />}>
      <form id="service-form" noValidate className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <FormError message={s.error} />
        <Field label="Nome" required error={s.errors.name}>
          {(p) => <Input {...p} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ex.: Avaliação inicial" />}
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Duração padrão (min)" required error={s.errors.durationMinutes}>
            {(p) => <Input {...p} type="number" min={5} step={5} value={form.durationMinutes} onChange={(e) => setForm({ ...form, durationMinutes: Number(e.target.value) })} />}
          </Field>
          <Field label="Preço de referência (R$)" error={s.errors.price} hint="Usado em orçamentos futuros.">
            {(p) => <Input {...p} inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="0,00" />}
          </Field>
        </div>
        <Checkbox label="Ativo" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
      </form>
    </Dialog>
  );
}

function ServicesSection() {
  const { can } = useOrg();
  const services = useServices();
  const [editing, setEditing] = useState<Service | null | 'new'>(null);
  const manage = can('services.manage');
  return (
    <SectionCard
      title="Serviços"
      action={manage ? <Button size="sm" icon={<Plus className="size-4" aria-hidden />} onClick={() => setEditing('new')}>Novo serviço</Button> : undefined}
      query={services}
      empty={<EmptyState icon={<Tag className="size-5" aria-hidden />} title="Nenhum serviço" description="Serviços definem a duração padrão ao agendar." action={manage ? <Button onClick={() => setEditing('new')}>Cadastrar serviço</Button> : undefined} />}
    >
      {services.data?.map((sv) => (
        <li key={sv.id} className="flex items-center gap-3 px-5 py-3">
          <div className="flex-1">
            <p className="font-semibold">{sv.name} {!sv.active && <Badge>Inativo</Badge>}</p>
            <p className="text-sm text-muted">{sv.durationMinutes} min · {sv.price ? fmtMoney(sv.price) : 'sem preço de referência'}</p>
          </div>
          {manage && <Button variant="secondary" size="sm" icon={<Pencil className="size-3.5" aria-hidden />} onClick={() => setEditing(sv)}>Editar</Button>}
        </li>
      ))}
      <ServiceDialog open={editing !== null} service={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
    </SectionCard>
  );
}

function SecuritySection() {
  const { orgId, can, me } = useOrg();
  const s = useSaver();
  const org = useOrgQuery<{ requireMfaPrivileged: boolean }>(['summary'], '');
  const value = org.data?.requireMfaPrivileged ?? false;
  return (
    <Card className="p-5">
      <h2 className="font-bold">Segurança da organização</h2>
      <p className="mt-1 text-sm text-muted">Proteções aplicadas pelo servidor a todos os membros.</p>
      <div className="mt-5 space-y-3">
        <FormError message={s.error} />
        <Checkbox
          label="Exigir verificação em duas etapas de proprietários e gestores"
          description={me.user.mfaEnabled ? 'Quem não tiver MFA ativo perde o acesso à clínica até ativar.' : 'Ative o MFA na sua conta (Minha conta) antes de exigi-lo da equipe.'}
          checked={value}
          disabled={!can('org.manage') || s.pending || org.isLoading}
          onChange={(e) => s.run(() => api.put(`/orgs/${orgId}/security`, { requireMfaPrivileged: e.target.checked }), 'Política de segurança atualizada', () => {})}
        />
      </div>
    </Card>
  );
}

function SectionCard({ title, action, query, empty, children }: { title: string; action?: ReactNode; query: { isLoading: boolean; error: unknown; data?: unknown[]; refetch: () => unknown }; empty: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <h2 className="font-bold">{title}</h2>
        {action}
      </div>
      {query.isLoading && <LoadingBlock />}
      {query.error ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : null}
      {query.data && query.data.length === 0 && empty}
      <ul className="divide-y divide-border">{children}</ul>
    </Card>
  );
}

const SECTIONS: { key: Section; label: string; icon: typeof Building2 }[] = [
  { key: 'unidades', label: 'Unidades', icon: Building2 },
  { key: 'profissionais', label: 'Profissionais', icon: Stethoscope },
  { key: 'cadeiras', label: 'Cadeiras e salas', icon: Armchair },
  { key: 'servicos', label: 'Serviços', icon: Tag },
  { key: 'seguranca', label: 'Segurança', icon: ShieldCheck },
];

function SettingsInner() {
  const params = useSearchParams();
  const router = useRouter();
  const section = (SECTIONS.find((s) => s.key === params.get('secao'))?.key ?? 'unidades') as Section;
  return (
    <>
      <PageHeader title="Configurações" description="Estrutura da clínica usada pela agenda." />
      <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
        <nav aria-label="Seções de configuração" className="flex gap-1 overflow-x-auto lg:flex-col">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              aria-current={section === s.key ? 'page' : undefined}
              onClick={() => router.replace(`/app/configuracoes?secao=${s.key}`)}
              className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold ${section === s.key ? 'bg-primary-soft text-primary-text' : 'text-muted hover:bg-surface-2 hover:text-fg'}`}
            >
              <s.icon className="size-4" aria-hidden /> {s.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0">
          {section === 'unidades' && <UnitsSection />}
          {section === 'profissionais' && <ProfessionalsSection />}
          {section === 'cadeiras' && <ChairsSection />}
          {section === 'servicos' && <ServicesSection />}
          {section === 'seguranca' && <SecuritySection />}
        </div>
      </div>
    </>
  );
}

export default function SettingsPage() {
  return (
    <Suspense>
      <SettingsInner />
    </Suspense>
  );
}
