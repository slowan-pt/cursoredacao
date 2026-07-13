# Restore

## Módulo financeiro

Após restaurar um ambiente com dados financeiros:

1. Validar contagens das tabelas `correction_compensation_entries`, `teacher_payment_closings` e `teacher_payouts`.
2. Conferir se `correction_id` continua único em `correction_compensation_entries`.
3. Rodar `npm run financial:backfill:dry-run -- --since=YYYY-MM-DD --limit=100` para identificar correções finalizadas sem lançamento.
4. Manter as flags financeiras desligadas até validar integridade e permissões.

Atualizado em: 2026-07-13.

## Código

1. Clonar o repositório autorizado.
2. Conferir branch e commit.
3. Criar `.dev.vars` com secrets válidos.
4. Rodar `npm install`.
5. Rodar `npm run check:all`.

## Banco

1. Restaurar dump validado no Supabase.
2. Conferir migrations aplicadas.
3. Validar login e leitura de perfis.

## Uploads

1. Restaurar objetos R2 se o bucket estiver ativo.
2. Validar metadados em `storage_files`.
3. Testar download autenticado.
4. Confirmar que redações excluídas continuam bloqueadas mesmo se o objeto existir no bucket.

## Pós-Restore

- Testar `/health`.
- Testar login de superadmin, professor e aluno.
- Testar isolamento entre sites.
- Testar envio e visualização de redação.
