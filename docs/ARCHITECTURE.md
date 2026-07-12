# Arquitetura

## Stack Oficial

- Backend: Cloudflare Workers.
- Framework HTTP: Hono.
- Deploy: Wrangler.
- Frontend: HTML/CSS/JS estático em `public/`.
- Banco: Supabase PostgreSQL.
- Autenticação: Supabase Auth.
- Uploads definitivos: Cloudflare R2.
- Pagamentos planejados: Asaas.
- E-mails planejados: Resend.

## Componentes

- `src/index.ts`: composição do Worker, rotas, healthcheck, headers e observabilidade.
- `src/config.ts`: leitura centralizada de variáveis e feature flags.
- `src/auth.ts`: geração e validação de sessão local.
- `src/supabase.ts`: clientes Supabase anon e service role.
- `src/routes/`: rotas de autenticação, aluno, professor/admin, superadmin e site público.
- `src/uploads.ts`: validação temporária de upload base64.
- `src/storage.ts`: interface de storage privado, provider local temporário e provider R2.
- `src/payments.ts`: gateway e normalizadores Asaas.
- `src/email.ts`: provider de e-mail e templates transacionais.

## Multi-Tenant

- Cada site/professor deve operar isolado por `site_id`.
- Alunos pertencem a um site/professor.
- Professores filhos/corretores só devem acessar redações direcionadas.
- Superadmin gerencia a plataforma, professores e sites.

## Regras de Produção

- Não usar base64 como armazenamento permanente.
- Não ativar pagamento real sem webhook idempotente.
- Não publicar antes de rotacionar credenciais e limpar histórico.
- Não expor banco diretamente.
- Não armazenar segredos no código.
