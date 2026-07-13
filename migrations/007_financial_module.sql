-- Redação com Estratégia — módulo financeiro interno.
-- Migration não destrutiva: cria tabelas novas e índices; não altera pagamentos, matrículas ou correções existentes.

CREATE TABLE IF NOT EXISTS public.financial_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL UNIQUE REFERENCES public.sites(id) ON DELETE CASCADE,
  currency TEXT NOT NULL DEFAULT 'BRL',
  default_correction_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (default_correction_amount_cents >= 0),
  default_review_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (default_review_amount_cents >= 0),
  payment_cycle TEXT NOT NULL DEFAULT 'MANUAL' CHECK (payment_cycle IN ('MANUAL', 'WEEKLY', 'BIWEEKLY', 'MONTHLY')),
  payment_due_days INTEGER NOT NULL DEFAULT 0 CHECK (payment_due_days >= 0),
  allow_custom_correction_amount BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.correction_compensation_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  child_professor_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  turma_id UUID REFERENCES public.turmas(id) ON DELETE CASCADE,
  correction_type TEXT NOT NULL DEFAULT 'CORRECAO' CHECK (correction_type IN ('CORRECAO', 'REVISAO')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  valid_from DATE NOT NULL DEFAULT CURRENT_DATE,
  valid_until DATE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  priority INTEGER NOT NULL DEFAULT 100,
  notes TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (valid_until IS NULL OR valid_until >= valid_from)
);

CREATE TABLE IF NOT EXISTS public.teacher_payment_closings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  child_professor_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  parent_professor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'CLOSED', 'APPROVED', 'PAID', 'CANCELED')),
  entries_count INTEGER NOT NULL DEFAULT 0 CHECK (entries_count >= 0),
  gross_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (gross_amount_cents >= 0),
  adjustments_amount_cents INTEGER NOT NULL DEFAULT 0,
  final_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (final_amount_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'BRL',
  closed_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  canceled_at TIMESTAMPTZ,
  notes TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);

CREATE TABLE IF NOT EXISTS public.correction_compensation_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  correction_id UUID NOT NULL REFERENCES public.correcoes(id) ON DELETE RESTRICT,
  child_professor_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  parent_professor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  aluno_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  turma_id UUID REFERENCES public.turmas(id) ON DELETE SET NULL,
  rule_id UUID REFERENCES public.correction_compensation_rules(id) ON DELETE SET NULL,
  closing_id UUID REFERENCES public.teacher_payment_closings(id) ON DELETE SET NULL,
  correction_type TEXT NOT NULL DEFAULT 'CORRECAO' CHECK (correction_type IN ('CORRECAO', 'REVISAO')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'IN_CLOSING', 'PAID', 'CANCELED', 'REVERSED')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'BRL',
  assigned_at TIMESTAMPTZ,
  corrected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  canceled_at TIMESTAMPTZ,
  cancel_reason TEXT,
  rule_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (correction_id)
);

CREATE TABLE IF NOT EXISTS public.teacher_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  closing_id UUID NOT NULL REFERENCES public.teacher_payment_closings(id) ON DELETE RESTRICT,
  child_professor_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'BRL',
  status TEXT NOT NULL DEFAULT 'REGISTERED' CHECK (status IN ('REGISTERED', 'PAID', 'CANCELED')),
  payment_method TEXT,
  paid_at TIMESTAMPTZ,
  receipt_url TEXT,
  notes TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.financial_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  closing_id UUID REFERENCES public.teacher_payment_closings(id) ON DELETE CASCADE,
  child_professor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'BRL',
  adjustment_type TEXT NOT NULL CHECK (adjustment_type IN ('BONUS', 'DISCOUNT', 'REVERSAL', 'MANUAL')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) >= 3),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.financial_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID REFERENCES public.sites(id) ON DELETE SET NULL,
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  target_table TEXT NOT NULL,
  target_id UUID,
  action TEXT NOT NULL,
  previous_data_json JSONB,
  new_data_json JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_financial_settings_site
  ON public.financial_settings(site_id);

CREATE INDEX IF NOT EXISTS idx_comp_rules_site_child_active
  ON public.correction_compensation_rules(site_id, child_professor_id, active, priority);

CREATE INDEX IF NOT EXISTS idx_comp_rules_site_turma_active
  ON public.correction_compensation_rules(site_id, turma_id, active, priority);

CREATE INDEX IF NOT EXISTS idx_comp_entries_site_status
  ON public.correction_compensation_entries(site_id, status, corrected_at DESC);

CREATE INDEX IF NOT EXISTS idx_comp_entries_child_status
  ON public.correction_compensation_entries(child_professor_id, status, corrected_at DESC);

CREATE INDEX IF NOT EXISTS idx_comp_entries_closing
  ON public.correction_compensation_entries(closing_id);

CREATE INDEX IF NOT EXISTS idx_closings_site_child_status
  ON public.teacher_payment_closings(site_id, child_professor_id, status, period_end DESC);

CREATE INDEX IF NOT EXISTS idx_payouts_closing
  ON public.teacher_payouts(closing_id);

CREATE INDEX IF NOT EXISTS idx_adjustments_closing
  ON public.financial_adjustments(closing_id);

CREATE INDEX IF NOT EXISTS idx_financial_audit_site_created
  ON public.financial_audit_logs(site_id, created_at DESC);

ALTER TABLE public.financial_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.correction_compensation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.correction_compensation_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teacher_payment_closings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teacher_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_audit_logs ENABLE ROW LEVEL SECURITY;
