'use client';

import { PERMISSIONS, type Permission } from '@oralis/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, MailPlus, Pencil, UserCog, UserMinus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Badge, Card, CardHeader, EmptyState, ErrorState, LoadingBlock, Notice, PageHeader } from '@/components/ui/feedback';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, FormError, Input, Select } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { type Member, type Role, useInvitations, useMembers, useRoles, useUnits } from '@/lib/queries';
import { useOrg } from '@/lib/session';

/** Formulário de papel + unidades, usado para convidar e para alterar membros. */
function AccessFields({ roles, roleId, setRoleId, allUnits, setAllUnits, unitIds, setUnitIds, errors }: {
  roles: Role[];
  roleId: string;
  setRoleId: (v: string) => void;
  allUnits: boolean;
  setAllUnits: (v: boolean) => void;
  unitIds: string[];
  setUnitIds: (v: string[]) => void;
  errors: Record<string, string>;
}) {
  const { membership } = useOrg();
  const units = useUnits();
  const assignable = roles.filter((r) => membership.role.key === 'owner' || r.key !== 'owner');
  const role = roles.find((r) => r.id === roleId);
  return (
    <div className="space-y-4">
      <Field label="Papel" required error={errors.roleId} hint={role?.description ?? undefined}>
        {(p) => (
          <Select {...p} value={roleId} onChange={(e) => setRoleId(e.target.value)}>
            <option value="">Selecione…</option>
            {assignable.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <fieldset className="space-y-2">
        <legend className="mb-1 text-[13px] font-semibold">Unidades de atuação</legend>
        <Checkbox label="Todas as unidades" description="Inclui unidades criadas no futuro." checked={allUnits} onChange={(e) => setAllUnits(e.target.checked)} disabled={!membership.allUnits} />
        {!allUnits && (
          <div className="ml-6 space-y-1.5">
            {units.data?.map((u) => (
              <Checkbox key={u.id} label={u.name} checked={unitIds.includes(u.id)} onChange={(e) => setUnitIds(e.target.checked ? [...unitIds, u.id] : unitIds.filter((x) => x !== u.id))} />
            ))}
          </div>
        )}
        {errors.unitIds && <p className="text-xs text-danger">{errors.unitIds}</p>}
      </fieldset>
    </div>
  );
}

function InviteDialog({ open, onClose, roles }: { open: boolean; onClose: () => void; roles: Role[] }) {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');
  const [allUnits, setAllUnits] = useState(true);
  const [unitIds, setUnitIds] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<string>('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open) {
      setEmail('');
      setRoleId('');
      setAllUnits(true);
      setUnitIds([]);
      setErrors({});
      setError(null);
      setLink(null);
      setCopied(false);
    }
  }, [open]);

  const invite = useMutation({
    mutationFn: () => api.post<{ token: string; emailDelivery: string }>(`/orgs/${orgId}/invitations`, { email, roleId, allUnits, unitIds }),
    onSuccess: async (r) => {
      setLink(`${window.location.origin}/convite/${r.token}`);
      setDelivery(r.emailDelivery);
      await qc.invalidateQueries({ queryKey: ['org', orgId] });
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        setErrors(err.fieldErrors);
        setError(Object.keys(err.fieldErrors).length ? null : err.message);
      }
    },
  });

  async function copy() {
    if (!link) return;
    await navigator.clipboard.writeText(link).catch(() => {});
    setCopied(true);
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Convidar para a equipe"
      footer={
        link ? (
          <Button onClick={onClose}>Concluir</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" form="invite-form" loading={invite.isPending}>
              Gerar convite
            </Button>
          </>
        )
      }
    >
      {link ? (
        <div className="space-y-4">
          {delivery === 'sent' ? (
            <Notice tone="accent" title={`Convite enviado para ${email}`}>O link vale por 7 dias e só pode ser usado pela conta com este e-mail. Você também pode copiá-lo abaixo.</Notice>
          ) : delivery === 'queued_retry' ? (
            <Notice tone="warning" title="O e-mail não pôde ser enviado agora">Haverá novas tentativas automáticas. Enquanto isso, copie o link e envie por outro canal.</Notice>
          ) : (
            <Notice tone="warning" title="Envio de e-mail não configurado neste ambiente">
              A mensagem foi para a caixa de saída local. Copie o link abaixo e envie para {email} pelo canal de sua preferência. Ele vale por 7 dias.
            </Notice>
          )}
          <div className="flex gap-2">
            <Input readOnly value={link} aria-label="Link do convite" onFocus={(e) => e.target.select()} />
            <Button variant="secondary" onClick={copy} icon={copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}>
              {copied ? 'Copiado' : 'Copiar'}
            </Button>
          </div>
          <p className="text-xs text-muted">Por segurança, este link não será exibido novamente. Se perdê-lo, gere um novo convite (o anterior é cancelado).</p>
        </div>
      ) : (
        <form
          id="invite-form"
          className="space-y-4"
          noValidate
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            invite.mutate();
          }}
        >
          <FormError message={error} />
          <Field label="E-mail" required error={errors.email}>
            {(p) => <Input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
          </Field>
          <AccessFields roles={roles} roleId={roleId} setRoleId={setRoleId} allUnits={allUnits} setAllUnits={setAllUnits} unitIds={unitIds} setUnitIds={setUnitIds} errors={errors} />
        </form>
      )}
    </Dialog>
  );
}

