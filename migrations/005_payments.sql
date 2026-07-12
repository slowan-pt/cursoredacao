-- ============================================================
-- Redação com Estratégia — Pagamentos e webhooks
-- Migration não destrutiva. Revisar antes de executar no Supabase.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  turma_id UUID REFERENCES public.turmas(id) ON DELETE SET NULL,
  aluno_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  payer_email TEXT NOT NULL,
  payer_name TEXT,
  provider TEXT NOT NULL DEFAULT 'ASAAS',
  provider_payment_id TEXT UNIQUE,
  provider_customer_id TEXT,
  external_reference TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'PENDING',
  amount_cents INTEGER NOT NULL DEFAULT 0,
  billing_type TEXT,
  checkout_code TEXT,
  raw_summary JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  paid_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.payment_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL DEFAULT 'ASAAS',
  provider_event_id TEXT NOT NULL,
  provider_payment_id TEXT,
  event_type TEXT NOT NULL,
  processed BOOLEAN NOT NULL DEFAULT false,
  received_at TIMESTAMPTZ DEFAULT now(),
  processed_at TIMESTAMPTZ,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS idx_payments_site ON public.payments(site_id);
CREATE INDEX IF NOT EXISTS idx_payments_aluno ON public.payments(aluno_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON public.payments(status);
CREATE INDEX IF NOT EXISTS idx_payment_events_payment ON public.payment_webhook_events(provider_payment_id);

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_webhook_events ENABLE ROW LEVEL SECURITY;
