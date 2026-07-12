# E-mails Transacionais

Atualizado em: 2026-07-12.

## Estado

- Camada local preparada.
- Feature flag padrão: `ENABLE_EMAILS=false`.
- Provedor preparado: Resend via REST API.
- Nenhuma chave real foi adicionada.
- Nenhum e-mail real foi enviado nesta sessão.

## Arquivos Preparados

- `src/email.ts`: provider abstrato, provider desativado e provider Resend.
- `src/types.ts`: `RESEND_API_KEY` e `EMAIL_FROM`.
- `.env.example`: variáveis sem valores reais.

## Resend

A documentação oficial do Resend informa:

- Base URL: `https://api.resend.com`
- Envio: `POST /emails`
- Autenticação: header `Authorization: Bearer <api key>`

Referências:

- https://resend.com/docs/api-reference/introduction
- https://resend.com/docs/api-reference/emails/send-email

## Ativação Manual Futura

1. Verificar domínio/remetente no Resend.
2. Criar API key com menor permissão possível para envio.
3. Definir secrets no ambiente correto:

```bash
npx wrangler secret put RESEND_API_KEY
```

4. Configurar:

```text
ENABLE_EMAILS=true
EMAIL_FROM="Redação com Estratégia <no-reply@redacaocomestrategia.com.br>"
```

5. Testar em homologação antes de produção.

## Templates Planejados

- confirmação de cadastro;
- recuperação de senha via Supabase Auth;
- pagamento confirmado;
- matrícula liberada;
- correção concluída;
- falha de pagamento.

## Regras de Segurança

- Não registrar API key em logs.
- Não enviar e-mails reais em ambiente de desenvolvimento por padrão.
- Não substituir recuperação de senha do Supabase sem necessidade.
- Não incluir dados sensíveis desnecessários em templates.
- Registrar apenas status de envio e identificador do provedor.
