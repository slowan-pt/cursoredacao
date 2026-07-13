# Redação com Estratégia — Status do Projeto

## Módulo financeiro interno — Endurecimento transacional — 2026-07-13

- Status: implementado localmente, migration aplicada no Supabase, `npm run check:all` validado.
- Migration aplicada: `009_financial_transactions.sql`.
- RPCs transacionais criadas: `create_teacher_closing`, `approve_teacher_closing`, `add_teacher_closing_adjustment`, `register_teacher_payout`, `cancel_teacher_closing`, `reverse_teacher_payout`.
- Idempotência: tabela `financial_idempotency_keys` com unicidade por `site_id`, operação e chave.
- Operações movidas para o banco: criação de fechamento, aprovação, ajuste, pagamento, cancelamento e estorno.
- Backend: rotas `/api/admin/financial/closings*` e `/api/admin/financial/payouts/:id/reverse` passaram a chamar RPCs.
- Interface: telas `Meus Ganhos` e `Financeiro` exibem aviso de "Módulo financeiro em homologação"; exportações e gráficos seguem desligados.
- Flags preparadas para ativação controlada no Worker: `ENABLE_FINANCIAL_MODULE=true` e `ENABLE_TEACHER_COMPENSATION=true`; `ENABLE_FINANCIAL_EXPORTS=false` e `ENABLE_FINANCIAL_CHARTS=false`.
- Backfill: apenas dry-run executado, sem criação retroativa de dívidas; resultado atual: `0` lançamentos pendentes.
- Testes: `npm run check:all` passou; validação de existência das 6 RPCs passou; `npm run financial:smoke` passou com dados fictícios.
- Validação remota: professor pai, professor filho e superadmin acessaram endpoints financeiros; fluxo via API criou fechamento, aprovou, registrou pagamento fictício e gerou notificação interna.
- Risco pendente: ainda falta UI completa para seleção múltipla, ajuste, cancelamento e estorno; por enquanto essas operações estão seguras no backend/RPC, mas não plenamente confortáveis na tela.

## Módulo financeiro interno — Ciclo A — 2026-07-13

- Status: implementado localmente, aguardando revisão.
- Branch atual: `main`.
- Arquitetura preservada: Cloudflare Workers, Hono, Supabase PostgreSQL/Auth, frontend estático e Wrangler.
- Escopo deste ciclo: auditoria inicial, feature flags e migration não destrutiva do ledger financeiro.
- Arquivos principais: `src/config.ts`, `src/types.ts`, `.env.example`, `wrangler.jsonc`, `migrations/007_financial_module.sql`, `docs/FINANCIAL_MODULE.md`.
- Migration remota: não aplicada neste ciclo.
- Deploy: não realizado neste ciclo.
- Evidência da auditoria:
  - pagamentos de alunos já usam `payments` e `payment_webhook_events`;
  - professores filhos ainda ficam no CMS do site;
  - correções finalizadas gravam `status=FINALIZADA`, `prof_id` e `finalizada_em`;
  - ainda não há tabela própria de valores devidos a corretores filhos.
- Próxima ação recomendada: aplicar a migration em janela controlada e iniciar o Ciclo B, gerando um lançamento único em `correction_compensation_entries` quando uma redação direcionada a professor filho for finalizada.

## Módulo financeiro interno — Ciclo B — 2026-07-13

- Status: implementado localmente, validado por `npm run check:all`, aguardando deploy/virada controlada das flags.
- Migrations aplicadas no Supabase: `007_financial_module.sql` e `008_financial_statuses.sql`.
- Tabelas confirmadas: `financial_settings`, `correction_compensation_rules`, `correction_compensation_entries`, `teacher_payment_closings`, `teacher_payouts`, `financial_adjustments`, `financial_audit_logs`.
- Gatilho implementado: `PATCH /api/admin/correcoes/:id` cria lançamento financeiro quando correção atribuída a professor filho vira `FINALIZADA`.
- Idempotência: `correction_compensation_entries.correction_id` é único.
- Professor filho: endpoints e tela mínima `Meus Ganhos`.
- Professor pai: endpoints e tela mínima `Financeiro`.
- Superadmin: endpoint `/api/superadmin/financial`.
- Backfill: script dry-run criado sem gerar dívida retroativa.
- Flags no Worker: continuam `false` por padrão; menus financeiros só aparecem quando `ENABLE_FINANCIAL_MODULE=true`.
- Risco pendente: fechamentos e pagamentos manuais ainda usam sequência de updates via Supabase REST, não RPC SQL transacional.

