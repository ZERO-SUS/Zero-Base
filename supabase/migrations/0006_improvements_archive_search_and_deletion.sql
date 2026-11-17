-- ============================================================================
-- ZERO BASE — 0006_improvements_archive_search_and_deletion.sql
-- Backward-compatible migration adding:
--   1. Updated attachment categories & reminder 'cancelled' status
--   2. Search trigram indexes on services
--   3. Enhanced get_dashboard_metrics (billed vs collected)
--   4. find_similar_customers duplicate detection
--   5. Atomic create_unified_service RPC
--   6. Safe transactional permanently_delete_service & permanently_delete_customer RPCs
--   7. Server-side paginated global search_records RPC
-- ============================================================================

-- 1. Expand service_files.category constraint cleanly (preserving existing values)
ALTER TABLE public.service_files DROP CONSTRAINT IF EXISTS service_files_category_check;
ALTER TABLE public.service_files ADD CONSTRAINT service_files_category_check CHECK (
  category IN (
    'Bills / Invoices',
    'UPI Transaction Screenshots',
    'Before-Service Area Photos',
    'After-Service Area Photos',
    'Other Attachments',
    'Bill photos',
    'UPI transaction screenshots',
    'Before-cleaning photos',
    'After-cleaning photos',
    'Tank photos',
    'Hose photos',
    'Work-area photos',
    'Other attachments'
  )
);

-- 2. Expand reminders.status to explicitly support 'cancelled'
ALTER TABLE public.reminders DROP CONSTRAINT IF EXISTS reminders_status_check;
ALTER TABLE public.reminders ADD CONSTRAINT reminders_status_check CHECK (
  status IN ('active', 'contacted', 'confirmed', 'snoozed', 'dismissed', 'cancelled', 'completed')
);

DROP INDEX IF EXISTS public.idx_reminders_unique_service_due;
CREATE UNIQUE INDEX idx_reminders_unique_service_due
  ON public.reminders(service_id, due_date)
  WHERE service_id IS NOT NULL AND archived_at IS NULL AND status NOT IN ('dismissed', 'cancelled');

-- Expand audit_logs.action to support PERMANENT_DELETE
ALTER TABLE public.audit_logs DROP CONSTRAINT IF EXISTS audit_logs_action_check;
ALTER TABLE public.audit_logs ADD CONSTRAINT audit_logs_action_check CHECK (
  action IN (
    'INSERT', 'UPDATE', 'ARCHIVE', 'RESTORE',
    'DELETE_FILE', 'PERMANENT_DELETE', 'AUTH', 'BACKUP', 'STORAGE_CLEANUP'
  )
);

