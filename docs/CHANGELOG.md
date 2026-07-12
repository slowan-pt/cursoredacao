# Changelog

Todas as mudanças relevantes deste projeto devem ser registradas aqui.

## Não publicado

### Adicionado

- Consolidação local das alterações pendentes de checkout, aluno e professor/admin:
  - checkout público simulado com código único;
  - cadastro/login pago separados;
  - bloqueio/inativação de aluno;
  - exclusão lógica de redações no painel do aluno;
  - professor filho/corretor com permissões e direcionamentos;
  - organização de correções por turmas;
  - ajustes de turmas, preços, prévias e títulos públicos;
  - melhorias visuais correspondentes.
- Scripts de validação local em `package.json`:
  - `npm run typecheck`
  - `npm run check:diff`
  - `npm run check:all`
- Registro da Sprint 1 de higiene geral em `docs/PROJECT_STATUS.md`.
- Helper `src/securityHeaders.ts` com headers complementares:
  - `Content-Security-Policy`
  - `Referrer-Policy`
  - `Permissions-Policy`
  - `Cross-Origin-Opener-Policy`
- Documento `docs/BLOCKERS.md` com bloqueios críticos e importantes.
- Provider local de desenvolvimento em memória para a camada de storage privado.
- Utilitários de webhook Asaas para normalização de payload e chave de idempotência.
- Templates puros de e-mail para recibo de checkout e correção disponível.
- Middleware de observabilidade com `x-request-id`, `server-timing` e log estruturado de erro.
- Bloqueio documentado para sprints de Professor/Aluno/Admin enquanto houver diffs locais amplos nas telas e rotas.
- Documentação operacional:
  - `docs/ARCHITECTURE.md`
  - `docs/ROADMAP.md`
  - `docs/SECURITY.md`
  - `docs/BACKUP.md`
  - `docs/RESTORE.md`

### Segurança

- Nenhuma rotação de credenciais foi executada nesta entrada.
- Nenhuma limpeza de histórico Git foi executada nesta entrada.
- Nenhum push ou deploy foi executado nesta entrada.
- A CSP foi definida de forma compatível com o frontend atual, mantendo `unsafe-inline` enquanto houver scripts/estilos inline.
- Rate limiting efetivo foi documentado como bloqueio porque não deve ser simulado com memória local em Cloudflare Workers.
- O provider local de storage não é persistente e não deve ser usado em produção.
- A normalização de webhook Asaas não libera matrícula; ela apenas prepara dados para uma rota futura idempotente.
- Templates de e-mail não enviam mensagens por conta própria; envio real continua atrás de `ENABLE_EMAILS`.
- Logs de erro não registram payloads, tokens ou dados de arquivos.
- Alterações de UX foram adiadas para evitar misturar novas mudanças com arquivos funcionais já modificados.
- Legacy API keys do Supabase foram desativadas manualmente em 2026-07-12.
- A nova `SUPABASE_SERVICE_KEY` `sb_secret_...` passou em leitura administrativa.
- Após a desativação, login professor/aluno falhou com `401`; pendente migrar `SUPABASE_ANON_KEY` para a Publishable key.

### Observações

- O branch local continua à frente de `origin/main`.
- As alterações funcionais locais pendentes foram consolidadas em commits locais em 2026-07-12.
- Nenhum push, deploy ou migration real foi executado durante a consolidação.

### Consolidação de alterações locais pendentes — 2026-07-12

- `ae4d383 chore: update local ignore and Supabase migration comments`
- `558fc09 feat: consolidate public checkout flow`
- `ba59b55 feat: consolidate student enrollment access`
- `f66a1ee feat: consolidate professor management flows`

Testes executados antes dos commits:

- `npm run check:all`

Resultado:

- Typecheck concluído.
- Scanner de segredos sem padrões encontrados na working tree rastreável.
- `git diff --check` sem erro fatal; apenas avisos LF/CRLF do Windows.

## Sessão autônoma anterior — 2026-07-12

### Adicionado

- Inventário do projeto em `docs/PROJECT_STATUS.md`.
- Runbook de segurança em `docs/SECURITY_RUNBOOK.md`.
- Scanner local de segredos em `scripts/scan-secrets.mjs`.
- Preparação de storage privado com R2.
- Preparação de gateway Asaas.
- Preparação de provider de e-mail com Resend.
- Documentação de deploy, rollback e testes.

### Segurança

- Seeds e scripts administrativos foram ajustados para evitar impressão de senhas.
- Variáveis sensíveis foram documentadas em `.env.example` sem valores reais.

### Não executado

- Push.
- Deploy.
- Migrations reais.
- Rotação real de credenciais.
- Limpeza de histórico Git.
- Criação de bucket R2.
- Cobrança Asaas real.
- Envio real de e-mails.
