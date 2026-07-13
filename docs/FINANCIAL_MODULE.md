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
- Nenhuma migration remota foi aplicada neste ciclo.
- Nenhuma rota pública foi ativada neste ciclo.

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

1. Ciclo B: gerar `correction_compensation_entries` quando uma correção direcionada a professor filho for finalizada.
2. Ciclo C: criar API e tela `Meus ganhos` para professor filho.
3. Ciclo D: criar fechamento manual e pagamento manual no painel do professor pai.
4. Ciclo E: criar visão global do superadmin.
5. Ciclo F: adicionar CSV, gráficos e notificações internas.
6. Ciclo G: ampliar testes, auditoria e documentação.

## Rollback

Como o Ciclo A só adiciona flags e tabelas novas, o rollback operacional é manter todas as flags financeiras como `false`. Se a migration for aplicada e precisar ser removida em ambiente de desenvolvimento, remover primeiro tabelas dependentes e depois `financial_settings`. Em produção, preferir desativação por flags e não fazer `DROP TABLE` sem backup.
