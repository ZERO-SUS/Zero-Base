-- ============================================================================
-- ZERO BASE — 0007_service_cart_and_items.sql
-- Itemized Service Cart & Checkout System (Backward-compatible migration)
-- Preserves all historical services, payments, reminders, and files.
-- ============================================================================

-- 1. Extend business_settings with structured active/inactive service_categories
ALTER TABLE public.business_settings
  ADD COLUMN IF NOT EXISTS service_categories JSONB NOT NULL DEFAULT '[
    {"name": "Overhead Tank Cleaning", "active": true, "kind": "tank"},
    {"name": "Underground Sump Cleaning", "active": true, "kind": "sump"},
    {"name": "Sump and Overhead Tank Cleaning", "active": true, "kind": "tank"},
    {"name": "Solar Cleaning", "active": true, "kind": "solar"},
    {"name": "Plumbing", "active": true, "kind": "plumbing"}
  ]'::jsonb;

-- Sync existing business_settings.service_types into service_categories if not customized yet
UPDATE public.business_settings bs
SET service_categories = (
  SELECT jsonb_agg(
    jsonb_build_object(
      'name', elem,
      'active', true,
      'kind', CASE
        WHEN elem ILIKE '%sump%' THEN 'sump'
        WHEN elem ILIKE '%tank%' THEN 'tank'
        WHEN elem ILIKE '%solar%' THEN 'solar'
        WHEN elem ILIKE '%plumb%' THEN 'plumbing'
        ELSE 'other'
      END
    )
  )
  FROM jsonb_array_elements_text(bs.service_types) AS elem
)
WHERE jsonb_array_length(bs.service_types) > 0;

-- 2. Add itemized cart & discount columns to services (preserving existing data)
ALTER TABLE public.services
  ADD COLUMN IF NOT EXISTS subtotal_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (subtotal_amount >= 0),
  ADD COLUMN IF NOT EXISTS discount_type TEXT NOT NULL DEFAULT 'fixed' CHECK (discount_type IN ('fixed', 'percentage')),
  ADD COLUMN IF NOT EXISTS discount_value NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (discount_value >= 0),
  ADD COLUMN IF NOT EXISTS service_categories_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Backfill existing historical services safely without altering totals
UPDATE public.services
SET subtotal_amount = CASE WHEN price > 0 THEN price ELSE total_amount END,
    discount_value = discount,
    discount_type = 'fixed',
    service_categories_snapshot = CASE
      WHEN jsonb_array_length(service_categories_snapshot) = 0 THEN jsonb_build_array(service_type)
      ELSE service_categories_snapshot
    END
WHERE subtotal_amount = 0 AND (price > 0 OR total_amount > 0);

-- 3. Service Category Groups (each category shown once per service visit)
CREATE TABLE IF NOT EXISTS public.service_category_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id UUID NOT NULL REFERENCES public.services(id) ON DELETE CASCADE,
  category_name TEXT NOT NULL CHECK (char_length(trim(category_name)) > 0),
  pricing_mode TEXT NOT NULL DEFAULT 'itemized' CHECK (pricing_mode IN ('itemized', 'category_total')),
  category_subtotal NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (category_subtotal >= 0),
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_service_category_groups_service_id
  ON public.service_category_groups(service_id);

-- 4. Service Items (individual or grouped entries under each category)
CREATE TABLE IF NOT EXISTS public.service_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id UUID NOT NULL REFERENCES public.services(id) ON DELETE CASCADE,
  category_group_id UUID NOT NULL REFERENCES public.service_category_groups(id) ON DELETE CASCADE,
  category_name TEXT NOT NULL CHECK (char_length(trim(category_name)) > 0),
  item_name TEXT,
  capacity_litres INTEGER CHECK (capacity_litres IS NULL OR capacity_litres >= 0),
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  unit_price NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  line_total NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (line_total >= 0),
  description TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_service_items_service_id
  ON public.service_items(service_id);
CREATE INDEX IF NOT EXISTS idx_service_items_group_id
  ON public.service_items(category_group_id);

-- 5. Enable Owner-Allowlist RLS on new cart tables
ALTER TABLE public.service_category_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_category_groups_select_owner" ON public.service_category_groups
  FOR SELECT TO authenticated
  USING (public.is_authorized_owner());

CREATE POLICY "service_category_groups_insert_owner" ON public.service_category_groups
  FOR INSERT TO authenticated
  WITH CHECK (public.is_authorized_owner());

CREATE POLICY "service_category_groups_update_owner" ON public.service_category_groups
  FOR UPDATE TO authenticated
  USING (public.is_authorized_owner())
  WITH CHECK (public.is_authorized_owner());

CREATE POLICY "service_category_groups_delete_owner" ON public.service_category_groups
  FOR DELETE TO authenticated
  USING (public.is_authorized_owner());

