# Operação e recuperação da Oralis

## Verificação antes de publicar

Execute `npm run typecheck`, `npm run test:tools`, `npm test` e `npm run build`.
Em ambientes com pouca memória, execute os testes da API com `node node_modules/jest/bin/jest.js --config apps/api/jest-isolated.config.cjs --runInBand`, mantendo a checagem de tipos separada. Para um build sem Turbopack: `npm run build -w @oralis/web -- --webpack`. O frontend usa fontes do sistema e não precisa baixar fontes durante o build.
A suíte API migra e limpa o banco indicado por `DATABASE_URL_TEST`; use exclusivamente um banco descartável. Não execute duas suítes API simultaneamente no mesmo banco.

O workflow `.github/workflows/quality.yml` executa essas verificações com PostgreSQL 18 em push/PR quando o projeto estiver em um repositório GitHub. Sua inclusão local não representa uma execução remota de CI.

Com a interface em `http://localhost:3000`, `npm run test:ui` verifica editor, agenda, financeiro, comunicação, busca e painéis usando Chrome via CDP. Defina `CHROME_PATH` se necessário. As chamadas API nesses roteiros são simuladas; não enviam comunicações nem efetuam pagamentos reais. Relatórios e capturas ficam em `.data/ui-review`.

`npm run test:e2e` executa uma jornada com navegador, proxy Next, API Nest e PostgreSQL reais, sem interceptação de respostas. Requer `npm run dev`, banco local e ambiente development/test sem credenciais de mensageria. Cria uma clínica sintética nova a cada execução e mantém os registros para inspeção; não limpa tabelas existentes. Cadastro/onboarding, paciente, atendimento, evolução e recebimento são exercitados pela interface; recursos e orçamento são preparados pela API real. Portal usa link sem envio de e-mail. Relatório e capturas: `.data/real-journey/<id>/`. Esse teste não certifica provedores externos.

## Saúde e diagnóstico

- `GET /api/health/live`: processo HTTP está respondendo.
- `GET /api/health/ready` e `/api/health`: verificam conexão PostgreSQL; respondem 503 quando indisponível.
- Cada resposta inclui `X-Request-ID`; erros da interface apresentam essa referência ao suporte.
- Logs de falhas/latência incluem método, rota parametrizada, duração, status e referência. Não incluem corpo, consulta da URL ou conteúdo clínico.
- O painel da gestão mostra jobs encerrados com falha, execuções presas há mais de dez minutos e e-mails com falha. As contagens são da organização e exigem `audit.read`.

Configure monitoramento externo sobre readiness, taxa de 5xx e latência. A aplicação fornece sinais; este pacote não provisiona um serviço de alertas.

## Backup e ensaio de restauração

Pré-requisitos: clientes PostgreSQL compatíveis com o servidor (PostgreSQL 18 neste projeto), `pg_dump` e `pg_restore` no PATH ou pasta indicada por `PG_BIN`. O PostgreSQL embarcado de desenvolvimento não fornece esses dois executáveis.

1. Configure `DATABASE_URL` e `STORAGE_DIR` da instância que será copiada.
2. Execute `npm run backup`. O resultado fica em `.data/backups/<data-id>`.
3. Configure `RESTORE_DATABASE_URL` para um banco **novo**, com nome `oralis_restore_<identificador>`, e credencial autorizada a criar esse banco.
4. Execute `npm run backup:verify -- .data/backups/<data-id>`.
5. Confira a saída e `.data/restore-verification/<banco>/verification.json`. O banco restaurado é mantido para inspeção; nenhuma aplicação é iniciada nele.

O backup usa snapshot PostgreSQL consistente, dump customizado, contagem de tabelas, catálogo de gatilhos e hashes SHA-256 dos documentos. A restauração confere esses dados, a relação entre versões documentais e arquivos, e rejeita destino existente ou equivalente à origem, caminhos inseguros e links simbólicos/junctions.

Os arquivos de backup **não são cifrados pelo script**. Use volume/destino privado com criptografia, retenção e cópia externa definidos pelo operador. Guarde `ENCRYPTION_KEY` separadamente em cofre: sem a chave original, segredos cifrados não são recuperáveis. Roles globais, permissões do servidor, credenciais de provedores e configuração de infraestrutura não estão incluídos no dump. O script não substitui um plano de recuperação completo.

Não remova documentos durante a cópia; se uma referência do snapshot perder seu arquivo, o backup falha e não produz manifesto válido. Um ensaio interrompido pode deixar banco/pasta de inspeção; use um novo identificador para repetir e revise o resíduo manualmente.

## Integrações e limites

- SMTP vazio utiliza caixa de saída local fora de produção; produção exige configuração SMTP. Workers usam exclusão mútua por item. Ainda é possível duplicar envio se o provedor aceitar e o processo falhar antes do commit; não há garantia de entrega exatamente uma vez.
- Stripe, mensagens e IA dependem de configuração e validação com os respectivos provedores. Testes locais não certificam essas integrações externas.
- WhatsApp/SMS possuem adaptador Twilio configurável. WhatsApp exige vincular a versão local do modelo a um Content SID aprovado. Aceite pelo provedor não significa entrega; consulte [configuração de mensagens](MESSAGING.md).
- O editor protege links, abas, troca de clínica/unidade e fechamento/recarregamento com rascunho pendente. Voltar/avançar do navegador depende da recuperação local do rascunho.
- O armazenamento de documentos usa driver local privado; produção exige estratégia de armazenamento, recuperação e acesso apropriada à instalação.
- Histórico clínico mantém a política organizacional de continuidade do cuidado. Timeline operacional e consultas respeitam os filtros de unidade definidos em suas rotas.

## Evidências desta entrega

Os relatórios de UI registram cenários e erros em `.data/ui-review/*-results.json`. Os testes de backup validam salvaguardas e integridade; a restauração real deve ser ensaiada em ambiente com os clientes PostgreSQL instalados. Consulte também `docs/06-validacao-especializada.md` para as validações clínicas/jurídicas externas.
