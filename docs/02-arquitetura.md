# Arquitetura e decisões

## Visão geral

```
navegador ──► Next.js (apps/web, :3000) ──/api/* (proxy)──► NestJS (apps/api, :4000) ──► PostgreSQL 18
                 │                                              │
                 └── @oralis/shared (regras, permissões, esquemas zod) ──┘
```

Monólito modular. Cada domínio fica em `apps/api/src/modules/<domínio>` e
expõe serviços; controladores não chamam controladores de outros domínios.

| Módulo (incremento 1) | Responsabilidade |
|---|---|
| `identity` | Cadastro, login, sessões opacas revogáveis, `/auth/me` |
| `organizations` | Organização, unidades e horários, papéis, equipe e convites, profissionais, cadeiras, serviços, checklist de implantação |
| `patients` | Cadastro, busca, duplicidades, ficha auditada |
| `scheduling` | Agenda do dia, criação, reagendamento, máquina de estados, histórico |
| `audit` | Registro somente-inserção e consulta |

## Decisões (ADRs resumidos)

| # | Decisão | Motivo | Reversível? |
|---|---|---|---|
| D1 | **NestJS 11** (CommonJS), não o 12 | O 12 é ESM-only; decorators + Jest + ts-node em ESM ainda têm atrito. Migração planejada quando o ecossistema estabilizar. | Sim |
| D2 | **Drizzle ORM 0.45** + migrações SQL versionadas | O Prisma "latest" é um RC (8.0.0-rc). Drizzle gera SQL legível e permite migrações manuais para exclusion constraints e gatilhos. | Sim |
| D3 | **Sessões opacas no banco** (cookie httpOnly, SameSite=Lax) em vez de JWT | Revogação imediata, listagem de sessões, permissões lidas a cada requisição (mudança de papel vale na hora). | Sim |
| D4 | **argon2id** (`@node-rs/argon2`, binários pré-compilados) | Recomendação OWASP; sem toolchain nativa no Windows. | — |
| D5 | **Proxy same-origin** (`/api/*` via rewrites do Next) e API sem CORS | Cookie de sessão nunca cruza origens; CSRF reduzido a cabeçalho obrigatório + Origin. | Sim |
| D6 | **PostgreSQL embarcado** (`embedded-postgres`, binários oficiais 18.4) para dev/testes | A máquina não tem Docker. É PostgreSQL real (inclui `btree_gist`, `pg_trgm`). O `docker-compose.yml` mantém a mesma versão para quem usa Docker. | Sim |
| D7 | **Esquemas zod compartilhados** (`@oralis/shared`) | A mesma regra valida o formulário e a API. A API sempre revalida. | — |
| D8 | **TanStack Query** no front | Cache, estados de carregamento/erro e invalidação após mutações. | Sim |
| D9 | **Tailwind CSS v4** com tokens em CSS | Tema claro/escuro por variáveis; contraste controlado em um único lugar. | Sim |
| D10 | **Relógio injetável** (`Clock`) | Regras dependentes de horário (check-in no dia, falta após o início) testadas de forma reproduzível. | — |
| D11 | Redis e fila de jobs **adiados** | Nenhum job assíncrono no incremento 1. Entram com lembretes/automações (reservado no compose). | — |

## Estratégia multi-tenant

Defesa em camadas:

1. **Rota**: toda rota de dados é `/api/orgs/:orgId/...`.
2. **`TenantGuard`**: carrega o vínculo *ativo* do usuário naquela organização; sem vínculo → **404** (não revela existência). Carrega permissões do papel e unidades de atuação a cada requisição.
3. **Serviços**: toda consulta filtra `organization_id = :orgId`; recursos com unidade verificam o escopo (`canAccessUnit`).
4. **Banco**: chaves estrangeiras **compostas** `(id, organization_id)` — uma consulta da organização A não consegue referenciar paciente, profissional, cadeira ou unidade da organização B, mesmo que a aplicação erre.
5. **Testes**: `tenant-isolation.spec.ts` tenta acessar e alterar dados de outra organização por todas as rotas, e insere diretamente no banco para provar a FK composta.

Planejado: Row-Level Security do PostgreSQL como quarta barreira, e chaves de
cache/fila/arquivo sempre prefixadas por `organization_id`.

## Agenda sem conflitos sob concorrência

- Verificação prévia na transação → mensagem clara com o tipo de conflito.
- Garantia final: **exclusion constraints** `EXCLUDE USING gist` sobre
  `tstzrange(starts_at, ends_at, '[)')` para profissional, cadeira e paciente,
  apenas para status que ocupam o horário. Duas requisições simultâneas: uma vence, a outra recebe 409.
- Teste: 8 requisições paralelas para o mesmo horário → exatamente 1 sucesso.

## Datas e fusos

Instantes em `timestamptz` (UTC). Dia civil, horário de funcionamento e
exibição sempre no fuso IANA da unidade (`@date-fns/tz` no servidor e
`Intl.DateTimeFormat` com `timeZone` na interface — nunca o fuso do navegador).

## Segurança aplicada neste incremento

- Autorização sempre no backend (testes chamam a API diretamente).
- CSRF: cabeçalho `x-oralis-csrf` obrigatório em mutações + checagem de `Origin`.
- Limite de tentativas de login/cadastro por IP + e-mail (memória; Redis quando houver mais de uma instância).
- Tempo de resposta de login equalizado para e-mail inexistente.
- Tokens (sessão e convite) armazenados apenas como hash SHA-256.
- `helmet`, `x-powered-by` desativado, limite de corpo de 256 KB, `X-Frame-Options: DENY` no front.
- Logs de erro sem corpo de requisição. Auditoria registra nomes de campos alterados, nunca valores pessoais.
- Auditoria e histórico de status protegidos por gatilho contra UPDATE/DELETE.
- Configuração validada na inicialização; produção exige cookie `Secure`.

## Ambientes

`APP_ENV` = development | test | staging | production. Fora de produção a
interface exibe faixa de ambiente. Seed de demonstração recusa produção e
bancos não locais. Testes usam banco próprio (`DATABASE_URL_TEST`) e recusam
rodar se for igual ao de desenvolvimento.
