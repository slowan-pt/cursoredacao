-- Redacao com Estrategia - operacoes financeiras atomicas.
-- Migration nao destrutiva: adiciona idempotencia, indices e RPCs transacionais.

CREATE TABLE IF NOT EXISTS public.financial_idempotency_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (length(trim(operation)) >= 3),
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) >= 8),
  result_json JSONB NOT NULL,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, operation, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_financial_idempotency_lookup
  ON public.financial_idempotency_keys(site_id, operation, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_comp_entries_closing_ready
  ON public.correction_compensation_entries(site_id, child_professor_id, status, closing_id)
  WHERE status = 'AWAITING_CLOSING';

CREATE INDEX IF NOT EXISTS idx_payouts_closing_status
  ON public.teacher_payouts(site_id, closing_id, status);

ALTER TABLE public.financial_idempotency_keys ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.create_teacher_closing(
  p_site_id UUID,
  p_parent_professor_id UUID,
  p_child_professor_id UUID,
  p_entry_ids UUID[],
  p_period_start DATE DEFAULT NULL,
  p_period_end DATE DEFAULT NULL,
  p_notes TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing JSONB;
  v_closing_id UUID;
  v_requested_count INTEGER;
  v_locked_count INTEGER;
  v_gross INTEGER;
  v_period_start DATE;
  v_period_end DATE;
  v_result JSONB;
BEGIN
  IF p_site_id IS NULL OR p_parent_professor_id IS NULL OR p_child_professor_id IS NULL THEN
    RAISE EXCEPTION 'Parametros obrigatorios ausentes';
  END IF;

  IF COALESCE(array_length(p_entry_ids, 1), 0) = 0 THEN
    RAISE EXCEPTION 'Informe ao menos um lancamento';
  END IF;

  SELECT count(DISTINCT item)::INTEGER INTO v_requested_count
  FROM unnest(p_entry_ids) item
  WHERE item IS NOT NULL;

  IF v_requested_count <> COALESCE(array_length(p_entry_ids, 1), 0) THEN
    RAISE EXCEPTION 'Lancamentos duplicados ou invalidos';
  END IF;

  IF COALESCE(trim(p_idempotency_key), '') <> '' THEN
    SELECT result_json INTO v_existing
    FROM public.financial_idempotency_keys
    WHERE site_id = p_site_id
      AND operation = 'create_teacher_closing'
      AND idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  PERFORM 1 FROM public.profiles
  WHERE id = p_parent_professor_id
    AND site_id = p_site_id
    AND role IN ('ADMIN', 'CORRETOR', 'SUPERADMIN')
    AND COALESCE(ativo, TRUE) = TRUE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Professor responsavel invalido para este site';
  END IF;

  PERFORM 1 FROM public.profiles
  WHERE id = p_child_professor_id
    AND site_id = p_site_id
    AND role IN ('CORRETOR', 'ADMIN')
    AND COALESCE(ativo, TRUE) = TRUE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Corretor invalido para este site';
  END IF;

  WITH locked AS (
    SELECT id, amount_cents, corrected_at
    FROM public.correction_compensation_entries
    WHERE site_id = p_site_id
      AND child_professor_id = p_child_professor_id
      AND id = ANY(p_entry_ids)
      AND status = 'AWAITING_CLOSING'
      AND closing_id IS NULL
    FOR UPDATE
  )
  SELECT count(*)::INTEGER,
         COALESCE(sum(amount_cents), 0)::INTEGER,
         COALESCE(p_period_start, min(corrected_at)::DATE, CURRENT_DATE),
         COALESCE(p_period_end, max(corrected_at)::DATE, CURRENT_DATE)
  INTO v_locked_count, v_gross, v_period_start, v_period_end
  FROM locked;

  IF v_locked_count <> v_requested_count THEN
    RAISE EXCEPTION 'Um ou mais lancamentos nao estao disponiveis para fechamento';
  END IF;

  IF v_period_end < v_period_start THEN
    RAISE EXCEPTION 'Periodo invalido';
  END IF;

  INSERT INTO public.teacher_payment_closings (
    site_id,
    child_professor_id,
    parent_professor_id,
    period_start,
    period_end,
    status,
    entries_count,
    gross_amount_cents,
    adjustments_amount_cents,
    final_amount_cents,
    notes,
    created_by,
    updated_by
  ) VALUES (
    p_site_id,
    p_child_professor_id,
    p_parent_professor_id,
    v_period_start,
    v_period_end,
    'DRAFT',
    v_locked_count,
    v_gross,
    0,
    v_gross,
    NULLIF(trim(COALESCE(p_notes, '')), ''),
    p_parent_professor_id,
    p_parent_professor_id
  )
  RETURNING id INTO v_closing_id;

  UPDATE public.correction_compensation_entries
  SET closing_id = v_closing_id,
      status = 'IN_CLOSING',
      updated_by = p_parent_professor_id,
      updated_at = now()
  WHERE site_id = p_site_id
    AND child_professor_id = p_child_professor_id
    AND id = ANY(p_entry_ids)
    AND status = 'AWAITING_CLOSING'
    AND closing_id IS NULL;

  INSERT INTO public.financial_audit_logs (
    site_id, actor_id, target_table, target_id, action, new_data_json, metadata
  ) VALUES (
    p_site_id,
    p_parent_professor_id,
    'teacher_payment_closings',
    v_closing_id,
    'CLOSING_CREATED',
    jsonb_build_object('entry_ids', p_entry_ids, 'gross_amount_cents', v_gross),
    jsonb_build_object('idempotency_key', NULLIF(p_idempotency_key, ''))
  );

  v_result := jsonb_build_object(
    'ok', true,
    'closing_id', v_closing_id,
    'status', 'DRAFT',
    'entries_count', v_locked_count,
    'gross_amount_cents', v_gross,
    'final_amount_cents', v_gross,
    'period_start', v_period_start,
    'period_end', v_period_end
  );

  IF COALESCE(trim(p_idempotency_key), '') <> '' THEN
    INSERT INTO public.financial_idempotency_keys(site_id, operation, idempotency_key, result_json, created_by)
    VALUES (p_site_id, 'create_teacher_closing', p_idempotency_key, v_result, p_parent_professor_id)
    ON CONFLICT (site_id, operation, idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_teacher_closing(
  p_site_id UUID,
  p_parent_professor_id UUID,
  p_closing_id UUID,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing JSONB;
  v_closing public.teacher_payment_closings%ROWTYPE;
  v_result JSONB;
BEGIN
  IF COALESCE(trim(p_idempotency_key), '') <> '' THEN
    SELECT result_json INTO v_existing
    FROM public.financial_idempotency_keys
    WHERE site_id = p_site_id
      AND operation = 'approve_teacher_closing'
      AND idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  SELECT * INTO v_closing
  FROM public.teacher_payment_closings
  WHERE id = p_closing_id
    AND site_id = p_site_id
    AND parent_professor_id = p_parent_professor_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fechamento nao encontrado';
  END IF;
  IF v_closing.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'Somente fechamentos em rascunho podem ser aprovados';
  END IF;

  UPDATE public.teacher_payment_closings
  SET status = 'APPROVED',
      approved_at = now(),
      updated_by = p_parent_professor_id,
      updated_at = now()
  WHERE id = p_closing_id
  RETURNING * INTO v_closing;

  UPDATE public.correction_compensation_entries
  SET status = 'APPROVED',
      approved_at = now(),
      updated_by = p_parent_professor_id,
      updated_at = now()
  WHERE site_id = p_site_id
    AND closing_id = p_closing_id
    AND status = 'IN_CLOSING';

  INSERT INTO public.financial_audit_logs(site_id, actor_id, target_table, target_id, action, new_data_json, metadata)
  VALUES (p_site_id, p_parent_professor_id, 'teacher_payment_closings', p_closing_id, 'CLOSING_APPROVED', to_jsonb(v_closing), jsonb_build_object('idempotency_key', NULLIF(p_idempotency_key, '')));

  v_result := jsonb_build_object(
    'ok', true,
    'closing_id', p_closing_id,
    'status', v_closing.status,
    'approved_at', v_closing.approved_at,
    'final_amount_cents', v_closing.final_amount_cents
  );

  IF COALESCE(trim(p_idempotency_key), '') <> '' THEN
    INSERT INTO public.financial_idempotency_keys(site_id, operation, idempotency_key, result_json, created_by)
    VALUES (p_site_id, 'approve_teacher_closing', p_idempotency_key, v_result, p_parent_professor_id)
    ON CONFLICT (site_id, operation, idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.add_teacher_closing_adjustment(
  p_site_id UUID,
  p_parent_professor_id UUID,
  p_closing_id UUID,
  p_amount_cents INTEGER,
  p_adjustment_type TEXT,
  p_reason TEXT,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing JSONB;
  v_closing public.teacher_payment_closings%ROWTYPE;
  v_adjustment_id UUID;
  v_adjustments INTEGER;
  v_final INTEGER;
  v_result JSONB;
BEGIN
  IF p_amount_cents IS NULL OR p_amount_cents = 0 THEN
    RAISE EXCEPTION 'Valor de ajuste invalido';
  END IF;
  IF COALESCE(trim(p_reason), '') = '' OR length(trim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'Informe o motivo do ajuste';
  END IF;
  IF upper(trim(p_adjustment_type)) NOT IN ('BONUS', 'DISCOUNT', 'REVERSAL', 'MANUAL') THEN
    RAISE EXCEPTION 'Tipo de ajuste invalido';
  END IF;

  IF COALESCE(trim(p_idempotency_key), '') <> '' THEN
    SELECT result_json INTO v_existing
    FROM public.financial_idempotency_keys
    WHERE site_id = p_site_id
      AND operation = 'add_teacher_closing_adjustment'
      AND idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  SELECT * INTO v_closing
  FROM public.teacher_payment_closings
  WHERE id = p_closing_id
    AND site_id = p_site_id
    AND parent_professor_id = p_parent_professor_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fechamento nao encontrado';
  END IF;
  IF v_closing.status IN ('PAID', 'CANCELED') THEN
    RAISE EXCEPTION 'Fechamento pago ou cancelado nao aceita ajustes';
  END IF;

  INSERT INTO public.financial_adjustments(site_id, closing_id, child_professor_id, amount_cents, adjustment_type, reason, created_by)
  VALUES (p_site_id, p_closing_id, v_closing.child_professor_id, p_amount_cents, upper(trim(p_adjustment_type)), trim(p_reason), p_parent_professor_id)
  RETURNING id INTO v_adjustment_id;

  SELECT COALESCE(sum(amount_cents), 0)::INTEGER
  INTO v_adjustments
  FROM public.financial_adjustments
  WHERE site_id = p_site_id
    AND closing_id = p_closing_id;

  v_final := v_closing.gross_amount_cents + v_adjustments;
  IF v_final < 0 THEN
    RAISE EXCEPTION 'Ajuste deixaria o fechamento negativo';
  END IF;

  UPDATE public.teacher_payment_closings
  SET adjustments_amount_cents = v_adjustments,
      final_amount_cents = v_final,
      updated_by = p_parent_professor_id,
      updated_at = now()
  WHERE id = p_closing_id
  RETURNING * INTO v_closing;

  INSERT INTO public.financial_audit_logs(site_id, actor_id, target_table, target_id, action, new_data_json, metadata)
  VALUES (p_site_id, p_parent_professor_id, 'financial_adjustments', v_adjustment_id, 'CLOSING_ADJUSTMENT_ADDED', jsonb_build_object('amount_cents', p_amount_cents, 'reason', p_reason), jsonb_build_object('closing_id', p_closing_id, 'idempotency_key', NULLIF(p_idempotency_key, '')));

  v_result := jsonb_build_object(
    'ok', true,
    'adjustment_id', v_adjustment_id,
    'closing_id', p_closing_id,
    'status', v_closing.status,
    'adjustments_amount_cents', v_adjustments,
    'final_amount_cents', v_final
  );

  IF COALESCE(trim(p_idempotency_key), '') <> '' THEN
    INSERT INTO public.financial_idempotency_keys(site_id, operation, idempotency_key, result_json, created_by)
    VALUES (p_site_id, 'add_teacher_closing_adjustment', p_idempotency_key, v_result, p_parent_professor_id)
    ON CONFLICT (site_id, operation, idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.register_teacher_payout(
  p_site_id UUID,
  p_parent_professor_id UUID,
  p_closing_id UUID,
  p_amount_cents INTEGER,
  p_payment_method TEXT DEFAULT 'MANUAL',
  p_reference TEXT DEFAULT NULL,
  p_notes TEXT DEFAULT NULL,
  p_paid_at TIMESTAMPTZ DEFAULT now(),
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing JSONB;
  v_closing public.teacher_payment_closings%ROWTYPE;
  v_paid_before INTEGER;
  v_paid_after INTEGER;
  v_balance_before INTEGER;
  v_next_status TEXT;
  v_payout_id UUID;
  v_result JSONB;
BEGIN
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'Valor de pagamento invalido';
  END IF;

  IF COALESCE(trim(p_idempotency_key), '') <> '' THEN
    SELECT result_json INTO v_existing
    FROM public.financial_idempotency_keys
    WHERE site_id = p_site_id
      AND operation = 'register_teacher_payout'
      AND idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  SELECT * INTO v_closing
  FROM public.teacher_payment_closings
  WHERE id = p_closing_id
    AND site_id = p_site_id
    AND parent_professor_id = p_parent_professor_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fechamento nao encontrado';
  END IF;
  IF v_closing.status NOT IN ('APPROVED', 'PARTIALLY_PAID') THEN
    RAISE EXCEPTION 'Fechamento precisa estar aprovado para pagamento';
  END IF;

  SELECT COALESCE(sum(amount_cents), 0)::INTEGER
  INTO v_paid_before
  FROM public.teacher_payouts
  WHERE site_id = p_site_id
    AND closing_id = p_closing_id
    AND status <> 'CANCELED';

  v_balance_before := v_closing.final_amount_cents - v_paid_before;
  IF p_amount_cents > v_balance_before THEN
    RAISE EXCEPTION 'Valor maior que o saldo do fechamento';
  END IF;

  INSERT INTO public.teacher_payouts(site_id, closing_id, child_professor_id, amount_cents, status, payment_method, reference, paid_at, notes, created_by, updated_by)
  VALUES (p_site_id, p_closing_id, v_closing.child_professor_id, p_amount_cents, 'PAID', COALESCE(NULLIF(trim(p_payment_method), ''), 'MANUAL'), NULLIF(trim(COALESCE(p_reference, '')), ''), COALESCE(p_paid_at, now()), NULLIF(trim(COALESCE(p_notes, '')), ''), p_parent_professor_id, p_parent_professor_id)
  RETURNING id INTO v_payout_id;

  v_paid_after := v_paid_before + p_amount_cents;
  v_next_status := CASE WHEN v_paid_after >= v_closing.final_amount_cents THEN 'PAID' ELSE 'PARTIALLY_PAID' END;

  UPDATE public.teacher_payment_closings
  SET status = v_next_status,
      paid_at = CASE WHEN v_next_status = 'PAID' THEN COALESCE(p_paid_at, now()) ELSE NULL END,
      updated_by = p_parent_professor_id,
      updated_at = now()
  WHERE id = p_closing_id
  RETURNING * INTO v_closing;

  UPDATE public.correction_compensation_entries
  SET status = CASE WHEN v_next_status = 'PAID' THEN 'PAID' ELSE 'PARTIALLY_PAID' END,
      paid_at = CASE WHEN v_next_status = 'PAID' THEN COALESCE(p_paid_at, now()) ELSE NULL END,
      updated_by = p_parent_professor_id,
      updated_at = now()
  WHERE site_id = p_site_id
    AND closing_id = p_closing_id
    AND status IN ('APPROVED', 'PARTIALLY_PAID');

  INSERT INTO public.financial_audit_logs(site_id, actor_id, target_table, target_id, action, new_data_json, metadata)
  VALUES (p_site_id, p_parent_professor_id, 'teacher_payouts', v_payout_id, 'PAYOUT_REGISTERED', jsonb_build_object('amount_cents', p_amount_cents, 'closing_status', v_next_status), jsonb_build_object('closing_id', p_closing_id, 'idempotency_key', NULLIF(p_idempotency_key, '')));

  v_result := jsonb_build_object(
    'ok', true,
    'payout_id', v_payout_id,
    'closing_id', p_closing_id,
    'amount_cents', p_amount_cents,
    'paid_amount_cents', v_paid_after,
    'remaining_amount_cents', GREATEST(0, v_closing.final_amount_cents - v_paid_after),
    'closing_status', v_next_status
  );

  IF COALESCE(trim(p_idempotency_key), '') <> '' THEN
    INSERT INTO public.financial_idempotency_keys(site_id, operation, idempotency_key, result_json, created_by)
    VALUES (p_site_id, 'register_teacher_payout', p_idempotency_key, v_result, p_parent_professor_id)
    ON CONFLICT (site_id, operation, idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_teacher_closing(
  p_site_id UUID,
  p_parent_professor_id UUID,
  p_closing_id UUID,
  p_reason TEXT,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing JSONB;
  v_closing public.teacher_payment_closings%ROWTYPE;
  v_payouts INTEGER;
  v_entries INTEGER;
  v_result JSONB;
BEGIN
  IF COALESCE(trim(p_reason), '') = '' OR length(trim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'Informe o motivo do cancelamento';
  END IF;

  IF COALESCE(trim(p_idempotency_key), '') <> '' THEN
    SELECT result_json INTO v_existing
    FROM public.financial_idempotency_keys
    WHERE site_id = p_site_id
      AND operation = 'cancel_teacher_closing'
      AND idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  SELECT * INTO v_closing
  FROM public.teacher_payment_closings
  WHERE id = p_closing_id
    AND site_id = p_site_id
    AND parent_professor_id = p_parent_professor_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fechamento nao encontrado';
  END IF;
  IF v_closing.status IN ('PAID', 'CANCELED') THEN
    RAISE EXCEPTION 'Fechamento pago ou cancelado nao pode ser cancelado por aqui';
  END IF;

  SELECT count(*)::INTEGER INTO v_payouts
  FROM public.teacher_payouts
  WHERE site_id = p_site_id
    AND closing_id = p_closing_id
    AND status <> 'CANCELED';
  IF v_payouts > 0 THEN
    RAISE EXCEPTION 'Fechamento com pagamento registrado nao pode ser cancelado';
  END IF;

  UPDATE public.correction_compensation_entries
  SET closing_id = NULL,
      status = 'AWAITING_CLOSING',
      updated_by = p_parent_professor_id,
      updated_at = now()
  WHERE site_id = p_site_id
    AND closing_id = p_closing_id
    AND status IN ('IN_CLOSING', 'APPROVED');

  GET DIAGNOSTICS v_entries = ROW_COUNT;

  UPDATE public.teacher_payment_closings
  SET status = 'CANCELED',
      canceled_at = now(),
      notes = concat_ws(E'\n', notes, 'Cancelado: ' || trim(p_reason)),
      updated_by = p_parent_professor_id,
      updated_at = now()
  WHERE id = p_closing_id
  RETURNING * INTO v_closing;

  INSERT INTO public.financial_audit_logs(site_id, actor_id, target_table, target_id, action, new_data_json, metadata)
  VALUES (p_site_id, p_parent_professor_id, 'teacher_payment_closings', p_closing_id, 'CLOSING_CANCELED', to_jsonb(v_closing), jsonb_build_object('reason', p_reason, 'released_entries', v_entries, 'idempotency_key', NULLIF(p_idempotency_key, '')));

  v_result := jsonb_build_object(
    'ok', true,
    'closing_id', p_closing_id,
    'status', 'CANCELED',
    'released_entries', v_entries
  );

  IF COALESCE(trim(p_idempotency_key), '') <> '' THEN
    INSERT INTO public.financial_idempotency_keys(site_id, operation, idempotency_key, result_json, created_by)
    VALUES (p_site_id, 'cancel_teacher_closing', p_idempotency_key, v_result, p_parent_professor_id)
    ON CONFLICT (site_id, operation, idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.reverse_teacher_payout(
  p_site_id UUID,
  p_parent_professor_id UUID,
  p_payout_id UUID,
  p_reason TEXT,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing JSONB;
  v_payout public.teacher_payouts%ROWTYPE;
  v_closing public.teacher_payment_closings%ROWTYPE;
  v_paid_after INTEGER;
  v_next_status TEXT;
  v_result JSONB;
BEGIN
  IF COALESCE(trim(p_reason), '') = '' OR length(trim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'Informe o motivo do estorno';
  END IF;

  IF COALESCE(trim(p_idempotency_key), '') <> '' THEN
    SELECT result_json INTO v_existing
    FROM public.financial_idempotency_keys
    WHERE site_id = p_site_id
      AND operation = 'reverse_teacher_payout'
      AND idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  SELECT * INTO v_payout
  FROM public.teacher_payouts
  WHERE id = p_payout_id
    AND site_id = p_site_id
    AND status <> 'CANCELED'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pagamento nao encontrado';
  END IF;

  SELECT * INTO v_closing
  FROM public.teacher_payment_closings
  WHERE id = v_payout.closing_id
    AND site_id = p_site_id
    AND parent_professor_id = p_parent_professor_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fechamento nao encontrado para este professor';
  END IF;

  UPDATE public.teacher_payouts
  SET status = 'CANCELED',
      notes = concat_ws(E'\n', notes, 'Estornado: ' || trim(p_reason)),
      updated_by = p_parent_professor_id,
      updated_at = now()
  WHERE id = p_payout_id
  RETURNING * INTO v_payout;

  SELECT COALESCE(sum(amount_cents), 0)::INTEGER
  INTO v_paid_after
  FROM public.teacher_payouts
  WHERE site_id = p_site_id
    AND closing_id = v_payout.closing_id
    AND status <> 'CANCELED';

  v_next_status := CASE WHEN v_paid_after = 0 THEN 'APPROVED'
                        WHEN v_paid_after >= v_closing.final_amount_cents THEN 'PAID'
                        ELSE 'PARTIALLY_PAID' END;

  UPDATE public.teacher_payment_closings
  SET status = v_next_status,
      paid_at = CASE WHEN v_next_status = 'PAID' THEN paid_at ELSE NULL END,
      updated_by = p_parent_professor_id,
      updated_at = now()
  WHERE id = v_payout.closing_id
  RETURNING * INTO v_closing;

  UPDATE public.correction_compensation_entries
  SET status = CASE WHEN v_next_status = 'PAID' THEN 'PAID'
                    WHEN v_next_status = 'PARTIALLY_PAID' THEN 'PARTIALLY_PAID'
                    ELSE 'APPROVED' END,
      paid_at = CASE WHEN v_next_status = 'PAID' THEN paid_at ELSE NULL END,
      updated_by = p_parent_professor_id,
      updated_at = now()
  WHERE site_id = p_site_id
    AND closing_id = v_payout.closing_id;

  INSERT INTO public.financial_audit_logs(site_id, actor_id, target_table, target_id, action, new_data_json, metadata)
  VALUES (p_site_id, p_parent_professor_id, 'teacher_payouts', p_payout_id, 'PAYOUT_REVERSED', to_jsonb(v_payout), jsonb_build_object('reason', p_reason, 'closing_id', v_payout.closing_id, 'idempotency_key', NULLIF(p_idempotency_key, '')));

  v_result := jsonb_build_object(
    'ok', true,
    'payout_id', p_payout_id,
    'closing_id', v_payout.closing_id,
    'status', 'CANCELED',
    'closing_status', v_next_status,
    'paid_amount_cents', v_paid_after,
    'remaining_amount_cents', GREATEST(0, v_closing.final_amount_cents - v_paid_after)
  );

  IF COALESCE(trim(p_idempotency_key), '') <> '' THEN
    INSERT INTO public.financial_idempotency_keys(site_id, operation, idempotency_key, result_json, created_by)
    VALUES (p_site_id, 'reverse_teacher_payout', p_idempotency_key, v_result, p_parent_professor_id)
    ON CONFLICT (site_id, operation, idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;
