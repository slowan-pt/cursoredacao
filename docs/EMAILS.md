# E-mails Transacionais

Atualizado em: 2026-07-13.

## Estado

- Camada local preparada.
- Feature flag padrão: `ENABLE_EMAILS=false`.
- Provedores preparados: Brevo e Resend via REST API.
- Provedor recomendado para o início: Brevo, por causa do plano gratuito com maior limite diário.
- `BREVO_API_KEY`/`RESEND_API_KEY` ainda devem ser configuradas como secrets no Worker conforme o provedor escolhido.
- Nenhum e-mail real foi enviado neste ciclo.
- Nenhuma chave real foi adicionada.
- Nenhum e-mail real foi enviado nesta sessão.
- `MockEmailProvider` preparado para validação local sem envio real.
- Templates adicionais preparados em `src/email.ts`:
  - pagamento aprovado para o aluno;
  - pagamento vencido;
  - reembolso/estorno;
  - novo aluno pago para o professor;
  - recuperação de senha, sem substituir o fluxo seguro do Supabase Auth.
- Envio real continua bloqueado até criação de `RESEND_API_KEY`, verificação do domínio de envio e troca consciente de `ENABLE_EMAILS=true`.

## Arquivos Preparados

- `src/email.ts`: provider abstrato, provider desativado, provider Brevo e provider Resend.
- `src/email.ts`: templates puros para recibo de checkout e correção disponível.
- `src/types.ts`: `BREVO_API_KEY`, `RESEND_API_KEY`, `EMAIL_PROVIDER` e `EMAIL_FROM`.
- `.env.example`: variáveis sem valores reais.

## Brevo

A documentação oficial da Brevo informa:

- Envio transacional por API: `POST https://api.brevo.com/v3/smtp/email`
- Autenticação: header `api-key`
- Antes de enviar, é necessário criar a API key e registrar/verificar o remetente.

Referências:

- https://developers.brevo.com/docs/send-a-transactional-email
- https://developers.brevo.com/reference/send-transac-email
- https://help.brevo.com/hc/en-us/articles/209467485-Create-and-manage-your-API-keys

## Resend

A documentação oficial do Resend informa:

- Base URL: `https://api.resend.com`
- Envio: `POST /emails`
- Autenticação: header `Authorization: Bearer <api key>`

Referências:

- https://resend.com/docs/api-reference/introduction
- https://resend.com/docs/api-reference/emails/send-email

## Ativação Manual Futura

1. Verificar domínio/remetente no provedor escolhido.
2. Criar API key com menor permissão possível para envio.
3. Definir secrets no ambiente correto:

```bash
npx wrangler secret put BREVO_API_KEY
# ou, se escolher Resend:
npx wrangler secret put RESEND_API_KEY
```

4. Configurar:

```text
ENABLE_EMAILS=true
EMAIL_PROVIDER=brevo
EMAIL_FROM="Redação com Estratégia <no-reply@redacaocomestrategia.com.br>"
```

5. Testar em homologação antes de produção.

## Templates Planejados

- recibo de checkout;
- correção concluída;
- confirmação de cadastro;
- recuperação de senha via Supabase Auth;
- pagamento confirmado;
- matrícula liberada;
- falha de pagamento.

## Templates Preparados

- `renderCheckoutReceiptEmail`
  - informa turma, código único e transação;
  - direciona o aluno para login/cadastro;
  - não envia e-mail sozinho.
- `renderCorrectionReadyEmail`
  - informa atividade/turma;
  - direciona o aluno para visualizar a correção;
  - não envia e-mail sozinho.
- `renderPaymentApprovedEmail`
- `renderPaymentOverdueEmail`
- `renderPaymentRefundedEmail`
- `renderTeacherNewPaidStudentEmail`
- `renderPasswordRecoveryEmail`

## Ainda Não Integrado

- Os templates não são disparados automaticamente enquanto `ENABLE_EMAILS=false`.
- Falta configurar `RESEND_API_KEY` e domínio/remetente verificado.
- Falta definir política de retry/idempotência para envio real.
- Falta criar prévias visuais automatizadas dos templates em HTML estático.
- `npm run preview:emails` gera prévias locais em `tmp/email-previews` e valida `MockEmailProvider` sem API key real.

## Preview Local

```bash
npm run preview:emails
```

O comando:

- não usa `RESEND_API_KEY`;
- não envia e-mails reais;
- gera HTMLs locais em `tmp/email-previews`;
- valida os templates com `MockEmailProvider`;
- mantém os arquivos gerados fora do Git.

## Regras de Segurança

- Não registrar API key em logs.
- Não enviar e-mails reais em ambiente de desenvolvimento por padrão.
- Não substituir recuperação de senha do Supabase sem necessidade.
- Não incluir dados sensíveis desnecessários em templates.
- Registrar apenas status de envio e identificador do provedor.
