# Oralis Cloud

Plataforma SaaS para clínicas odontológicas — *Toda a sua clínica conectada. Mais tempo para cuidar.*

**Estado:** plataforma em desenvolvimento com agenda, ficha clínica, documentos, tratamentos, financeiro, relacionamento e administração. A entrega integrada adiciona busca global, prioridades por perfil, linha do tempo e proteções de salvamento e acesso.

Consulte [operação e recuperação](docs/07-operacao.md) e [validação especializada](docs/06-validacao-especializada.md) antes de preparar produção.

## Estrutura

```
.
├── apps/
│   ├── api/                 NestJS 11 + Drizzle ORM (monólito modular)
│   │   ├── drizzle/         migrações SQL versionadas (0001 = exclusion constraints e gatilhos)
│   │   ├── src/common/      guards (CSRF, sessão, organização/permissões), erros, relógio
│   │   ├── src/db/          esquema, migrador, seed de demonstração
│   │   ├── src/modules/     identidade · agenda · clínico · financeiro · CRM · busca · auditoria
│   │   └── test/            testes de integração contra PostgreSQL real
│   └── web/                 Next.js 16 (App Router) + Tailwind v4 + TanStack Query
│       └── src/
│           ├── app/         rotas: /entrar /criar-conta /convite /onboarding /app/*
│           ├── components/  design system (ui/) e componentes de jornada
│           └── lib/         cliente da API, sessão/organização ativa, formatação pt-BR
├── packages/shared/         permissões, máquina de estados, esquemas zod, fuso, CPF/telefone
├── scripts/dev-db.mjs       PostgreSQL 18 embarcado para máquinas sem Docker
├── docker-compose.yml       alternativa com Docker (PostgreSQL 18 + Redis reservado)
└── docs/                    produto, arquitetura, dados, permissões, verificação, validação
```

## Como executar

Pré-requisitos: Node.js ≥ 22.12 (testado com 24.11) e npm. Docker é opcional.

```bash
npm install
cp .env.example .env            # ajuste senhas/URLs e gere ENCRYPTION_KEY (instrução no arquivo)

# Terminal 1 — banco (PostgreSQL 18 real, dados em .data/postgres)
npm run db:start                # ou: docker compose up postgres

# Terminal 2 — migrações e dados fictícios (opcional)
npm run db:migrate
npm run db:seed:demo            # imprime as contas e a senha gerada (ou use SEED_DEMO_PASSWORD)
npm run dev:api                 # http://127.0.0.1:4000/api

# Terminal 3 — interface
npm run dev:web                 # http://localhost:3000
```

Variáveis (todas em `.env`, veja `.env.example`): `APP_ENV`, `DATABASE_URL`,
`DATABASE_URL_TEST`, `DEV_DB_PORT`, `DEV_DB_PASSWORD`, `API_PORT`, `WEB_ORIGIN`,
`SESSION_COOKIE_SECURE`, `API_INTERNAL_URL`, `SEED_DEMO_PASSWORD`.

Recriar a demonstração do zero (apaga o banco **de desenvolvimento**):
`npm run db:seed:demo -- --reset`.

## Como validar (roteiro manual)

1. Acesse `/criar-conta`, crie uma conta e preencha a clínica, a unidade e o horário em `/onboarding`.
2. Na visão geral, siga o checklist **Começar com o Oralis**: cadastre um profissional
   (vincule ao seu usuário), uma cadeira e um serviço em **Configurações**.
3. Em **Equipe → Convidar**, convide alguém como *Recepção*. Use o link de convite (ou SMTP quando configurado),
   abra em outra janela anônima e crie a conta com o e-mail convidado.
4. Como recepção: cadastre um paciente em **Pacientes**. Tente cadastrar de novo com o mesmo nome e
   nascimento — o sistema pede confirmação.
5. Na **Agenda**, clique em um horário livre e agende para hoje. Tente agendar outro paciente no mesmo
   horário e profissional: aparece o conflito.
6. Na consulta: *Confirmar presença* → *Fazer check-in*. A recepção não vê *Iniciar atendimento*.
7. Como o dentista vinculado: *Iniciar atendimento* → *Concluir atendimento*.
8. Abra a consulta e veja o **Histórico**; abra **Auditoria** como proprietário.
9. Alterne tema (ícone no topo) e teste em largura de celular.

## Testes

```bash
npm run db:start   # em outro terminal
npm test           # shared (unitários) + api (integração em banco oralis_test)
npm run typecheck
npm run test:tools
npm run build
```

Os testes de integração usam o banco `oralis_test`, aplicam as migrações e
limpam as tabelas a cada suíte. Um relógio fixo torna reproduzíveis as regras
dependentes de horário.

## Operação e melhorias integradas

- Ctrl+K busca pacientes e consultas conforme permissões e unidades.
- O painel reúne prioridades da recepção, profissionais, financeiro e gestão.
- A ficha inclui linha do tempo, atalhos por aba e rascunho clínico recuperável.
- Agenda conecta vagas à lista de espera; financeiro oferece indicadores com filtros e previsão; relacionamento reúne confirmações e histórico.
- Saúde da API, referência de erros, CI e scripts de backup estão descritos no [guia de operação](docs/07-operacao.md).

Integrações externas e restauração real de backup precisam de validação no ambiente configurado. `npm run test:ui` usa APIs simuladas; `npm run test:e2e` exercita a jornada com API e banco reais em uma clínica sintética local (veja o guia de operação).

## Complementos de operação

- Estoque e laboratórios: telas conectadas às APIs, com movimentações, fornecedores, materiais por serviço e acompanhamento de ordens.
- Pacientes: importação CSV com mapeamento, prévia e relatório; consolidação auditada de cadastros com acesso explícito aos históricos originais preservados.
- WhatsApp/SMS: adaptador Twilio, sem envio até configurar credenciais e modelos. Veja [mensageria](docs/MESSAGING.md).
- MFA já está disponível em **Minha conta**; documentação técnica atualizada para refletir a implementação.
