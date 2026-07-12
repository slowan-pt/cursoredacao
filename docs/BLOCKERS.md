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
