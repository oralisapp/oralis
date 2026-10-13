/**
 * Catálogo de permissões do ambiente da clínica.
 *
 * A permissão é sempre verificada no backend. A interface usa o mesmo
 * catálogo apenas para esconder ações que o usuário não pode executar.
 *
 * Escopo por unidade: além da permissão, o vínculo (membership) define em
 * quais unidades o usuário atua. Recursos com unidade (agenda, cadeiras)
 * só são acessíveis dentro desse escopo.
 */
export const PERMISSIONS = {
  'org.manage': { module: 'Organização', label: 'Alterar dados da organização' },
  'units.manage': { module: 'Organização', label: 'Criar e configurar unidades e horários' },
  'team.read': { module: 'Equipe', label: 'Ver membros da equipe' },
  'team.manage': { module: 'Equipe', label: 'Convidar membros e alterar papéis' },
  'professionals.manage': { module: 'Equipe', label: 'Configurar profissionais' },
  'resources.manage': { module: 'Agenda', label: 'Configurar cadeiras e salas' },
  'services.manage': { module: 'Agenda', label: 'Configurar serviços, duração e preço' },
  'patients.read': { module: 'Pacientes', label: 'Consultar cadastro operacional de pacientes' },
  'patients.write': { module: 'Pacientes', label: 'Cadastrar e editar pacientes' },
  'schedule.read': { module: 'Agenda', label: 'Ver agenda' },
  'schedule.write': { module: 'Agenda', label: 'Agendar e reagendar consultas' },
  'schedule.confirm': { module: 'Agenda', label: 'Registrar confirmação de presença' },
  'schedule.checkin': { module: 'Agenda', label: 'Fazer check-in na recepção' },
  'schedule.cancel': { module: 'Agenda', label: 'Cancelar consultas e registrar faltas' },
  'schedule.attend': { module: 'Atendimento', label: 'Iniciar e concluir os próprios atendimentos' },
  'schedule.attend_any': { module: 'Atendimento', label: 'Iniciar e concluir atendimentos de qualquer profissional' },
  'clinical.read': { module: 'Prontuário', label: 'Ler prontuário (incremento 2)' },
  'clinical.write': { module: 'Prontuário', label: 'Registrar evoluções (incremento 2)' },
  'treatments.read': { module: 'Tratamentos', label: 'Ver planos de tratamento e orçamentos' },
  'treatments.write': { module: 'Tratamentos', label: 'Montar planos de tratamento' },
  'quotes.present': { module: 'Tratamentos', label: 'Apresentar orçamentos' },
  'quotes.approve': { module: 'Tratamentos', label: 'Registrar aprovação ou recusa de orçamento' },
  'quotes.discount': { module: 'Tratamentos', label: 'Conceder desconto acima de 10%' },
  'finance.read': { module: 'Financeiro', label: 'Ver financeiro da clínica' },
  'finance.write': { module: 'Financeiro', label: 'Lançar cobranças, recebimentos e despesas' },
  'finance.approve': { module: 'Financeiro', label: 'Aprovar estornos e fechar caixa' },
  'crm.read': { module: 'Relacionamento', label: 'Ver funil e comunicações' },
  'crm.write': { module: 'Relacionamento', label: 'Gerenciar contatos, mensagens e campanhas' },
  'automations.manage': { module: 'Relacionamento', label: 'Configurar e ativar automações' },
  'inventory.read': { module: 'Estoque', label: 'Ver estoque' },
  'inventory.write': { module: 'Estoque', label: 'Movimentar estoque' },
  'labs.read': { module: 'Laboratórios', label: 'Ver trabalhos de laboratório' },
  'labs.write': { module: 'Laboratórios', label: 'Gerenciar trabalhos de laboratório' },
  'reports.read': { module: 'Relatórios', label: 'Ver indicadores e relatórios gerenciais' },
  'billing.manage': { module: 'Assinatura', label: 'Gerenciar a assinatura do Oralis' },
  'data.export': { module: 'Organização', label: 'Exportar dados' },
  'patients.merge': { module: 'Pacientes', label: 'Unificar cadastros duplicados' },
  'patients.import': { module: 'Pacientes', label: 'Importar pacientes por planilha' },
  'support.manage': { module: 'Suporte', label: 'Abrir chamados e autorizar acesso do suporte' },
  'audit.read': { module: 'Auditoria', label: 'Consultar trilha de auditoria' },
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export type SystemRoleKey = 'owner' | 'manager' | 'dentist' | 'reception' | 'assistant' | 'finance';

export interface SystemRoleDefinition {
  key: SystemRoleKey;
  name: string;
  description: string;
  permissions: readonly Permission[];
}

/**
 * Papéis iniciais criados em cada organização. Ficam gravados no banco
 * (tabela roles/role_permissions) para permitir personalização futura sem
 * migração. Proprietário não pode ser removido nem rebaixado por um gestor.
 */
export const SYSTEM_ROLES: Record<SystemRoleKey, SystemRoleDefinition> = {
  owner: {
    key: 'owner',
    name: 'Proprietário',
    description: 'Responsável pela organização. Acesso administrativo completo.',
    permissions: ALL_PERMISSIONS,
  },
  manager: {
    key: 'manager',
    name: 'Gestor',
    description: 'Coordena unidades, equipe e agenda. Não lê prontuário por padrão.',
    permissions: [
      'units.manage', 'team.read', 'team.manage', 'professionals.manage', 'resources.manage',
      'services.manage', 'patients.read', 'patients.write', 'schedule.read', 'schedule.write',
      'schedule.confirm', 'schedule.checkin', 'schedule.cancel', 'audit.read',
      'treatments.read', 'quotes.approve', 'quotes.discount', 'finance.read', 'finance.write', 'finance.approve',
      'crm.read', 'crm.write', 'automations.manage', 'inventory.read', 'inventory.write', 'labs.read', 'labs.write',
      'reports.read', 'data.export', 'patients.merge', 'patients.import', 'support.manage',
    ],
  },
  dentist: {
    key: 'dentist',
    name: 'Dentista',
    description: 'Atende os próprios pacientes e registra o prontuário.',
    permissions: [
      'team.read', 'patients.read', 'patients.write', 'schedule.read', 'schedule.write',
      'schedule.confirm', 'schedule.attend', 'clinical.read', 'clinical.write',
      'treatments.read', 'treatments.write', 'quotes.present', 'quotes.approve', 'labs.read', 'labs.write', 'inventory.read', 'crm.read',
    ],
  },
  reception: {
    key: 'reception',
    name: 'Recepção',
    description: 'Agenda, confirmações, check-in e cadastro operacional. Sem acesso ao prontuário.',
    permissions: [
      'team.read', 'patients.read', 'patients.write', 'schedule.read', 'schedule.write',
      'schedule.confirm', 'schedule.checkin', 'schedule.cancel',
      'treatments.read', 'quotes.approve', 'crm.read', 'crm.write', 'labs.read', 'inventory.read', 'patients.import',
    ],
  },
  assistant: {
    key: 'assistant',
    name: 'Auxiliar',
    description: 'Apoio ao atendimento e à recepção.',
    permissions: ['team.read', 'patients.read', 'schedule.read', 'schedule.checkin', 'inventory.read', 'inventory.write', 'labs.read'],
  },
  finance: {
    key: 'finance',
    name: 'Financeiro',
    description: 'Cobranças e recebimentos. Sem acesso clínico nem à agenda.',
    permissions: ['team.read', 'patients.read', 'treatments.read', 'finance.read', 'finance.write', 'reports.read', 'inventory.read'],
  },
};

/** Papéis que um gestor (não proprietário) pode atribuir. */
export const ASSIGNABLE_BY_MANAGER: readonly SystemRoleKey[] = ['manager', 'dentist', 'reception', 'assistant', 'finance'];

export function roleHas(role: Pick<SystemRoleDefinition, 'permissions'>, permission: Permission): boolean {
  return role.permissions.includes(permission);
}
