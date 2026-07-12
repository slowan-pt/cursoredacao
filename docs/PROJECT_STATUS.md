# Redação com Estratégia — Status do Projeto

## Dados gerais

- Data da atualização: 2026-07-12.
- Branch atual: `main`.
- Relação com remoto: `main...origin/main [ahead 22]` após a consolidação local de 2026-07-12.
- Último commit local confirmado: `f66a1ee feat: consolidate professor management flows`.
- Estado do working tree: limpo após consolidar os 11 arquivos rastreados modificados preexistentes.
- Versão atual declarada: `1.0.0` em `package.json`.
- Ambiente atual observado: Cloudflare Workers, URL pública `https://cursoreducao.slowgithub.workers.dev`.
- Última versão do Worker informada neste ciclo: `ee1800a1-114f-4b09-8067-ada375564e3e`.

## Arquitetura oficial

- Backend: Cloudflare Workers.
- Framework HTTP: Hono.
- Frontend: arquivos estáticos HTML/CSS/JS em `public/`.
- Banco de dados: Supabase PostgreSQL.
- Autenticação: Supabase Auth.
- Deploy: Wrangler.
- Uploads definitivos planejados: Cloudflare R2.
- Pagamentos planejados: Asaas.
- E-mails planejados: Resend ou provedor compatível por variáveis de ambiente.
- Domínio oficial planejado: `redacaocomestrategia.com.br`.
- Não faz parte da arquitetura atual: Docker, VPS, Express, Nest ou migração para servidor Node tradicional.

## Estado do código

### Estado confirmado no último commit

- O último commit local confirmado antes da Sprint 1 atual é `3f1c91f docs: update autonomous session status`.
- O último commit de segurança base é `7ed95b9 chore: harden initial production settings`.
- A sessão autônoma criou commits locais adicionais para documentação, scanner de segredos, seed scripts, R2, Asaas, e-mails e planos operacionais.
- Este status não confirma por si só que credenciais antigas foram rotacionadas nem que o histórico Git foi limpo.

### Alterações locais não commitadas

Status atual: não há arquivos modificados no working tree após a consolidação local.

Arquivos que estavam modificados antes da consolidação:

- `.gitignore`
- `migrations/001_schema.sql`
- `migrations/003_corretor_automatico.sql`
- `public/aluno/index.html`
- `public/css/style.css`
- `public/login.html`
- `public/professor/index.html`
- `src/routes/admin.ts`
- `src/routes/aluno.ts`
- `src/routes/auth.ts`
- `src/routes/site.ts`

Resumo anterior do `git diff --stat`:

- 11 arquivos funcionais modificados.
- Aproximadamente 2499 inserções e 306 remoções ainda não commitadas.
- Maior volume de alteração em `public/professor/index.html`, `src/routes/admin.ts`, `src/routes/site.ts` e `public/css/style.css`.
- Observação: há pequenos hunks de TTL de sessão em `src/routes/auth.ts` e `src/routes/aluno.ts` feitos nesta sessão, mas não commitados separadamente porque esses arquivos já continham diffs amplos preexistentes.

### Migrations alteradas

- `migrations/001_schema.sql`: referência do projeto Supabase alterada de `qizhulhyodpxoowxmqct` para `yejchbqovozvehylobrd`.
- `migrations/003_corretor_automatico.sql`: referência do projeto Supabase alterada de `qizhulhyodpxoowxmqct` para `yejchbqovozvehylobrd`.
- Status: concluído e commitado em `ae4d383`.
- Risco: migrations alteradas não significam que o banco remoto esteja migrado ou validado.

### Autenticação

- Evidências locais:
  - `src/routes/auth.ts` contém fluxo de `checkout_code`.
  - `src/routes/auth.ts` contém endpoint `oauth-session`, controlado por flag OAuth.
  - `public/login.html` contém campo de código de pagamento e ajuste de fluxo login/cadastro.
- Status: concluído e commitado em `558fc09`.
- Commitado: sim.
- Testado: não verificado neste documento.
- Risco: mudanças de login/cadastro precisam ser testadas com aluno pago, aluno bloqueado, professor, professor filho e superadmin.

### Uploads

- Evidências locais:
  - `src/uploads.ts` existe e valida base64 por MIME/tamanho.
  - `src/routes/aluno.ts` chama `validateIncomingArquivo`.
  - `public/aluno/index.html` e `public/professor/index.html` ainda têm trechos de leitura base64 no frontend.