## Atualização de Produção — 2026-07-13

- Branch atual: `main`.
- Último commit antes da migracao do Worker: `97559e9 fix: avoid leaking internal service errors`.
- GitHub remoto atual: `https://github.com/slowan-pt/cursoredacao.git`.
- Working tree antes da rodada: limpo.
- Worker novo publicado nesta rodada: `b2fb90d2-33cb-49f8-acbd-880f65ef4c1e`.
- URL remota validada: `https://cursoredacao.slowgithub.workers.dev`.
- Worker antigo `cursoreducao` preservado para rollback/observacao, sem exclusao.
- `APP_URL` continua apontando para `https://redacaocomestrategia.com.br`.
- Custom domain oficial ainda não está ativo. A tentativa via Wrangler/API Cloudflare falhou com HTTP 400 na criação de domain records, então o `wrangler.jsonc` ficou sem `routes` de custom domain para manter deploys seguros.
- Secrets essenciais do Worker novo configurados: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`, `SESSION_SECRET`.
- Secrets Asaas configurados no Worker novo: `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN`.

### Concluído Nesta Rodada

- Metadados públicos adicionados:
  - `public/robots.txt`;
  - `public/sitemap.xml`;
  - `public/site.webmanifest`;
  - `public/favicon.svg`.
- Páginas públicas principais receberam canonical, manifest, favicon e metadados compatíveis com o domínio oficial:
  - `public/index.html`;
  - `public/login.html`;
  - `public/auth-callback.html`.
- Script `npm run check:public` criado para validar metadados essenciais.
- Script `npm run smoke:prod` criado para smoke remoto de `/health`, páginas públicas e assets.
- Script `npm run audit:static` criado para bloquear marcadores temporários, `debugger`, `console.log` em código servido ao usuário, `document.write` fora do loader controlado e scripts locais que listem usuários.
- Script `npm run typecheck:unused` adicionado e incluído no `check:all`.
- `npm run check:all` passou.
- `npm run smoke:prod -- --base=https://cursoredacao.slowgithub.workers.dev` passou no fallback `workers.dev` novo.
- `ENABLE_APP_RATE_LIMITING=false` foi documentado em `.env.example`, `wrangler.jsonc` e tipagem centralizada.
- Documentação operacional nova:
  - `docs/DOMAIN.md`;
  - `docs/SUPABASE_AUTH.md`;
  - `docs/ASAAS_PRODUCTION.md`;
  - `docs/RATE_LIMITING.md`;
  - `docs/OBSERVABILITY.md`;
  - `docs/LAUNCH_CHECKLIST.md`;
  - rascunhos jurídicos em `docs/legal/`.
- Migration não destrutiva preparada para índices de performance: `migrations/006_performance_indexes.sql`.
- `scripts/migrate.mjs` corrigido para não descartar statements SQL precedidos por comentários de linha.
- Headers `Cache-Control: no-store` adicionados para `/api/*`, `/login.html` e `/auth-callback.html`.
- Rotas `/login` e `/auth-callback` passaram a ser servidas via Worker para garantir `Cache-Control: no-store` nos assets sensíveis.
- Rotas administrativas, aluno, site, auth e superadmin passaram a retornar mensagem genérica para falhas internas de banco/serviço, evitando vazamento de detalhes de Supabase.
- `migrations/006_performance_indexes.sql` aplicada via conexão administrativa ignorada pelo Git; 11 índices confirmados.
- Asaas Sandbox no Worker novo validado com cobrança PIX, webhook `PAYMENT_CREATED`, sync e reconciliação.
- Reconciliação sandbox adicionada em `POST /api/payments/asaas/sandbox-reconciliation`.
- Painel de saúde superadmin adicionado em `/api/superadmin/health` e na aba `Saúde`.
- `npm run preview:emails` adicionado para gerar previews locais dos templates sem API key real.

