# Asaas — Pagamentos

Atualizado em: 2026-07-12.

## Estado

- Integração real ainda não está ativada.
- Feature flag padrão: `ENABLE_PAYMENTS=false`.
- Ambiente padrão: `ASAAS_ENV=sandbox`.
- Nenhuma chave real foi adicionada.
- Nenhuma cobrança real foi criada.
- `ASAAS_WEBHOOK_TOKEN` existe no Worker; `ASAAS_API_KEY` ainda não existe.
- Migration `005_payments.sql` aplicada no banco remoto em 2026-07-12.
- Rota `POST /api/payments/asaas/webhook` preparada e fechada por `ENABLE_PAYMENTS=false`.

## Arquivos Preparados

- `src/payments.ts`: gateway desacoplado para Asaas.
- `src/payments.ts`: normalização de payload de webhook e chave de idempotência.
- `src/types.ts`: variáveis `ASAAS_ENV`, `ASAAS_API_KEY` e `ASAAS_WEBHOOK_TOKEN`.
- `.env.example`: variáveis sem valores reais.
- `migrations/005_payments.sql`: tabelas de pagamentos e eventos de webhook.
- `src/routes/payments.ts`: rota guardada para webhook Asaas.

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

- Testar rota de webhook com `ENABLE_PAYMENTS=true` em sandbox.
- Criar endpoint de checkout real.
- Persistir cobrança em `payments`.
- Liberar matrícula somente no processamento idempotente do webhook.
- Definir política para boleto/cartão além de PIX.
- Criar testes com mocks.
