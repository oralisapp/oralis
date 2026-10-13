# Validação da API — 7 de outubro de 2026

Comando executado na raiz do workspace:

```powershell
node node_modules/jest/bin/jest.js --config apps/api/jest-isolated.config.cjs --runInBand
```

Resultado observado na saída do processo (sessão 12271):

```text
Test Suites: 22 passed, 22 total
Tests:       196 passed, 196 total
Snapshots:   0 total
Time:        156.403 s
Ran all test suites.
```

Código de saída: **0**. A execução foi serial e usou o banco configurado em `DATABASE_URL_TEST`. Incluiu as regressões de importação/consolidação de pacientes, concorrência de mensagens, resiliência dos jobs e escopo de operações.

A saída também apresentou um aviso de depreciação do `pg`: chamadas simultâneas a `client.query()` no mesmo cliente deixarão de ser suportadas no pg 9. O aviso não provocou falha nesta execução.

Este arquivo transcreve o resumo efetivamente retornado pela ferramenta; não é um arquivo de log integral. Não houve nova execução para produzir este registro. O modo isolado do Jest transpila os testes sem analisar todos os tipos; a verificação de tipos deve ser realizada separadamente com `npm run typecheck`.
