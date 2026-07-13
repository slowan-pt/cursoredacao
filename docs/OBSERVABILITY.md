# Observabilidade

Atualizado em: 2026-07-13.

## Estado

- `src/observability.ts` adiciona `x-request-id`, `server-timing` e logs estruturados de erro.
- `wrangler.jsonc` esta com observability habilitado.
- `/health` retorna apenas estado minimo e versao, sem dados sensiveis.

## Eventos Para Monitorar

- HTTP 5xx.
- HTTP 401/403 em login, aluno, professor e webhook.
- Falha de upload R2.
- Falha de criacao de cobranca Asaas.
- Webhook Asaas autenticado com payload invalido.
- Webhook Asaas sem pagamento local correspondente.
- E-mail com erro quando `ENABLE_EMAILS=true`.
- Aluno pago sem matricula ativa.

## Runbooks Curtos

### Pagamento nao liberou

1. Verificar `payments` por `provider_payment_id` ou `external_reference`.
2. Verificar `payment_webhook_events`.
3. Confirmar se o evento recebido foi `PAYMENT_RECEIVED` ou `PAYMENT_CONFIRMED`.
4. Reenviar evento pelo painel Asaas Sandbox/Producao, se seguro.
5. Nao criar matricula manual sem registrar a causa.

### Upload indisponivel

1. Confirmar `ENABLE_R2_UPLOADS=true`.
2. Confirmar binding `R2_UPLOADS`.
3. Validar tamanho e MIME do arquivo.
4. Verificar logs do Worker por `request_id`.

### Login falhando

1. Testar `/health`.
2. Verificar `SUPABASE_URL` e publishable key no ambiente.
3. Confirmar se o usuario esta ativo e pertence ao site correto.
4. Nao reativar usuario sem autorizacao.

