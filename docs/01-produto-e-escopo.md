# Oralis Cloud — Produto e escopo

> "Toda a sua clínica conectada. Mais tempo para cuidar."

Este documento consolida os requisitos recebidos (seções 1–56), registra as
contradições encontradas e define o que entra no MVP, o que é evolução e o que
depende de terceiros. É a referência para decidir o próximo incremento.

## 1. Visão e diferenciais

Plataforma SaaS multi-tenant para dentistas autônomos, consultórios, clínicas
com equipe e redes com várias unidades. Três ambientes separados:

| Ambiente | Quem usa | O que nunca faz |
|---|---|---|
| **Clínica** (`/app`) | Proprietário, gestor, dentista, recepção, auxiliar, financeiro | Mostrar dados clínicos a quem não tem papel clínico |
| **Paciente** (`/paciente`) | Paciente ou responsável | Mostrar o que a clínica não liberou |
| **Administração do SaaS** (`/admin`) | Equipe da plataforma | Acessar dados clínicos sem concessão temporária e auditada |

Diferenciais (todos derivados de registros explícitos, nunca de inferência clínica):

1. **Central de Ação** com critério e origem de cada recomendação.
2. **Fluxo do dia** (Previsto → Confirmado → Chegou → Em atendimento → Concluído) com espera e atrasos.
3. **Vaga aberta → lista de espera** com sugestão de candidatos elegíveis (sem reserva automática).
4. **Mapa de continuidade do cuidado** (plano aprovado sem sessão, tratamento sem próxima etapa).
5. **Motor de automações** Evento → Condições → Ação → Resultado, com simulação antes de ativar.
6. **Rastreabilidade**: toda informação importante leva à sua origem (histórico + auditoria).

## 2. Requisitos consolidados (sem duplicações)

Os prompts repetiram as seções 40–44. Abaixo, a lista única por domínio.

| Domínio | Requisitos-chave |
|---|---|
| Identidade | Cadastro, login, sessões revogáveis, MFA para perfis privilegiados, proteção contra abuso |
| Organizações | Organização → unidades; fuso por unidade; convites; papéis granulares por ação/módulo/unidade |
| Assinaturas | Planos Essencial/Profissional/Rede configuráveis no backend; trial; mensal/anual; estados trial/ativa/vencida/suspensa/cancelada; carência; webhooks idempotentes; direitos aplicados no backend |
| Onboarding | Checklist com dependências; importação assistida (upload → mapeamento → validação → prévia → processamento → relatório); ambiente demo separado |
| Agenda | Dia/semana/mês por profissional/cadeira/unidade; conflitos; bloqueios/férias/recorrência; encaixes; lista de espera; status com histórico; check-in; atrasos; lembretes; link seguro de confirmação; sincronização externa opcional |
| Pacientes | Cadastro 360°, responsável legal, preferências e autorizações de comunicação, duplicidades e unificação auditada |
| Prontuário | Anamnese versionada, evoluções com autoria, finalização + adendo, odontograma por dente/superfície, documentos |
| Tratamentos | Planos com etapas/dependências, orçamento versionado, aprovação apontando a versão apresentada, apresentação ao paciente |
| Financeiro | Receber/pagar, parcelas, recebimentos parciais, estornos, conciliação, comissões, precisão decimal |
| Relacionamento | Funil, tarefas, templates, central de comunicações, consentimento e frequência |
| Portal do paciente | Agendamentos, confirmação, formulários, orçamentos, cobranças, documentos liberados |
| Estoque e laboratórios | Lotes/validade, mínimo, movimentações com motivo; ordens de laboratório com prazos e atrasos |
| Inteligência | Indicadores com fórmula e origem; IA assistiva opcional e revisada |
| Operação do SaaS | Site público, demonstração interativa, checkout, suporte com acesso excepcional, comunicados, flags, ambientes |

## 3. Contradições encontradas e resolução proposta

Todas as resoluções são premissas reversíveis.

