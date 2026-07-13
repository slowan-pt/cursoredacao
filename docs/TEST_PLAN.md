# Plano de Testes

Atualizado em: 2026-07-13.

## Home Marketplace — 2026-07-13

- `npm run check:all`: passou localmente antes e depois do deploy.
- Verificação de banco somente leitura: slugs `puppin-teste` e `slow` existem e estão ativos.
- Deploy validado: Worker `cursoredacao`, versão `33f6728e-68aa-4809-9c3f-4eecfcaa77b9`.
- `/`: HTTP 200 e contém hero, vitrine de professores, planos, funcionamento e seção para alunos.
- `/api/marketplace/professores`: HTTP 200 com JSON de professores/sites ativos.
- `/redacao/puppin-teste`: HTTP 200.
- `/redacao/slow`: HTTP 200.
- `/login.html`: HTTP 200.
- `npm run smoke:prod -- --base=https://cursoredacao.slowgithub.workers.dev`: passou.
- Login professor, `/api/admin/stats`, `/api/admin/site` e logout: passaram.
- Login aluno, `/api/aluno/stats`, `/api/aluno/turmas` e logout: passaram.

## Resultado Remoto MVP — 2026-07-13

- `npm run check:all`: passou.
- `npm run smoke:prod -- --base=https://cursoredacao.slowgithub.workers.dev`: passou no Worker novo.
- Worker novo validado: `https://cursoredacao.slowgithub.workers.dev`.
- Worker antigo preservado: `https://cursoreducao.slowgithub.workers.dev`.
- O smoke remoto valida `Cache-Control: no-store` em `/login`.
- `/health`: HTTP 200, `service=redacao`, `version=1.0.0`.
- Login professor: passou.
- Login aluno: passou.
- Aluno tentando acessar rota administrativa de pagamentos/notificações: HTTP 403.
- Professor tentando acessar rota de aluno: HTTP 403.
- Professor tentando alterar turma de outro site: HTTP 404 controlado.
- Uploads R2 fictícios PDF, JPEG e PNG: passaram.
- MIME inválido, PNG corrompido, URL externa falsa e arquivo acima do limite: rejeitados.
- Exclusão controlada de redação de teste: bloqueou reabertura e marcou metadados R2 como `DELETED`.
- Painel financeiro: `/api/admin/payments?limit=5&status=ALL` retornou HTTP 200 e `sandbox=true`.
- Notificações internas: `/api/admin/notifications` retornou HTTP 200 para professor e HTTP 403 para aluno.
- Worker novo `cursoredacao`: Asaas Sandbox validado com criação de cobrança PIX e `PAYMENT_CREATED` no webhook.
- Reconciliação sandbox: `dry_run` validado; execução real em sandbox atualizou pagamento `RECEIVED`, liberou matrícula única e repetição não duplicou.
- Painel de saúde superadmin: `/api/superadmin/health` retornou HTTP 200.
- Migration `006_performance_indexes.sql`: aplicada e 11 índices confirmados.

## Resultado Financeiro Transacional — 2026-07-13

- `npm run check:all`: passou após as alterações.
- Migration `009_financial_transactions.sql`: aplicada no Supabase.
- RPCs confirmadas por consulta somente leitura: 6 de 6 encontradas.
- `npm run financial:backfill:dry-run`: passou; `missing_compensation_entries=0`.
- `npm run financial:backfill:dry-run -- --since=2026-01-01 --limit=100`: passou; sem gravação e sem pendências.
- `npm run financial:smoke`: passou com dados fictícios `FIN_SMOKE_*`.
- Smoke validou:
  - idempotência de fechamento;
  - tentativa duplicada com chave diferente;
  - corrida concorrente com duas conexões;
  - pagamento parcial;
  - retry de pagamento parcial com a mesma idempotency key;
  - pagamento total;
  - bloqueio de pagamento acima do saldo parcial;
  - cancelamento liberando lançamento;
  - estorno voltando fechamento para `APPROVED`;
  - bloqueio de professor de outro site;
  - auditoria.
- Smoke remoto via API:
  - login professor pai HTTP 200;
  - `/api/admin/financial/summary`, `payables`, `closings` e `audit` HTTP 200;
  - login professor filho HTTP 200 e `summary.role=CHILD_TEACHER`;
  - `/api/superadmin/financial` HTTP 200;
  - fechamento/aprovação/pagamento manual fictício via API HTTP 201/200/201;
  - `/api/admin/notifications` HTTP 200 após pagamento fictício.
- Smoke remoto do painel financeiro operacional:
  - `npm run smoke:prod -- --base=https://cursoredacao.slowgithub.workers.dev`: passou;
  - professor pai: `/api/admin/financial/summary`, `/api/admin/financial/teachers` e `/api/admin/financial/export.csv?type=payables` retornaram HTTP 200;
  - CSV financeiro retornou `text/csv; charset=utf-8`;
  - professor filho: `/api/admin/financial/summary` e `/api/admin/financial/compensations` retornaram HTTP 200;
  - professor filho tentando `/api/admin/financial/payables` recebeu HTTP 403, comportamento esperado.
