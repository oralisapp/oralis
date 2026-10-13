# Conclusão das pendências — plano de implementação

**Objetivo:** executar os seis pontos da revisão aprovada pelo usuário em 07/10/2026.

**Arquitetura:** preservar NestJS/Drizzle/PostgreSQL e Next.js. Completar jornadas sobre as APIs atuais. Novas operações de pacientes devem validar organização, permissões, concorrência e registrar auditoria. Provedores externos permanecem desabilitados sem configuração, sem simular entregas.

**Tecnologias:** TypeScript, Zod, React Query, Jest, PostgreSQL, Chrome CDP.

## Entregas e verificações

- [x] Estoque e laboratórios: páginas, formulários, consultas, movimentações, ordens e navegação; permissões, referências e lotes cobertos por regressões; cadastros exercitados no navegador real.
- [x] Pacientes: importação CSV com mapeamento/prévia/validação/relatório; consolidação auditada, transacional e preservando registros em fichas vinculadas; testes de duplicidade, isolamento e integridade.
- [x] Comunicação: adaptador real configurável para WhatsApp/SMS, estado correto de aceite pelo provedor, timeout e falhas; testes sem mensagens reais; guia de configuração.
- [x] Jornada integrada: seis etapas aprovadas com navegador → frontend → API → banco real; relatório `.data/real-journey/3e30758e-6ab7-4347-90b2-1aac3a035f46/results.json` com `passed: true`, sem erros de runtime.
- [ ] Recuperação real bloqueada: `npm run backup` confirmou ausência de pg_dump; pg_restore também não localizado. Download dos clientes bloqueado pela rede do ambiente. Nove testes das ferramentas passaram; ensaio real permanece pendente.
- [x] Documentação: corrigir situação do MFA e refletir entregas, testes e dependências externas reais.
- [x] Revisão de especificação e qualidade; typecheck aprovado, 196 testes API + 22 regras compartilhadas + 9 ferramentas aprovados; builds API e web com webpack aprovados.

## Limites de execução

Não publicar nem enviar comunicações para pacientes reais. Não expor segredos. Não apagar dados existentes para testar. Credenciais e validação de provedores reais dependem do ambiente do operador. O trabalho local prossegue sem pedir novamente autorização já dada para estas entregas.