### Não Concluído Por Depender De Ação Manual

- Ativar `redacaocomestrategia.com.br` e `www.redacaocomestrategia.com.br` como custom domains do Worker `cursoredacao` no painel Cloudflare.
- Configurar Site URL e Redirect URLs no Supabase para o domínio oficial.
- Criar e validar domínio/API key no Resend.
- Ativar Asaas produção e fazer PIX real de baixo valor.
- Criar regras reais de rate limiting no Cloudflare WAF/Rate Limiting ou implementar Durable Objects.
- Revisar termos, privacidade, retenção e reembolso com apoio jurídico.

## Atualização MVP — 2026-07-13

- Branch atual: `main`.
- Working tree após este ciclo: alterações locais em código e docs, ainda não commitadas até a revisão final.
- Worker publicado mais recente neste ciclo: `720e4f78-c4d6-4f2f-95ad-552292343fd0`.
- Ambiente remoto testado: `https://cursoreducao.slowgithub.workers.dev`.
- `APP_URL` no Worker aponta para `https://redacaocomestrategia.com.br`, mas o custom domain ainda depende de configuração/validação externa na Cloudflare.

### Concluído e testado remotamente neste ciclo

- R2 ativo para novos uploads com referências `r2:<object_key>`.
- Upload fictício validado para PDF, JPEG e PNG pelo fluxo real do aluno.
- Rejeições validadas: MIME inválido, PNG corrompido, URL externa falsa e arquivo acima de `MAX_UPLOAD_BYTES`.
- Metadados `storage_files` gravados e marcados como `DELETED` após exclusão controlada.
- Aluno e professor não acessam redação excluída pelo professor.
- Professor recebe `404` controlado ao tentar alterar turma de outro site.
- Professor visualiza `/api/admin/payments` com filtro, flag Sandbox e referência mascarada.
- Professor visualiza notificações internas por `/api/admin/notifications`; aluno recebe `403`.
- `/health` publicado e validado com HTTP 200.
- `npm run check:all` passou após as alterações.

### Parcial ou planejado

- Logout limpa o cookie no navegador, mas JWT já emitido continua válido se alguém reutilizar manualmente o valor até expirar. Para revogação real é necessário estado compartilhado por banco/KV/Durable Object.
- Rate limiting efetivo ainda depende de Cloudflare Rate Limiting/WAF/Durable Objects; não foi implementado contador em memória para evitar falsa proteção.
- Resend está preparado em código/templates, mas `ENABLE_EMAILS=false` e não há envio real.
- Domínio oficial ainda precisa ser ativado/validado no painel Cloudflare.
- GitHub remoto atual foi corrigido para `https://github.com/slowan-pt/cursoredacao.git` e respondeu a `git ls-remote`.

## Dados gerais

- Data da atualização: 2026-07-13.
- Branch atual: `main`.
- Relação com remoto antes desta rodada: branch `main` sincronizada com `origin/main`.
- Último commit local confirmado antes desta homologação: `a087598 feat: add Asaas sandbox homologation flow`.
- Estado do working tree: modificado durante homologação Asaas sandbox; alterações em `src/payments.ts`, `src/routes/payments.ts` e docs serão consolidadas em commits locais.
- Versão atual declarada: `1.0.0` em `package.json`.
- Ambiente atual observado: Cloudflare Workers, URL pública `https://cursoreducao.slowgithub.workers.dev`.
- Última versão do Worker validada nesta homologação comercial Asaas: `a6c0461f-f674-4f0f-9b53-4c7e9bdb548f`.

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
  - `src/uploads.ts` valida data URL por MIME, magic bytes e tamanho, devolvendo bytes validados.
  - `src/storage.ts` possui referência privada `r2:<object_key>`.
  - `src/routes/aluno.ts` grava envio/edição em storage privado quando `ENABLE_R2_UPLOADS=true`.
  - `src/routes/admin.ts` hidrata arquivo privado em data URL ao abrir a correção.
  - `public/aluno/index.html` e `public/professor/index.html` ainda consomem data URL no editor/visualizador.