-- 3. Additional trigram indexes for fast global search on services
CREATE INDEX IF NOT EXISTS idx_services_notes_trgm
  ON public.services USING gin (COALESCE(notes, '') gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_services_description_trgm
  ON public.services USING gin (COALESCE(description, '') gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_services_type_trgm
  ON public.services USING gin (service_type gin_trgm_ops);

-- 4. Enhanced Dashboard Metrics (distinguishing total billed vs collected)
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
  IF NOT public.is_authorized_owner() THEN
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
      WHERE archived_at IS NULL
        AND date_trunc('month', service_date)::date = v_month_start
    ),
    'services_this_year', (
      SELECT COUNT(*) FROM public.services
      WHERE archived_at IS NULL
        AND date_trunc('year', service_date)::date = v_year_start
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
    'total_recorded_revenue', (
      SELECT COALESCE(SUM(total_amount), 0)
      FROM public.services
      WHERE archived_at IS NULL
    ),
    'total_collected_payments', (
      SELECT COALESCE(SUM(
        CASE WHEN p.payment_type = 'payment' THEN p.amount
             WHEN p.payment_type = 'refund' THEN -p.amount
             ELSE 0 END
      ), 0)
      FROM public.payments p
      JOIN public.services s ON s.id = p.service_id
      WHERE p.archived_at IS NULL AND s.archived_at IS NULL
    ),
    'pending_payments_amount', (
      SELECT COALESCE(SUM(balance_amount), 0)
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
      JOIN public.services s ON s.id = p.service_id
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
      JOIN public.services s ON s.id = p.service_id
      WHERE p.archived_at IS NULL AND s.archived_at IS NULL
        AND date_trunc('year', p.payment_date)::date = v_year_start
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- 5. Intelligent duplicate customer detection (phone strongest signal + optional name/address)
CREATE OR REPLACE FUNCTION public.find_similar_customers(
  p_phone TEXT DEFAULT '',
  p_alt_phone TEXT DEFAULT '',
  p_name TEXT DEFAULT '',
  p_address TEXT DEFAULT ''
)
RETURNS TABLE (
  id UUID,
  customer_code TEXT,
  full_name TEXT,
  phone_number TEXT,
  alternate_phone TEXT,
  address TEXT,
  area TEXT,
  archived_at TIMESTAMPTZ,
  match_reason TEXT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH inputs AS (
    SELECT
      trim(COALESCE(p_phone, '')) AS raw_phone,
      public.normalize_phone_digits(p_phone) AS norm_phone,
      trim(COALESCE(p_alt_phone, '')) AS raw_alt,
      public.normalize_phone_digits(p_alt_phone) AS norm_alt,
      lower(regexp_replace(trim(COALESCE(p_name, '')), '\s+', ' ', 'g')) AS norm_name,
      lower(regexp_replace(trim(COALESCE(p_address, '')), '\s+', ' ', 'g')) AS norm_addr
  )
  SELECT
    c.id,
    c.customer_code,
    c.full_name,
    c.phone_number,
    c.alternate_phone,
    c.address,
    c.area,
    c.archived_at,
    CASE
      WHEN i.norm_phone <> '' AND length(i.norm_phone) >= 6 AND (
        right(public.normalize_phone_digits(c.phone_number), 10) = right(i.norm_phone, 10)
        OR right(public.normalize_phone_digits(COALESCE(c.alternate_phone, '')), 10) = right(i.norm_phone, 10)
      ) THEN 'Matching phone number'
      WHEN i.norm_alt <> '' AND length(i.norm_alt) >= 6 AND (
        right(public.normalize_phone_digits(c.phone_number), 10) = right(i.norm_alt, 10)
        OR right(public.normalize_phone_digits(COALESCE(c.alternate_phone, '')), 10) = right(i.norm_alt, 10)
      ) THEN 'Matching alternate phone'
      ELSE 'Similar name & address'
    END AS match_reason
  FROM public.customers c
  CROSS JOIN inputs i
  WHERE public.is_authorized_owner()
    AND (
      (i.raw_phone <> '' AND (c.phone_number = i.raw_phone OR c.alternate_phone = i.raw_phone))
      OR (
        length(i.norm_phone) >= 6 AND (
          public.normalize_phone_digits(c.phone_number) = i.norm_phone
          OR public.normalize_phone_digits(COALESCE(c.alternate_phone, '')) = i.norm_phone
          OR right(public.normalize_phone_digits(c.phone_number), 10) = right(i.norm_phone, 10)
          OR (c.alternate_phone IS NOT NULL AND right(public.normalize_phone_digits(c.alternate_phone), 10) = right(i.norm_phone, 10))
        )
      )
      OR (
        length(i.norm_alt) >= 6 AND (
          public.normalize_phone_digits(c.phone_number) = i.norm_alt
          OR public.normalize_phone_digits(COALESCE(c.alternate_phone, '')) = i.norm_alt
          OR right(public.normalize_phone_digits(c.phone_number), 10) = right(i.norm_alt, 10)
          OR (c.alternate_phone IS NOT NULL AND right(public.normalize_phone_digits(c.alternate_phone), 10) = right(i.norm_alt, 10))
        )
      )
      OR (
        length(i.norm_name) >= 4
        AND length(i.norm_addr) >= 5
        AND lower(regexp_replace(c.full_name, '\s+', ' ', 'g')) = i.norm_name
        AND similarity(lower(c.address), i.norm_addr) > 0.55
      )
    )
  ORDER BY c.archived_at NULLS FIRST, c.created_at DESC
  LIMIT 10;
$$;

-- 6. Atomic Unified Customer + Service + Initial Payment + Optional Reminder creation
CREATE OR REPLACE FUNCTION public.create_unified_service(
  p_customer_id UUID DEFAULT NULL,
  p_customer_full_name TEXT DEFAULT NULL,
  p_customer_phone TEXT DEFAULT NULL,
  p_customer_alt_phone TEXT DEFAULT NULL,
  p_customer_address TEXT DEFAULT NULL,
  p_customer_area TEXT DEFAULT NULL,
  p_customer_notes TEXT DEFAULT NULL,
  p_service_date DATE DEFAULT NULL,
  p_service_type TEXT DEFAULT NULL,
  p_tank_details TEXT DEFAULT NULL,
  p_description TEXT DEFAULT NULL,
  p_price NUMERIC DEFAULT 0,
  p_discount NUMERIC DEFAULT 0,
  p_notes TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL,
  p_payment_amount NUMERIC DEFAULT NULL,
  p_payment_method TEXT DEFAULT NULL,
  p_payment_ref TEXT DEFAULT NULL,
  p_payment_date DATE DEFAULT NULL,
  p_reminder_enabled BOOLEAN DEFAULT false,
  p_reminder_date DATE DEFAULT NULL,
  p_reminder_type TEXT DEFAULT 'service_due',
  p_reminder_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_customer public.customers%ROWTYPE;
  v_service public.services%ROWTYPE;
  v_reminder public.reminders%ROWTYPE;
  v_existing_service public.services%ROWTYPE;
BEGIN
  IF NOT public.is_authorized_owner() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing_service
    FROM public.services
    WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      SELECT * INTO v_customer FROM public.customers WHERE id = v_existing_service.customer_id;
      RETURN jsonb_build_object(
        'customer', to_jsonb(v_customer),
        'service', to_jsonb(v_existing_service),
        'deduplicated', true
      );
    END IF;
  END IF;

  IF p_customer_id IS NOT NULL THEN
    SELECT * INTO v_customer FROM public.customers WHERE id = p_customer_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Customer not found';
    END IF;
    IF v_customer.archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot add a service to an archived customer';
    END IF;
  ELSE
    INSERT INTO public.customers (
      full_name, phone_number, alternate_phone, address, area, notes, created_by, updated_by
    ) VALUES (
      trim(p_customer_full_name),
      trim(p_customer_phone),
      NULLIF(trim(COALESCE(p_customer_alt_phone, '')), ''),
      trim(p_customer_address),
      NULLIF(trim(COALESCE(p_customer_area, '')), ''),
      NULLIF(trim(COALESCE(p_customer_notes, '')), ''),
      v_uid,
      v_uid
    )
    RETURNING * INTO v_customer;
  END IF;

  INSERT INTO public.services (
    customer_id,
    service_date,
    service_type,
    tank_details,
    description,
    price,
    discount,
    next_due_date,
    notes,
    idempotency_key,
    created_by,
    updated_by
  ) VALUES (
    v_customer.id,
    p_service_date,
    trim(p_service_type),
    NULLIF(trim(COALESCE(p_tank_details, '')), ''),
    NULLIF(trim(COALESCE(p_description, '')), ''),
    p_price,
    COALESCE(p_discount, 0),
    CASE WHEN p_reminder_enabled THEN p_reminder_date ELSE NULL END,
    NULLIF(trim(COALESCE(p_notes, '')), ''),
    p_idempotency_key,
    v_uid,
    v_uid
  )
  RETURNING * INTO v_service;

  IF p_payment_amount IS NOT NULL AND p_payment_amount > 0 THEN
    INSERT INTO public.payments (
      service_id,
      customer_id,
      amount,
      payment_type,
      payment_method,
      reference_number,
      payment_date,
      idempotency_key,
      created_by
    ) VALUES (
      v_service.id,
      v_customer.id,
      p_payment_amount,
      'payment',
      COALESCE(p_payment_method, 'Cash'),
      NULLIF(trim(COALESCE(p_payment_ref, '')), ''),
      COALESCE(p_payment_date, p_service_date),
      CASE WHEN p_idempotency_key IS NOT NULL THEN p_idempotency_key || ':initial-payment' ELSE NULL END,
      v_uid
    );
    SELECT * INTO v_service FROM public.services WHERE id = v_service.id;
  END IF;

  IF p_reminder_enabled AND p_reminder_date IS NOT NULL THEN
    -- Update trigger-created reminder or insert with custom type/notes
    UPDATE public.reminders
    SET reminder_type = COALESCE(p_reminder_type, 'service_due'),
        notes = NULLIF(trim(COALESCE(p_reminder_notes, '')), ''),
        updated_by = v_uid
    WHERE service_id = v_service.id
      AND archived_at IS NULL
    RETURNING * INTO v_reminder;

    IF NOT FOUND THEN
      INSERT INTO public.reminders (
        service_id, customer_id, due_date, reminder_type, status, notes, created_by, updated_by
      ) VALUES (
        v_service.id,
        v_customer.id,
        p_reminder_date,
        COALESCE(p_reminder_type, 'service_due'),
        'active',
        NULLIF(trim(COALESCE(p_reminder_notes, '')), ''),
        v_uid,
        v_uid
      )
      ON CONFLICT DO NOTHING
      RETURNING * INTO v_reminder;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'customer', to_jsonb(v_customer),
    'service', to_jsonb(v_service),
    'reminder', CASE WHEN v_reminder.id IS NOT NULL THEN to_jsonb(v_reminder) ELSE NULL END,
    'deduplicated', false
  );
END;
$$;

-- 7. Safe transactional permanent deletion RPCs (return storage_paths for bucket cleanup)
CREATE OR REPLACE FUNCTION public.permanently_delete_service(p_service_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_email TEXT;
  v_srv public.services%ROWTYPE;
  v_paths TEXT[];
  v_pay_count INT;
  v_rem_count INT;
BEGIN
  IF NOT public.is_authorized_owner() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT * INTO v_srv FROM public.services WHERE id = p_service_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Service record not found';
  END IF;

  SELECT email INTO v_email FROM public.profiles WHERE id = v_uid;

  SELECT COALESCE(array_agg(storage_path), ARRAY[]::TEXT[])
  INTO v_paths
  FROM public.service_files
  WHERE service_id = p_service_id;

  DELETE FROM public.service_files WHERE service_id = p_service_id;
  DELETE FROM public.reminders WHERE service_id = p_service_id;
  GET DIAGNOSTICS v_rem_count = ROW_COUNT;
  DELETE FROM public.payments WHERE service_id = p_service_id;
  GET DIAGNOSTICS v_pay_count = ROW_COUNT;
  DELETE FROM public.services WHERE id = p_service_id;

  INSERT INTO public.audit_logs (
    actor_id, actor_email, action, entity_type, entity_id, old_values, metadata
  ) VALUES (
    v_uid,
    v_email,
    'PERMANENT_DELETE',
    'services',
    p_service_id,
    to_jsonb(v_srv),
    jsonb_build_object(
      'deleted_payments', v_pay_count,
      'deleted_reminders', v_rem_count,
      'deleted_files_count', COALESCE(array_length(v_paths, 1), 0)
    )
  );

  RETURN jsonb_build_object(
    'deleted_service_id', p_service_id,
    'storage_paths', to_jsonb(v_paths),
    'deleted_payments', v_pay_count,
    'deleted_reminders', v_rem_count
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.permanently_delete_customer(p_customer_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_email TEXT;
  v_cust public.customers%ROWTYPE;
  v_paths TEXT[];
  v_srv_count INT;
  v_pay_count INT;
  v_rem_count INT;
BEGIN
  IF NOT public.is_authorized_owner() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT * INTO v_cust FROM public.customers WHERE id = p_customer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found';
  END IF;

  SELECT email INTO v_email FROM public.profiles WHERE id = v_uid;

  SELECT COALESCE(array_agg(storage_path), ARRAY[]::TEXT[])
  INTO v_paths
  FROM public.service_files
  WHERE customer_id = p_customer_id;

  DELETE FROM public.service_files WHERE customer_id = p_customer_id;
  DELETE FROM public.reminders WHERE customer_id = p_customer_id;
  GET DIAGNOSTICS v_rem_count = ROW_COUNT;
  DELETE FROM public.payments WHERE customer_id = p_customer_id;
  GET DIAGNOSTICS v_pay_count = ROW_COUNT;
  DELETE FROM public.services WHERE customer_id = p_customer_id;
  GET DIAGNOSTICS v_srv_count = ROW_COUNT;
  DELETE FROM public.customers WHERE id = p_customer_id;

  INSERT INTO public.audit_logs (
    actor_id, actor_email, action, entity_type, entity_id, old_values, metadata
  ) VALUES (
    v_uid,
    v_email,
    'PERMANENT_DELETE',
    'customers',
    p_customer_id,
    to_jsonb(v_cust),
    jsonb_build_object(
      'deleted_services', v_srv_count,
      'deleted_payments', v_pay_count,
      'deleted_reminders', v_rem_count,
      'deleted_files_count', COALESCE(array_length(v_paths, 1), 0)
    )
  );

  RETURN jsonb_build_object(
    'deleted_customer_id', p_customer_id,
    'storage_paths', to_jsonb(v_paths),
    'deleted_services', v_srv_count,
    'deleted_payments', v_pay_count,
    'deleted_reminders', v_rem_count
  );
END;
$$;
