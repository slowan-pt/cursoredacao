# Security Runbook — Credenciais e Histórico Git

Atualizado em: 2026-07-12.

Este runbook prepara ações manuais de segurança. Não execute etapas destrutivas sem revisão humana.

## Situação Atual

- Branch local: `main`.
- O branch local está à frente do remoto.
- O working tree funcional foi consolidado em commits locais.
- Há histórico Git com indicação de credenciais antigas expostas.
- Há arquivos locais ignorados de ambiente que podem conter segredos reais e não devem ser commitados.
- Legacy API keys do Supabase foram desativadas manualmente em 2026-07-12.
- A nova `SUPABASE_SERVICE_KEY` em formato `sb_secret_...` passou em leitura administrativa.
- A `SUPABASE_ANON_KEY` foi migrada para valor `sb_publishable_...` e os fluxos professor/aluno passaram localmente e no Worker remoto.

## Credenciais Que Devem Ser Rotacionadas

1. Senha do banco Supabase/PostgreSQL exposta anteriormente.
2. Supabase service key ou secret key exposta anteriormente.
3. Secrets correspondentes no Cloudflare Worker.
4. Qualquer `.dev.vars`, `.env` ou `.env.*` local que tenha usado valores antigos.
5. `SUPABASE_ANON_KEY`, caso as Legacy API Keys tenham sido desativadas em conjunto. Status em 2026-07-12: migrada para publishable key.

## Ordem Segura de Rotação

1. Gerar novas credenciais no painel do provedor.
2. Atualizar ambientes locais ignorados pelo Git.
3. Atualizar secrets do Cloudflare manualmente com `wrangler secret put`.
4. Testar localmente:
   - `npm run security:scan`
   - `npx tsc --noEmit`
   - login controlado
   - `/health`
   - consulta somente leitura ao Supabase
5. Migrar `SUPABASE_ANON_KEY` para a Publishable key antes ou imediatamente após desativar legacy anon.
6. Invalidar credenciais antigas no provedor.
7. Confirmar que as credenciais antigas não funcionam mais.
8. Somente depois limpar histórico Git.

## Estado Pós-Rotação — 2026-07-12

- `SUPABASE_SERVICE_KEY`: migrada para `sb_secret_...`.
- `SUPABASE_ANON_KEY`: migrada para `sb_publishable_...` mantendo o nome legado da variável.
- Senha PostgreSQL/Supabase: rotacionada e validada via pooler com consulta somente leitura.
- Legacy API keys: desativadas no painel Supabase.
- Worker padrão `cursoreducao`: secrets `SUPABASE_SERVICE_KEY` e `SUPABASE_ANON_KEY` atualizados.
- Testes professor/corretor e aluno: passaram.
- Próximo ciclo: limpeza segura do histórico Git.

## Wrangler Secrets

Use sempre prompt interativo. Não coloque valores em comandos, README, issues ou logs.

Exemplo seguro:

```bash
npx wrangler secret put SUPABASE_SERVICE_KEY
```

Confirme antes qual ambiente será atualizado. Não atualizar produção sem revisão.

## Verificação Local de Segredos

Use:

```bash
npm run security:scan
```

O scanner mostra apenas arquivo, linha e tipo de padrão. Ele não imprime valores.

Arquivos `.env`, `.env.*` e `.dev.vars` são ignorados porque podem conter segredos locais reais. Eles devem ser conferidos manualmente.

## Histórico Git

Commits já identificados como sensíveis ou relacionados:

- `c317a48`
- `7ed95b9`
- `5612972`

Antes de qualquer reescrita:

1. Criar backup local seguro, sem enviar para nuvem.
2. Listar branches, tags e refs.
3. Confirmar que ninguém mais está usando o histórico antigo.
4. Rotacionar credenciais antes da limpeza.

## Plano de Limpeza com git-filter-repo

Não executar automaticamente.

Plano sugerido, após rotação:

1. Instalar/confirmar `git filter-repo`.
2. Criar clone espelho local.
3. Remover padrões e arquivos sensíveis do histórico.
4. Validar com buscas por padrão.
5. Executar `git fsck`.
6. Preparar force push.
7. Confirmar novamente com o responsável.
8. Executar force push somente após aprovação explícita.

## Comandos de Inspeção Seguros

```bash
git status --short --branch
git branch --all --verbose --no-abbrev
git tag --list
git log --all --oneline -- scripts/migrate.mjs scripts/check.mjs .env.example
git log --all --oneline -G "postgres connection string|SUPABASE_SERVICE_KEY|service_role" -- .
npm run security:scan
```

## Ações Proibidas Sem Aprovação

- `git push --force`
- `git reset --hard`
- `git clean`
- `git reflog expire`
- `git gc --prune`
- revogar credenciais reais
- alterar secrets reais em produção
- executar migrations destrutivas
- publicar domínio oficial

## Bloqueios Manuais

- A rotação real depende de acesso ao painel Supabase.
- A atualização real de secrets depende de valores que não devem ser compartilhados em chat.
- A limpeza remota depende de aprovação explícita para force push.
