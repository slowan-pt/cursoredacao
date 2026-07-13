# Changelog

Todas as mudanças relevantes deste projeto devem ser registradas aqui.

## Não publicado

### Adicionado

- Rodada de finalização para produção em 2026-07-13:
  - adicionados `robots.txt`, `sitemap.xml`, `site.webmanifest` e `favicon.svg`;
  - páginas públicas principais passaram a declarar canonical, manifest, favicon e metadados do domínio oficial;
  - criado `npm run check:public`;
  - criado `npm run smoke:prod`;
  - `check:all` agora valida metadados públicos;
  - `ENABLE_APP_RATE_LIMITING=false` documentado em `.env.example`, `wrangler.jsonc` e tipos;
  - docs novas: domínio, Supabase Auth, Asaas produção, rate limiting, observabilidade e checklist de lançamento;
  - rascunhos jurídicos adicionados em `docs/legal/`;
  - deploy publicado: `2c4d20c0-4454-47d4-9b9f-5e5df70dece5`;
  - smoke remoto validado no fallback `https://cursoreducao.slowgithub.workers.dev`.
- Finalização incremental do MVP em 2026-07-13:
  - upload R2 validado remotamente por PDF, PNG e JPEG fictícios via fluxo real do aluno;
  - rejeição remota validada para MIME inválido, PNG corrompido, URL externa falsa e arquivo acima de `MAX_UPLOAD_BYTES`;
  - exclusão controlada de redação agora remove a referência `arquivo_url`, bloqueia acesso direto e marca metadados R2 como `DELETED`;
  - rota de detalhe do professor não retorna redações `EXCLUIDA_PELO_PROFESSOR`;
  - atualização de turma fora do site do professor passou a retornar `404` controlado;
  - painel financeiro do professor ganhou filtro de status, indicação de Sandbox, estado de carregamento e referência mascarada da cobrança;
  - criadas rotas site-scoped `/api/admin/notifications` e `/api/admin/notifications/:id/read`;
  - dashboard do professor passa a listar notificações internas sem depender de Resend;
  - templates de e-mail preparados para pagamento aprovado, pagamento vencido, reembolso/estorno, novo aluno pago ao professor e recuperação de senha;
  - deploys publicados durante o ciclo: `4c782c21-20c7-46b0-84be-b42047f0bd49`, `3e2fa71d-6f6e-4040-ba15-bd22ef6a50a6`, `720e4f78-c4d6-4f2f-95ad-552292343fd0`.
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
- Integração incremental de upload privado:
  - validação de bytes/MIME em `src/uploads.ts`;
  - referência interna `r2:<object_key>`;
  - gravação em storage privado quando `ENABLE_R2_UPLOADS=true`;
  - hidratação temporária para data URL nas rotas de detalhe de correção.
- Bucket R2 privado `redacao-uploads` criado.
- Migration `004_storage_files.sql` aplicada no Supabase após backup de metadados do schema.
- Variáveis explícitas de produção adicionadas ao `wrangler.jsonc`, mantendo pagamentos, e-mails, OAuth e checkout simulado desligados.
- Deploy real do Worker `cursoreducao` executado com versão `627f2f9d-1a96-484a-91e9-24c55956ec30`.
- R2 remoto validado com put/get/delete de objeto temporário.
- GitHub remoto foi corrigido posteriormente para `https://github.com/slowan-pt/cursoredacao.git`; o bloqueio antigo de `Repository not found` nao se aplica ao remoto atual.
- Tentativa de configurar custom domains via Wrangler falhou na criação dos domain records; rollback executado e `workers_dev=true` foi explicitado.
- Healthcheck `/health` passou a rodar antes dos Assets para evitar 404.
- Deploy atual validado com versão `70d38840-7c8d-4cac-96dd-6347ac92a41d`.
- Upload R2 real via aplicação validado com arquivo de teste, referência `r2:`, metadados em `storage_files` e limpeza posterior.
- Rota guardada `POST /api/payments/asaas/webhook` adicionada e publicada com `ENABLE_PAYMENTS=false`.
- Migration `005_payments.sql` aplicada no Supabase após backup de metadados do schema.
- Asaas segue bloqueado por ausência de `ASAAS_API_KEY`; Resend segue bloqueado por ausência de `RESEND_API_KEY`.
- Webhook Asaas ajustado para liberar matrícula/créditos automaticamente quando um pagamento existente chega como `CONFIRMED` ou `RECEIVED`.
- Homologação completa Asaas segue bloqueada porque `ASAAS_API_KEY` não existe e o valor do `ASAAS_WEBHOOK_TOKEN` do Worker não pode ser lido de volta.
- Homologação Asaas sandbox avançada com `ASAAS_API_KEY` e `ASAAS_WEBHOOK_TOKEN` configurados no Worker:
  - `ENABLE_PAYMENTS=true` e `ASAAS_ENV=sandbox` publicados;
  - rota protegida de homologação cria cliente, chave Pix EVP, cobrança PIX R$ 5,00 e QR Code;
  - gateway Asaas envia `User-Agent`, exigido pela API;
  - webhook sem token validado com resposta `401`;
  - pagamento automático do QR Code via API bloqueado por permissão sandbox (`insufficient_permission` para operações de saque/pagamento via API);
  - cobrança mais recente permanece `PENDING` até simulação/pagamento manual ou liberação dessa permissão na chave sandbox.
