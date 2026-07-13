-- Ajusta estados financeiros do módulo interno sem alterar dados existentes.

ALTER TABLE public.correction_compensation_entries
  DROP CONSTRAINT IF EXISTS correction_compensation_entries_status_check;

ALTER TABLE public.correction_compensation_entries
  ADD CONSTRAINT correction_compensation_entries_status_check
  CHECK (status IN (
    'AWAITING_CLOSING',
    'IN_CLOSING',
    'APPROVED',
    'PARTIALLY_PAID',
    'PAID',
    'CANCELED',
    'REVERSED',
    'PENDING_REVIEW',
    'DISPUTED',
    'PENDING'
  ));

ALTER TABLE public.teacher_payment_closings
  DROP CONSTRAINT IF EXISTS teacher_payment_closings_status_check;

ALTER TABLE public.teacher_payment_closings
  ADD CONSTRAINT teacher_payment_closings_status_check
  CHECK (status IN (
    'DRAFT',
    'CLOSED',
    'APPROVED',
    'PARTIALLY_PAID',
    'PAID',
    'CANCELED'
  ));

ALTER TABLE public.teacher_payouts
  ADD COLUMN IF NOT EXISTS reference TEXT;

ALTER TABLE public.teacher_payouts
  DROP CONSTRAINT IF EXISTS teacher_payouts_status_check;

ALTER TABLE public.teacher_payouts
  ADD CONSTRAINT teacher_payouts_status_check
  CHECK (status IN ('REGISTERED', 'PAID', 'CANCELED'));

CREATE INDEX IF NOT EXISTS idx_comp_entries_correction_unique
  ON public.correction_compensation_entries(correction_id);
