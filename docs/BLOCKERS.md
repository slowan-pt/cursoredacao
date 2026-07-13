# Blockers

## Dominio oficial ainda nao ativo

- Prioridade: critica para lancamento publico.
- Situacao atual em 2026-07-13:
  - `APP_URL` ja aponta para `https://redacaocomestrategia.com.br`.
  - O Worker novo `https://cursoredacao.slowgithub.workers.dev` segue publicado e validado.
  - O Worker antigo `https://cursoreducao.slowgithub.workers.dev` foi preservado temporariamente para rollback/observacao.
  - A tentativa de custom domain via Wrangler/API Cloudflare falhou com HTTP 400 no endpoint de domain records.
  - `wrangler.jsonc` ficou sem `routes` de custom domain para nao quebrar deploys.
- Proxima acao: configurar `redacaocomestrategia.com.br` e `www.redacaocomestrategia.com.br` em Cloudflare Dashboard → Workers & Pages → `cursoredacao` → Settings → Triggers → Custom Domains.
- Teste posterior: `npm run smoke:prod -- --base=https://redacaocomestrategia.com.br`.

## Secrets Asaas no Worker novo

- Prioridade: resolvido em 2026-07-13.
- Situacao atual:
  - Worker `cursoredacao` tem `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`, `SESSION_SECRET`, `ASAAS_API_KEY` e `ASAAS_WEBHOOK_TOKEN`.
  - `PAYMENT_CREATED` chegou no endpoint novo e foi gravado.
  - Reconciliação sandbox validada.
- Cuidado restante: manter `ASAAS_ENV=sandbox` até domínio oficial e produção Asaas serem revisados.

## Rate limiting efetivo

- Prioridade: importante para producao.
- Situacao atual:
  - `ENABLE_APP_RATE_LIMITING=false`.
  - Existe ponto de extensao no codigo, mas nao ha protecao global efetiva na aplicacao.
  - Nao foi implementado contador em memoria local porque isso nao protege globalmente em Cloudflare Workers.
- Proxima acao: configurar Cloudflare WAF/Rate Limiting ou aprovar implementacao com Durable Objects.

## Revogação real de sessão após logout

- Prioridade: importante para produção.
- Situação: o logout remove o cookie do navegador com atributos consistentes, mas o JWT stateless emitido continua válido se o valor antigo for reutilizado manualmente até a expiração.
- Impacto: em caso de captura de cookie antes do logout, o logout sozinho não invalida o token no backend.
- Solução sugerida:
  1. Criar `session_version` ou `revoked_sessions` no banco, KV ou Durable Object.
  2. Incluir `jti` no JWT.
  3. Validar `jti`/versão em `requireAuth`.
  4. Revogar no logout e em bloqueio/inativação crítica.
  5. Manter TTL curto para sessões sensíveis.

## Rotação de credenciais comprometidas

- Prioridade: crítica.
- Impacto: impede considerar o repositório e os ambientes como prontos para publicação segura.
- Situação: requer ação manual no Supabase e no Cloudflare.
- Solução sugerida:
  1. Rotacionar a senha do banco Supabase/PostgreSQL.
  2. Rotacionar a chave privilegiada Supabase usada como `SUPABASE_SERVICE_KEY`.
  3. Atualizar `.dev.vars` e arquivos locais ignorados.
  4. Atualizar secrets do Cloudflare Worker no ambiente correto.
  5. Validar localmente.
  6. Só depois limpar o histórico Git.

## Limpeza segura do histórico Git

- Prioridade: crítica.
- Impacto: commits antigos ainda podem conter ou referenciar credenciais expostas.
- Situação: limpeza local executada em 2026-07-12; o remoto foi corrigido em 2026-07-13 para `https://github.com/slowan-pt/cursoredacao.git`.
- Solução sugerida:
  1. Backup local sensível criado.
  2. História alcançável validada sem formatos reais de segredo.
  3. Reflog/objetos órfãos limpos localmente.
  4. Manter o remoto atual `slowan-pt/cursoredacao`.
  5. Fazer push normal para commits novos.
  6. Nao fazer force push sem nova aprovacao e plano de recuperacao.

## Domínio oficial ainda não publicado

- Prioridade: crítica para lançamento público.
- Impacto: `redacaocomestrategia.com.br` ainda não aponta para o Worker.
- Situação:
  - O domínio responde com nameserver Cloudflare, mas não há registro raiz/www resolvendo para o Worker.
  - A tentativa de aplicar custom domains via `wrangler deploy` falhou no endpoint de domain records.
  - O deploy parcial desativou temporariamente `workers.dev`; foi feito rollback e novo deploy com `workers_dev=true`.
