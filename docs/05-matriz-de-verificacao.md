# Matriz de verificação

Estados: **Planejado** · **Implementado** (código existe, sem teste automatizado) ·
**Testado** (coberto por teste automatizado executado) · **Dependente de
configuração** · **Simulado apenas em demonstração**.

Uma funcionalidade só é "Testada" quando há teste automatizado que passou.
Interface existente não conta como conclusão.

Jornadas: A = assinatura → clínica → equipe → paciente → agenda;
B = confirmação → check-in → atendimento → evolução → plano.

## Incremento 1

| Funcionalidade | Jornada | Tela | Endpoint | Regra de negócio | Permissão | Teste automatizado | Estado | Dependência externa |
|---|---|---|---|---|---|---|---|---|
| Cadastro do responsável | A | `/criar-conta` | `POST /api/auth/signup` | e-mail único normalizado; senha ≥ 10; argon2id | pública + limite de taxa | `auth.spec` | Testado | — |
| Login / logout | A | `/entrar` | `POST /api/auth/login`, `/logout` | tempo equalizado; sessão revogada no servidor | pública + limite | `auth.spec` | Testado | — |
| Sessões revogáveis | — | `/app/conta` | `GET/DELETE /api/auth/sessions` | só as próprias | sessão | `auth.spec` | Testado | — |
| Proteção CSRF | — | todas | todas as mutações | cabeçalho + Origin | — | `auth.spec`, jornada E2E | Testado | — |
| Criar organização + unidade + horário | A | `/onboarding` | `POST /api/orgs` | papéis de sistema criados; criador vira proprietário | sessão | `helpers` (todas as suítes) | Testado | — |
| Unidades e horários | A | `/app/configuracoes?secao=unidades` | `POST/PUT /units`, `PUT /units/:id/hours` | intervalos sem sobreposição; só quem atua em todas cria unidade | `units.manage` | `permissions.spec`, `domain.test` | Testado | — |
| Convite de membro | A | `/app/equipe`, `/convite/[token]` | `POST /invitations`, `/invitations/preview`, `/invitations/accept` | token só como hash; 7 dias; e-mail deve coincidir; uso único | `team.manage` | `permissions.spec` | Testado | E-mail: **não configurado** (link copiado manualmente) |
| Alterar papel / remover membro | A | `/app/equipe` | `PUT/DELETE /members/:id` | vale na próxima requisição; ≥ 1 proprietário | `team.manage` | `permissions.spec` | Testado | — |
| Profissionais, cadeiras, serviços | A | `/app/configuracoes` | `/professionals`, `/chairs`, `/services` | unidade no escopo; preço `numeric` | `*.manage` | `scheduling.spec`, `tenant-isolation.spec` | Testado | — |
| Checklist "Começar com o Oralis" | A | `/app/visao-geral` | `GET /onboarding` | calculado de registros reais | membro | jornada E2E | Testado (E2E) | — |
| Cadastro de paciente | A | `/app/pacientes` | `POST /patients` | CPF válido; telefone BR; duplicidade CPF bloqueia; nome+nascimento pede confirmação | `patients.write` | `patients.spec` | Testado | — |
| Busca de pacientes | A | `/app/pacientes` | `GET /patients?q=` | sem acentos; por telefone/CPF | `patients.read` | `patients.spec` | Testado | — |
| Edição com controle de versão | A | ficha do paciente | `PUT /patients/:id` | versão obrigatória; auditoria só com nomes de campos | `patients.write` | `patients.spec` | Testado | — |
| Ficha do paciente (resumo + agendamentos) | A | `/app/pacientes/[id]` | `GET /patients/:id` | acesso auditado; agenda filtrada por unidade | `patients.read` | `patients.spec` | Testado | — |
| Agenda diária por profissional/cadeira | A | `/app/agenda` | `GET /agenda` | dia no fuso da unidade | `schedule.read` | `scheduling.spec` | Testado | — |
| Agendar com validação de conflito | A | `/app/agenda` | `POST /appointments` | sem sobreposição de profissional, cadeira e paciente (exclusion constraint); horário de funcionamento; sem passado | `schedule.write` | `scheduling.spec` (incl. 8 requisições simultâneas) | Testado | — |
| Reagendar | D | painel da consulta | `PUT /appointments/:id/schedule` | só agendada/confirmada; invalida confirmação; versão | `schedule.write` | `scheduling.spec` | Testado | — |
| Confirmar / check-in / falta / cancelar | B | visão geral, painel | `POST /appointments/:id/transitions` | máquina de estados; check-in só no dia; falta só após início; motivo de cancelamento | `schedule.confirm/checkin/cancel` | `scheduling.spec`, `permissions.spec` | Testado | Confirmação pelo paciente via link: **Planejado** (incremento 3) |
| Iniciar / concluir atendimento | B | painel | idem | só o profissional responsável (ou `attend_any`) | `schedule.attend` | `permissions.spec` | Testado | — |
| Histórico de status | B | painel da consulta | `GET /appointments/:id` | somente-inserção (gatilho) | `schedule.read` | `scheduling.spec` | Testado | — |
| Fluxo do dia (Previsto → Concluído) | B | `/app/visao-geral` | `GET /agenda` | espera desde check-in; atraso = 10 min sem check-in | `schedule.read` | jornada E2E (dados) | Implementado (UI sem teste automatizado) | — |
| Auditoria | — | `/app/auditoria` | `GET /audit` | somente-inserção; sem conteúdo clínico | `audit.read` | `scheduling.spec`, `patients.spec`, `permissions.spec` | Testado | — |
| Isolamento entre organizações | todas | — | todas | 404 sem vínculo; FKs compostas | — | `tenant-isolation.spec` (+ teste de mutação) | Testado | — |
| Tema claro/escuro, responsivo | — | todas | — | tokens AA; sem rolagem horizontal | — | verificação manual por captura (Chrome headless) | Implementado | — |
| Seed de demonstração (Clínica Aurora) | — | — | `npm run db:seed:demo` | só local e fora de produção; dados fictícios | — | execução manual | Simulado apenas em demonstração | — |

