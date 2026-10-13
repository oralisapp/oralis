# Requisitos que dependem de validação especializada

O Oralis Cloud **não declara conformidade legal automática**. Os itens abaixo
são premissas técnicas que precisam ser confirmadas por profissionais
habilitados antes do lançamento comercial.

## Jurídico / LGPD

| Tema | Premissa atual do sistema | Validar com |
|---|---|---|
| Papéis LGPD | Clínica = controladora dos dados de pacientes; Oralis = operadora | Advogado(a) especialista em proteção de dados |
| Base legal para dados de saúde | Tutela da saúde / execução de contrato; consentimento específico para comunicações de relacionamento | idem |
| Contrato de tratamento de dados (DPA) | Ainda não redigido | idem |
| Direitos do titular (acesso, correção, portabilidade) | Fluxo planejado; exclusão limitada por obrigações de guarda | idem |
| Retenção após cancelamento da assinatura | Dados **não** são apagados automaticamente; exportação disponível; prazo de guarda a definir | idem + regulação odontológica |
| Registro de acesso a dados pessoais | Abertura de ficha de paciente é auditada | idem |
| Transferência internacional (hospedagem, IA) | Não há; qualquer fornecedor fora do Brasil exige avaliação | idem |
| Termos de uso e política de privacidade | Em elaboração; a tela de cadastro informa que são preliminares | idem |
| Incidentes de segurança | Procedimento de comunicação à ANPD e titulares a definir | idem |

## Regulação odontológica (CFO / CROs)

| Tema | Premissa atual | Validar com |
|---|---|---|
| Prazo de guarda do prontuário odontológico | Prontuário não é excluído pela aplicação; prazo a confirmar | Consultor(a) de regulação odontológica / CFO |
| Prontuário eletrônico e assinatura | Finalização com autoria e hash interno (incremento 2); assinatura com validade jurídica só via certificadora | idem + certificadora |
| Autoria e responsabilidade técnica | Cada registro clínico terá profissional responsável, data e unidade | idem |
| Numeração dentária | Notação FDI (ISO 3950) proposta para o odontograma | Dentista revisor(a) |
| Termos de consentimento | Modelos serão fornecidos pela clínica; o sistema não gera consentimento a partir do aceite de orçamento | Dentista + jurídico |
| Publicidade e apresentação de tratamentos | Sem "antes e depois" sintético; ilustrações rotuladas | Código de Ética Odontológica |

## Fiscal e pagamentos

| Tema | Premissa | Validar com |
|---|---|---|
| Emissão de NFS-e | Não implementada; depende de emissor homologado por município | Contador(a) + fornecedor |
| Cobrança de pacientes e da assinatura | Fluxos e credenciais separados; dados de cartão nunca armazenados | Provedor de pagamentos (PCI) |
| Comissões e repasses | Regras configuráveis; enquadramento trabalhista/tributário fora do escopo do software | Contador(a) |

## Segurança

| Tema | Situação |
|---|---|
| Teste de intrusão independente | Não realizado |
| Backup e teste de restauração | Não configurado neste ambiente local |
| Criptografia em repouso | Depende da hospedagem do PostgreSQL e do armazenamento de objetos |
| MFA para perfis privilegiados | Implementado: ativação/desativação na conta, desafio de login e códigos de recuperação; testar política da clínica antes de produção |
