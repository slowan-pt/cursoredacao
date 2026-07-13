# Rate Limiting

Atualizado em: 2026-07-13.

## Estado

- Nao ha protecao global efetiva implementada no codigo da aplicacao.
- `ENABLE_APP_RATE_LIMITING=false` deve permanecer assim ate existir um mecanismo compartilhado.
- O arquivo `src/rateLimit.ts` existe apenas como ponto de extensao para uma solucao real.
- Nao usar `Map`, variavel global ou memoria local do Worker como controle definitivo, porque instancias de Cloudflare Workers nao compartilham estado de forma confiavel.

## Rotas Prioritarias

- `POST /api/auth/login`
- `POST /api/auth/register`
- recuperacao de senha, quando exposta pelo backend
- checkout publico de turma
- criacao de cobranca Asaas
- `POST /api/payments/asaas/webhook`
- uploads de redacao
- rotas administrativas sensiveis

## Opcao Recomendada Para Primeira Producao

1. Cloudflare Dashboard.
2. Security.
3. WAF.
4. Rate limiting rules.
5. Criar regras por metodo, caminho e IP.
6. Comecar em modo log/monitoramento.
7. Depois aplicar bloqueio/desafio apenas nos endpoints de abuso claro.

## Regras Sugeridas Iniciais

| Rota | Limite sugerido | Janela | Acao inicial | Excecoes/observacoes |
| --- | --- | --- | --- | --- |
| `/api/auth/login` | 10 tentativas | 1 minuto por IP | Log, depois challenge/bloqueio | Atenção a redes corporativas/NAT |
| `/api/auth/register` | 5 tentativas | 1 minuto por IP | Log, depois challenge | Permitir professores/alunos legítimos |
| recuperação de senha | 5 tentativas | 10 minutos por IP/e-mail | Log, depois challenge | Evitar enumeração de usuário |
| checkout público | 10 tentativas | 1 minuto por IP | Log, depois challenge | Não bloquear retorno de pagamento |
| criação de cobrança | 5 tentativas | 5 minutos por IP/e-mail | Log, depois challenge | Idempotência por cobrança pendente |
| upload de redação | 20 tentativas | 10 minutos por usuário/IP | Log, depois bloqueio temporário | Considerar tamanho do arquivo |
| webhook Asaas | validar token; 60 requisições | 1 minuto por IP/origem | Log | Não bloquear eventos legítimos sem monitorar |
| rotas administrativas sensíveis | 60 requisições | 1 minuto por usuário/IP | Log, depois challenge | Superadmin/professor podem operar em lote |

## Configuração Manual Cloudflare

1. Cloudflare Dashboard.
2. Security.
3. WAF.
4. Rate limiting rules.
5. Criar uma regra por grupo de rotas.
6. Começar com ação `Log`.
7. Revisar falsos positivos por pelo menos um ciclo de homologação.
8. Trocar para `Managed Challenge` ou bloqueio temporário apenas onde houver abuso claro.

## Durable Objects

Durable Objects podem ser usados depois para limites por usuario, email ou site, com armazenamento consistente e decisoes no proprio Worker.

Nao implementar essa alternativa sem testes dedicados, porque ela muda a arquitetura operacional e cria um componente stateful novo.

## Criterio Para Ativar `ENABLE_APP_RATE_LIMITING`

- Solucao compartilhada definida.
- Testes de login, cadastro, checkout, webhook e upload.
- Mensagens de erro amigaveis.
- Runbook de desbloqueio.
- Monitoramento de falsos positivos.