- Status: parcial.
- Commitado: parte pode estar no último commit; alterações em `src/routes/aluno.ts` e frontends estão locais.
- Testado: não verificado neste documento.
- Risco: base64 continua sendo solução temporária; R2 ainda não implementado.

### Pagamentos

- Evidências locais:
  - `src/routes/site.ts` contém rota `/api/site/:slug/checkout`.
  - `src/routes/site.ts` persiste `checkout_leads` no CMS serializado.
  - O fluxo é identificado como `PAGAMENTO_APROVADO_SIMULADO`.
  - `src/config.ts` contém flags `ENABLE_PAYMENTS` e `ENABLE_PUBLIC_CHECKOUT_SIMULATED`.
- Status: parcial.
- Commitado: não verificado como commitado; alterações principais estão locais.
- Testado: não verificado neste documento.
- Risco: Asaas ainda não implementado; webhook, assinatura, idempotência e conciliação ainda pendentes.

### Domínio

- Evidências locais:
  - `.env.example` aponta `APP_URL=https://redacaocomestrategia.com.br`.
  - A aplicação ainda foi observada em `https://cursoreducao.slowgithub.workers.dev`.
  - Referências a `slowgithub.workers.dev` ainda existem em contexto operacional e histórico do projeto.
- Status: planejado/parcial.
- Commitado: `.env.example` parece estar no commit de segurança, mas domínio final não foi validado.
- Testado: não verificado.
- Risco: domínio final ainda depende de configuração Cloudflare, rotas do Worker, SSL e validação de redirects.

### Interface

- Evidências locais:
  - `public/professor/index.html` tem alterações grandes em dashboard, correções, professores filhos, site, turmas, pré-comentários e layout.
  - `public/css/style.css` recebeu estilos para correções por caixas, professor filho, edição do site, comentários e toolbar.
  - `public/aluno/index.html` recebeu ajustes de preço e matrícula.
  - `public/login.html` recebeu ajustes no fluxo de cadastro por pagamento.
- Status: concluído e commitado em `f66a1ee`.
- Commitado: sim.
- Testado: parcialmente em ciclos anteriores, mas não verificado como pacote completo neste documento.
- Risco: alto volume de diff local aumenta risco de regressão visual e funcional.

## Roadmap por ciclos

| Ciclo | Status | Observação |
| --- | --- | --- |
| Segurança inicial | concluído e commitado | Commit `7ed95b9`; ainda precisa validação pós-rotação. |
| Rotação de credenciais e Git | parcial | Runbook e scanner criados; rotação/limpeza real seguem manuais e pendentes. |
| R2 e uploads | parcial | Camada R2, binding, migration e documentação preparados; fluxo base64 ainda não integrado ao R2. |
| Asaas | parcial | Gateway, envs, migration e documentação sandbox preparados; webhook/checkout real pendentes. |
| E-mails | parcial | Provider Resend/mock preparado; nenhum envio real ativado. |
| Domínio e produção | parcial | Docs de deploy/rollback criadas; domínio oficial ainda não configurado. |
| Testes e homologação | parcial | Plano de teste criado; `npx tsc --noEmit` e scanner passam. |
| Lançamento | planejado | Depende de credenciais, histórico Git, domínio, R2/pagamentos por flags e validação. |
| Evolução do SaaS | planejado | Multi-professores, sites por professor e corretores filhos em evolução local. |

## Funcionalidades

