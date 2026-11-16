-- ============================================================================
-- ZERO BASE — 0002_financial_triggers_and_audit.sql
-- Server-side financial calculations, reminder sync, profile safety & audit logs
-- ============================================================================

-- 1. Automatic updated_at timestamp
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_customers_updated_at
  BEFORE UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_services_updated_at
  BEFORE UPDATE ON public.services
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_reminders_updated_at
  BEFORE UPDATE ON public.reminders
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_business_settings_updated_at
  BEFORE UPDATE ON public.business_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 2. Deterministic payment status helper
CREATE OR REPLACE FUNCTION public.compute_payment_status(
  p_total_amount NUMERIC,
  p_gross_paid NUMERIC,
  p_refunded NUMERIC
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_net NUMERIC;
BEGIN
  v_net := GREATEST(0, COALESCE(p_gross_paid, 0) - COALESCE(p_refunded, 0));

  IF COALESCE(p_refunded, 0) > 0 AND v_net <= 0 THEN
    RETURN 'Refunded';
  ELSIF COALESCE(p_total_amount, 0) = 0 THEN
    RETURN 'Paid';
  ELSIF v_net <= 0 THEN
    RETURN 'Unpaid';
  ELSIF v_net < p_total_amount THEN
    RETURN 'Partially Paid';
  ELSE
    RETURN 'Paid';
  END IF;
END;
$$;

-- 3. Enforce service total_amount, balance_amount & payment_status
CREATE OR REPLACE FUNCTION public.enforce_service_financials()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_gross_paid NUMERIC := 0;
  v_refunded NUMERIC := 0;
BEGIN
  -- Support supplying either price+discount OR direct total_amount
  IF NEW.price = 0 AND NEW.total_amount > 0 AND NEW.discount = 0 THEN
    NEW.price := NEW.total_amount;
  END IF;

  IF NEW.price < 0 OR NEW.discount < 0 THEN
    RAISE EXCEPTION 'Price and discount must be non-negative';
  END IF;
  IF NEW.discount > NEW.price THEN
    RAISE EXCEPTION 'Discount cannot exceed price';
  END IF;

  NEW.total_amount := ROUND(NEW.price - NEW.discount, 2);

  IF TG_OP = 'INSERT' THEN
    NEW.amount_paid := 0;
    NEW.balance_amount := NEW.total_amount;
    NEW.payment_status := public.compute_payment_status(NEW.total_amount, 0, 0);
  ELSE
    SELECT
      COALESCE(SUM(CASE WHEN payment_type = 'payment' THEN amount ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN payment_type = 'refund' THEN amount ELSE 0 END), 0)
    INTO v_gross_paid, v_refunded
    FROM public.payments
    WHERE service_id = NEW.id AND archived_at IS NULL;

    NEW.amount_paid := ROUND(GREATEST(0, v_gross_paid - v_refunded), 2);
    NEW.balance_amount := ROUND(GREATEST(0, NEW.total_amount - NEW.amount_paid), 2);
    NEW.payment_status := public.compute_payment_status(NEW.total_amount, v_gross_paid, v_refunded);
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_services_enforce_financials
  BEFORE INSERT OR UPDATE OF price, discount, total_amount ON public.services
  FOR EACH ROW EXECUTE FUNCTION public.enforce_service_financials();

-- 4. Ensure payment customer_id matches parent service.customer_id
CREATE OR REPLACE FUNCTION public.sync_payment_customer()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_customer_id UUID;
BEGIN
  SELECT customer_id INTO v_customer_id
  FROM public.services
  WHERE id = NEW.service_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referenced service not found';
  END IF;

  NEW.customer_id := v_customer_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_payments_sync_customer
  BEFORE INSERT ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.sync_payment_customer();

-- 5. Recalculate service payment totals whenever payments change
CREATE OR REPLACE FUNCTION public.recalculate_service_payment_totals()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_service_id UUID;
  v_total_amount NUMERIC;
  v_gross_paid NUMERIC;
  v_refunded NUMERIC;
  v_net_paid NUMERIC;
  v_balance NUMERIC;
  v_status TEXT;
BEGIN
  v_service_id := COALESCE(NEW.service_id, OLD.service_id);

  SELECT total_amount INTO v_total_amount
  FROM public.services
  WHERE id = v_service_id;

  IF NOT FOUND THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT
    COALESCE(SUM(CASE WHEN payment_type = 'payment' THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN payment_type = 'refund' THEN amount ELSE 0 END), 0)
  INTO v_gross_paid, v_refunded
  FROM public.payments
  WHERE service_id = v_service_id AND archived_at IS NULL;

  v_net_paid := ROUND(GREATEST(0, v_gross_paid - v_refunded), 2);
  v_balance := ROUND(GREATEST(0, v_total_amount - v_net_paid), 2);
  v_status := public.compute_payment_status(v_total_amount, v_gross_paid, v_refunded);

  UPDATE public.services
  SET amount_paid = v_net_paid,
      balance_amount = v_balance,
      payment_status = v_status
  WHERE id = v_service_id;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_payments_recalculate_service
  AFTER INSERT OR UPDATE OR DELETE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.recalculate_service_payment_totals();

-- 6. Sync reminder when a service is created or next_due_date is updated
CREATE OR REPLACE FUNCTION public.sync_reminder_from_service()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.archived_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' AND NEW.next_due_date IS NOT NULL THEN
    INSERT INTO public.reminders (
      service_id, customer_id, due_date, reminder_type, status, created_by, updated_by
    )
    VALUES (
      NEW.id, NEW.customer_id, NEW.next_due_date, 'service_due', 'active', NEW.created_by, NEW.updated_by
    )
    ON CONFLICT DO NOTHING;
  ELSIF TG_OP = 'UPDATE' AND NEW.next_due_date IS DISTINCT FROM OLD.next_due_date THEN
    IF NEW.next_due_date IS NOT NULL THEN
      UPDATE public.reminders
      SET due_date = NEW.next_due_date,
          updated_by = NEW.updated_by
      WHERE service_id = NEW.id
        AND archived_at IS NULL
        AND status IN ('active', 'contacted', 'confirmed', 'snoozed');

      IF NOT FOUND AND NOT EXISTS (
        SELECT 1 FROM public.reminders WHERE service_id = NEW.id AND archived_at IS NULL
      ) THEN
        INSERT INTO public.reminders (
          service_id, customer_id, due_date, reminder_type, status, created_by, updated_by
        )
        VALUES (
          NEW.id, NEW.customer_id, NEW.next_due_date, 'service_due', 'active', NEW.updated_by, NEW.updated_by
        )
        ON CONFLICT DO NOTHING;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_services_sync_reminder
  AFTER INSERT OR UPDATE OF next_due_date ON public.services
  FOR EACH ROW EXECUTE FUNCTION public.sync_reminder_from_service();

-- 7. Automatic audit logging trigger across business tables
CREATE OR REPLACE FUNCTION public.write_audit_log()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id UUID;
  v_actor_email TEXT;
  v_action TEXT;
  v_entity_id UUID;
  v_old JSONB;
  v_new JSONB;
BEGIN
  v_actor_id := auth.uid();
  IF v_actor_id IS NOT NULL THEN
    SELECT email INTO v_actor_email FROM public.profiles WHERE id = v_actor_id;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_action := 'INSERT';
    v_old := NULL;
    v_new := to_jsonb(NEW);
    v_entity_id := NEW.id;
  ELSIF TG_OP = 'UPDATE' THEN
    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
    v_entity_id := NEW.id;
    IF (v_old->>'archived_at') IS NULL AND (v_new->>'archived_at') IS NOT NULL THEN
      v_action := 'ARCHIVE';
    ELSIF (v_old->>'archived_at') IS NOT NULL AND (v_new->>'archived_at') IS NULL THEN
      v_action := 'RESTORE';
    ELSE
      v_action := 'UPDATE';
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    v_action := 'DELETE_FILE';
    v_old := to_jsonb(OLD);
    v_new := NULL;
    v_entity_id := OLD.id;
  END IF;

  INSERT INTO public.audit_logs (
    actor_id, actor_email, action, entity_type, entity_id, old_values, new_values
  ) VALUES (
    v_actor_id, v_actor_email, v_action, TG_TABLE_NAME, v_entity_id, v_old, v_new
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_audit_customers AFTER INSERT OR UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

CREATE TRIGGER trg_audit_services AFTER INSERT OR UPDATE ON public.services
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

CREATE TRIGGER trg_audit_payments AFTER INSERT OR UPDATE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

CREATE TRIGGER trg_audit_service_files AFTER INSERT OR UPDATE OR DELETE ON public.service_files
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

CREATE TRIGGER trg_audit_reminders AFTER INSERT OR UPDATE ON public.reminders
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

CREATE TRIGGER trg_audit_business_settings AFTER INSERT OR UPDATE ON public.business_settings
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- 8. Auto-provision profile for auth.users (still requires owner_allowlist entry for access!)
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', 'Owner Administrator'),
    'admin'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();
