# Asaas Producao

Atualizado em: 2026-07-13.

## Estado

- Sandbox homologado.
- `ASAAS_ENV=sandbox` deve permanecer ate autorizacao comercial.
- Nao usar API de producao neste ciclo.
- Nao criar cobranca real automaticamente.

## Antes De Ativar Producao

1. Dominio oficial funcionando com HTTPS.
2. Webhook de producao criado no Asaas:

```text
https://redacaocomestrategia.com.br/api/payments/asaas/webhook
```

3. Token de webhook exclusivo de producao.
4. `ASAAS_API_KEY` de producao configurada via `wrangler secret put`.
5. Teste PIX real de baixo valor aprovado pelo responsavel comercial.
6. Politicas de cancelamento, reembolso, chargeback e suporte revisadas.

## Estados De Pagamento

Liberam matricula automaticamente:

- `PAYMENT_CONFIRMED`
- `PAYMENT_RECEIVED`
- status externo normalizado como `RECEIVED_IN_CASH`

Nao liberam matricula:

- `PAYMENT_CREATED`
- `PAYMENT_PENDING`
- `PAYMENT_OVERDUE`
- `PAYMENT_DELETED`
- `PAYMENT_REFUNDED`
- `PAYMENT_CHARGEBACK_REQUESTED`
- `PAYMENT_AWAITING_CHARGEBACK_REVERSAL`

Nao remover acesso automaticamente em reembolso ou chargeback sem regra comercial aprovada.

## Rollback

1. Voltar `ASAAS_ENV=sandbox`.
2. Manter webhook sandbox ativo.
3. Desativar temporariamente compra publica se necessario com `ENABLE_PAYMENTS=false`.
4. Reconciliar manualmente pagamentos reais criados durante o incidente.