| Funcionalidade | Status | Evidência no código | Commitado | Testado | Risco pendente |
| --- | --- | --- | --- | --- | --- |
| Healthcheck `/health` | concluído e commitado | `src/index.ts`/configuração de segurança, resposta observada anteriormente | sim | parcial | `APP_VERSION` aparece como `dev` no health atual. |
| Configuração centralizada/env flags | concluído e commitado | `src/config.ts`, `src/types.ts`, `.env.example` | sim | parcial | Confirmar secrets reais no Cloudflare. |
| Scanner local de segredos | concluído e commitado | `scripts/scan-secrets.mjs`, `npm run security:scan` | sim | sim | Não substitui varredura de histórico remoto. |
| Supabase Auth | concluído e commitado | `src/supabase.ts`, `src/routes/auth.ts` | sim | parcial | Fluxos novos locais ainda não revisados. |
| Login/cadastro com código de pagamento | implementado localmente, aguardando revisão | `public/login.html`, `src/routes/auth.ts` | não | não verificado | Pode afetar UX e validação de cadastro. |
| OAuth Google | parcial | `src/routes/auth.ts`, `public/auth-callback.html`, flag `ENABLE_OAUTH` | sim/parcial | não verificado | Deve permanecer desativado se não aprovado. |
| Sites por professor | parcial | `src/routes/site.ts`, `public/professor/index.html` | parte sim, parte local | não verificado | CMS serializado em `allowed_origins` é dívida técnica. |
| Edição do site por menus | implementado localmente, aguardando revisão | `public/professor/index.html`, `public/css/style.css` | não | não verificado | Alto risco visual. |
| Turmas CRUD | parcial | `src/routes/admin.ts`, `public/professor/index.html` | parte sim, parte local | parcial | Exclusão com alunos precisa teste manual. |
| Exclusão de turma sem alunos | implementado localmente, aguardando revisão | `src/routes/admin.ts`, `public/professor/index.html` | não | parcial | Confirmar comportamento em banco novo e fallback CMS. |
| Alunos CRUD/inativação | implementado localmente, aguardando revisão | `src/routes/admin.ts`, `public/professor/index.html`, `public/login.html` | não | não verificado | Bloqueio real de login precisa teste. |
| Envio de redação | parcial | `src/routes/aluno.ts`, `public/aluno/index.html` | parte sim, parte local | não verificado | Upload base64 temporário. |
| Correção de redação | implementado localmente, aguardando revisão | `public/professor/index.html`, `public/css/style.css`, `src/routes/admin.ts` | não | parcial | Toolbar e bloqueios precisam regressão visual. |
| Pré-comentários | implementado localmente, aguardando revisão | `public/professor/index.html`, `src/routes/admin.ts` | não | não verificado | Seeds/listagens precisam confirmação. |
| Professores filhos/corretores | implementado localmente, aguardando revisão | `src/routes/admin.ts`, `public/professor/index.html` | não | não verificado | Controle de permissão é área sensível. |
| R2 privado | parcial | `src/storage.ts`, `migrations/004_storage_files.sql`, `docs/R2.md` | sim | parcial | Não integrado ao fluxo de upload existente. |
| Checkout simulado | parcial | `src/routes/site.ts`, `src/routes/auth.ts`, `public/login.html` | não | não verificado | Não substitui Asaas real. |
| Gateway Asaas | parcial | `src/payments.ts`, `migrations/005_payments.sql`, `docs/ASAAS.md` | sim | parcial | Webhook e checkout real ainda pendentes. |
| E-mails de transação | parcial | `src/email.ts`, `docs/EMAILS.md` | sim | parcial | Resend não configurado/validado; flag desligada. |
| Relatórios | parcial | `public/professor/index.html` | não | não verificado | Dados e permissões precisam revisão. |

## Segurança

### Segredos já removidos

- `scripts/migrate.mjs` usa `SUPABASE_DB_URL` em vez de credencial hardcoded.
- `.env.example` existe sem valores reais.
- `src/config.ts` valida `SESSION_SECRET` e flags.
- `scripts/setup.mjs` e `scripts/seed-puppin-teste.mjs` não imprimem mais senhas e exigem senhas por ambiente, salvo opt-in explícito de seed inseguro local.
- `scripts/scan-secrets.mjs` verifica padrões de segredos sem imprimir valores.
- Status: concluído e commitado no ciclo de segurança inicial.

### Segredos ainda no histórico

- Foi identificado anteriormente que o histórico Git continha:
  - senha PostgreSQL/Supabase em commit publicado antigo;
  - senha em commit local/reflog;
  - Supabase service/secret key em commit local/rejeitado.
- Status: risco ainda pendente até limpeza segura do histórico.
- Não reproduzir segredos em logs, docs ou commits.

### Credenciais a rotacionar

- Senha do banco Supabase/PostgreSQL antigo.
- Supabase service key/secret key exposta anteriormente.
- Secrets correspondentes no Cloudflare Worker.
- Arquivos locais ignorados, como `.dev.vars`, devem ser atualizados com valores novos.

### Situação do Git

- Branch `main` está `ahead 9` em relação a `origin/main` antes da Sprint 1 de higiene atual.
- Working tree está sujo.
- Limpeza de histórico ainda não executada neste documento.

### Situação da service key

