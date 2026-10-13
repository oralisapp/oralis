# Modelo de dados

Fonte de verdade: `apps/api/src/db/schema.ts` + `apps/api/drizzle/*.sql`.

## Incremento 1 (implementado)

| Tabela | Dono | Escopo de unidade | Estados | Campos sensíveis | Integridade principal |
|---|---|---|---|---|---|
| `users` | — (global) | — | ativo / `disabled_at` | `password_hash` (argon2id), e-mail | e-mail único (minúsculas) |
| `sessions` | usuário | — | ativa / expirada / revogada | `token_hash` | só hash do token |
| `organizations` | — | — | `active`, `suspended`, `archived`; `is_demo` | — | — |
| `clinic_units` | organização | é a unidade | `active` | — | `(id, organization_id)` único; nome único na org |
| `business_hours` | organização | unidade | — | — | `opens_at < closes_at`; weekday 0–6 |
| `roles` / `role_permissions` | organização | — | `is_system` | — | chave do papel única na org |
| `memberships` | organização | `all_units` ou `membership_units` | `active`, `suspended`, `removed` | — | usuário único por org; papel da mesma org (FK composta) |
| `invitations` | organização | `unit_ids` | pendente / aceito / revogado / expirado | `token_hash`, e-mail | papel da mesma org |
| `professionals` / `professional_units` | organização | unidades em que atende | `active` | CRO | vínculo com membro da mesma org |
| `chairs` | organização | unidade | `active` | — | nome único na unidade |
| `services` | organização | — | `active` | — | duração 5–480; preço `numeric(12,2)` ≥ 0 |
| `patients` | organização | — (cadastro único) | `active`, `archived` | CPF, telefone, e-mail, nascimento | CPF único na org (parcial); `version` |
| `appointments` | organização | unidade | `scheduled`, `confirmed`, `arrived`, `in_progress`, `completed`, `no_show`, `cancelled` | — | FKs compostas; `ends_at > starts_at`; motivo obrigatório se cancelada; **exclusion constraints** de profissional, cadeira e paciente; `version` |
| `appointment_status_history` | organização | via consulta | — | — | **somente-inserção** (gatilho) |
| `audit_events` | organização (ou nulo p/ eventos de conta) | `unit_id` opcional | — | IP, user-agent | **somente-inserção** (gatilho) |

Índices: agenda por `(organization_id, unit_id, starts_at)`, por paciente e por
profissional; busca de pacientes por trigram sobre `search_name` (sem acentos);
auditoria por `(organization_id, created_at)` e por entidade.

### Retenção e arquivamento (política proposta — requer validação jurídica)

- Pacientes e consultas não são excluídos fisicamente pela interface; pacientes podem ser **arquivados**.
- Auditoria e histórico de status são permanentes enquanto a organização existir.
- Cancelamento da assinatura **não** apaga registros clínicos (ver `06-validacao-especializada.md`).

## Próximos incrementos (planejado)

| Entidade | Incremento | Observação |
|---|---|---|
| `encounters` | 2 | 1:1 com consulta iniciada; profissional e unidade |
| `clinical_records` | 2 | rascunho → finalizado; `content_hash`; gatilho impede UPDATE após finalizar |
| `clinical_record_amendments` | 2 | somente-inserção, autor e hash |
| `anamnesis_templates` / `anamnesis_responses` | 2 | versão do modelo gravada na resposta |
| `schedule_blocks`, `waitlist_entries` | 3 | bloqueios participam da verificação de conflito |
| `odontogram_entries` | 4 | dente (notação FDI) + superfície + condição + origem |
| `treatment_plans`, `treatment_items`, `quotes`, `quote_versions` | 4 | aprovação aponta `quote_version_id` |
| `receivables`, `payments`, `payment_allocations`, `refunds`, `payables`, `cash_accounts`, `financial_categories` | 5 | valores em `numeric`; eventos distintos (contratado ≠ cobrado ≠ recebido) |
| `plans`, `subscriptions`, `webhook_events` | 5 | `webhook_events` com chave única do provedor (idempotência) |
| `patient_representatives`, `communication_preferences` | 6 | finalidade e base legal registradas |
| `tasks`, `automations`, `automation_executions`, `communication_events` | 7 | condição reavaliada antes da ação |
| `inventory_*`, `suppliers`, `laboratories`, `laboratory_orders` | 7 | ajustes exigem motivo e autoria |
