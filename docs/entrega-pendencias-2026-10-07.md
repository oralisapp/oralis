# Entrega das pendências

## Recursos implementados

- Estoque: materiais, mínimo, fornecedores, entradas/saídas, perdas, ajustes, transferências, consumo por procedimento, saldos por unidade e lotes disponíveis. Saídas automáticas distribuem a quantidade entre lotes; referências entre organizações são recusadas.
- Laboratórios: parceiros, solicitações, responsável e tratamento, acompanhamento de estados, retrabalho, histórico e ficha reduzida. Filtros de unidade são aplicados antes dos limites de resultados.
- Pacientes: CSV UTF-8 até 100 KB/500 pacientes, mapeamento, prévia, validação, confirmação transacional e relatório. Proteção contra reimportação idêntica. Consolidação auditada com versões e históricos originais vinculados, sem reescrever prontuários. Ver [regras e limites](patient-import-consolidation.md).
- Mensagens: adaptador Twilio para SMS e WhatsApp aprovado por modelo, validação de configuração, timeout e histórico com protocolo. Reserva transacional evita ultrapassar o limite semanal com chamadas simultâneas. Sem envio automático de teste a terceiros. Ver [configuração](MESSAGING.md).
- Operação: falha de conexão no ciclo da fila não derruba o servidor; build da interface não depende de baixar fontes. Formulário de recebimento preserva estado quando a ficha é renderizada novamente com o mesmo paciente.
- Documentação atualizada sobre MFA, módulos implementados e testes reais versus simulados.

## Verificação

- `npm run typecheck`: aprovado.
- API: 22 suítes / 196 testes aprovados, incluindo todas as regressões novas. [Comando e evidência](validation-api-2026-10-07.md).
- Regras compartilhadas: 22 testes aprovados.
- `npm run test:tools`: nove testes de backup aprovados.
- Build da API aprovado; build Next com webpack aprovado, inclusive após o ajuste do recebimento (35 páginas geradas, saída 0).
- A migração 0015 foi aplicada ao banco de desenvolvimento e ao banco de testes.
- `npm run test:e2e`: seis etapas aprovadas com interface/API/PostgreSQL reais, saída 0, sem erros de runtime. Evidência: `.data/real-journey/3e30758e-6ab7-4347-90b2-1aac3a035f46/results.json` (`passed: true`) e cinco capturas na mesma pasta. Verificados cadastro/onboarding, paciente, confirmação/check-in/atendimento e evolução finalizada, recebimento de parcela com saldo zerado, novos cadastros de estoque/laboratório e portal do paciente. As execuções intermediárias com falha também são preservadas.

## Dependências externas restantes

1. **Restauração real de backup:** o ensaio não foi executado. `npm run backup` falhou porque `pg_dump` não existe neste ambiente; `pg_restore` também não foi localizado. O download dos clientes PostgreSQL foi bloqueado pela rede. Instalar os clientes compatíveis, configurar `PG_BIN` e seguir [operação e recuperação](07-operacao.md).
2. **Homologação de provedores:** configurar credenciais e modelos aprovados de mensagens e validar a conta real. SMTP, Stripe e outros provedores continuam dependendo das respectivas credenciais e ambiente. Testes locais não certificam entrega externa, pagamento real ou restauração real.

Nenhuma publicação ou comunicação para pacientes reais foi realizada. As clínicas criadas pelo teste têm nomes iniciados por “Clínica sintética E2E” e e-mails no domínio reservado `example.test`.