## Estado dos módulos (atualizado em 07/10/2026)

| Funcionalidade | Estado |
|---|---|
| Evolução em rascunho, finalização imutável, adendo | Implementado; suíte clinical.spec |
| MFA para perfis privilegiados | Implementado; conta, desafio de login e recuperação |
| Recuperação de senha | Dependente de configuração (provedor de e-mail) |
| Agenda semanal/mensal, bloqueios, férias, recorrência | Implementado; suíte agenda-advanced.spec |
| Lista de espera e sugestão de vagas | Implementado; agenda e painel de oportunidades |
| Arrastar e soltar na agenda | Planejado |
| Lembretes por WhatsApp/SMS/e-mail | Adaptadores implementados; dependem de credenciais e validação externa |
| Odontograma, planos e orçamentos | Implementado; suíte treatments.spec |
| Financeiro clínico | Implementado; suíte finance.spec |
| Assinatura do SaaS e webhooks | Dependente de configuração (provedor de pagamentos) |
| Portal do paciente e site público | Implementado; suíte portal.spec; administração SaaS permanece evolução separada |
| Importação de pacientes por planilha | Implementada via CSV com mapeamento, prévia, revalidação e relatório |
| Unificação de cadastros duplicados | Consolidação auditada, preservando históricos em fichas vinculadas; não reescreve prontuários |
| Estoque e laboratórios | APIs e telas implementadas; regressões de referências, unidades e lotes |

As referências de suítes indicam cobertura existente, não substituem o resultado de execução no ambiente. A jornada real está em `npm run test:e2e`; os roteiros `test:ui` continuam usando API simulada. Consulte o relatório da entrega para resultados e bloqueios observados.