- A aplicação usa `SUPABASE_SERVICE_KEY` em runtime via `src/supabase.ts`.
- A rotação foi planejada, mas este documento não confirma que a chave antiga foi invalidada.
- Status: parcial/não verificado.

### Situação da senha do banco

- `SUPABASE_DB_URL` deve ficar apenas em ambiente administrativo/local para scripts.
- Este documento não confirma que a senha antiga foi invalidada no Supabase.
- Status: parcial/não verificado.

### Riscos atuais

- Histórico Git ainda pode expor credenciais antigas.
- Alto volume de alterações locais não commitadas dificulta rollback fino.
- Permissões de professor filho e isolamento por site/aluno são sensíveis e precisam teste.
- Upload base64 não é solução definitiva.
- Checkout simulado não deve ser confundido com pagamento real.

## Domínio

- Domínio oficial: `redacaocomestrategia.com.br`.
- Situação atual da Cloudflare: não verificada neste documento.
- Ambiente público observado: `https://cursoreducao.slowgithub.workers.dev`.
- Referências antigas encontradas:
  - URLs antigas em contexto operacional e possivelmente em código/documentação.
  - Migrations locais atualizadas para o projeto Supabase `yejchbqovozvehylobrd`.
- Pendências:
  - configurar DNS no Cloudflare;
  - associar domínio ao Worker;
  - validar SSL;
  - redirecionar `www` para domínio principal;
  - revisar `APP_URL`;
  - testar login, callback e links públicos no domínio final.

## Uploads

- Estado atual: upload ainda baseado em base64 em fluxos do frontend.
- Validação local: `src/uploads.ts` valida MIME, formato e tamanho máximo.
- Produção: deve bloquear novos uploads se `ENABLE_R2_UPLOADS=false`.
- R2: planejado, não implementado.
- Risco: não armazenar uploads permanentes em base64 no banco na versão pública.

## Pagamentos

- Estado atual: checkout simulado com `PAGAMENTO_APROVADO_SIMULADO`.
- Flag relevante: `ENABLE_PUBLIC_CHECKOUT_SIMULATED`.
- Asaas: ainda não implementado.
- Requisitos obrigatórios para Asaas:
  - webhook com assinatura/validação;
  - idempotência por ID de evento/transação;
  - conciliação de status;
  - logs sem dados sensíveis;
  - ambiente sandbox separado de produção;
  - fallback seguro quando Asaas estiver indisponível;
  - não liberar matrícula sem confirmação confiável em produção.

## Dívida técnica

### Críticos

- Rotacionar e invalidar credenciais comprometidas.
- Limpar histórico Git/GitHub com backup local seguro.
- Validar secrets do Cloudflare sem expor valores.
- Garantir isolamento entre superadmin, professor pai, professor filho e aluno.
- Fechar upload definitivo com R2 antes de produção real.

### Importantes

- Reduzir dependência de CMS serializado em `sites.allowed_origins`.
- Criar testes mínimos para login, matrícula, upload, correção e permissões.
- Revisar exclusões e inativações com rastreabilidade/auditoria.
- Validar o banco Supabase novo como principal.
- Revisar migrations antes de rodar em qualquer ambiente.

### Melhorias futuras

- Painel financeiro real.
- Relatórios avançados.
- Automação de deploy após processo manual estável.
- Observabilidade e alertas.
- Editor visual do site mais robusto, se necessário.

## Checklist de produção

| Item | Status |
| --- | --- |
| Arquitetura oficial mantida em Workers/Hono/Supabase | concluído |
| `.env.example` sem valores reais | concluído |
| Healthcheck mínimo | concluído |
| Feature flags básicas | concluído |
| Rotação da senha do banco | não verificado |
| Rotação da Supabase service key | não verificado |
| Limpeza do histórico Git | pendente |
| Secrets atualizadas no Cloudflare | não verificado |
| `APP_ENV=production` no ambiente final | não verificado |
| Domínio `redacaocomestrategia.com.br` configurado | pendente |
| `www` redirecionando para domínio principal | pendente |
| R2 configurado | pendente |
| Camada R2 local preparada | parcial |
| Upload base64 bloqueado em produção | parcial |
| Asaas sandbox | parcial |
| Asaas produção | pendente |
| Camada Resend/e-mails preparada | parcial |
| Resend/e-mails reais | pendente |
| Rate limiting efetivo | pendente |
| Teste de login professor | não verificado |
| Teste de login aluno | não verificado |
| Teste de professor filho | não verificado |
| Teste de matrícula | não verificado |
| Teste de upload | não verificado |
| Teste de correção | não verificado |
| Teste de rollback | pendente |

