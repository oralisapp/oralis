/**
 * Regras PURAS dos modelos de automação: recebem registros simples e devolvem
 * quem seria selecionado e por quê. As mesmas funções servem para a execução
 * real, para a simulação com dados reais (sem efeitos) e com dados sintéticos.
 */

export type TemplateKey = 'confirmation' | 'vacancy' | 'quote_followup' | 'continuity' | 'stock_minimum' | 'overdue_receivable';

export interface Candidate {
  entityType: string;
  entityId: string;
  patientId?: string | null;
  label: string;
  selected: boolean;
  reasons: string[];
  action: string;
  dedupeKey: string;
}

export const TEMPLATE_INFO: Record<TemplateKey, { name: string; event: string; conditions: string; action: string; protection: string; usesMessage: boolean }> = {
  confirmation: { name: 'Confirmação de consulta', event: 'A consulta se aproxima (horas antes, configurável)', conditions: 'Consulta ainda agendada e sem confirmação; canal configurado; paciente autoriza avisos no canal', action: 'Enviar pedido de confirmação com link seguro', protection: 'Uma vez por versão da consulta; se ela mudar antes do envio, a condição é reavaliada e nada é enviado', usesMessage: true },
  vacancy: { name: 'Vaga aberta', event: 'Consulta cancelada', conditions: 'O horário ainda está no futuro e há pacientes compatíveis na lista de espera', action: 'Criar tarefa para a recepção com os candidatos', protection: 'Não reserva a vaga para ninguém: a recepção escolhe e a agenda impede vaga dupla', usesMessage: false },
  quote_followup: { name: 'Orçamento sem retorno', event: 'Prazo sem contato atingido', conditions: 'Orçamento apresentado, dentro da validade e sem contato registrado no período', action: 'Criar tarefa (ou mensagem aprovada) para retomar o contato', protection: 'Suspende sozinha ao haver resposta, recusa, aprovação ou novo contato', usesMessage: true },
  continuity: { name: 'Continuidade do tratamento', event: 'Etapa de tratamento concluída', conditions: 'Há etapas planejadas ainda sem consulta agendada', action: 'Criar tarefa para agendar a próxima etapa', protection: 'Não interpreta dependências clínicas: lista as etapas e o profissional/recepção decide', usesMessage: false },
  stock_minimum: { name: 'Estoque mínimo', event: 'Movimentação de estoque', conditions: 'Saldo da unidade abaixo do mínimo configurado', action: 'Criar alerta de reposição', protection: 'Nunca faz compra automática', usesMessage: false },
  overdue_receivable: { name: 'Recebimento vencido', event: 'Vencimento ultrapassado (dias configuráveis)', conditions: 'Saldo em aberto, sem contestação ou acordo suspensivo', action: 'Criar tarefa (ou mensagem configurada) de cobrança respeitosa', protection: 'Confere o saldo atualizado imediatamente antes; mensagem não expõe valores nem dados clínicos', usesMessage: true },
};

const H = 3_600_000;
const D = 86_400_000;

export interface ConfirmationRecord { id: string; version: number; startsAt: Date; status: string; patientId: string; patientName: string; hasChannel: boolean; consent: boolean }
export function confirmationRule(autoId: string, cfg: { hoursBefore: number }, rows: ConfirmationRecord[], now: Date): Candidate[] {
  return rows.map((a) => {
    const hours = (a.startsAt.getTime() - now.getTime()) / H;
    const reasons: string[] = [];
    let selected = true;
    if (hours <= 0) (selected = false), reasons.push('A consulta já começou');
    else if (hours > cfg.hoursBefore) (selected = false), reasons.push(`Faltam ${hours.toFixed(1)} h (envio a partir de ${cfg.hoursBefore} h antes)`);
    else reasons.push(`Faltam ${hours.toFixed(1)} h (limite ${cfg.hoursBefore} h)`);
    if (a.status !== 'scheduled') (selected = false), reasons.push(`Situação "${a.status}" — não aguarda confirmação`);
    else reasons.push('Ainda não confirmada');
    if (!a.hasChannel) (selected = false), reasons.push('Paciente sem contato no canal escolhido');
    if (!a.consent) (selected = false), reasons.push('Paciente não autoriza avisos neste canal');
    return { entityType: 'appointment', entityId: a.id, patientId: a.patientId, label: `${a.patientName} — ${a.startsAt.toISOString()}`, selected, reasons, action: 'Enviar pedido de confirmação', dedupeKey: `confirmation:${autoId}:${a.id}:${a.version}` };
  });
}