- Status: parcial, implementado localmente.
- Commitado: aguardando commit deste ciclo.
- Testado: `npm run check:all` passou.
- Risco: endpoint autenticado/streaming ainda pendente; hidratação temporária por data URL precisa validação com upload real.

### Pagamentos

- Evidências locais:
  - `src/routes/site.ts` contém rota `/api/site/:slug/checkout`.
  - `src/routes/site.ts` carrega site/turma diretamente do banco, valida turma aberta e usa exclusivamente `turmas.preco`.
  - `src/routes/site.ts` cria registro interno em `payments`, cobrança PIX Asaas Sandbox e reaproveita cobrança pendente existente para evitar duplicidade.
  - `src/routes/payments.ts` grava eventos em `payment_webhook_events` e libera matrícula somente para status pago normalizado.
  - `src/routes/payments.ts` registra notificação interna no CMS do site quando o pagamento é recebido.
  - `src/routes/admin.ts` expõe `/api/admin/payments` para o professor visualizar vendas.
  - `public/professor/index.html` mostra pagamentos recentes no dashboard.
  - `src/config.ts` contém flags `ENABLE_PAYMENTS` e `ENABLE_PUBLIC_CHECKOUT_SIMULATED`.
- Status: implementado localmente, aguardando revisão/commit deste ciclo.
- Commitado: ainda não neste ciclo.
- Testado: sim, em 2026-07-13 no Worker publicado `cursoreducao`.
- Evidência de homologação:
  - turma nova `Homologacao Comercial 20260713-000003`, preço `R$ 5,73`;
  - checkout público criou cobrança PIX Asaas Sandbox `pay_4d2uxcz072cm1m5s`;
  - `PAYMENT_CREATED` manteve pagamento `PENDING` e zero matrículas;
  - `PAYMENT_RECEIVED` atualizou pagamento para `RECEIVED`;
  - matrícula ativa criada com origem `ASAAS_CHECKOUT`;
  - aluno acessou a turma após login;
  - painel do professor exibiu pagamento com aluno, turma, valor, PIX, status e data de pagamento;
  - notificação interna `PAYMENT_RECEIVED` criada no CMS.
- Risco: confirmação de pagamento ainda depende do painel Asaas Sandbox porque a API local não tem `ASAAS_API_KEY`; em produção ainda faltam políticas finais de boleto/cartão, reenvio de eventos pelo painel e alertas visuais de notificação.

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
| Asaas | parcial | Gateway, envs, migration, webhook e ciclo sandbox completo por webhook validados; checkout público real ainda precisa amarração final de UX. |
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
| R2 privado | parcial | `src/storage.ts`, `src/uploads.ts`, `src/routes/aluno.ts`, `src/routes/admin.ts`, `migrations/004_storage_files.sql`, `docs/R2.md` | aguardando commit | parcial | Depende de bucket, migration e endpoint autenticado/streaming. |
| Checkout simulado | parcial | `src/routes/site.ts`, `src/routes/auth.ts`, `public/login.html` | não | não verificado | Não substitui Asaas real. |
| Gateway Asaas | parcial | `src/payments.ts`, `src/routes/payments.ts`, `migrations/005_payments.sql`, `docs/ASAAS.md` | sim/parcial | sim | Cobrança sandbox `pay_k1hnnk6q1mt7l20l` recebeu `PAYMENT_CREATED` e `PAYMENT_RECEIVED`; matrícula única criada. |
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
- Legacy API keys do Supabase foram desativadas em 2026-07-12; `SUPABASE_SERVICE_KEY` usa `sb_secret_...` e `SUPABASE_ANON_KEY` usa `sb_publishable_...`.
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
| Desativação da service key legacy | concluído |
| Migração da anon key para publishable key | concluído |
| Limpeza do histórico Git | parcial |
| Secrets atualizadas no Cloudflare | não verificado |
| `APP_ENV=production` no ambiente final | não verificado |
| Domínio `redacaocomestrategia.com.br` configurado | pendente |
| `www` redirecionando para domínio principal | pendente |
| R2 configurado | parcial |
| Camada R2 local preparada | concluído |
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

## Desativação das Legacy API Keys — 2026-07-12