## Consolidação de alterações locais pendentes — 2026-07-12

### Commits criados

- `ae4d383 chore: update local ignore and Supabase migration comments`
  - `.gitignore`
  - `migrations/001_schema.sql`
  - `migrations/003_corretor_automatico.sql`
- `558fc09 feat: consolidate public checkout flow`
  - `public/login.html`
  - `src/routes/auth.ts`
  - `src/routes/site.ts`
- `ba59b55 feat: consolidate student enrollment access`
  - `public/aluno/index.html`
  - `src/routes/aluno.ts`
- `f66a1ee feat: consolidate professor management flows`
  - `public/professor/index.html`
  - `src/routes/admin.ts`
  - `public/css/style.css`

### Testes executados

- `npm run check:all` antes de cada commit funcional.
- Resultado: typecheck concluído, scanner de segredos sem padrões encontrados e `git diff --check` sem erro fatal.
- Observação: persistem apenas avisos de LF/CRLF esperados no Windows.

### Migrations

- `migrations/001_schema.sql`: segura para revisão; diff apenas em comentário de URL do projeto Supabase.
- `migrations/003_corretor_automatico.sql`: segura para revisão; diff apenas em comentário de URL do projeto Supabase.
- Nenhuma migration foi executada.

### Ações não executadas

- Nenhum push.
- Nenhum deploy.
- Nenhuma migration real.
- Nenhuma alteração em Supabase, Cloudflare, DNS, R2, Asaas ou Resend.
- Nenhuma limpeza de histórico Git.

## Próxima ação recomendada

1. Concluir a rotação das credenciais.
2. Confirmar que as credenciais antigas deixaram de funcionar.
3. Criar backup Git local seguro.
4. Limpar o histórico Git/GitHub.
5. Validar que segredos não permanecem em commits, reflog, tags, branches ou objetos alcançáveis.
6. Somente depois avançar para R2 e uploads definitivos.

## Como retomar depois de 30 dias

- Branch: `main`.
- Último commit confirmado antes da Sprint 1 atual: `3f1c91f docs: update autonomous session status`.
- Alterações locais: 11 arquivos funcionais modificados preexistentes.
- Ciclo atual: rotação de credenciais e limpeza segura de histórico Git ainda pendentes.
- Bloqueio principal: credenciais antigas comprometidas ainda precisam ser tratadas como expostas até rotação e limpeza final.
- Próxima ação segura: retomar pelo ciclo de rotação, validar secrets local/Cloudflare e só depois limpar histórico.
- Ações que não devem ser executadas sem revisão:
  - force push;
  - migrations em banco remoto;
  - deploy de produção no domínio final;
  - ativação de pagamento real;
  - ativação de upload real sem R2;
  - alteração destrutiva em alunos, turmas, redações ou sites;
  - remoção de branches/tags;
  - commit agrupando todas as alterações locais sem revisão por tema.

## Sessão autônoma de 2026-07-12

### Commits locais criados

- `5612972 docs: add project status inventory`
- `bdea73c security: harden seed scripts and token ttl`
- `b4a5cdb security: add secret scan runbook`
- `aa9965d feat: prepare private R2 storage`
- `e3c6f72 feat: prepare Asaas payment gateway`
- `17b4fc5 feat: prepare transactional email provider`
- `a5b1b02 docs: add deploy rollback and test plans`
- `3f1c91f docs: update autonomous session status`

### Testes executados

- `npx tsc --noEmit`
- `npm run security:scan`
- `git diff --check`
- `node --check` em scripts criados/alterados quando aplicável.

### Ações não executadas por segurança

- Nenhum `git push`.
- Nenhum deploy com Wrangler.
- Nenhuma alteração de DNS.
- Nenhuma rotação real de credenciais.
- Nenhuma limpeza de histórico Git.
- Nenhuma migration executada contra Supabase.
- Nenhum bucket R2 criado.
- Nenhuma cobrança Asaas criada.
- Nenhum e-mail real enviado.

## Sprint 1 — Higiene geral do projeto — 2026-07-12

### Tarefas concluídas

- Centralizados scripts de validação em `package.json`:
  - `typecheck`
  - `check:diff`
  - `check:all`
