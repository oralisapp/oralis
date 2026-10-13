-- Catálogo inicial. Preços NÃO são definidos aqui (ficam nulos até a
-- administração publicá-los). Segurança essencial (MFA, auditoria, exportação,
-- isolamento) não é recurso de plano: vale para todos.
INSERT INTO plans (key, name, description, max_units, max_users, storage_mb, features, trial_days, sort_order, commercial_terms) VALUES
  ('essencial', 'Essencial', 'Para consultórios e operações menores.', 1, 3, 5120,
   ARRAY['agenda','prontuario','tratamentos','financeiro','portal','importacao'], 14, 1,
   'Cobrança recorrente mensal ou anual. Cancelamento a qualquer momento, com acesso até o fim do período pago.'),
  ('profissional', 'Profissional', 'Para clínicas com equipe e automações.', 1, 15, 20480,
   ARRAY['agenda','prontuario','tratamentos','financeiro','portal','importacao','automacoes','crm','estoque','laboratorios'], 14, 2,
   'Cobrança recorrente mensal ou anual. Cancelamento a qualquer momento, com acesso até o fim do período pago.'),
  ('rede', 'Rede', 'Para organizações com várias unidades e gestão consolidada.', NULL, NULL, 102400,
   ARRAY['agenda','prontuario','tratamentos','financeiro','portal','importacao','automacoes','crm','estoque','laboratorios','multiunidade_relatorios','ia_assistiva'], 14, 3,
   'Condições comerciais combinadas com a equipe Oralis.')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
-- Organizações já existentes recebem um período de avaliação do plano Profissional.
INSERT INTO subscriptions (organization_id, plan_id, status, trial_ends_at)
SELECT o.id, p.id, 'trial', now() + interval '14 days'
FROM organizations o CROSS JOIN plans p
WHERE p.key = 'profissional' AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.organization_id = o.id);
