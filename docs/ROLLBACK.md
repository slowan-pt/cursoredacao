# Rollback

Atualizado em: 2026-07-13.

## Estado Atual de Referência

- Worker publicado mais recente validado: `b2fb90d2-33cb-49f8-acbd-880f65ef4c1e`.
- Worker antigo `cursoreducao` permanece publicado como fallback temporário, mas o alvo oficial atual é `cursoredacao`.
- `ENABLE_R2_UPLOADS=true`; rollback de código não deve apagar objetos R2.
- `ENABLE_PAYMENTS=true` com `ASAAS_ENV=sandbox`; não alternar para produção durante rollback.

## Regras

- Não executar rollback sem identificar a versão atual e a versão alvo.
- Não reverter migrations destrutivamente.
- Não apagar dados de usuários.
- Não fazer force push como rollback de aplicação publicada.

## Cloudflare Workers

Inspecionar versões:

```bash
npx wrangler versions list
```

Rollback após aprovação:

```bash
npx wrangler rollback
```

Ou para uma versão específica:

```bash
npx wrangler rollback <VERSION_ID>
```

## Banco de Dados

- Migrations deste projeto devem ser não destrutivas por padrão.
- Para falha após migration, preferir migration corretiva.
- Não executar `DROP`, `TRUNCATE` ou exclusão em massa sem backup e aprovação.

## R2

- Arquivos privados não devem ser removidos em rollback de código.
- Se uma versão nova gravar metadados incorretos, corrigir metadados com script dry-run revisado.

## Checklist Pós-Rollback

- `/health` responde.
- Login funciona.
- Rotas de professor/aluno funcionam.
- Upload/download conforme flags.
- Logs sem erro repetitivo.
- Asaas Sandbox continua em `ASAAS_ENV=sandbox`.
- Painel de saúde superadmin responde em `/api/superadmin/health`.
# Rollback Do Módulo Financeiro

Atualizado em: 2026-07-13.

## Rollback Preferencial

1. Alterar no `wrangler.jsonc`:
   - `ENABLE_FINANCIAL_MODULE=false`
   - `ENABLE_TEACHER_COMPENSATION=false`
   - manter `ENABLE_FINANCIAL_EXPORTS=false`
   - manter `ENABLE_FINANCIAL_CHARTS=false`
2. Executar `npm run check:all`.
3. Executar `npx wrangler deploy --dry-run`.
4. Executar `npx wrangler deploy`.
5. Validar `/health` e login professor.

## Rollback De Versão Worker

- Versão anterior ao endurecimento transacional publicado: `39d88ab7-3851-49f2-803d-025206076221`.
- Versão transacional atual validada: `f3f442df-7841-4cb9-b210-631199ca10b2`.
- Usar `npx wrangler rollback <VERSION_ID>` somente se o rollback por flag não resolver.

## Banco De Dados

- Não executar `DROP TABLE` em produção para rollback operacional.
- As tabelas e RPCs financeiras podem permanecer sem uso quando as flags estiverem desligadas.
- Não executar backfill real sem backup e aprovação explícita.

## Observação

O registro manual de pagamento no módulo financeiro é controle interno. Ele não representa transferência bancária automática para o professor filho.