- Mantidas intactas as alterações funcionais locais não commitadas.
- Criado/atualizado changelog local para registrar a evolução controlada.

### Arquivos alterados

- `package.json`
- `docs/PROJECT_STATUS.md`
- `docs/CHANGELOG.md`

### Testes executados

- `npm run typecheck`
- `npm run security:scan`
- `npm run check:diff`

### Riscos encontrados

- O working tree continua com 11 arquivos funcionais modificados fora desta sprint.
- A rotação de credenciais e a limpeza de histórico seguem pendentes e bloqueiam qualquer publicação segura.

### Pendências

- Commitar esta sprint após validação.
- Rotacionar credenciais comprometidas.
- Limpar histórico Git apenas depois da rotação e com aprovação explícita.

### Próximos passos

- Continuar Sprint 1 com melhorias pequenas em documentação e scripts seguros.
- Evitar alterações funcionais amplas enquanto houver diffs grandes não revisados.

## Sprint 2 — Segurança local — 2026-07-12

### Tarefas concluídas

- Adicionado helper `src/securityHeaders.ts` para centralizar headers HTTP complementares.
- Integrado `appSecurityHeaders` no Worker principal em `src/index.ts`.
- Criado `docs/BLOCKERS.md` para registrar bloqueios que não devem ser resolvidos automaticamente neste ciclo.
- Incluídos:
  - `Content-Security-Policy`
  - `Referrer-Policy`
  - `Permissions-Policy`
  - `Cross-Origin-Opener-Policy`

### Arquivos alterados

- `src/securityHeaders.ts`
- `src/index.ts`
- `docs/BLOCKERS.md`
- `docs/PROJECT_STATUS.md`
- `docs/CHANGELOG.md`

### Testes executados

- `npm run typecheck`
- `npm run security:scan`
- `npm run check:diff`

### Riscos encontrados

- A CSP ainda precisa permitir `unsafe-inline` porque o frontend atual usa scripts e estilos inline em HTML estático.
- Remover `unsafe-inline` exige refatoração futura dos arquivos em `public/`.
- Rate limiting efetivo segue bloqueado por depender de Cloudflare Rate Limiting, Durable Objects ou equivalente.

### Pendências

- Validar manualmente páginas públicas, login, painel do aluno e painel do professor com os headers ativos.
- Evoluir CSP para política mais restrita após separar scripts e estilos inline.

### Próximos passos

- Continuar com melhorias pequenas de segurança local que não dependam de painel externo nem de deploy.

## Sprint 3 — Uploads e storage — 2026-07-12

### Tarefas concluídas

- Adicionado provider local de desenvolvimento em memória na camada `PrivateStorage`.
- Ajustada a interface `PrivateStorage.get` para retornar um corpo genérico de objeto armazenado.
- Mantido bloqueio em produção quando `ENABLE_R2_UPLOADS=false`.
- Documentado o modo local temporário em `docs/R2.md`.

### Arquivos alterados

- `src/storage.ts`
- `docs/R2.md`
- `docs/PROJECT_STATUS.md`
- `docs/CHANGELOG.md`

### Testes executados

- `npm run typecheck`
- `npm run security:scan`
- `npm run check:diff`

### Riscos encontrados

- O provider local usa memória do processo e não é persistente.
- O fluxo principal de upload ainda usa base64 nos frontends e rotas atuais.
- R2 real continua dependente de bucket, binding, migration revisada e testes.

### Pendências

- Integrar a camada `PrivateStorage` ao envio real de redações.
- Criar endpoint autenticado de download/stream.
- Manter bloqueio de upload em produção quando R2 estiver desativado.

### Próximos passos

- Preparar integrações de pagamento/e-mail apenas em modo desativado por flags.

## Sprint 4 — Asaas preparado por flags — 2026-07-12

### Tarefas concluídas

- Adicionados tipos para payload de webhook Asaas.
- Criada normalização de webhook com:
  - evento;
  - pagamento;
  - status interno;
  - referência externa;
  - chave de idempotência.
- Mantida a integração real desativada por `ENABLE_PAYMENTS=false`.
- Atualizada documentação Asaas com o fluxo de idempotência.

### Arquivos alterados

- `src/payments.ts`
- `docs/ASAAS.md`
- `docs/PROJECT_STATUS.md`
- `docs/CHANGELOG.md`

### Testes executados

- `npm run typecheck`
- `npm run security:scan`
- `npm run check:diff`

### Riscos encontrados

