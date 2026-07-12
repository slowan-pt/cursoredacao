# Segurança

## Estado Atual

- Configuração centralizada em `src/config.ts`.
- Feature flags para pagamentos, R2, e-mails, OAuth e checkout simulado.
- Scanner local de segredos em `scripts/scan-secrets.mjs`.
- Headers HTTP básicos e CSP compatível com o frontend atual.
- Validação temporária de uploads base64 por MIME e tamanho.

## Pendências Críticas

- Rotacionar senha do banco Supabase/PostgreSQL.
- Rotacionar chave privilegiada Supabase.
- Atualizar secrets do Cloudflare Worker.
- Limpar histórico Git depois da rotação.
- Implementar rate limiting efetivo com Cloudflare, Durable Objects ou equivalente.

## Regras

- Nunca imprimir secrets em logs.
- Nunca enviar arquivos para storage público.
- Nunca liberar matrícula por retorno de navegador em produção.
- Nunca confiar apenas em IDs recebidos do frontend.
- Sempre validar `site_id`, papel do usuário e vínculo com turma/aluno.
