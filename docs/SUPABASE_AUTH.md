# Supabase Auth Para Producao

Atualizado em: 2026-07-13.

## Estado

- Supabase Auth continua sendo a autenticacao oficial.
- Legacy API Keys ja foram desativadas.
- `SUPABASE_SERVICE_KEY` usa chave nova `sb_secret_...`.
- `SUPABASE_ANON_KEY` usa publishable key nova, mantendo nome legado da variavel para compatibilidade.
- Nao alterar JWT signing keys.

## Configuracao Manual Do Dominio

No painel Supabase:

1. Authentication.
2. URL Configuration.
3. Site URL:

```text
https://redacaocomestrategia.com.br
```

4. Redirect URLs:

```text
https://redacaocomestrategia.com.br/auth-callback.html
https://redacaocomestrategia.com.br/login.html
https://redacaocomestrategia.com.br/redacao/*
https://cursoredacao.slowgithub.workers.dev/auth-callback.html
https://cursoredacao.slowgithub.workers.dev/login.html
https://cursoredacao.slowgithub.workers.dev/redacao/*
https://cursoreducao.slowgithub.workers.dev/auth-callback.html
https://cursoreducao.slowgithub.workers.dev/login.html
https://cursoreducao.slowgithub.workers.dev/redacao/*
```

Manter o fallback `workers.dev` ate o dominio oficial estar homologado.

## Testes

- Login professor no dominio oficial.
- Login aluno no dominio oficial.
- Logout.
- Recuperacao de senha.
- Bloqueio de aluno inativo.
- Aluno tentando acessar outro site.
- Professor tentando acessar outro site.

## Riscos

- Redirect URL ausente causa falha de callback.
- Remover fallback cedo demais dificulta suporte durante a publicacao.
- Trocar JWT signing keys sem plano invalida sessoes e pode quebrar integracoes.