function EditMemberDialog({ member, onClose, roles }: { member: Member | null; onClose: () => void; roles: Role[] }) {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [roleId, setRoleId] = useState('');
  const [allUnits, setAllUnits] = useState(true);
  const [unitIds, setUnitIds] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (member) {
      setRoleId(member.roleId);
      setAllUnits(member.allUnits);
      setUnitIds(member.unitIds);
      setErrors({});
      setError(null);
    }
  }, [member]);

  const save = useMutation({
    mutationFn: () => api.put(`/orgs/${orgId}/members/${member!.membershipId}`, { roleId, allUnits, unitIds }),
    onSuccess: async () => {
      toast({ tone: 'success', title: 'Acesso atualizado', description: 'A mudança vale a partir da próxima ação da pessoa.' });
      await qc.invalidateQueries({ queryKey: ['org', orgId] });
      onClose();
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        setErrors(err.fieldErrors);
        setError(err.message);
      }
    },
  });

  return (
    <Dialog
      open={!!member}
      onClose={onClose}
      title={`Acesso de ${member?.name ?? ''}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormError message={error} />
        <AccessFields roles={roles} roleId={roleId} setRoleId={setRoleId} allUnits={allUnits} setAllUnits={setAllUnits} unitIds={unitIds} setUnitIds={setUnitIds} errors={errors} />
      </div>
    </Dialog>
  );
}

export default function TeamPage() {
  const { orgId, can, me } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const manage = can('team.manage');
  const members = useMembers(can('team.read'));
  const roles = useRoles(can('team.read'));
  const invitations = useInvitations(manage);
  const units = useUnits();
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);

  const remove = useMutation({
    mutationFn: (m: Member) => api.delete(`/orgs/${orgId}/members/${m.membershipId}`),
    onSuccess: async () => {
      toast({ tone: 'success', title: 'Membro removido', description: 'O acesso à organização foi encerrado.' });
      await qc.invalidateQueries({ queryKey: ['org', orgId] });
    },
    onError: (err) => toast({ tone: 'error', title: 'Não foi possível remover', description: err instanceof ApiError ? err.message : undefined }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/orgs/${orgId}/invitations/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['org', orgId] }),
  });

  if (!can('team.read')) return <ErrorState error={new ApiError(403, 'forbidden', '')} />;
  const unitName = (id: string) => units.data?.find((u) => u.id === id)?.name ?? '—';

  return (
    <>
      <PageHeader
        title="Equipe"
        description="Quem acessa a clínica, com qual papel e em quais unidades."
        actions={manage && <Button icon={<MailPlus className="size-4" aria-hidden />} onClick={() => setInviting(true)}>Convidar</Button>}
      />
      <div className="space-y-6">
        <Card>
          <CardHeader title="Membros" />
          {members.isLoading && <LoadingBlock />}
          {members.error && <ErrorState error={members.error} onRetry={() => members.refetch()} />}
          {members.data && (
            <ul className="divide-y divide-border">
              {members.data.map((m) => (
                <li key={m.membershipId} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">
                      {m.name} {m.userId === me.user.id && <span className="text-xs font-normal text-muted">(você)</span>}
                    </p>
                    <p className="text-sm text-muted">{m.email}</p>
                  </div>
                  <Badge tone={m.roleKey === 'owner' ? 'primary' : 'neutral'}>{m.roleName}</Badge>
                  <span className="w-40 truncate text-sm text-muted">{m.allUnits ? 'Todas as unidades' : m.unitIds.map(unitName).join(', ')}</span>
                  {manage && m.userId !== me.user.id && (
                    <span className="flex gap-1">
                      <Button variant="ghost" size="sm" icon={<Pencil className="size-3.5" aria-hidden />} onClick={() => setEditing(m)}>
                        Alterar
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-danger"
                        icon={<UserMinus className="size-3.5" aria-hidden />}
                        onClick={() => window.confirm(`Remover ${m.name} da equipe? O acesso será encerrado imediatamente.`) && remove.mutate(m)}
                      >
                        Remover
                      </Button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        {manage && (
          <Card>
            <CardHeader title="Convites pendentes" description="Convites expiram em 7 dias." />
            {invitations.data && invitations.data.length === 0 && <p className="px-5 py-4 text-sm text-muted">Nenhum convite pendente.</p>}
            <ul className="divide-y divide-border">
              {invitations.data?.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                  <span className="flex-1 font-medium">{i.email}</span>
                  <Badge>{i.roleName}</Badge>
                  <span className="text-muted">expira em {fmtDate(i.expiresAt, 'America/Sao_Paulo')}</span>
                  <Button variant="ghost" size="sm" onClick={() => revoke.mutate(i.id)}>
                    Cancelar convite
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card>
          <CardHeader icon={<UserCog className="size-5" aria-hidden />} title="Papéis e permissões" description="O que cada papel pode fazer. A verificação acontece no servidor, não apenas na tela." />
          {roles.data ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th scope="col" className="px-5 py-2 font-semibold">Permissão</th>
                    {roles.data.map((r) => (
                      <th key={r.id} scope="col" className="px-2 py-2 text-center font-semibold">{r.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(Object.keys(PERMISSIONS) as Permission[]).map((p) => (
                    <tr key={p} className="border-b border-border last:border-0">
                      <th scope="row" className="px-5 py-2 text-left font-normal">
                        {PERMISSIONS[p].label}
                        <span className="ml-1 text-xs text-subtle">· {PERMISSIONS[p].module}</span>
                      </th>
                      {roles.data.map((r) => (
                        <td key={r.id} className="px-2 py-2 text-center">
                          {r.permissions.includes(p) ? <Check className="mx-auto size-4 text-accent" aria-label="Sim" /> : <span className="text-subtle" aria-label="Não">—</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <LoadingBlock />
          )}
        </Card>
      </div>

      {roles.data && <InviteDialog open={inviting} onClose={() => setInviting(false)} roles={roles.data} />}
      {roles.data && <EditMemberDialog member={editing} onClose={() => setEditing(null)} roles={roles.data} />}
      {!roles.data && !roles.isLoading && <EmptyState icon={<UserCog className="size-5" />} title="Papéis indisponíveis" />}
    </>
  );
}
