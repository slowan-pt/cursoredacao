# Asaas — Pagamentos

Atualizado em: 2026-07-12.

## Estado

- Integração real está em homologação sandbox.
- Feature flag publicada no Worker atual: `ENABLE_PAYMENTS=true`.
- Ambiente padrão: `ASAAS_ENV=sandbox`.
- `ASAAS_WEBHOOK_TOKEN` e `ASAAS_API_KEY` existem como Cloudflare Secrets no Worker `cursoreducao`.
- Migration `005_payments.sql` aplicada no banco remoto em 2026-07-12.
- A rota de webhook fica ativa com token mesmo quando `ENABLE_PAYMENTS=false`, para não perder eventos de pagamento.
- Ao receber pagamento `CONFIRMED` ou `RECEIVED` para um registro existente, o webhook vincula o aluno à turma, ativa o aluno e registra créditos.
- Rota protegida `POST /api/payments/asaas/sandbox-homologation` criada para homologação controlada em sandbox.
- Homologação em 2026-07-12 criou cliente, chave Pix ativa, cobrança PIX R$ 5,00 e QR Code/copia-e-cola sandbox.
- Pagamento automático do QR Code via API ficou bloqueado pelo Asaas: `insufficient_permission` para operações de saque/pagamento via API.
- O pagamento local mais recente permanece `PENDING` até simulação/pagamento manual no Asaas Sandbox.
- Nenhum webhook de pagamento confirmado chegou para a cobrança mais recente porque o pagamento não foi concluído no sandbox.

## Arquivos Preparados

- `src/payments.ts`: gateway desacoplado para Asaas.
- `src/payments.ts`: criação de cliente, cobrança PIX, QR Code, chave Pix EVP e tentativa controlada de pagamento de QR Code sandbox.
- `src/payments.ts`: normalização de payload de webhook e chave de idempotência.
- `src/types.ts`: variáveis `ASAAS_ENV`, `ASAAS_API_KEY` e `ASAAS_WEBHOOK_TOKEN`.
- `.env.example`: variáveis sem valores reais.
- `migrations/005_payments.sql`: tabelas de pagamentos e eventos de webhook.
- `src/routes/payments.ts`: rota guardada para webhook Asaas.
- `src/routes/payments.ts`: rota autenticada de homologação sandbox.

## Segurança do Webhook

Segundo a documentação oficial do Asaas, o webhook pode enviar um token no header `asaas-access-token`.
O endpoint da aplicação deve validar esse header antes de processar qualquer evento.

Referências oficiais:

- https://docs.asaas.com/docs/webhooks-3
- https://docs.asaas.com/docs/receive-asaas-events-at-your-webhook-endpoint
- https://docs.asaas.com/docs/create-new-webhook-via-api

## Regras de Idempotência

- Cada evento deve ser armazenado em `payment_webhook_events`.
- A chave única planejada é `(provider, provider_event_id)`.
- A função `buildPaymentWebhookIdempotencyKey` gera uma chave interna no formato `ASAAS:{providerEventId}`.
- A função `normalizeAsaasWebhookPayload` extrai evento, pagamento, status normalizado e referência externa sem liberar matrícula.
- Eventos repetidos devem retornar sucesso sem repetir matrícula.
- A matrícula só deve ser liberada após confirmação confiável pelo webhook.
- O retorno do navegador nunca deve liberar matrícula em produção.

## Estados Internos

- `PENDING`
- `CONFIRMED`
- `RECEIVED`
- `OVERDUE`
- `CANCELED`
- `REFUNDED`
- `CHARGEBACK`
- `FAILED`

## Ativação Manual Futura

1. Criar chave sandbox no Asaas.
2. Definir secrets no ambiente correto:

```bash
npx wrangler secret put ASAAS_API_KEY
npx wrangler secret put ASAAS_WEBHOOK_TOKEN
```

3. Configurar:

```text
ENABLE_PAYMENTS=true
ASAAS_ENV=sandbox
```

4. Confirmar que `migrations/005_payments.sql` segue aplicada no Supabase.
5. Criar webhook sandbox apontando para `/api/payments/asaas/webhook`.
6. Testar:
   - evento duplicado;
   - pagamento pendente;
   - pagamento confirmado;
   - pagamento cancelado;
   - falha de token;
   - matrícula duplicada.

## Pendências

- Concluir pagamento/simulação manual da cobrança sandbox criada para disparar webhook real.
- Alternativa: habilitar permissão de pagamento/saque via API na chave sandbox e repetir a rota de homologação.
- Após pagamento confirmado, validar gravação em `payment_webhook_events`, atualização de `payments` e matrícula automática.
- Validar idempotência real reenviando o mesmo evento.
- Criar endpoint de checkout real para uso público.
- Definir política para boleto/cartão além de PIX.
- Criar testes com mocks.

## Resultado da Homologação Sandbox — 2026-07-12

- Worker publicado com `ENABLE_PAYMENTS=true` e `ASAAS_ENV=sandbox`.
- API Asaas autenticada com sucesso após inclusão de `User-Agent`.
- Conta sandbox exigiu chave Pix ativa; a homologação passou a criar/verificar chave `EVP` automaticamente.
- Cobrança PIX sandbox de R$ 5,00 criada e persistida em `payments`.
- QR Code e código PIX foram retornados pela API.
- Webhook sem token respondeu `401`, como esperado.
- Simulação automática de pagamento via `POST /pix/qrCodes/pay` foi recusada pelo Asaas por falta de permissão de saque/pagamento via API.
- Status local esperado até ação manual: `PENDING`.
