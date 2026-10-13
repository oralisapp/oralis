# Oralis — interface e experiência

**Objetivo:** renovar a experiência da clínica com identidade editorial, navegação clara e foco no trabalho de hoje.
**Direção:** verde floresta, lima, papel claro, tipografia Manrope e títulos editoriais; tema escuro com os mesmos contrastes semânticos.
**Arquitetura:** manter Next.js, TanStack Query, componentes compartilhados e autorização existente. Dados do painel vêm das consultas atuais; nenhuma métrica fictícia.

## Implementação
1. Atualizar tokens, tipografia, campos, botões, cartões e cabeçalhos.
2. Renovar shell com navegação escura, contexto de clínica/unidade, busca de navegação por teclado e menu móvel acessível.
3. Redesenhar painel com métricas, progresso diário, próximos atendimentos, tarefas e fluxo de pacientes.
4. Refinar lista de pacientes e moldura de autenticação.
5. Verificar TypeScript, build e interface em desktop/mobile, com estados vazios, falhas e tema escuro.

## Critérios
- Nenhuma alteração de contratos da API ou regras clínicas.
- Atalhos respeitam permissões; seletores de clínica/unidade permanecem disponíveis.
- Navegação por teclado, foco visível e preferência por movimento reduzido.
- Layout adaptável a telas pequenas, sem esconder dados essenciais.

## Verificação realizada
- `npm run typecheck -w @oralis/web`: aprovado.
- `npm run build -w @oralis/web`: aprovado.
- Chromium headless, com respostas da API simuladas exclusivamente para teste visual: desktop 1440 px, celular 390 px e 320 px.
- Sem overflow horizontal nas larguras verificadas.
- Busca de navegação com Ctrl+K e foco inicial; abertura do menu móvel com foco dentro do diálogo.
- Busca de pacientes, resultado vazio e limpeza de busca.
- Painel preenchido, vazio e erro de carregamento; temas claro e escuro.
- Capturas locais em `.data/ui-review/`; dados dessas capturas são fictícios e não foram gravados no banco.
- Nenhum teste de mutação clínica ou financeira foi executado nesta mudança de interface.
