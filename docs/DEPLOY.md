# Deploy Manual — Cloudflare Workers

Atualizado em: 2026-07-13.

Este projeto usa Cloudflare Workers com Wrangler. Não usar Docker/VPS para a arquitetura atual.

## Estado Atual do Worker

- Worker padrão: `cursoredacao`.
- Worker antigo preservado para rollback/observacao: `cursoreducao`.
- Último deploy validado no Worker novo: `c0515734-9256-4c7d-90ac-d3846d4bb9e4`.
- URL atual: `https://cursoredacao.slowgithub.workers.dev`.
- `APP_ENV=production`.
- `ENABLE_R2_UPLOADS=true`.
- `ENABLE_PAYMENTS=true`.
- `ASAAS_ENV=sandbox`.
- `ENABLE_PUBLIC_CHECKOUT_SIMULATED=false`.
- `ENABLE_EMAILS=false`.
- `ENABLE_OAUTH=false`.
- `ENABLE_APP_RATE_LIMITING=false`.
- Domínio oficial `redacaocomestrategia.com.br` ainda pendente de configuração final.
- `workers_dev=true` deve permanecer explícito enquanto o domínio oficial não estiver estável.
- Secrets essenciais ja configurados no Worker novo: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`, `SESSION_SECRET`.
- Secrets Asaas ainda precisam ser configurados no Worker novo antes de homologar pagamentos nele: `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN`.

## Pré-requisitos

- Credenciais rotacionadas.
- Histórico Git limpo ou risco aceito conscientemente.
- Secrets configuradas no Cloudflare.
- Bucket R2 criado, se `ENABLE_R2_UPLOADS=true`.
- Asaas sandbox configurado, se `ENABLE_PAYMENTS=true`.
- Resend configurado, se `ENABLE_EMAILS=true`.
- `npx tsc --noEmit` passando.
- `npm run security:scan` sem achados.

## Variáveis e Secrets

Secrets que devem ser configuradas por prompt interativo:

```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler secret put SUPABASE_SERVICE_KEY
npx wrangler secret put SESSION_SECRET
```

Opcionais conforme flags:

```bash
npx wrangler secret put ASAAS_API_KEY
npx wrangler secret put ASAAS_WEBHOOK_TOKEN
npx wrangler secret put RESEND_API_KEY
```

Não passar valores diretamente no comando.

## Checklist Antes do Deploy

```bash
git status --short --branch
npm run security:scan
npm run check:public
npx tsc --noEmit
git diff --check
```

Conferir manualmente:

- `ENABLE_PUBLIC_CHECKOUT_SIMULATED=false` em produção real.
- `ENABLE_R2_UPLOADS=true` apenas se bucket e migration estiverem prontos.
- `ENABLE_PAYMENTS=true` apenas se Asaas sandbox/produção estiver validado.
- `ENABLE_EMAILS=true` apenas se domínio Resend estiver verificado.

## Deploy

Somente após aprovação humana:

```bash
npx wrangler deploy
```

## Domínio Oficial

Domínio planejado:

```text
https://redacaocomestrategia.com.br
```

Checklist manual:

- adicionar custom domain no Worker;
- apontar DNS no Cloudflare;
- validar SSL;
- configurar redirect de `www`;
- atualizar Site URL no Supabase;
- atualizar Redirect URLs no Supabase;
- revisar `APP_URL`;
- testar login e recuperação de senha.

Ver instruções detalhadas em `docs/DOMAIN.md` e `docs/SUPABASE_AUTH.md`.

## Pós-Deploy

Testar:

- `/health`;
- login professor;
- login aluno;
- site público de professor;
- matrícula simulada ou pagamento real, conforme flags;
- envio de redação;
- correção;
- download de arquivo;
- logout.

Resultado do deploy validado em 2026-07-12:

- `/health`: passou.
- Login professor/corretor: passou.
- Rota protegida professor/corretor: passou.
- Login aluno: passou.
- Rota protegida aluno: passou.
- Isolamento do aluno em outro site: bloqueado como esperado.
- Logout professor/corretor e aluno: passou.
- R2 remoto: put/get/delete de objeto temporário passou.
- Upload R2 via aplicação: passou com arquivo de teste e limpeza posterior.
- Smoke remoto público em 2026-07-13: `/health`, `/`, `/login.html`, `/redacao/puppin-teste`, `/robots.txt`, `/sitemap.xml` e `/site.webmanifest` passaram no fallback `workers.dev`.

## Incidente Controlado de Domínio

Em 2026-07-12, uma tentativa de publicar custom domains via Wrangler falhou na criação dos registros de domínio pela API Cloudflare.
O deploy parcial removeu temporariamente o alvo `workers.dev`.

Resposta aplicada:

1. Rollback para `627f2f9d-1a96-484a-91e9-24c55956ec30`.
2. Remoção das rotas que falharam do `wrangler.jsonc`.
3. Adição explícita de `workers_dev=true`.
4. Novo deploy validado.
5. Correção de `/health` para passar pelo Worker antes dos Assets.

Próxima tentativa de domínio deve ser feita pelo painel Cloudflare ou com API validada em uma janela controlada.