- Não foi executado backfill real.
- Não foi usado Asaas produção.
- Pendente: trocar prompts/confirms das ações financeiras por modais dedicadas e adicionar teste visual automatizado.

## Não Verificado Automaticamente Neste Ciclo

- Fluxo financeiro visual completo com botões de ajuste, cancelamento e estorno.
- Exportação CSV do módulo financeiro: verificada remotamente para contas a pagar; ainda falta varrer todos os tipos em teste automatizado.
- Criação de fechamento por RPC SQL transacional em fluxo visual real.
- Corretor filho acessando somente correções atribuídas em cenário com dados reais suficientes.
- Custom domain `redacaocomestrategia.com.br`.
- Envio real via Resend.
- Cobrança Asaas de produção.
- Revogação server-side de JWT após logout.
- Smoke remoto pelo domínio oficial `https://redacaocomestrategia.com.br`, porque o custom domain ainda não está ativo.
- Aplicação real da migration `006_performance_indexes.sql` no Supabase, pois depende de janela operacional.

## Validações Automatizadas Disponíveis

```bash
npm run security:scan
npm run check:public
npm run audit:static
npm run check:financial
npm run typecheck:unused
npm run smoke:prod
npx tsc --noEmit
git diff --check
```

## Fluxos Manuais Prioritários

### Superadmin

- Login.
- Listar professores.
- Bloquear professor.
- Confirmar que site bloqueado não libera acesso indevido.

### Professor Pai

- Login no próprio site.
- Criar turma.
- Editar turma.
- Excluir turma sem alunos.
- Tentar excluir turma com alunos e confirmar bloqueio.
- Criar aluno.
- Inativar aluno.
- Criar professor corretor filho.
- Direcionar correções por turma/aluno.

### Professor Filho

- Login.
- Ver somente correções direcionadas.
- Não ver menus administrativos do professor pai.
- Corrigir redação direcionada.
- Confirmar que não acessa correções fora do escopo.

### Aluno

- Cadastro pendente.
- Cadastro por pagamento simulado.
- Login de aluno ativo.
- Bloqueio de aluno inativo.
- Matrícula em turma.
- Envio de redação somente em turma vinculada.
- Visualização de correção.
- Logout.

### Upload

- PDF válido.
- JPEG válido.
- PNG válido.
- MIME inválido.
- Arquivo acima de `MAX_UPLOAD_BYTES`.
- Base64 bloqueado quando `APP_ENV=production` e `ENABLE_R2_UPLOADS=false`.

### Pagamentos

- Checkout simulado com flag ligada em ambiente não produção.
- Confirmar que retorno do navegador não deve liberar pagamento real.
- Fluxo comercial público de turma nova:
  - professor cria turma com nome, descrição, status aberto e preço;
  - turma aparece no site público correto;
  - aluno inicia compra pelo site público;
  - backend lê turma/preço diretamente do banco;
  - checkout cria registro em `payments`;
  - checkout cria cobrança PIX Asaas Sandbox;
  - segundo clique reaproveita cobrança `PENDING`;
  - `PAYMENT_CREATED` não libera matrícula;
  - `PAYMENT_RECEIVED`, `PAYMENT_CONFIRMED` ou equivalente normalizado libera matrícula;
  - professor visualiza nome do aluno, turma, valor, forma de pagamento, status e data;
  - notificação interna é gravada sem depender de e-mail.
- Asaas Sandbox:
  - token inválido no webhook retorna HTTP 401;
  - payload inválido retorna HTTP 400 quando autenticado;
  - webhook válido retorna HTTP 200;
  - `PAYMENT_CREATED` é gravado e não libera matrícula;
  - `PAYMENT_RECEIVED` ou `PAYMENT_CONFIRMED` libera matrícula;
  - `RECEIVED_IN_CASH` é normalizado para `RECEIVED`;
  - cobrança inexistente fica armazenada para reconciliação;
  - matrícula duplicada é impedida por `turma_id,aluno_id`;
  - API de produção não deve ser chamada com `ASAAS_ENV=sandbox`.

#### Evidência de homologação comercial — 2026-07-13

- Turma: `Homologacao Comercial 20260713-000003`.
- Preço: `R$ 5,73`.
- Cobrança Sandbox: `pay_4d2uxcz072cm1m5s`.
- `PAYMENT_CREATED`: recebido/processado, matrícula não criada.
- `PAYMENT_RECEIVED`: recebido/processado, matrícula criada.
- Aluno: login validado e turma comprada disponível.
- Professor: pagamento visível na API administrativa e no dashboard.

### E-mails

- `ENABLE_EMAILS=false` não envia e-mail real.
- Provider mock retorna status desativado.
- Resend só envia em ambiente autorizado.