### Estado

- Legacy API keys do Supabase desativadas manualmente no painel.
- `SUPABASE_SERVICE_KEY` local e do Worker padrão `cursoreducao` já usam `sb_secret_...`.
- `SUPABASE_ANON_KEY` local e do Worker padrão `cursoreducao` usam `sb_publishable_...`.
- Leitura administrativa com a nova secret key passou.
- Fluxos de login professor/corretor e aluno passaram após migrar a publishable key.

### Testes após desativação

- `npm run check:all`: passou.
- `GET /health`: passou.
- Leitura administrativa com `sb_secret_...`: passou.
- Login professor/corretor: passou.
- Login aluno: passou.
- Painel do aluno: passou.
- Tentativa de acesso do aluno a outro site: bloqueada com `403`, como esperado.

### Diagnóstico

- A nova `SUPABASE_SERVICE_KEY` está validada.
- A nova `SUPABASE_ANON_KEY` com valor `sb_publishable_...` está validada.
- O nome da variável permanece legado para evitar refatoração durante o incidente; renomear para `SUPABASE_PUBLISHABLE_KEY` pode ficar para ciclo futuro.
- Próxima ação segura: iniciar o ciclo controlado de limpeza do histórico Git, com backup local sensível e validação antes de qualquer force push.

## Ciclo 1 — Limpeza Git local — 2026-07-12

### Estado encontrado

- Branch atual: `main`.
- Remoto: `origin` apontando para `https://github.com/slowan-pt/redacao.git`.
- Branch local: `main...origin/main [ahead 25]`.
- Tags: nenhuma tag local listada.
- Working tree antes da limpeza: limpo.
- Scanner estrito da história alcançável: nenhum formato real de segredo encontrado.
- Scanner estrito do reflog antes da limpeza: encontrou uma secret key Supabase em commit órfão local/reflog `608247c...`, no arquivo `scripts/check.mjs`.
- `origin/main`: continha apenas marcador de host Supabase em `scripts/migrate.mjs`, sem connection string literal detectada.

### Ações executadas

- Backup local criado fora do repositório:
  - `C:\Users\adm.sloannascimento\Downloads\puppin\_git_backups\cursoreducao-20260712-191058`
- Backup contém:
  - clone mirror local;
  - bundle Git `cursoreducao-before-cleanup.bundle`;
  - `HEAD.txt`;
  - `STATUS.txt`.
- Reflog local expirado com `git reflog expire --expire=now --expire-unreachable=now --all`.
- Objetos inalcançáveis podados com `git gc --prune=now`.
- `git-filter-repo` não foi aplicado à `main` porque a varredura estrita não encontrou segredos reais na história alcançável; o segredo restante estava somente em reflog/objeto órfão, fora do escopo de reescrita de commits alcançáveis.

### Validação após limpeza

- Reflog: vazio ou sem refs retornadas.
- `git fsck --full --unreachable --no-reflogs`: sem objetos inalcançáveis listados.
- Scanner estrito da história alcançável: sem formatos reais de segredo.
- `npm run check:all`: passou.

### Pendências deste ciclo

- Commitar esta documentação.
- Fazer push com `git push --force-with-lease` para publicar a sequência local e substituir o remoto antigo com segurança.
- Clonar/validar o remoto após o push.

## Ciclo 2 — Integração R2 incremental — 2026-07-12

### Implementado localmente

- Novos envios e edições de redação usam storage privado quando `ENABLE_R2_UPLOADS=true`.
- O banco guarda referência interna `r2:<object_key>` em vez de base64 quando R2 está ativo.
- Metadados são inseridos em `storage_files`.
- Se a gravação no storage/metadados falhar, o envio recém-criado é revertido.
- As rotas de detalhe do professor e do aluno hidratam o arquivo privado para data URL para manter compatibilidade com o editor atual.
- Bucket R2 privado `redacao-uploads` criado na Cloudflare.
- Backup local de metadados do schema criado em `C:\Users\adm.sloannascimento\Downloads\puppin\_db_backups`.
- Migration `004_storage_files.sql` aplicada no Supabase.
- `wrangler.jsonc` configurado com `APP_ENV=production`, `ENABLE_R2_UPLOADS=true` e integrações incompletas desligadas.
- Deploy real executado no Worker `cursoreducao`.

