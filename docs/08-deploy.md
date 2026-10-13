# Publicação: web na Vercel + API em servidor

```
Navegador ──https──▶ Vercel (Next.js, região gru1)
                       │  /api/*  (rewrite: mesma origem, cookie httpOnly)
                       ▼
                     API NestJS (Railway ou Render, contêiner sempre ligado)
                       ├──▶ PostgreSQL gerenciado (Neon ou Supabase)
                       └──▶ Bucket S3 privado (AWS S3 sa-east-1 ou Cloudflare R2)
```

Por que a API não roda na Vercel: ela executa tarefas periódicas a cada 15 s
(lembretes, vencimento de orçamentos, exportações, atrasos de laboratório) e
mantém um pool de conexões com o banco. Funções serverless não ficam ligadas
entre requisições.

> **Antes de dados reais de pacientes**, cumpra a lista "Antes de abrir para
> pacientes reais" no fim deste documento. Publicar não torna o sistema pronto
> para produção.

## 1. Repositório

A Vercel e o Railway/Render publicam a partir de um repositório Git (GitHub).

```powershell
git init
git add .
git commit -m "Oralis Cloud"
```

Crie um repositório **privado** no GitHub e envie (`git remote add origin ...`,
`git push -u origin main`). Confira que `.env` **não** foi incluído
(`git ls-files | Select-String "\.env$"` não deve retornar nada).

## 2. Banco de dados (Neon ou Supabase)

1. Crie o projeto na região **São Paulo** (dados de saúde: mantenha no Brasil
   quando possível e registre a decisão no relatório de impacto/LGPD).
2. Use a versão mais recente de PostgreSQL oferecida. O projeto é testado em
   PostgreSQL 18; as migrações criam a extensão `btree_gist` (disponível nos
   dois provedores).
3. Copie a string de conexão **direta** (não a "pooled"/PgBouncer em modo
   transaction: a agenda usa advisory locks de transação, que funcionam em
   ambas, mas prefira a direta) com `?sslmode=require`.
4. Ative backups automáticos/PITR do provedor e anote o período de retenção.

## 3. Arquivos (bucket S3 privado)

AWS S3 (região `sa-east-1`) ou Cloudflare R2:

1. Crie o bucket com **bloqueio total de acesso público**.
2. Ative **versionamento** (proteção contra exclusão acidental) e criptografia
   em repouso (padrão na AWS e no R2).
3. Crie uma credencial restrita a esse bucket com permissão apenas de
   `GetObject`, `PutObject` e `DeleteObject`.
4. R2: `S3_ENDPOINT=https://<conta>.r2.cloudflarestorage.com`, `S3_REGION=auto`.

Os arquivos nunca ficam públicos: o download passa pela API com link assinado
de 5 minutos.

## 4. API (Railway ou Render)

Crie um serviço a partir do repositório usando o **`Dockerfile.api`** da raiz
(Railway: *Settings → Build → Dockerfile Path*; Render: *New Web Service →
Docker*, Dockerfile Path `Dockerfile.api`). A cada versão o contêiner aplica as
migrações pendentes e só então sobe; se a migração falhar, a versão não entra
no ar.

Variáveis de ambiente (nunca no repositório):

| Variável | Valor |
|---|---|
| `APP_ENV` | `production` (ou `staging` para homologação) |
| `DATABASE_URL` | string do passo 2 |
| `WEB_ORIGIN` | `https://<seu-projeto>.vercel.app` ou o domínio próprio |
| `SESSION_COOKIE_SECURE` | `true` |
| `ENCRYPTION_KEY` | **nova**, gerada com `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Guarde também num cofre: sem ela, segredos de MFA não são recuperáveis. |
| `API_HOST` | `0.0.0.0` (já definido na imagem) |
| `TRUST_PROXY` | `2` (proxy da Vercel + proxy do provedor). Confira no passo 6. |
| `SMTP_URL`, `MAIL_FROM` | provedor de e-mail transacional (obrigatório em produção) |
| `STORAGE_DRIVER` | `s3` (obrigatório em produção) |
| `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT` | passo 3 |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | opcional; sem elas a assinatura aparece como "não configurado" |
| `TWILIO_*` | opcional; sem elas SMS/WhatsApp aparecem como "não configurado" |

A API se recusa a subir em produção sem HTTPS em `WEB_ORIGIN`, sem cookie
seguro, sem SMTP ou sem S3: a mensagem de erro aparece no log do serviço.

Anote a URL pública da API (ex.: `https://oralis-api.up.railway.app`).
Verifique: `https://<api>/api/health/ready` deve responder `{"status":"ok"}`.

Mantenha **uma única instância** por enquanto: as tarefas periódicas usam
`FOR UPDATE SKIP LOCKED` e suportam várias, mas isso não foi ensaiado em
produção.

## 5. Web (Vercel)

1. *Add New → Project* → importe o repositório.
2. **Root Directory: `apps/web`**. O `apps/web/vercel.json` já define
   instalação e build do monorepo (gera o pacote compartilhado antes) e a
   região `gru1` (São Paulo).
3. Variáveis de ambiente:
   - `API_INTERNAL_URL` = URL da API do passo 4 (https). Sem ela o build falha
     de propósito.
   - `APP_ENV` = `production` (controla o aviso de ambiente na interface).
4. *Deploy*. Depois, se usar domínio próprio, atualize `WEB_ORIGIN` na API.

Previews da Vercel (`*-git-*.vercel.app`) têm outra origem e serão recusados
pela proteção CSRF da API. Para homologação, crie uma API `staging` separada
com o `WEB_ORIGIN` do domínio de preview fixo.

## 6. Conferência após publicar

- [ ] `https://<web>/entrar` abre a tela de login com estilo.
- [ ] Criar conta → onboarding → painel funciona (cookie de sessão chega via `/api`).
- [ ] E-mail de redefinição de senha chega pelo SMTP real.
- [ ] Enviar um documento de ~10 MB e baixá-lo de volta (S3 + limite de tamanho
      do proxy da Vercel; confirme que o envio não é recusado).
- [ ] Em *Auditoria*, o IP registrado no login é o seu IP real. Se aparecer IP
      de servidor, ajuste `TRUST_PROXY` (3 se houver mais um proxy, 1 se menos).
- [ ] Errar a senha várias vezes bloqueia só aquele e-mail/IP, não todos.
- [ ] Stripe (se configurado): webhook apontando para
      `https://<web>/api/billing/webhooks/stripe` e um evento de teste aceito.

## Antes de abrir para pacientes reais

- [ ] Contrato com cada provedor (Vercel, Railway/Render, Neon/Supabase, AWS/R2,
      e-mail) cobrindo tratamento de dados pessoais sensíveis (LGPD art. 11) e
      transferência internacional quando aplicável.
- [ ] Relatório de impacto, política de privacidade e termos revisados por
      advogado (os textos atuais estão marcados como preliminares).
- [ ] Revisão de segurança independente e teste de invasão.
- [ ] Ensaio real de restauração: backup do provedor do banco + versão do bucket.
- [ ] Monitoramento externo de `/api/health/ready`, erros 5xx e alertas.
- [ ] MFA obrigatório para perfis privilegiados (*Configurações → Segurança*).
- [ ] Concluir os incrementos pendentes que a clínica vai usar.