CREATE POLICY "service_items_select_owner" ON public.service_items
  FOR SELECT TO authenticated
  USING (public.is_authorized_owner());

CREATE POLICY "service_items_insert_owner" ON public.service_items
  FOR INSERT TO authenticated
  WITH CHECK (public.is_authorized_owner());

CREATE POLICY "service_items_update_owner" ON public.service_items
  FOR UPDATE TO authenticated
  USING (public.is_authorized_owner())
  WITH CHECK (public.is_authorized_owner());

CREATE POLICY "service_items_delete_owner" ON public.service_items
  FOR DELETE TO authenticated
  USING (public.is_authorized_owner());

-- 6. Helper to insert validated cart groups & items and return computed totals
CREATE OR REPLACE FUNCTION public._persist_service_cart_items(
  p_service_id UUID,
  p_cart_groups JSONB
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_grp JSONB;
  v_item JSONB;
  v_group_id UUID;
  v_group_idx INT := 0;
  v_item_idx INT := 0;
  v_pricing_mode TEXT;
  v_cat_name TEXT;
  v_cat_subtotal NUMERIC(12, 2);
  v_item_qty INT;
  v_item_price NUMERIC(12, 2);
  v_item_line NUMERIC(12, 2);
  v_items_sum NUMERIC(12, 2);
  v_grand_subtotal NUMERIC(12, 2) := 0;
BEGIN
  IF p_cart_groups IS NULL OR jsonb_typeof(p_cart_groups) <> 'array' OR jsonb_array_length(p_cart_groups) = 0 THEN
    RAISE EXCEPTION 'At least one service category is required in the cart';
  END IF;

  DELETE FROM public.service_category_groups WHERE service_id = p_service_id;

  FOR v_grp IN SELECT * FROM jsonb_array_elements(p_cart_groups)
  LOOP
    v_cat_name := trim(COALESCE(v_grp->>'category_name', ''));
    IF char_length(v_cat_name) = 0 THEN
      RAISE EXCEPTION 'Category name cannot be empty';
    END IF;

    v_pricing_mode := COALESCE(v_grp->>'pricing_mode', 'itemized');
    IF v_pricing_mode NOT IN ('itemized', 'category_total') THEN
      RAISE EXCEPTION 'Invalid pricing_mode: %', v_pricing_mode;
    END IF;

    IF v_grp->'items' IS NULL OR jsonb_typeof(v_grp->'items') <> 'array' OR jsonb_array_length(v_grp->'items') = 0 THEN
      RAISE EXCEPTION 'Category "%" must contain at least one item', v_cat_name;
    END IF;

    v_items_sum := 0;

    INSERT INTO public.service_category_groups (
      service_id, category_name, pricing_mode, category_subtotal, display_order
    ) VALUES (
      p_service_id, v_cat_name, v_pricing_mode, 0, v_group_idx
    ) RETURNING id INTO v_group_id;

    v_item_idx := 0;
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_grp->'items')
    LOOP
      v_item_qty := COALESCE((v_item->>'quantity')::int, 1);
      IF v_item_qty < 1 THEN
        RAISE EXCEPTION 'Item quantity must be at least 1';
      END IF;

      IF v_pricing_mode = 'itemized' THEN
        v_item_price := ROUND(COALESCE((v_item->>'unit_price')::numeric, 0), 2);
        IF v_item_price < 0 THEN
          RAISE EXCEPTION 'Unit price cannot be negative';
        END IF;
        v_item_line := ROUND(v_item_qty * v_item_price, 2);
      ELSE
        -- Category-level pricing does not require or double-count individual item prices
        v_item_price := 0;
        v_item_line := 0;
      END IF;

      v_items_sum := ROUND(v_items_sum + v_item_line, 2);

      INSERT INTO public.service_items (
        service_id,
        category_group_id,
        category_name,
        item_name,
        capacity_litres,
        quantity,
        unit_price,
        line_total,
        description,
        display_order
      ) VALUES (
        p_service_id,
        v_group_id,
        v_cat_name,
        NULLIF(trim(COALESCE(v_item->>'item_name', '')), ''),
        CASE
          WHEN v_item->>'capacity_litres' IS NULL OR trim(v_item->>'capacity_litres') = '' THEN NULL
          ELSE (v_item->>'capacity_litres')::int
        END,
        v_item_qty,
        v_item_price,
        v_item_line,
        NULLIF(trim(COALESCE(v_item->>'description', '')), ''),
        v_item_idx
      );

      v_item_idx := v_item_idx + 1;
    END LOOP;

    IF v_pricing_mode = 'category_total' THEN
      v_cat_subtotal := ROUND(COALESCE((v_grp->>'category_subtotal')::numeric, 0), 2);
      IF v_cat_subtotal < 0 THEN
        RAISE EXCEPTION 'Category subtotal cannot be negative';
      END IF;
    ELSE
      v_cat_subtotal := v_items_sum;
    END IF;

    UPDATE public.service_category_groups
    SET category_subtotal = v_cat_subtotal
    WHERE id = v_group_id;

    v_grand_subtotal := ROUND(v_grand_subtotal + v_cat_subtotal, 2);
    v_group_idx := v_group_idx + 1;
  END LOOP;

  RETURN v_grand_subtotal;
