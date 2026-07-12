# Changelog

Todas as mudanças relevantes deste projeto devem ser registradas aqui.

## Não publicado

### Adicionado

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

### Segurança

- Nenhuma rotação de credenciais foi executada nesta entrada.
- Nenhuma limpeza de histórico Git foi executada nesta entrada.
- Nenhum push ou deploy foi executado nesta entrada.
- A CSP foi definida de forma compatível com o frontend atual, mantendo `unsafe-inline` enquanto houver scripts/estilos inline.
- Rate limiting efetivo foi documentado como bloqueio porque não deve ser simulado com memória local em Cloudflare Workers.

### Observações

- O branch local continua à frente de `origin/main`.
- Existem alterações funcionais locais não commitadas que precisam ser preservadas e revisadas separadamente.

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