- Ação manual sugerida:
  1. Cloudflare Dashboard → Workers & Pages → `cursoredacao` → Settings → Triggers → Custom Domains.
  2. Adicionar `redacaocomestrategia.com.br`.
  3. Adicionar `www.redacaocomestrategia.com.br`.
  4. Garantir DNS proxied/laranja para ambos.
  5. Validar SSL ativo.
  6. Reexecutar `/health`, página inicial, login e assets.

## Asaas produção e checkout público

- Prioridade: importante.
- Impacto: produção não deve ser usada antes de revisão.
- Situação:
  - `ASAAS_WEBHOOK_TOKEN` e `ASAAS_API_KEY` existem como secrets do Worker novo em sandbox.
  - `ENABLE_PAYMENTS=true` e `ASAAS_ENV=sandbox` foram publicados.
  - Migration `005_payments.sql` aplicada.
  - Webhook sandbox validado no Worker `cursoredacao`.
  - `PAYMENT_CREATED` não liberou matrícula.
  - `PAYMENT_RECEIVED` liberou matrícula única.
  - Reconciliação sandbox liberou matrícula idempotente para pagamento recebido.
- Ação manual sugerida:
  1. Manter `ASAAS_ENV=sandbox` até finalizar UX pública do checkout.
  2. Revisar webhook e assinatura antes de produção.
  3. Configurar chave de produção somente quando o domínio oficial e os testes finais estiverem concluídos.

## Resend sem API key e domínio verificado

- Prioridade: importante.
- Impacto: e-mails transacionais reais seguem desativados.
- Situação:
  - `RESEND_API_KEY` não existe localmente nem no Worker.
  - `ENABLE_EMAILS=false` em produção.
- Ação manual sugerida:
  1. Verificar domínio/remetente no Resend.
  2. Configurar DNS SPF/DKIM/DMARC conforme Resend.
  3. Executar `npx wrangler secret put RESEND_API_KEY`.
  4. Testar somente com endereço controlado antes de ativar.

## SUPABASE_ANON_KEY ainda legacy

- Prioridade: crítica.
- Status: resolvido em 2026-07-12.
- Impacto anterior: após desativar as Legacy API Keys do Supabase, login professor/aluno falhava porque a autenticação ainda usava `SUPABASE_ANON_KEY` no formato JWT legacy.
- Situação atual:
  - `SUPABASE_SERVICE_KEY` usa `sb_secret_...`.
  - `SUPABASE_ANON_KEY` usa `sb_publishable_...`.
  - Worker `cursoreducao` foi atualizado.
  - Testes professor/aluno passaram localmente e no Worker remoto.
- Próximo cuidado: o nome `SUPABASE_ANON_KEY` é legado; em ciclo futuro, pode ser renomeado para `SUPABASE_PUBLISHABLE_KEY`.

## Rate limiting efetivo

- Prioridade: importante.
- Impacto: login, cadastro, checkout, recuperação de senha e upload ficam sem proteção efetiva contra abuso automatizado.
- Situação: Cloudflare Workers não deve depender de memória local como contador compartilhado.
- Solução sugerida:
  - Usar Cloudflare Rate Limiting, WAF, Durable Objects ou outro backend compartilhado.
  - Rotas prioritárias:
    - `/api/auth/login`
    - `/api/auth/register`
    - `/api/auth/forgot-password`
    - checkout público
    - upload de redação
    - OAuth

## CSP restritiva sem unsafe-inline

- Prioridade: melhoria.
- Impacto: a CSP atual precisa permitir scripts e estilos inline para não quebrar o frontend estático.
- Situação: arquivos em `public/` ainda usam scripts/estilos inline.
- Solução sugerida:
  - Extrair scripts inline para arquivos `.js`.
  - Extrair estilos inline para CSS.
  - Só então remover `unsafe-inline` da política.

## Sprints de interface com working tree sujo

- Prioridade: importante.
- Status: resolvido localmente em 2026-07-12.
- Impacto anterior: as sprints de Professor, Aluno e Administrador exigiam editar arquivos que já possuíam alterações locais amplas não commitadas.
- Arquivos afetados:
  - `public/professor/index.html`
  - `public/aluno/index.html`
  - `public/login.html`
  - `public/css/style.css`
  - `src/routes/admin.ts`
  - `src/routes/aluno.ts`
  - `src/routes/auth.ts`
  - `src/routes/site.ts`
- Situação atual: as alterações locais foram revisadas, testadas com `npm run check:all` e separadas nos commits:
  - `558fc09 feat: consolidate public checkout flow`
  - `ba59b55 feat: consolidate student enrollment access`
  - `f66a1ee feat: consolidate professor management flows`
- Próximo cuidado: novas alterações nessas áreas devem continuar em commits pequenos e testáveis.
