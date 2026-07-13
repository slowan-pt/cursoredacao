# Dominio Oficial

Atualizado em: 2026-07-13.

Dominio oficial: `https://redacaocomestrategia.com.br`.

## Estado Atual

- `APP_URL` ja aponta para `https://redacaocomestrategia.com.br` no `wrangler.jsonc`.
- O Worker publicado e validado continua acessivel pelo fallback `https://cursoredacao.slowgithub.workers.dev`.
- O Worker antigo `https://cursoreducao.slowgithub.workers.dev` foi preservado temporariamente para rollback/observacao.
- `workers_dev=true` deve permanecer ate o dominio oficial passar nos testes.
- A tentativa de configurar custom domains via `wrangler.jsonc` falhou na API de domain records da Cloudflare com HTTP 400.
- As rotas de custom domain foram removidas do `wrangler.jsonc` para nao quebrar deploys futuros.

## Acao Manual Recomendada

1. Cloudflare Dashboard.
2. Workers & Pages.
3. Abrir o Worker `cursoredacao`.
4. Settings.
5. Triggers.
6. Custom Domains.
7. Add Custom Domain.
8. Adicionar `redacaocomestrategia.com.br`.
9. Repetir para `www.redacaocomestrategia.com.br`.
10. Confirmar que os registros DNS ficam proxied.
11. Aguardar emissao do certificado SSL.

## Testes Depois Da Configuracao

```bash
npm run smoke:prod -- --base=https://redacaocomestrategia.com.br
```

Se preferir sem argumento, use:

```bash
$env:APP_BASE_URL="https://redacaocomestrategia.com.br"
npm run smoke:prod
```

Validar manualmente:

- `/health`
- `/`
- `/login.html`
- `/redacao/puppin-teste`
- login professor
- login aluno
- checkout sandbox
- envio de arquivo pequeno
- logout

## Rollback

Se o dominio falhar:

1. Remover temporariamente os custom domains do Worker no painel.
2. Manter `workers_dev=true`.
3. Usar `https://cursoredacao.slowgithub.workers.dev` como fallback.
4. Nao alterar secrets nem banco para resolver erro de DNS.
