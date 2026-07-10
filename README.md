# Redacao

Plataforma multi-site para professores de redacao, com area publica por professor, login de alunos, turmas, matriculas, envio de redacoes, correcao e painel administrativo.

## Desenvolvimento

```bash
npm install
npm run dev
```

## Deploy

```bash
npm run deploy
```

## Variaveis locais

Crie um arquivo `.dev.vars` local com as credenciais do Supabase e o segredo de sessao. Esse arquivo nao deve ser versionado.
Use `.env.example` como referencia das variaveis obrigatorias e feature flags.

## Seguranca inicial

Rotas que precisam de limite de requisicoes antes do lancamento publico:

- `/api/auth/login`
- `/api/auth/register`
- `/api/auth/forgot-password`
- `/api/auth/oauth-session`
- `/api/site/:slug/checkout`
- `/api/aluno/correcoes`

O projeto possui apenas uma interface/middleware placeholder para rate limiting. A protecao efetiva deve ser feita com Cloudflare Rate Limiting, Durable Objects ou solucao equivalente.