| # | Tensão | Resolução |
|---|---|---|
| C1 | "Agenda impede conflitos" × "encaixes" | Conflito é bloqueado sempre pelo banco. Encaixe será um tipo explícito de consulta que exige a permissão `schedule.overbook`, ocupa o profissional mas é marcado e auditado. Não implementado no incremento 1. |
| C2 | "Suspender por inadimplência" × "exportação sem bloqueios abusivos" | Assinatura suspensa vira **somente leitura + exportação**, nunca bloqueio total; dados clínicos jamais são apagados por inadimplência ou cancelamento. |
| C3 | Admin do SaaS "gerencia organizações" × "sem acesso clínico" | Ambiente `/admin` com identidade e guardas próprios. Não existe superusuário que atravesse o `TenantGuard`. Suporte usa concessão temporária, por escopo, autorizada pela clínica e auditada. |
| C4 | "Assinatura do prontuário" × "não declarar conformidade" | Finalização interna com hash e autoria; assinatura digital (ICP-Brasil ou equivalente) só via integração validada e marcada como dependente de fornecedor. |
| C5 | Recepção "sem prontuário" × dentista precisa de alertas clínicos no atendimento | Alertas clínicos ficam no domínio Prontuário (`clinical.read`). A recepção vê apenas **preferências de acolhimento** (acessibilidade), cadastradas com finalidade própria. |
| C6 | Pacientes por unidade × organização com várias unidades | Paciente pertence à **organização** (cadastro único). Consultas, cadeiras e caixa pertencem à **unidade**, e o escopo do usuário é aplicado nelas. |
| C7 | "Ambiente demo dentro do produto" × "dados sintéticos fora de produção" | Demonstração pública roda em implantação separada. Demo dentro da conta do cliente = organização marcada `is_demo`, que nunca envia mensagens. |
| C8 | Mesmo painel "o que precisa de atenção hoje" × painel por papel | A pergunta é a mesma; o conteúdo muda por papel (seção 20). |
| C9 | Rota `/admin/auditoria` × auditoria da clínica | Duas trilhas: `/app/auditoria` (eventos da organização) e `/admin/auditoria` (eventos da plataforma). |
| C10 | Aceite de orçamento × consentimento clínico | São registros diferentes; aprovar orçamento nunca marca consentimento nem procedimento executado. |

## 4. MVP, evolução e dependências de terceiros

**MVP comercializável (incrementos 1–6)**: identidade, organização/unidades/equipe,
permissões, pacientes, agenda completa (incl. semana/mês, bloqueios, lista de
espera), workspace de atendimento com evolução e adendo, odontograma, planos e
orçamentos, financeiro clínico básico (receber, parcial, estorno), assinatura do
SaaS com um provedor, portal do paciente mínimo, auditoria, exportação.

**Evolução**: CRM e funil, motor de automações com simulação, estoque,
laboratórios, Central de Ação, capacidade, relatórios por coorte, multiunidade
avançada, suporte com acesso excepcional, flags por plano/piloto, IA assistiva.

**Dependem de terceiros (nunca simulados como prontos)**:

| Capacidade | Dependência |
|---|---|
| Cobrança da assinatura e de pacientes | Provedor de pagamentos (webhooks assinados, sandbox) |
| E-mail transacional (convites, recuperação de senha) | Provedor de e-mail |
| WhatsApp / SMS | API oficial do WhatsApp Business ou fornecedor homologado |
| Nota fiscal | Emissor homologado por município/estado |
| Assinatura digital de documentos clínicos | Certificadora/assinador validado |
| Sincronização de calendário | Google/Microsoft com consentimento OAuth |
| IA assistiva | Fornecedor com contrato, finalidade e configuração explícita por clínica |

## 5. Primeira fatia vertical (incremento 1)

Jornada A + início da B, com persistência real:

1. Criar conta (responsável) → criar organização e primeira unidade com horário.
2. Configurar profissionais, cadeiras e serviços.
3. Convidar membro (link gerado; e-mail não configurado).
4. Cadastrar paciente (com detecção de duplicidade).
5. Agendar consulta (conflitos e horário de funcionamento).
6. Confirmar → check-in → iniciar → concluir (máquina de estados).
7. Consultar histórico da consulta, ficha do paciente e auditoria.

Os passos "salvar evolução em rascunho" e "finalizar registro" (seção 38, itens
10–11) são o **incremento 2**: exigem o domínio Prontuário, com permissões
clínicas, rascunho, finalização imutável e adendo.

## 6. Plano de incrementos

| Incremento | Entrega | Jornada |
|---|---|---|
| **1 (este)** | Base, design system, identidade, organização, permissões, pacientes, agenda diária com conflitos e fluxo de status, auditoria | A, B (parcial) |
| 2 | Workspace de atendimento: evolução em rascunho, finalização com hash, adendo, anamnese versionada, alertas clínicos | B |
| 3 | Agenda semana/mês, bloqueios e férias, lista de espera e sugestão de vagas, link seguro de confirmação | D |
| 4 | Odontograma, planos de tratamento, orçamento versionado e apresentação | B, C |
| 5 | Financeiro clínico (contas a receber, parciais, estornos, caixa) + assinatura do SaaS com provedor real | C, F |
| 6 | Portal do paciente, site público, checkout, administração do SaaS | F, comercial |
| 7+ | CRM, automações, estoque, laboratórios, Central de Ação, IA assistiva | E e diferenciais |