### Testes

- `npm run check:all`: passou.
- `npx wrangler deploy --dry-run`: passou e reconheceu `env.R2_UPLOADS`.
- `npx wrangler deploy`: passou; versão `627f2f9d-1a96-484a-91e9-24c55956ec30`.
- `GET /health`: passou com `version=1.0.0`.
- Login professor/corretor: passou.
- Login aluno: passou.
- Rota protegida professor/corretor: passou.
- Rota protegida aluno: passou.
- Logout professor/corretor e aluno: passou.
- Isolamento do aluno em outro site: bloqueado.
- R2 remoto: put/get/delete de objeto temporário passou, com exclusão do objeto de teste.

### Pendências

- Criar endpoint autenticado/streaming para substituir a hidratação temporária por data URL.
- Validar upload/leitura via aplicação com aluno/turma de homologação dedicado, para evitar consumir créditos reais.

## Bloqueio GitHub resolvido — 2026-07-13

- Bloqueio anterior: `origin` configurado como `https://github.com/slowan-pt/redacao.git` retornava `Repository not found`.
- Remoto atual: `https://github.com/slowan-pt/cursoredacao.git`.
- `git ls-remote origin refs/heads/main` respondeu corretamente antes desta rodada.
- `gh` CLI não está instalado, mas não é necessário para o push Git atual.
- Git local usa credential helper do Windows e identidade `slowan-pt <slowgithub@gmail.com>`.
- Próxima ação segura: usar push normal para commits novos. Nao usar force push sem nova revisao especifica.

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

- Rota de webhook Asaas criada e publicada; teste autenticado ainda depende do valor real do secret ou disparo pelo painel Asaas.

## Verificação do Webhook Asaas — 2026-07-12

Status: parcial, bloqueado por credenciais externas.

Evidências:

- Rota publicada: `POST /api/payments/asaas/webhook`.
- `ASAAS_WEBHOOK_TOKEN` existe como secret no Worker `cursoreducao`.
- Tabelas `payments` e `payment_webhook_events` existem no Supabase.
- Antes da correção, a rota retornava `503` porque dependia de `ENABLE_PAYMENTS=false`.
- Correção aplicada: o webhook agora fica ativo quando o token está configurado, mesmo com checkout/pagamentos desligados.
- Teste sem token retornou `401`, comportamento esperado.
- `payment_webhook_events` permanecia com 0 eventos antes do teste autenticado.
- Nova correção aplicada: webhook com status `CONFIRMED` ou `RECEIVED` agora atualiza pagamento, vincula o aluno à turma, ativa o aluno e registra créditos de envio via CMS/fallback.
- Deploy validado após a correção: `68e7b1f4-1dae-4207-9f23-88d8f3a52356`.
- Teste sem token após o deploy retornou `401`, comportamento esperado.
- Banco conferido após o teste sem token: `payments=0`, `payment_webhook_events=0`.

Limite encontrado:

- O valor de `ASAAS_WEBHOOK_TOKEN` não pode ser lido de volta pelo Wrangler/Cloudflare, pois secrets são write-only.
- Não foi possível fazer o POST autenticado com o valor real sem o usuário colar o token novamente ou sem o Asaas disparar um evento de teste.
- Não existe `ASAAS_API_KEY` localmente nem como secret do Worker; portanto não é possível criar cobrança sandbox automaticamente.

Próximo teste seguro:

1. Enviar um evento de teste pelo painel do Asaas, ou colar temporariamente o token em um prompt seguro local.
2. Verificar resposta `200` ou `202`.
3. Conferir inserção em `payment_webhook_events`.
4. Criar um registro de pagamento sandbox com `external_reference` controlado e repetir o webhook para validar atualização em `payments`.
5. Configurar `ASAAS_API_KEY` sandbox para permitir criação automática de cobrança de R$ 5,00.
6. Repetir o ciclo completo: cobrança `PENDING`, webhook `CONFIRMED/RECEIVED`, matrícula automática e login do aluno.
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
