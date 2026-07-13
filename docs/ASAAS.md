# Asaas — Pagamentos

Atualizado em: 2026-07-13.

## Atualização MVP — 2026-07-13

- Ambiente publicado continua em Sandbox: `ASAAS_ENV=sandbox`.
- `ENABLE_PAYMENTS=true`.
- Produção não foi ativada nesta rodada.
- Checklist separado criado em `docs/ASAAS_PRODUCTION.md`.
- Fluxo comercial público já foi validado com preço vindo exclusivamente de `turmas.preco`.
- Painel financeiro do professor reforçado neste ciclo:
  - filtro simples por status;
  - indicação visual de Sandbox;
  - referência da cobrança mascarada;
  - listagem site-scoped por professor.
- Notificações internas de pagamento ficam disponíveis em `/api/admin/notifications`.
- Produção Asaas segue bloqueada até revisão de domínio, webhook produção, PIX real de baixo valor e política de reembolso/chargeback.

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
- Após confirmação manual no painel Asaas, a sincronização protegida consultou o provedor e atualizou o pagamento local para `RECEIVED`.
- A matrícula do aluno foi criada/ativada automaticamente com origem `ASAAS_SYNC`.
- Nenhum webhook de pagamento confirmado chegou para a cobrança homologada; o endpoint não registrou erro no Worker.
- Novo ciclo completo em 2026-07-13 validou o fluxo principal por webhook:
  - cobrança sandbox `pay_k1hnnk6q1mt7l20l`;
  - `PAYMENT_CREATED` recebido, armazenado e processado sem liberar matrícula;
  - `PAYMENT_RECEIVED` recebido com status Asaas `RECEIVED_IN_CASH`, normalizado para `RECEIVED`;
  - pagamento interno atualizado para `RECEIVED`;
  - matrícula criada uma única vez com origem `ASAAS_WEBHOOK`;
  - aluno passou a acessar a turma de homologação.
- Ciclo comercial público em 2026-07-13 validou que qualquer turma nova com preço cadastrado pode iniciar venda pelo site público:
  - turma criada pelo professor: `Homologacao Comercial 20260713-000003`, valor `R$ 5,73`;
  - página pública exibiu a turma;
  - checkout público carregou turma/preço diretamente do banco;
  - cobrança PIX Asaas Sandbox criada: `pay_4d2uxcz072cm1m5s`;
  - `payments` ficou `PENDING` até webhook pago;
  - segundo clique no checkout reaproveitou a mesma cobrança pendente;
  - `PAYMENT_CREATED` não liberou matrícula;
  - após confirmação manual no Asaas, `PAYMENT_RECEIVED` atualizou `payments` para `RECEIVED`;
  - matrícula ativa criada com origem `ASAAS_CHECKOUT`;
  - aluno acessou a turma;
  - professor visualizou pagamento no dashboard;
  - notificação interna `PAYMENT_RECEIVED` foi gravada no CMS do site.

## Arquivos Preparados

- `src/payments.ts`: gateway desacoplado para Asaas.
- `src/payments.ts`: criação de cliente, cobrança PIX, QR Code, chave Pix EVP e tentativa controlada de pagamento de QR Code sandbox.
- `src/payments.ts`: normalização de payload de webhook e chave de idempotência.
- `src/types.ts`: variáveis `ASAAS_ENV`, `ASAAS_API_KEY` e `ASAAS_WEBHOOK_TOKEN`.
- `.env.example`: variáveis sem valores reais.
- `migrations/005_payments.sql`: tabelas de pagamentos e eventos de webhook.
- `src/routes/payments.ts`: rota guardada para webhook Asaas.
- `src/routes/payments.ts`: rota autenticada de homologação sandbox.
- `src/routes/payments.ts`: rota autenticada de sincronização sandbox para consultar status no Asaas e aplicar matrícula quando o status for pago.
- `src/routes/site.ts`: checkout público real em sandbox para turmas ativas.
- `src/routes/admin.ts`: consulta administrativa de pagamentos por site.
- `public/professor/index.html`: bloco de pagamentos recentes no dashboard.

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

- Validar idempotência real com reenvio manual do evento pelo painel Asaas Sandbox, quando necessário.
- Expandir checkout real para produção quando `ASAAS_ENV=production` for autorizado.
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
- Após confirmação manual, `POST /api/payments/asaas/sandbox-homologation/:id/sync` atualizou o pagamento para `RECEIVED`.
- A matrícula ficou ativa e repetição da sincronização manteve apenas uma matrícula ativa.
- Webhook real de confirmação não chegou para a cobrança homologada; existe apenas um evento antigo `PAYMENT_CREATED` de outro pagamento sem referência externa.

## Resultado da Homologação Completa por Webhook — 2026-07-13

- Cobrança sandbox: `pay_k1hnnk6q1mt7l20l`.
- Payment interno: `988a0f5f-5c39-47a9-842e-a5664ee13072`.
- External reference: `ASAAS-HML-d265f4dc-bb9b-4557-9419-18faf68c8c07`.
- `PAYMENT_CREATED`:
  - recebido pelo webhook;
  - resposta HTTP 200;
  - gravado uma vez em `payment_webhook_events`;
  - `processed=true`;
  - pagamento permaneceu `PENDING`;
  - matrícula permaneceu bloqueada.
- `PAYMENT_RECEIVED`:
  - recebido pelo webhook;
  - resposta HTTP 200 segundo comportamento atual da rota;
  - gravado uma vez em `payment_webhook_events`;
  - `processed=true`;
  - status externo `RECEIVED_IN_CASH` normalizado para `RECEIVED`;
  - payment interno atualizado para `RECEIVED`;
  - matrícula ativa criada uma única vez.
- Token inválido retorna HTTP 401.
- Acesso do aluno validado na rota de turmas.

## Resultado do Fluxo Comercial Público — 2026-07-13

- Worker publicado: `cursoreducao`, versão `a6c0461f-f674-4f0f-9b53-4c7e9bdb548f`.
- Turma criada via API do professor:
  - nome: `Homologacao Comercial 20260713-000003`;
  - status: `ABERTA`;
  - preço no banco: `R$ 5,73`;
  - site: `puppin-teste`.
- Página pública da turma carregou corretamente.
- Checkout público retornou:
  - status `PENDING`;
  - valor `5.73`;
  - nome da turma;
  - QR Code Pix;
  - copia-e-cola Pix;
  - `provider_payment_id=pay_4d2uxcz072cm1m5s`.
- Antes do pagamento:
  - `payments.status=PENDING`;
  - `payment_webhook_events` recebeu `PAYMENT_CREATED`;
  - nenhuma matrícula foi criada.
- Após confirmação manual no painel Asaas:
  - `payment_webhook_events` recebeu `PAYMENT_RECEIVED`;
  - evento ficou `processed=true`;
  - `payments.status=RECEIVED`;
  - `payments.paid_at` preenchido;
  - matrícula ativa criada na turma;
  - aluno de teste acessou a turma comprada;
  - professor visualizou o pagamento em `/api/admin/payments` e no bloco de dashboard;
  - notificação interna `Aluno pagou uma turma` registrada no CMS.
