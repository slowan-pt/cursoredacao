# Deploy Manual — Cloudflare Workers

Atualizado em: 2026-07-12.

Este projeto usa Cloudflare Workers com Wrangler. Não usar Docker/VPS para a arquitetura atual.

## Estado Atual do Worker

- Worker padrão: `cursoreducao`.
- Último deploy validado: `627f2f9d-1a96-484a-91e9-24c55956ec30`.
- URL atual: `https://cursoreducao.slowgithub.workers.dev`.
- `APP_ENV=production`.
- `ENABLE_R2_UPLOADS=true`.
- `ENABLE_PAYMENTS=false`.
- `ENABLE_PUBLIC_CHECKOUT_SIMULATED=false`.
- `ENABLE_EMAILS=false`.
- `ENABLE_OAUTH=false`.
- Domínio oficial `redacaocomestrategia.com.br` ainda pendente de configuração final.

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
