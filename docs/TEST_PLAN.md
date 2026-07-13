# Plano de Testes

Atualizado em: 2026-07-13.

## Resultado Remoto MVP — 2026-07-13

- `npm run check:all`: passou.
- `npm run smoke:prod`: passou no fallback `https://cursoreducao.slowgithub.workers.dev`.
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

## Não Verificado Automaticamente Neste Ciclo

- Corretor filho acessando somente correções atribuídas em cenário com dados reais suficientes.
- Custom domain `redacaocomestrategia.com.br`.
- Envio real via Resend.
- Cobrança Asaas de produção.
- Revogação server-side de JWT após logout.
- Smoke remoto pelo domínio oficial `https://redacaocomestrategia.com.br`, porque o custom domain ainda não está ativo.

## Validações Automatizadas Disponíveis

```bash
npm run security:scan
npm run check:public
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