END;
$$;

-- 7. Atomic Cart Service Creation RPC (Customer + Service + Groups + Items + Payment + Optional Reminder)
CREATE OR REPLACE FUNCTION public.create_cart_service(
  p_customer_id UUID DEFAULT NULL,
  p_customer_full_name TEXT DEFAULT NULL,
  p_customer_phone TEXT DEFAULT NULL,
  p_customer_alt_phone TEXT DEFAULT NULL,
  p_customer_address TEXT DEFAULT NULL,
  p_customer_area TEXT DEFAULT NULL,
  p_customer_notes TEXT DEFAULT NULL,
  p_service_date DATE DEFAULT NULL,
  p_cart_groups JSONB DEFAULT '[]'::jsonb,
  p_discount_type TEXT DEFAULT 'fixed',
  p_discount_value NUMERIC DEFAULT 0,
  p_description TEXT DEFAULT NULL,
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
  v_subtotal NUMERIC(12, 2);
  v_discount_amount NUMERIC(12, 2);
  v_cat_snapshot JSONB;
  v_primary_label TEXT;
  v_cat_count INT;
  v_tank_summary TEXT;
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

  SELECT
    COALESCE(jsonb_agg(DISTINCT trim(g->>'category_name')), '[]'::jsonb),
    COUNT(DISTINCT trim(g->>'category_name'))
  INTO v_cat_snapshot, v_cat_count
  FROM jsonb_array_elements(p_cart_groups) AS g;

  IF v_cat_count = 1 THEN
    v_primary_label := v_cat_snapshot->>0;
  ELSE
    v_primary_label := (v_cat_snapshot->>0) || ' (+' || (v_cat_count - 1)::text || ' more)';
  END IF;

  SELECT string_agg(
    COALESCE(NULLIF(trim(i->>'item_name'), ''), trim(g->>'category_name')) ||
    CASE WHEN NULLIF(trim(COALESCE(i->>'capacity_litres', '')), '') IS NOT NULL
      THEN ' ' || (i->>'capacity_litres') || 'L'
      ELSE '' END ||
    ' ×' || COALESCE((i->>'quantity')::int, 1)::text,
    ', '
  )
  INTO v_tank_summary
  FROM jsonb_array_elements(p_cart_groups) AS g,
       jsonb_array_elements(g->'items') AS i;

  -- Insert parent service temporarily with 0 totals, then populate cart items & compute authoritative totals
  INSERT INTO public.services (
    customer_id,
    service_date,
    service_type,
    tank_details,
    description,
    price,
    subtotal_amount,
    discount_type,
    discount_value,
    discount,
    service_categories_snapshot,
    next_due_date,
    notes,
    idempotency_key,
    created_by,
    updated_by
  ) VALUES (
    v_customer.id,
    p_service_date,
    v_primary_label,
    LEFT(v_tank_summary, 150),
    NULLIF(trim(COALESCE(p_description, '')), ''),
    0,
    0,
    COALESCE(p_discount_type, 'fixed'),
    COALESCE(p_discount_value, 0),
    0,
    v_cat_snapshot,
    CASE WHEN p_reminder_enabled THEN p_reminder_date ELSE NULL END,
    NULLIF(trim(COALESCE(p_notes, '')), ''),
    p_idempotency_key,
    v_uid,
    v_uid
  )
  RETURNING * INTO v_service;

  v_subtotal := public._persist_service_cart_items(v_service.id, p_cart_groups);

  IF COALESCE(p_discount_type, 'fixed') = 'percentage' THEN
    IF COALESCE(p_discount_value, 0) < 0 OR COALESCE(p_discount_value, 0) > 100 THEN
      RAISE EXCEPTION 'Percentage discount must be between 0 and 100';
    END IF;
    v_discount_amount := ROUND(v_subtotal * (COALESCE(p_discount_value, 0) / 100.0), 2);
  ELSE
    v_discount_amount := ROUND(COALESCE(p_discount_value, 0), 2);
    IF v_discount_amount < 0 OR v_discount_amount > v_subtotal THEN
      RAISE EXCEPTION 'Discount (%) cannot exceed subtotal (%)', v_discount_amount, v_subtotal;
    END IF;
  END IF;

  UPDATE public.services
  SET price = v_subtotal,
      subtotal_amount = v_subtotal,
      discount = v_discount_amount,
      discount_type = COALESCE(p_discount_type, 'fixed'),
      discount_value = COALESCE(p_discount_value, 0)
  WHERE id = v_service.id
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

-- 8. Atomic Cart Service Editing RPC (preserves payments & audit history)
CREATE OR REPLACE FUNCTION public.update_cart_service(
  p_service_id UUID,
  p_service_date DATE,
  p_cart_groups JSONB,
  p_discount_type TEXT DEFAULT 'fixed',
  p_discount_value NUMERIC DEFAULT 0,
  p_description TEXT DEFAULT NULL,
  p_notes TEXT DEFAULT NULL,
  p_next_due_date DATE DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_email TEXT;
  v_old_service public.services%ROWTYPE;
  v_new_service public.services%ROWTYPE;
  v_old_groups JSONB;
  v_subtotal NUMERIC(12, 2);
  v_discount_amount NUMERIC(12, 2);
  v_cat_snapshot JSONB;
  v_primary_label TEXT;
  v_cat_count INT;
  v_tank_summary TEXT;
BEGIN
  IF NOT public.is_authorized_owner() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT * INTO v_old_service FROM public.services WHERE id = p_service_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Service record not found';
  END IF;

  SELECT email INTO v_email FROM public.profiles WHERE id = v_uid;

  SELECT COALESCE(jsonb_agg(to_jsonb(g)), '[]'::jsonb)
  INTO v_old_groups
  FROM public.service_category_groups g
  WHERE g.service_id = p_service_id;

  v_subtotal := public._persist_service_cart_items(p_service_id, p_cart_groups);

  IF COALESCE(p_discount_type, 'fixed') = 'percentage' THEN
    IF COALESCE(p_discount_value, 0) < 0 OR COALESCE(p_discount_value, 0) > 100 THEN
      RAISE EXCEPTION 'Percentage discount must be between 0 and 100';
    END IF;
    v_discount_amount := ROUND(v_subtotal * (COALESCE(p_discount_value, 0) / 100.0), 2);
  ELSE
    v_discount_amount := ROUND(COALESCE(p_discount_value, 0), 2);
    IF v_discount_amount < 0 OR v_discount_amount > v_subtotal THEN
      RAISE EXCEPTION 'Discount (%) cannot exceed subtotal (%)', v_discount_amount, v_subtotal;
    END IF;
  END IF;

  SELECT
    COALESCE(jsonb_agg(DISTINCT trim(g->>'category_name')), '[]'::jsonb),
    COUNT(DISTINCT trim(g->>'category_name'))
  INTO v_cat_snapshot, v_cat_count
  FROM jsonb_array_elements(p_cart_groups) AS g;

  IF v_cat_count = 1 THEN
    v_primary_label := v_cat_snapshot->>0;
  ELSE
    v_primary_label := (v_cat_snapshot->>0) || ' (+' || (v_cat_count - 1)::text || ' more)';
  END IF;

  SELECT string_agg(
    COALESCE(NULLIF(trim(i->>'item_name'), ''), trim(g->>'category_name')) ||
    CASE WHEN NULLIF(trim(COALESCE(i->>'capacity_litres', '')), '') IS NOT NULL
      THEN ' ' || (i->>'capacity_litres') || 'L'
      ELSE '' END ||
    ' ×' || COALESCE((i->>'quantity')::int, 1)::text,
    ', '
  )
  INTO v_tank_summary
  FROM jsonb_array_elements(p_cart_groups) AS g,
       jsonb_array_elements(g->'items') AS i;

  UPDATE public.services
  SET service_date = p_service_date,
      service_type = v_primary_label,
      tank_details = LEFT(v_tank_summary, 150),
      description = NULLIF(trim(COALESCE(p_description, '')), ''),
      notes = NULLIF(trim(COALESCE(p_notes, '')), ''),
      next_due_date = p_next_due_date,
      price = v_subtotal,
      subtotal_amount = v_subtotal,
      discount = v_discount_amount,
      discount_type = COALESCE(p_discount_type, 'fixed'),
      discount_value = COALESCE(p_discount_value, 0),
      service_categories_snapshot = v_cat_snapshot,
      updated_by = v_uid
  WHERE id = p_service_id
  RETURNING * INTO v_new_service;

  INSERT INTO public.audit_logs (
    actor_id, actor_email, action, entity_type, entity_id, old_values, new_values
  ) VALUES (
    v_uid,
    v_email,
    'UPDATE',
    'service_cart',
    p_service_id,
    jsonb_build_object('service', to_jsonb(v_old_service), 'groups', v_old_groups),
    jsonb_build_object('service', to_jsonb(v_new_service), 'groups', p_cart_groups)
  );

  RETURN jsonb_build_object('service', to_jsonb(v_new_service));
END;
$$;
