-- ============================================================
-- Redacao com Estrategia — indices de performance
-- Migration nao destrutiva. Executar em janela segura no Supabase.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_profiles_site_role_ativo
  ON public.profiles(site_id, role, ativo);

CREATE INDEX IF NOT EXISTS idx_turmas_site_status_created
  ON public.turmas(site_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_correcoes_site_status_created
  ON public.correcoes(site_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_correcoes_aluno_status_created
  ON public.correcoes(aluno_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_correcoes_site_turma_status
  ON public.correcoes(site_id, turma_id, status);

CREATE INDEX IF NOT EXISTS idx_anotacoes_correcao_created
  ON public.anotacoes(correcao_id, created_at);

CREATE INDEX IF NOT EXISTS idx_turma_alunos_site_turma_ativo
  ON public.turma_alunos(site_id, turma_id, ativo);

CREATE INDEX IF NOT EXISTS idx_turma_alunos_site_aluno_ativo
  ON public.turma_alunos(site_id, aluno_id, ativo);

CREATE INDEX IF NOT EXISTS idx_payments_site_status_created
  ON public.payments(site_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payments_site_turma_email_status
  ON public.payments(site_id, turma_id, payer_email, status);

CREATE INDEX IF NOT EXISTS idx_payment_events_provider_received
  ON public.payment_webhook_events(provider, received_at DESC);
