'use client';

import { useState } from 'react';
import { Package } from 'lucide-react';
import { useOrg } from '@/lib/session';
import { ApiError, qs } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardHeader, EmptyState, ErrorState, LoadingBlock, PageHeader } from '@/components/ui/feedback';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/field';
import { Choice, dateLabel, OperationForm, TextField, useOperation } from '@/components/operations/shared';

type Item = { id: string; name: string; category: string | null; unitMeasure: string; minQuantity: string; belowMin: boolean; perUnit: { unitId: string; balance: number }[] };
type Supplier = { id: string; name: string; contact: string | null; phone: string | null; email: string | null };
type Movement = { m: { id: string; type: string; quantity: string; createdAt: string; reason: string | null; unitId: string; lotId: string | null }; lotCode: string | null; expiresOn: string | null; unitName: string; byName: string | null };
const movementNames: Record<string, string> = { in: 'Entrada', out: 'Saída', adjust_in: 'Ajuste de entrada', adjust_out: 'Ajuste de saída', transfer_in: 'Transferência recebida', transfer_out: 'Transferência enviada', consumption: 'Consumo do atendimento' };

export default function InventoryPage() {
  const { can, unit, membership } = useOrg();
  // Remount all forms when the active clinic or unit changes.
  return <InventoryWorkspace key={`${membership.organizationId}:${unit?.id}`} allowed={can('inventory.read')} />;
}
function InventoryWorkspace({ allowed }: { allowed: boolean }) {
  const { can, unit, membership } = useOrg();
  const writable = can('inventory.write') && membership.subscription.access === 'full';
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState('');
  const [selected, setSelected] = useState<Item | null>(null);
  const [movementType, setMovementType] = useState('in');
  const items = useOperation<Item[]>(`/inventory/items${qs({ unitId: unit?.id })}`, allowed && !!unit);
  const suppliers = useOperation<Supplier[]>('/inventory/suppliers', allowed);
  const materials = useOperation<{ id: string; serviceName: string; itemName: string; quantity: string; unitMeasure: string }[]>('/inventory/materials', allowed);
  const services = useOperation<{ id: string; name: string }[]>('/services', allowed && writable);
  const movements = useOperation<Movement[]>(`/inventory/items/${selected?.id}/movements${qs({ unitId: unit?.id })}`, allowed && !!selected && !!unit);
  const currentLots = useOperation<{ id: string | null; lotCode: string | null; expiresOn: string | null; balance: string }[]>(`/inventory/items/${selected?.id}/lots${qs({ unitId: unit?.id })}`, allowed && !!selected && !!unit);
  const alerts = useOperation<{ expiring: { lotId: string; unitId: string; itemName: string; lotCode: string; expiresOn: string; balance: number; expired: boolean }[] }>('/inventory/alerts', allowed);
  const close = () => { setMode(''); setSelected(null); };
  if (!allowed) return <ErrorState error={new ApiError(403, 'forbidden', '')} />;
  if (!unit) return <p>Selecione uma unidade para consultar o estoque.</p>;
  const unitMovements = movements.data?.filter(m => m.m.unitId === unit.id) ?? [];
  const lots = currentLots.data?.filter(l => l.id).map(l => ({ id: l.id!, name: `${l.lotCode} · saldo ${l.balance}${l.expiresOn ? ` · validade ${dateLabel(l.expiresOn)}` : ''}` })) ?? [];
  const filtered = items.data?.filter(i => `${i.name} ${i.category ?? ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <>
    <PageHeader title="Estoque" description={`Materiais, saldos e reposição · ${unit.name}`} actions={writable && <Button onClick={() => setMode('item')}>Novo material</Button>} />
    <div className="space-y-6">
      <Card><CardHeader title="Materiais da clínica" description="O cadastro e o mínimo são compartilhados; os saldos pertencem à unidade selecionada." /><div className="p-5"><Input aria-label="Buscar material" placeholder="Buscar por material ou categoria" value={search} onChange={e => setSearch(e.target.value)} /></div>
        {items.isLoading && <LoadingBlock />}{items.error && <ErrorState error={items.error} onRetry={() => items.refetch()} />}
        {filtered?.length === 0 && <EmptyState icon={<Package />} title="Nenhum material encontrado" description="Cadastre um material para começar a registrar entradas." />}
        <ul className="divide-y divide-border">{filtered?.map(i => <li key={i.id} className="flex flex-wrap items-center gap-3 px-5 py-4"><div className="min-w-40 flex-1"><p className="font-semibold">{i.name}</p><p className="text-xs text-muted">{i.category ?? 'Sem categoria'} · mínimo {i.minQuantity} {i.unitMeasure}</p></div><Badge tone={i.belowMin ? 'warning' : 'accent'}>{i.perUnit[0]?.balance ?? 0} {i.unitMeasure}{i.belowMin ? ' · repor' : ''}</Badge><Button size="sm" variant="ghost" onClick={() => { setSelected(i); setMode('history'); }}>Histórico</Button>{writable && <><Button size="sm" variant="secondary" onClick={() => { setSelected(i); setMovementType('in'); setMode('movement'); }}>Movimentar</Button><Button size="sm" variant="ghost" onClick={() => { setSelected(i); setMode('minimum'); }}>Mínimo</Button>{membership.units.length > 1 && <Button size="sm" variant="ghost" onClick={() => { setSelected(i); setMode('transfer'); }}>Transferir</Button>}</>}</li>)}</ul>
      </Card>
      <Card><CardHeader title="Validades próximas e vencidas" description="Lotes com saldo e vencimento nos próximos 30 dias." />{alerts.isLoading && <LoadingBlock />}{alerts.error && <ErrorState error={alerts.error} onRetry={() => alerts.refetch()} />}<ul className="divide-y divide-border">{alerts.data?.expiring.filter(l => l.unitId === unit.id).map(l => <li key={l.lotId} className="flex flex-wrap gap-3 px-5 py-3"><span className="flex-1">{l.itemName} · lote {l.lotCode}</span><span>{l.balance} em estoque</span><Badge tone={l.expired ? 'danger' : 'warning'}>{l.expired ? 'Vencido' : 'Vence'} em {dateLabel(l.expiresOn)}</Badge></li>)}</ul>{alerts.data && !alerts.data.expiring.some(l => l.unitId === unit.id) && <p className="p-5 text-sm text-muted">Nenhum lote próximo do vencimento.</p>}</Card>
      <Card><CardHeader title="Fornecedores" actions={writable && <Button size="sm" onClick={() => setMode('supplier')}>Novo fornecedor</Button>} />{suppliers.isLoading && <LoadingBlock />}{suppliers.error && <ErrorState error={suppliers.error} onRetry={() => suppliers.refetch()} />}<ul className="divide-y divide-border">{suppliers.data?.map(s => <li key={s.id} className="px-5 py-3"><p className="font-semibold">{s.name}</p><p className="text-sm text-muted">{[s.contact, s.phone, s.email].filter(Boolean).join(' · ') || 'Sem contato cadastrado'}</p></li>)}</ul>{suppliers.data?.length === 0 && <p className="p-5 text-muted">Nenhum fornecedor cadastrado.</p>}</Card>
      <Card><CardHeader title="Consumo por procedimento" description="Ao concluir um atendimento, os materiais configurados são baixados do estoque. Salvar novamente o mesmo par atualiza a quantidade." actions={writable && <Button size="sm" onClick={() => setMode('material')}>Configurar consumo</Button>} />{materials.isLoading && <LoadingBlock />}{materials.error && <ErrorState error={materials.error} onRetry={() => materials.refetch()} />}<ul className="divide-y divide-border">{materials.data?.map(m => <li key={m.id} className="px-5 py-3">{m.serviceName} · {m.itemName} <span className="text-muted">{m.quantity} {m.unitMeasure}</span></li>)}</ul>{materials.data?.length === 0 && <p className="p-5 text-muted">Nenhum consumo configurado.</p>}</Card>
    </div>
    {mode === 'item' && <OperationForm title="Novo material" path="/inventory/items" onClose={close}><TextField name="name" label="Nome" required maxLength={120} /><TextField name="category" label="Categoria" maxLength={60} /><TextField name="unitMeasure" label="Unidade de medida (un, ml, caixa…)" required maxLength={20} /><TextField name="minQuantity" label="Estoque mínimo por unidade" type="number" min="0" step="0.001" value="0" required /></OperationForm>}
    {mode === 'supplier' && <OperationForm title="Novo fornecedor" path="/inventory/suppliers" onClose={close}><TextField name="name" label="Nome" required maxLength={120} /><TextField name="contact" label="Contato" maxLength={120} /><TextField name="phone" label="Telefone" maxLength={30} /><TextField name="email" label="E-mail" type="email" maxLength={254} /></OperationForm>}
    {mode === 'minimum' && selected && <OperationForm title={`Mínimo · ${selected.name}`} path={`/inventory/items/${selected.id}/minimum`} method="put" onClose={close}><TextField name="minQuantity" label={`Mínimo (${selected.unitMeasure})`} value={selected.minQuantity} required type="number" min="0" step="0.001" /></OperationForm>}
    {(mode === 'movement' || mode === 'transfer') && selected && <OperationForm title={`${mode === 'transfer' ? 'Transferir' : 'Movimentar'} · ${selected.name}`} path={`/inventory/${mode === 'transfer' ? 'transfers' : 'movements'}`} onClose={close} transform={d => ({ ...d, itemId: selected.id, ...(mode === 'transfer' ? { fromUnitId: unit.id } : { unitId: unit.id, type: movementType }) })}>
      <p className="text-sm text-muted">Origem: {unit.name} · saldo {selected.perUnit[0]?.balance ?? 0} {selected.unitMeasure}</p>
      {mode === 'movement' ? <label className="block text-sm font-semibold">Movimento<select aria-label="Movimento" className="mt-2 w-full rounded-xl border border-border p-3" value={movementType} onChange={e => setMovementType(e.target.value)}>{['in', 'out', 'adjust_in', 'adjust_out'].map(t => <option key={t} value={t}>{movementNames[t]}</option>)}</select></label> : <Choice name="toUnitId" label="Unidade de destino" options={membership.units.filter(u => u.id !== unit.id)} />}
      <TextField name="quantity" label={`Quantidade (${selected.unitMeasure})`} type="number" min="0.001" step="0.001" required />
      {currentLots.isLoading && <LoadingBlock />}{currentLots.error && <ErrorState error={currentLots.error} onRetry={() => currentLots.refetch()} />}
      {mode === 'movement' && ['in', 'adjust_in'].includes(movementType) ? <><TextField name="lotCode" label="Código do lote" maxLength={60} /><TextField name="expiresOn" label="Validade do lote" type="date" /><TextField name="unitCost" label="Custo unitário (R$)" type="number" min="0" step="0.01" /><Choice name="supplierId" label="Fornecedor" options={suppliers.data ?? []} required={false} /></> : <Choice name="lotId" label="Lote" options={lots} required={false} />}
      <TextField name="reason" label="Motivo" required={mode === 'movement' && movementType.startsWith('adjust')} maxLength={300} />
    </OperationForm>}
    {mode === 'material' && <OperationForm title="Consumo por procedimento" path="/inventory/materials" onClose={close}>{services.error && <ErrorState error={services.error} onRetry={() => services.refetch()} />}<Choice name="serviceId" label="Procedimento" options={services.data ?? []} /><Choice name="itemId" label="Material" options={items.data ?? []} /><TextField name="quantity" label="Quantidade consumida por atendimento" type="number" min="0.001" step="0.001" required /></OperationForm>}
    {mode === 'history' && selected && <Dialog open title={`Histórico · ${selected.name}`} onClose={close}>{movements.isLoading && <LoadingBlock />}{movements.error && <ErrorState error={movements.error} onRetry={() => movements.refetch()} />}<p className="mb-3 text-xs text-muted">Até 300 movimentos recentes da unidade selecionada.</p><ul className="divide-y divide-border">{unitMovements.map(m => <li key={m.m.id} className="py-3"><p className="font-semibold">{movementNames[m.m.type] ?? m.m.type} · {m.m.quantity} {selected.unitMeasure}</p><p className="text-sm text-muted">{dateLabel(m.m.createdAt)} · {m.byName ?? 'Sistema'}{m.lotCode ? ` · lote ${m.lotCode}` : ''}</p>{m.m.reason && <p className="text-sm">{m.m.reason}</p>}</li>)}</ul>{movements.data && !unitMovements.length && <p>Nenhuma movimentação nesta unidade.</p>}</Dialog>}
  </>;
}
