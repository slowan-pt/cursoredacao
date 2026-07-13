# Restore

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
