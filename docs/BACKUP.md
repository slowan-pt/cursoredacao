# Backup

## Módulo financeiro

Inclua nas rotinas de backup as tabelas:

- `financial_settings`;
- `correction_compensation_rules`;
- `correction_compensation_entries`;
- `teacher_payment_closings`;
- `teacher_payouts`;
- `financial_adjustments`;
- `financial_audit_logs`.

Antes de ativar o módulo financeiro para uso real, faça um backup lógico do Supabase e guarde o dump em local seguro fora do repositório.

Atualizado em: 2026-07-13.

## Banco Supabase

Backup de produção deve ser feito pelo painel/CLI do Supabase antes de migrations ou mudanças estruturais.

## Git

Antes de limpar histórico:

1. Criar clone espelho local.
2. Criar bundle Git local.
3. Marcar os backups como sensíveis.
4. Não enviar backups com segredos antigos para nuvem.

## Arquivos

Uploads definitivos ficam no Cloudflare R2 quando `ENABLE_R2_UPLOADS=true`.

Pendência operacional:

1. Definir retenção/versionamento do bucket `redacao-uploads`.
2. Exportar metadados `storage_files` junto do backup do banco.
3. Testar restauração de um objeto fictício e validação pela rota autenticada.