export interface VacancyRecord { id: string; startsAt: Date; status: string; candidates: number; label: string }
export function vacancyRule(autoId: string, rows: VacancyRecord[], now: Date): Candidate[] {
  return rows.map((a) => {
    const reasons: string[] = [];
    let selected = a.status === 'cancelled';
    reasons.push(a.status === 'cancelled' ? 'Consulta cancelada' : `Situação "${a.status}"`);
    if (a.startsAt <= now) (selected = false), reasons.push('O horário já passou');
    else reasons.push('Horário ainda no futuro');
    if (a.candidates === 0) (selected = false), reasons.push('Nenhum paciente compatível na lista de espera');
    else reasons.push(`${a.candidates} paciente(s) compatível(is) na lista de espera`);
    return { entityType: 'appointment', entityId: a.id, label: a.label, selected, reasons, action: 'Criar tarefa “Vaga aberta”', dedupeKey: `vacancy:${autoId}:${a.id}` };
  });
}

export interface QuoteRecord { id: string; versionId: string; patientId: string; patientName: string; status: string; lastContactAt: Date; validUntil: string }
export function quoteRule(autoId: string, cfg: { daysWithoutContact: number }, rows: QuoteRecord[], now: Date, today: string): Candidate[] {
  return rows.map((q) => {
    const days = Math.floor((now.getTime() - q.lastContactAt.getTime()) / D);
    const reasons: string[] = [];
    let selected = q.status === 'presented';
    reasons.push(q.status === 'presented' ? 'Aguardando decisão do paciente' : `Orçamento "${q.status}"`);
    if (q.validUntil < today) (selected = false), reasons.push('Validade expirada');
    if (days < cfg.daysWithoutContact) (selected = false), reasons.push(`Último contato há ${days} dia(s) (limite ${cfg.daysWithoutContact})`);
    else reasons.push(`Sem contato há ${days} dia(s)`);
    return { entityType: 'quote', entityId: q.id, patientId: q.patientId, label: q.patientName, selected, reasons, action: 'Retomar contato', dedupeKey: `quote:${autoId}:${q.id}:${q.versionId}:${Math.floor(days / Math.max(1, cfg.daysWithoutContact))}` };
  });
}

export interface ContinuityRecord { planId: string; patientId: string; patientName: string; doneCount: number; pendingUnscheduled: string[] }
export function continuityRule(autoId: string, rows: ContinuityRecord[]): Candidate[] {
  return rows.map((p) => ({
    entityType: 'treatment_plan',
    entityId: p.planId,
    patientId: p.patientId,
    label: p.patientName,
    selected: p.pendingUnscheduled.length > 0,
    reasons: p.pendingUnscheduled.length ? [`${p.pendingUnscheduled.length} etapa(s) planejada(s) sem consulta: ${p.pendingUnscheduled.join(', ')}`] : ['Nenhuma etapa pendente sem agendamento'],
    action: 'Criar tarefa “Agendar próxima etapa”',
    dedupeKey: `continuity:${autoId}:${p.planId}:${p.doneCount}`,
  }));
}

export interface StockRecord { itemId: string; unitId: string; name: string; balance: number; min: number }
export function stockRule(autoId: string, rows: StockRecord[], today: string): Candidate[] {
  return rows.map((s) => ({
    entityType: 'inventory_item',
    entityId: s.itemId,
    label: s.name,
    selected: s.balance < s.min,
    reasons: [s.balance < s.min ? `Saldo ${s.balance} abaixo do mínimo ${s.min}` : `Saldo ${s.balance} dentro do mínimo ${s.min}`],
    action: 'Criar alerta de reposição (sem compra automática)',
    dedupeKey: `stock:${autoId}:${s.itemId}:${s.unitId}:${today}`,
  }));
}

