# Módulo financeiro interno

Atualizado em: 2026-07-13.

## Objetivo

Organizar o financeiro operacional da plataforma sem trocar a arquitetura atual. O módulo deve registrar vendas de turmas, gerar valores devidos a professores corretores filhos, permitir fechamento manual pelo professor pai e dar visão consolidada ao superadmin.

## Estado atual confirmado

- Pagamentos de alunos já usam Asaas Sandbox.
- A tabela `payments` registra venda, status, valor em centavos e vínculo com `site_id`, `turma_id` e `aluno_id`.
- A tabela `payment_webhook_events` registra webhooks e preserva idempotência por evento.
- Matrículas são liberadas apenas por estados pagos normalizados.
- Professores filhos existem hoje dentro do CMS do site em `sites.allowed_origins`, com permissões e direcionamentos por turma/aluno.
- Correções finalizadas gravam `status=FINALIZADA`, `prof_id` e `finalizada_em`.

## Endurecimento transacional — 2026-07-13

- Migration aplicada: `009_financial_transactions.sql`.
- Tabela de idempotência adicionada: `financial_idempotency_keys`.
- RPCs transacionais disponíveis:
  - `create_teacher_closing`;
  - `approve_teacher_closing`;
  - `add_teacher_closing_adjustment`;
  - `register_teacher_payout`;
  - `cancel_teacher_closing`;
  - `reverse_teacher_payout`.
- As RPCs validam `site_id`, professor pai, professor filho, status do fechamento, status dos lançamentos, saldo e chave de idempotência.
- As RPCs usam locks no banco para reduzir risco de pagamento duplicado ou fechamento concorrente.
- O frontend não calcula saldo final nem status financeiro definitivo; esses dados vêm do backend/banco.
- Exports e gráficos continuam atrás de flags desligadas.
- Validações executadas:
  - `npm run financial:smoke` criou dados fictícios `FIN_SMOKE_*` e validou fechamento idempotente, tentativa duplicada, corrida concorrente, pagamento parcial, retry de pagamento, pagamento total, bloqueio de excesso, cancelamento e estorno;
  - fluxo remoto via `/api/admin/financial/*` validou fechamento, aprovação, pagamento manual fictício e notificação interna;
  - professor pai, professor filho e superadmin acessaram endpoints financeiros com HTTP 200 no Worker publicado.

## Painel operacional e exportações — 2026-07-13

- `ENABLE_FINANCIAL_EXPORTS=true` e `ENABLE_FINANCIAL_CHARTS=true` no Worker `cursoredacao`.
- Professor pai:
  - visualiza resumo, corretores, contas a pagar, fechamentos, pagamentos e auditoria;
  - seleciona lançamentos de um mesmo corretor para criar fechamento;
  - aprova fechamento, registra ajuste, registra pagamento manual, cancela fechamento e estorna pagamento;
  - exporta CSV de contas a pagar, fechamentos, pagamentos e auditoria.
- Professor filho:
  - visualiza seus ganhos, lançamentos, fechamentos e pagamentos;
  - pode contestar lançamento ainda aguardando fechamento;
  - continua sem acesso às contas a pagar do professor pai.
- Novos endpoints:
  - `GET /api/admin/financial/teachers`;
  - `GET /api/admin/financial/export.csv?type=compensations|payables|closings|payouts|audit`.
- CSV usa `;`, UTF-8 com BOM e respeita `site_id`, papel do usuário e escopo do corretor filho.
- Validação remota:
  - professor pai: login, resumo, consolidado por corretor e CSV com HTTP 200;
  - professor filho: login, resumo e lançamentos com HTTP 200; contas a pagar bloqueadas com HTTP 403.

## Ciclo A implementado

- Feature flags adicionadas:
  - `ENABLE_FINANCIAL_MODULE`;
  - `ENABLE_TEACHER_COMPENSATION`;
  - `ENABLE_FINANCIAL_EXPORTS`;
  - `ENABLE_FINANCIAL_CHARTS`.
- Migration não destrutiva criada em `migrations/007_financial_module.sql`.
- Migration remota aplicada no Ciclo B.
- Nenhuma rota pública foi ativada neste ciclo.

## Ciclo B implementado

- Migrations aplicadas no Supabase:
  - `007_financial_module.sql`;
  - `008_financial_statuses.sql`.
- A finalização de uma correção atribuída a professor filho chama `ensureCorrectionCompensationEntry`.
- O lançamento é idempotente por `correction_id`.
- A regra usada fica congelada em `rule_snapshot_json`.
- Se não houver regra nem valor configurado para o professor filho, a entrega acadêmica da correção não é bloqueada; o sistema gera auditoria e notificação operacional.
- APIs criadas em `/api/admin/financial/*` para resumo, lançamentos, correções a pagar, fechamentos, aprovação, pagamentos manuais, auditoria e contestação.
- API superadmin criada em `/api/superadmin/financial`.
- Interface mínima adicionada:
  - `Meus Ganhos` para professor filho;
  - `Financeiro` para professor pai.
- Script dry-run criado: `npm run financial:backfill:dry-run -- --since=YYYY-MM-DD --limit=100`.
- Teste estrutural adicionado ao `npm run check:all`: `npm run check:financial`.
- As flags financeiras internas estão ativas em homologação controlada no Worker publicado; exports e gráficos continuam desligados.

## Modelo de dados preparado

- `financial_settings`: configuração financeira por site.
- `correction_compensation_rules`: regras de valor por corretor filho, turma e tipo de correção.
- `correction_compensation_entries`: lançamento único por redação corrigida.
- `teacher_payment_closings`: fechamento manual por professor filho e período.
- `teacher_payouts`: registro manual de pagamento ao professor filho.
- `financial_adjustments`: bônus, desconto, reversão e ajuste manual.
- `financial_audit_logs`: trilha de auditoria financeira.

Todos os valores monetários são armazenados em centavos.

## Regras de segurança

- O navegador nunca define valor financeiro final.
- O valor da turma vem de `turmas.preco` e o valor de correção deve vir da regra vigente no banco.
- Lançamentos financeiros não devem ser apagados; cancelamento ou reversão deve ser lógico.
- Professor filho só pode ver ganhos de correções atribuídas a ele.
- Professor pai só pode ver financeiro do próprio `site_id`.
- Superadmin pode ver o consolidado global.
- Pagamento ao professor filho é manual nesta fase; não há split Asaas nem transferência automática.

## Próximos ciclos

1. Trocar `prompt/confirm` das ações financeiras por modais dedicadas com validação visual.
2. Criar upload de comprovante de pagamento manual em R2.
3. Criar tela superadmin de divergências e reprocessamento de webhooks órfãos.
4. Ampliar testes automatizados de integração com login HTTP e cenários visuais.

## Rollback

O rollback operacional preferencial é voltar `ENABLE_FINANCIAL_MODULE=false` e `ENABLE_TEACHER_COMPENSATION=false`, fazer novo deploy e manter as tabelas/RPCs sem uso. Não fazer `DROP TABLE` nem remover RPCs em produção sem backup e janela controlada.
