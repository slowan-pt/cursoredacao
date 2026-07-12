# Blockers

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
- Situação: proibida no ciclo autônomo atual.
- Solução sugerida:
  1. Criar backup local sensível.
  2. Reescrever histórico com `git filter-repo`.
  3. Validar branches, tags, reflog e objetos alcançáveis.
  4. Fazer `git push --force-with-lease` apenas com confirmação explícita.

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
