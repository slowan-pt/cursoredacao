# Rollback

Atualizado em: 2026-07-12.

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
