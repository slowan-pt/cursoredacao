# Backup

## Banco Supabase

Backup de produção deve ser feito pelo painel/CLI do Supabase antes de migrations ou mudanças estruturais.

## Git

Antes de limpar histórico:

1. Criar clone espelho local.
2. Criar bundle Git local.
3. Marcar os backups como sensíveis.
4. Não enviar backups com segredos antigos para nuvem.

## Arquivos

Uploads definitivos devem ficar no Cloudflare R2. Quando R2 estiver ativo, definir rotina de backup/retention compatível com o plano usado.