export interface OverdueRecord { id: string; patientId: string | null; patientName: string; balanceCents: number; dueDate: string; hold: boolean }
export function overdueRule(autoId: string, cfg: { daysOverdue: number }, rows: OverdueRecord[], today: string): Candidate[] {
  return rows.map((r) => {
    const days = Math.floor((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${r.dueDate}T12:00:00Z`)) / D);
    const reasons: string[] = [];
    let selected = true;
    if (r.balanceCents <= 0) (selected = false), reasons.push('Sem saldo em aberto');
    else reasons.push('Saldo em aberto');
    if (days < cfg.daysOverdue) (selected = false), reasons.push(`Vencida há ${days} dia(s) (limite ${cfg.daysOverdue})`);
    else reasons.push(`Vencida há ${days} dia(s)`);
    if (r.hold) (selected = false), reasons.push('Cobrança suspensa (contestação ou acordo)');
    return { entityType: 'receivable', entityId: r.id, patientId: r.patientId, label: r.patientName, selected, reasons, action: 'Lembrete de pagamento', dedupeKey: `overdue:${autoId}:${r.id}:${Math.floor(Math.max(0, days) / 7)}` };
  });
}

/** Cenário sintético para simulação: nenhum dado real é lido nem alterado. */
export function syntheticCandidates(key: TemplateKey, cfg: Record<string, number>, now: Date, today: string): Candidate[] {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const sim = 'simulacao';
  switch (key) {
    case 'confirmation':
      return confirmationRule(sim, { hoursBefore: cfg.hoursBefore ?? 24 }, [
        { id: id(1), version: 1, startsAt: new Date(now.getTime() + 20 * H), status: 'scheduled', patientId: id(11), patientName: 'Paciente Fictício A', hasChannel: true, consent: true },
        { id: id(2), version: 1, startsAt: new Date(now.getTime() + 50 * H), status: 'scheduled', patientId: id(12), patientName: 'Paciente Fictício B', hasChannel: true, consent: true },
        { id: id(3), version: 2, startsAt: new Date(now.getTime() + 10 * H), status: 'confirmed', patientId: id(13), patientName: 'Paciente Fictício C', hasChannel: true, consent: true },
        { id: id(4), version: 1, startsAt: new Date(now.getTime() + 5 * H), status: 'scheduled', patientId: id(14), patientName: 'Paciente Fictício D', hasChannel: true, consent: false },
      ], now);
    case 'vacancy':
      return vacancyRule(sim, [
        { id: id(1), startsAt: new Date(now.getTime() + 26 * H), status: 'cancelled', candidates: 3, label: 'Consulta fictícia cancelada (amanhã)' },
        { id: id(2), startsAt: new Date(now.getTime() + 30 * H), status: 'cancelled', candidates: 0, label: 'Consulta fictícia cancelada sem candidatos' },
      ], now);
    case 'quote_followup':
      return quoteRule(sim, { daysWithoutContact: cfg.daysWithoutContact ?? 7 }, [
        { id: id(1), versionId: id(21), patientId: id(11), patientName: 'Paciente Fictício A', status: 'presented', lastContactAt: new Date(now.getTime() - 10 * D), validUntil: '2999-12-31' },
        { id: id(2), versionId: id(22), patientId: id(12), patientName: 'Paciente Fictício B', status: 'presented', lastContactAt: new Date(now.getTime() - 2 * D), validUntil: '2999-12-31' },
        { id: id(3), versionId: id(23), patientId: id(13), patientName: 'Paciente Fictício C', status: 'approved', lastContactAt: new Date(now.getTime() - 20 * D), validUntil: '2999-12-31' },
      ], now, today);
    case 'continuity':
      return continuityRule(sim, [
        { planId: id(1), patientId: id(11), patientName: 'Paciente Fictício A', doneCount: 1, pendingUnscheduled: ['Coroa (dente 46)'] },
        { planId: id(2), patientId: id(12), patientName: 'Paciente Fictício B', doneCount: 2, pendingUnscheduled: [] },
      ]);
    case 'stock_minimum':
      return stockRule(sim, [
        { itemId: id(1), unitId: id(31), name: 'Resina composta A2 (fictício)', balance: 2, min: 5 },
        { itemId: id(2), unitId: id(31), name: 'Luvas M (fictício)', balance: 40, min: 20 },
      ], today);
    case 'overdue_receivable':
      return overdueRule(sim, { daysOverdue: cfg.daysOverdue ?? 3 }, [
        { id: id(1), patientId: id(11), patientName: 'Paciente Fictício A', balanceCents: 15000, dueDate: '2000-01-01', hold: false },
        { id: id(2), patientId: id(12), patientName: 'Paciente Fictício B', balanceCents: 15000, dueDate: '2000-01-01', hold: true },
        { id: id(3), patientId: id(13), patientName: 'Paciente Fictício C', balanceCents: 15000, dueDate: today, hold: false },
      ], today);
  }
}
