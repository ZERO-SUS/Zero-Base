-- ============================================================================
-- ZERO BASE — 0004_reporting_and_search_functions.sql
-- SECURITY INVOKER RPC functions (preserve RLS) for dashboard, reports, search
-- ============================================================================

-- 1. Dashboard summary metrics in Asia/Kolkata timezone
CREATE OR REPLACE FUNCTION public.get_dashboard_metrics()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_today DATE := public.ist_today();
  v_month_start DATE := date_trunc('month', v_today)::date;
  v_year_start DATE := date_trunc('year', v_today)::date;
  v_result JSONB;
BEGIN
  IF NOT public.is_active_staff() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT jsonb_build_object(
    'today_ist', v_today,
    'total_customers', (
      SELECT COUNT(*) FROM public.customers WHERE archived_at IS NULL
    ),
    'total_services', (
      SELECT COUNT(*) FROM public.services WHERE archived_at IS NULL
    ),
    'services_this_month', (
      SELECT COUNT(*) FROM public.services
      WHERE archived_at IS NULL AND service_date >= v_month_start AND service_date <= v_today + INTERVAL '31 days'
        AND date_trunc('month', service_date)::date = v_month_start
    ),
    'services_this_year', (
      SELECT COUNT(*) FROM public.services
      WHERE archived_at IS NULL AND date_trunc('year', service_date)::date = v_year_start
    ),
    'todays_services', (
      SELECT COUNT(*) FROM public.services
      WHERE archived_at IS NULL AND service_date = v_today
    ),
    'upcoming_reminders', (
      SELECT COUNT(*) FROM public.reminders
      WHERE archived_at IS NULL AND status = 'active' AND due_date > v_today
    ),
    'due_today', (
      SELECT COUNT(*) FROM public.reminders
      WHERE archived_at IS NULL AND status = 'active' AND due_date = v_today
    ),
    'overdue_services', (
      SELECT COUNT(*) FROM public.reminders
      WHERE archived_at IS NULL AND status = 'active' AND due_date < v_today
    ),
    'pending_payments_amount', (
      SELECT COALESCE(SUM(GREATEST(0, total_amount - amount_paid)), 0)
      FROM public.services
      WHERE archived_at IS NULL AND payment_status IN ('Unpaid', 'Partially Paid')
    ),
    'pending_payments_count', (
      SELECT COUNT(*)
      FROM public.services
      WHERE archived_at IS NULL AND payment_status IN ('Unpaid', 'Partially Paid')
    ),
    'revenue_this_month', (
      SELECT COALESCE(SUM(
        CASE WHEN p.payment_type = 'payment' THEN p.amount
             WHEN p.payment_type = 'refund' THEN -p.amount
             ELSE 0 END
      ), 0)
      FROM public.payments p
      JOIN public.services s ON s.service_id = p.service_id
      WHERE p.archived_at IS NULL AND s.archived_at IS NULL
        AND date_trunc('month', p.payment_date)::date = v_month_start
    ),
    'revenue_this_year', (
      SELECT COALESCE(SUM(
        CASE WHEN p.payment_type = 'payment' THEN p.amount
             WHEN p.payment_type = 'refund' THEN -p.amount
             ELSE 0 END
      ), 0)
      FROM public.payments p
      JOIN public.services s ON s.service_id = p.service_id
      WHERE p.archived_at IS NULL AND s.archived_at IS NULL
        AND date_trunc('year', p.payment_date)::date = v_year_start
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- 2. Duplicate customer lookup by exact or normalized phone digits
CREATE OR REPLACE FUNCTION public.find_duplicate_customers(p_phone TEXT)
RETURNS TABLE (
  customer_id UUID,
  full_name TEXT,
  primary_phone TEXT,
  secondary_phone TEXT,
  address TEXT,
  locality TEXT,
  archived_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    c.customer_id,
    c.full_name,
    c.primary_phone,
    c.secondary_phone,
    c.address,
    c.locality,
    c.archived_at
  FROM public.customers c
  WHERE public.is_active_staff()
    AND (
      c.primary_phone = trim(p_phone)
      OR c.secondary_phone = trim(p_phone)
      OR (
        length(public.normalize_phone_digits(p_phone)) >= 6
        AND (
          public.normalize_phone_digits(c.primary_phone) = public.normalize_phone_digits(p_phone)
          OR public.normalize_phone_digits(COALESCE(c.secondary_phone, '')) = public.normalize_phone_digits(p_phone)
          OR right(public.normalize_phone_digits(c.primary_phone), 10) = right(public.normalize_phone_digits(p_phone), 10)
          OR (
            c.secondary_phone IS NOT NULL
            AND right(public.normalize_phone_digits(c.secondary_phone), 10) = right(public.normalize_phone_digits(p_phone), 10)
          )
        )
      )
    )
  ORDER BY c.archived_at NULLS FIRST, c.created_at DESC;
$$;

-- 3. Reports analytics for any date range
CREATE OR REPLACE FUNCTION public.get_reports_summary(p_start_date DATE, p_end_date DATE)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_services_agg JSONB;
  v_payments_agg JSONB;
  v_breakdown JSONB;
BEGIN
  IF NOT public.is_active_staff() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT jsonb_build_object(
    'total_services', COUNT(*),
    'total_billed', COALESCE(SUM(total_amount), 0),
    'outstanding_balance', COALESCE(SUM(GREATEST(0, total_amount - amount_paid)), 0)
  ) INTO v_services_agg
  FROM public.services
  WHERE archived_at IS NULL
    AND service_date >= p_start_date
    AND service_date <= p_end_date;

  SELECT jsonb_build_object(
    'total_collected', COALESCE(SUM(CASE WHEN payment_type = 'payment' THEN amount ELSE -amount END), 0),
    'cash_payments', COALESCE(SUM(CASE WHEN payment_method = 'Cash' THEN (CASE WHEN payment_type = 'payment' THEN amount ELSE -amount END) ELSE 0 END), 0),
    'upi_payments', COALESCE(SUM(CASE WHEN payment_method = 'UPI' THEN (CASE WHEN payment_type = 'payment' THEN amount ELSE -amount END) ELSE 0 END), 0),
    'other_payments', COALESCE(SUM(CASE WHEN payment_method = 'Other' THEN (CASE WHEN payment_type = 'payment' THEN amount ELSE -amount END) ELSE 0 END), 0)
  ) INTO v_payments_agg
  FROM public.payments p
  JOIN public.services s ON s.service_id = p.service_id
  WHERE p.archived_at IS NULL
    AND s.archived_at IS NULL
    AND p.payment_date >= p_start_date
    AND p.payment_date <= p_end_date;

  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) INTO v_breakdown
  FROM (
    SELECT
      service_type,
      COUNT(*) AS service_count,
      COALESCE(SUM(total_amount), 0) AS total_billed,
      COALESCE(SUM(amount_paid), 0) AS total_paid,
      COALESCE(SUM(GREATEST(0, total_amount - amount_paid)), 0) AS outstanding
    FROM public.services
    WHERE archived_at IS NULL
      AND service_date >= p_start_date
      AND service_date <= p_end_date
    GROUP BY service_type
    ORDER BY service_count DESC, total_billed DESC
  ) t;

  RETURN jsonb_build_object(
    'start_date', p_start_date,
    'end_date', p_end_date,
    'total_services', (v_services_agg->>'total_services')::int,
    'total_billed', (v_services_agg->>'total_billed')::numeric,
    'outstanding_balance', (v_services_agg->>'outstanding_balance')::numeric,
    'total_collected', (v_payments_agg->>'total_collected')::numeric,
    'cash_payments', (v_payments_agg->>'cash_payments')::numeric,
    'upi_payments', (v_payments_agg->>'upi_payments')::numeric,
    'other_payments', (v_payments_agg->>'other_payments')::numeric,
    'service_type_breakdown', v_breakdown
  );
END;
$$;
