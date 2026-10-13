import type { plans, subscriptions } from '../../db/schema';

export type AccessLevel = 'full' | 'read_only';

export const TERMS_VERSION = '2026-10-preliminar';
/** Após cancelamento ou suspensão, os dados ficam disponíveis para leitura e exportação por este período. */
export const READ_ONLY_DAYS = 90;
/** Carência após falha de pagamento, com acesso completo. */
export const GRACE_DAYS = 7;

export const FEATURE_LABEL: Record<string, string> = {
  agenda: 'Agenda, lista de espera e confirmações',
  prontuario: 'Prontuário, odontograma e documentos',
  tratamentos: 'Planos de tratamento e orçamentos',
  financeiro: 'Financeiro da clínica',
  portal: 'Portal do paciente',
  importacao: 'Importação de pacientes',
  automacoes: 'Automações',
  crm: 'Relacionamento (CRM) e comunicações',
  estoque: 'Estoque',
  laboratorios: 'Laboratórios',
  multiunidade_relatorios: 'Relatórios consolidados de várias unidades',
  ia_assistiva: 'IA assistiva (requer configuração)',
};

/**
 * Política transparente de acesso pelo estado da assinatura:
 * - avaliação ou ativa: acesso completo;
 * - pagamento atrasado: acesso completo durante a carência ({@link GRACE_DAYS} dias);
 * - depois da carência, suspensa ou cancelada: SOMENTE LEITURA + exportação.
 * Nunca há bloqueio total nem exclusão automática de registros clínicos.
 */
export function accessFor(sub: typeof subscriptions.$inferSelect | undefined, now: Date): { level: AccessLevel; reason: string } {
  if (!sub) return { level: 'full', reason: 'Sem assinatura registrada.' };
  switch (sub.status) {
    case 'trial':
      return sub.trialEndsAt && sub.trialEndsAt <= now ? { level: 'read_only', reason: 'O período de avaliação terminou.' } : { level: 'full', reason: 'Período de avaliação.' };
    case 'active':
      return sub.cancelAtPeriodEnd && sub.currentPeriodEnd && sub.currentPeriodEnd <= now ? { level: 'read_only', reason: 'O período contratado terminou.' } : { level: 'full', reason: 'Assinatura ativa.' };
    case 'past_due':
      return sub.graceUntil && sub.graceUntil > now ? { level: 'full', reason: 'Pagamento pendente — em período de carência.' } : { level: 'read_only', reason: 'Pagamento pendente após a carência.' };
    case 'suspended':
      return { level: 'read_only', reason: 'Assinatura suspensa.' };
    case 'cancelled':
      return { level: 'read_only', reason: 'Assinatura cancelada.' };
    default:
      return { level: 'read_only', reason: 'Estado desconhecido.' };
  }
}

export function planLimits(plan: typeof plans.$inferSelect) {
  return { units: plan.maxUnits, users: plan.maxUsers, storageMb: plan.storageMb, features: plan.features };
}
