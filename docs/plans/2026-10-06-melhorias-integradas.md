# Oralis — melhorias integradas

**Objetivo:** executar as melhorias de confiabilidade, ficha integrada, atendimento contínuo, agenda, financeiro acionável, relacionamento, busca, painéis por função e operação aprovadas em “execute tudo”.
**Arquitetura:** estender o monólito NestJS/Drizzle e a interface Next.js existentes; usar consultas autorizadas, transações e componentes atuais. Manter infraestrutura externa configurável sem enviar mensagens reais na validação.

## Frentes e critérios de aceite
1. Confiabilidade: tarefas respeitam unidade em leitura/escrita; CSV neutraliza fórmulas; e-mails possuem exclusão mútua entre workers; testes de regressão.
2. Paciente e atendimento: linha do tempo unificada com filtros de permissão; editor serializa saves e preserva rascunhos; prevenção de saída com alterações; próximos passos de cobrança/retorno após conclusão.
3. Agenda, financeiro e relacionamento: vagas/encaixes ligados à lista de espera; resumo financeiro com links de ação; central de comunicação com histórico, preferências e acompanhamento.
4. Busca e painel: Ctrl+K procura pacientes e consultas autorizadas; painel adaptado ao papel, com evoluções pendentes para profissionais e prioridades de gestão/recepção.
5. Operação: CI com tipos/testes/build; verificações de saúde e erros rastreáveis; scripts seguros de backup e restauração em banco separado; teste de restauração quando ferramentas locais permitirem.
6. Verificação: regressões backend executadas em sequência (banco de teste compartilhado), tipos/build e testes de interface; documentação atualizada com resultados e limites externos.

## Divisão de arquivos
- Agente confiabilidade: tasks, mail, exports e seus testes; sem editar AppModule/queries.ts.
- Agente paciente: novos componentes de timeline/saída, editor clínico, ficha e workspace; endpoints dedicados em patients/clinical, sem AppModule/queries.ts.
- Agente fluxo operacional: agenda, financeiro, relacionamento, seus serviços/testes; sem AppModule/queries.ts.
- Principal: busca global, painel por função, observabilidade, backup/restore, CI, integração e revisão final.

Nenhum agente executa a suíte de integração simultaneamente. Mudanças não relacionadas existentes devem ser preservadas. Não há repositório Git inicializado neste workspace.

## Verificação local — 06/10/2026

- `npm run typecheck`: aprovado (shared, API e web).
- `npm test`: 22 testes compartilhados + 174 testes API, 17 suítes API, sem falhas.
- `npm run test:tools`: 9 testes de salvaguardas/integridade de backup aprovados.
- `npm run build`: shared, NestJS e Next.js aprovados.
- Scripts CDP: editor (6 cenários), operação e busca/painéis por perfil; respostas API simuladas, sem mensagens ou pagamentos reais.
- Revisão adicional corrigiu exportação organizacional para exigir acesso a todas as unidades e lista de tratamentos para filtrar unidades autorizadas.
- CI configurado localmente; não executado em GitHub neste workspace sem repositório Git.
- Restauração real não executada: pg_dump/pg_restore ausentes. Script e guia de execução entregues; ensaio de recuperação permanece pendente no ambiente apropriado.
- Voltar/avançar do navegador mantém recuperação local; não há interceptação de popstate. Integrações externas exigem validação com provedores configurados.
