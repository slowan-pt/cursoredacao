# Checklist De Lancamento

Atualizado em: 2026-07-13.

## Obrigatorio Antes De Producao

- [ ] Custom domain `redacaocomestrategia.com.br` ativo.
- [ ] `www` redirecionando para o dominio raiz.
- [ ] HTTPS valido.
- [ ] Supabase Site URL e Redirect URLs atualizadas.
- [ ] Migration `006_performance_indexes.sql` aplicada no Supabase.
- [ ] `npm run check:all` passando.
- [ ] `npm run smoke:prod` passando no dominio oficial.
- [ ] R2 validado em upload e download.
- [ ] Asaas producao configurado, mas validado com PIX real de baixo valor.
- [ ] Webhook producao validado com token.
- [ ] Rate limiting no Cloudflare WAF ou alternativa compartilhada.
- [ ] Backup Supabase revisado.
- [ ] Restore testado em ambiente seguro.
- [ ] Politica de reembolso/cancelamento aprovada.
- [ ] Termos e privacidade revisados.
- [ ] Monitoramento de logs ativo.

## Recomendado

- [ ] Resend com dominio verificado.
- [ ] Alertas para webhooks falhos.
- [ ] Analytics simples.
- [ ] Onboarding do professor.
- [ ] Teste mobile em Android/iOS.
- [ ] Plano de suporte.

## Pode Ficar Para Depois

- [ ] Boleto.
- [ ] Cartao.
- [ ] OCR.
- [ ] SSO.
- [ ] Editor visual avancado.
- [ ] Mercado Pago.
