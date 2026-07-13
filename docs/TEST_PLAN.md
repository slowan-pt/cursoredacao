# Plano de Testes

Atualizado em: 2026-07-12.

## Validações Automatizadas Disponíveis

```bash
npm run security:scan
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

### E-mails

- `ENABLE_EMAILS=false` não envia e-mail real.
- Provider mock retorna status desativado.
- Resend só envia em ambiente autorizado.