- Após confirmação manual no painel Asaas:
  - rota protegida de sincronização sandbox consulta a cobrança no provedor;
  - status `RECEIVED_IN_CASH` é normalizado para `RECEIVED`;
  - pagamento local foi atualizado para `RECEIVED`;
  - matrícula do aluno foi criada/ativada com origem `ASAAS_SYNC`;
  - repetição da sincronização manteve apenas uma matrícula ativa;
  - webhook de confirmação não chegou para a cobrança homologada e precisa ser verificado nos logs do Asaas Sandbox.
- Homologação nova e completa por webhook Asaas Sandbox:
  - cobrança `pay_k1hnnk6q1mt7l20l` criada para turma de homologação nova;
  - `PAYMENT_CREATED` chegou, foi gravado e não liberou matrícula;
  - `PAYMENT_RECEIVED` chegou, foi gravado e atualizou o pagamento para `RECEIVED`;
  - matrícula criada uma única vez com origem `ASAAS_WEBHOOK`;
  - aluno validado com acesso à turma após confirmação;
  - token inválido validado com HTTP 401.
- Fluxo comercial público de turma nova validado com Asaas Sandbox:
  - checkout público agora cria cobrança PIX real em sandbox a partir do preço salvo em `turmas.preco`;
  - cobrança pendente existente é reaproveitada para o mesmo aluno/turma;
  - professor visualiza pagamentos recentes no dashboard;
  - webhook pago registra notificação interna no CMS;
  - turma `Homologacao Comercial 20260713-000003` vendida por `R$ 5,73`;
  - cobrança `pay_4d2uxcz072cm1m5s` recebeu `PAYMENT_CREATED` e depois `PAYMENT_RECEIVED`;
  - matrícula ativa criada com origem `ASAAS_CHECKOUT`;
  - aluno validado com acesso à turma comprada.
- Documentação operacional:
  - `docs/ARCHITECTURE.md`
  - `docs/ROADMAP.md`
  - `docs/SECURITY.md`
  - `docs/BACKUP.md`
  - `docs/RESTORE.md`

### Segurança

- Limpeza local do reflog/objetos órfãos após backup mirror e bundle.
- Scanner estrito da história alcançável não encontrou formatos reais de segredo.
- Commit órfão local/reflog `608247c...` com secret key antiga foi removido por expiração de reflog e `git gc --prune=now`.
- Nenhuma nova rotação de credenciais foi executada nesta entrada; as credenciais novas já estavam validadas.
- A limpeza local de reflog/objetos órfãos foi executada nesta entrada.
- Nenhum deploy foi executado nesta entrada.
- A CSP foi definida de forma compatível com o frontend atual, mantendo `unsafe-inline` enquanto houver scripts/estilos inline.
- Rate limiting efetivo foi documentado como bloqueio porque não deve ser simulado com memória local em Cloudflare Workers.
- O provider local de storage não é persistente e não deve ser usado em produção.
- A normalização de webhook Asaas não libera matrícula; ela apenas prepara dados para uma rota futura idempotente.
- Templates de e-mail não enviam mensagens por conta própria; envio real continua atrás de `ENABLE_EMAILS`.
- Logs de erro não registram payloads, tokens ou dados de arquivos.
- Alterações de UX foram adiadas para evitar misturar novas mudanças com arquivos funcionais já modificados.
- Legacy API keys do Supabase foram desativadas manualmente em 2026-07-12.
- A nova `SUPABASE_SERVICE_KEY` `sb_secret_...` passou em leitura administrativa.
- `SUPABASE_ANON_KEY` foi migrada para valor `sb_publishable_...`, mantendo temporariamente o nome legado da variável.
- Após atualizar o Worker `cursoreducao`, os fluxos professor/corretor e aluno voltaram a passar com as legacy keys desativadas.

### Observações

- O branch local foi sincronizado com o remoto correto antes da rodada de finalizacao para producao.
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