- Ainda não existe rota de webhook Asaas.
- Ainda não há persistência real de eventos em `payment_webhook_events`.
- Matrícula por pagamento real continua pendente e deve depender de webhook confiável.

### Pendências

- Criar rota de webhook somente quando o banco/migration estiver validado.
- Implementar persistência idempotente.
- Testar sandbox antes de qualquer produção.

### Próximos passos

- Preparar templates/serviço de e-mail sem envio real.

## Sprint 5 — E-mails transacionais preparados — 2026-07-12

### Tarefas concluídas

- Adicionados templates puros de e-mail:
  - recibo de checkout;
  - correção disponível.
- Mantido envio real desativado por `ENABLE_EMAILS=false`.
- Atualizada documentação de e-mails.

### Arquivos alterados

- `src/email.ts`
- `docs/EMAILS.md`
- `docs/PROJECT_STATUS.md`
- `docs/CHANGELOG.md`

### Testes executados

- `npm run typecheck`
- `npm run security:scan`
- `npm run check:diff`

### Riscos encontrados

- Templates ainda não estão integrados aos fluxos reais.
- Envio real depende de domínio/remetente verificado no provedor.

### Pendências

- Integrar templates aos pontos adequados somente quando `ENABLE_EMAILS=true`.
- Validar entregabilidade em homologação.

### Próximos passos

- Avançar para observabilidade local sem expor dados sensíveis.

## Sprint 6 — Observabilidade local — 2026-07-12

### Tarefas concluídas

- Adicionado middleware `requestTelemetry`.
- Incluído header `x-request-id` por requisição.
- Incluído `server-timing` com duração da aplicação.
- Substituído log bruto de erro por log estruturado mínimo.

### Arquivos alterados

- `src/observability.ts`
- `src/index.ts`
- `docs/PROJECT_STATUS.md`
- `docs/CHANGELOG.md`

### Testes executados

- `npm run typecheck`
- `npm run security:scan`
- `npm run check:diff`

### Riscos encontrados

- Métricas ainda são básicas e dependem dos logs do Worker.
- Não há exportação para ferramenta externa de observabilidade.

### Pendências

- Validar headers em `wrangler dev`.
- Definir política futura para amostragem de logs e correlação com usuários sem expor dados sensíveis.

### Próximos passos

- Antes de mexer nas telas de professor/aluno/admin, revisar o alto volume de alterações locais não commitadas.

## Sprints 7, 8 e 9 — Professor, Aluno e Administrador — 2026-07-12

### Status

- Status: bloqueado temporariamente para alterações diretas.

### Motivo

- As áreas de Professor, Aluno e Administrador dependem dos arquivos que já estão com grandes alterações locais não commitadas.
- Para preservar estabilidade e rastreabilidade, nenhuma nova mudança funcional foi aplicada nesses arquivos nesta passagem.

### Arquivos afetados

- `public/professor/index.html`
- `public/aluno/index.html`
- `public/login.html`
- `public/css/style.css`
- `src/routes/admin.ts`
- `src/routes/aluno.ts`
- `src/routes/auth.ts`
- `src/routes/site.ts`

### Ação tomada

- Bloqueio documentado em `docs/BLOCKERS.md`.

### Próximos passos

- Revisar e separar os diffs locais por tema.
- Criar commits pequenos para as alterações de interface já existentes.
- Retomar as sprints de UX após o working tree estar mais limpo.

## Sprint 13 — Documentação operacional — 2026-07-12

### Tarefas concluídas

- Criada documentação de arquitetura.
- Criado roadmap.
- Criado documento de segurança.
- Criados documentos de backup e restore.

### Arquivos alterados

- `docs/ARCHITECTURE.md`
- `docs/ROADMAP.md`
- `docs/SECURITY.md`
- `docs/BACKUP.md`
- `docs/RESTORE.md`
- `docs/PROJECT_STATUS.md`
- `docs/CHANGELOG.md`

### Testes executados

- `npm run typecheck`
- `npm run security:scan`
- `npm run check:diff`

### Riscos encontrados

- Documentação não substitui validação real do ambiente.
- Procedimentos de backup/restore ainda precisam ser testados com dados controlados.

### Pendências

- Testar processo de restore em ambiente não produtivo.
- Completar documentação após rotação de credenciais e limpeza de histórico.

### Próximos passos

- Revisar alterações locais funcionais pendentes e separar commits por área.
