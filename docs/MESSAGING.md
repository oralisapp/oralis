# SMS e WhatsApp via Twilio

A central de comunicações, campanhas e automações usa a API de mensagens Twilio. O envio continua condicionado ao consentimento por canal/categoria, bloqueio de organizações de demonstração e limite semanal. A implantação não enviou mensagens reais.

## Configuração

1. No ambiente da API, configure `TWILIO_ACCOUNT_SID` e `TWILIO_AUTH_TOKEN` como segredos. Não use variáveis `NEXT_PUBLIC_*`.
2. Para SMS, configure `TWILIO_SMS_FROM` com um remetente Twilio habilitado, em E.164 (`+` e código do país). Para WhatsApp, configure `TWILIO_WHATSAPP_FROM` com um remetente aprovado, também em E.164, sem `whatsapp:`. A integração acrescenta o prefixo.
3. O telefone do paciente aceita o formato brasileiro nacional já usado no cadastro; o adaptador acrescenta `+55`. Números internacionais explícitos precisam começar com `+`.
4. WhatsApp requer um modelo aprovado no Content Template Builder. Crie o modelo local com o mesmo texto e associe seu **UUID de versão** ao ContentSid em `TWILIO_WHATSAPP_TEMPLATES`. Exemplo (substitua todos os IDs):

```dotenv
TWILIO_WHATSAPP_TEMPLATES='{"00000000-0000-4000-8000-000000000001":{"contentSid":"HX00000000000000000000000000000000","variables":{"1":"primeiro_nome","2":"data","3":"hora","4":"link"}}}'
```

As chaves numéricas correspondem aos parâmetros do modelo aprovado. Os valores permitidos são `primeiro_nome`, `clinica`, `data`, `hora`, `profissional` e `link`. Variáveis obrigatórias vazias bloqueiam o envio. O modelo local serve à prévia; mantenha seu texto sincronizado com o aprovado no provedor. Ao editar um modelo local, ele recebe novo UUID e precisa de novo vínculo. Isso impede reutilizar silenciosamente uma aprovação para conteúdo alterado.

5. Para lembretes WhatsApp, selecione o modelo vinculado na automação. O texto padrão de automações sem modelo local não é enviado por WhatsApp. A API não presume uma sessão de atendimento de 24 horas e não envia texto livre por esse canal.
6. Reinicie a API após alterar as variáveis. A prévia mostra se o canal/modelo está configurado. Credenciais ausentes deixam o canal como `not_configured`; formatos inválidos de configuração impedem a inicialização, sem expor os valores.

## Estados e recuperação

O pedido é registrado antes do POST ao provedor. Uma resposta aceita salva o SID externo e o estado `queued`: **não significa entregue ou lido**. A implementação não recebe callbacks; consulte o console Twilio para a confirmação final. O histórico mostra os detalhes de envio e o SID para conferência.

O limite semanal reserva uma vaga em transação curta por clínica/paciente, compartilhada entre e-mail, SMS e WhatsApp. Envios pendentes já contam no limite, inclusive quando chegam simultaneamente. A transação termina antes de chamar o provedor; o resultado atualiza o mesmo registro.

Rejeições HTTP e falhas explícitas são registradas como `failed`. Timeout, desconexão, erro 5xx ou resposta inválida deixam o estado `queued` com detalhe de resultado incerto, pois o provedor pode ter recebido o pedido. Não há repetição automática de POST. Confira o console antes de repetir manualmente, evitando duplicidade. `TWILIO_TIMEOUT_MS` limita a chamada de 1 a 30 segundos (padrão 10 segundos).

Antes de ativar automações em uma clínica real, valide consentimentos, credenciais, remetentes e modelos aprovados com um destinatário de teste autorizado. Contas trial/sandbox têm restrições próprias. Os testes locais simulam a fronteira HTTP e não comprovam a habilitação da conta externa.

## Referências

- [Twilio Messages resource](https://www.twilio.com/docs/messaging/api/message-resource): endpoint, autenticação, parâmetros e estados.
- [Twilio WhatsApp API](https://www.twilio.com/docs/whatsapp/api): remetentes e mensagens WhatsApp.
- [Twilio Content API](https://www.twilio.com/docs/content/content-api-resources): ContentSid e ContentVariables.

Teste isolado sem banco: `node node_modules/jest/bin/jest.js --config apps/api/test/jest.mobile.config.cjs --runInBand`.
