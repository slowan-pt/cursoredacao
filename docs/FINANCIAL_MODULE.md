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
- As flags continuam desligadas por padrão em `wrangler.jsonc`; menus financeiros só aparecem quando `ENABLE_FINANCIAL_MODULE=true`.

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

1. Validar com dados reais uma correção finalizada por professor filho com flags financeiras ligadas em homologação.
2. Migrar criação/aprovação/pagamento de fechamento para RPC SQL transacional.
3. Criar tela completa de seleção múltipla de lançamentos.
4. Criar upload de comprovante de pagamento manual em R2.
5. Adicionar exportação CSV e alertas superadmin de divergência.
6. Criar testes de integração com dados controlados.

## Rollback

Como o Ciclo A só adiciona flags e tabelas novas, o rollback operacional é manter todas as flags financeiras como `false`. Se a migration for aplicada e precisar ser removida em ambiente de desenvolvimento, remover primeiro tabelas dependentes e depois `financial_settings`. Em produção, preferir desativação por flags e não fazer `DROP TABLE` sem backup.
