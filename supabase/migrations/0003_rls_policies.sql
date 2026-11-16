-- ============================================================================
-- ZERO BASE — 0003_rls_policies.sql
-- Strict Row Level Security across all tables (zero anonymous access)
-- ============================================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_settings ENABLE ROW LEVEL SECURITY;

-- Authorization helper functions
CREATE OR REPLACE FUNCTION public.is_active_staff()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
      AND is_active = true
      AND role IN ('admin', 'staff')
  );
$$;

CREATE OR REPLACE FUNCTION public.is_active_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
      AND is_active = true
      AND role = 'admin'
  );
$$;

-- PROFILES
CREATE POLICY "profiles_select_own_or_admin" ON public.profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.is_active_admin());

CREATE POLICY "profiles_update_own_or_admin" ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid() OR public.is_active_admin())
  WITH CHECK (id = auth.uid() OR public.is_active_admin());

-- CUSTOMERS (No hard DELETE allowed for business integrity)
CREATE POLICY "customers_select_active_staff" ON public.customers
  FOR SELECT TO authenticated
  USING (public.is_active_staff());

CREATE POLICY "customers_insert_active_staff" ON public.customers
  FOR INSERT TO authenticated
  WITH CHECK (public.is_active_staff());

CREATE POLICY "customers_update_active_staff" ON public.customers
  FOR UPDATE TO authenticated
  USING (public.is_active_staff())
  WITH CHECK (public.is_active_staff());

-- SERVICES
CREATE POLICY "services_select_active_staff" ON public.services
  FOR SELECT TO authenticated
  USING (public.is_active_staff());

CREATE POLICY "services_insert_active_staff" ON public.services
  FOR INSERT TO authenticated
  WITH CHECK (public.is_active_staff());

CREATE POLICY "services_update_active_staff" ON public.services
  FOR UPDATE TO authenticated
  USING (public.is_active_staff())
  WITH CHECK (public.is_active_staff());

-- PAYMENTS
CREATE POLICY "payments_select_active_staff" ON public.payments
  FOR SELECT TO authenticated
  USING (public.is_active_staff());

CREATE POLICY "payments_insert_active_staff" ON public.payments
  FOR INSERT TO authenticated
  WITH CHECK (public.is_active_staff());

CREATE POLICY "payments_update_active_staff" ON public.payments
  FOR UPDATE TO authenticated
  USING (public.is_active_staff())
  WITH CHECK (public.is_active_staff());

-- ATTACHMENTS
CREATE POLICY "attachments_select_active_staff" ON public.attachments
  FOR SELECT TO authenticated
  USING (public.is_active_staff());

CREATE POLICY "attachments_insert_active_staff" ON public.attachments
  FOR INSERT TO authenticated
  WITH CHECK (public.is_active_staff());

CREATE POLICY "attachments_update_active_staff" ON public.attachments
  FOR UPDATE TO authenticated
  USING (public.is_active_staff())
  WITH CHECK (public.is_active_staff());

-- REMINDERS
CREATE POLICY "reminders_select_active_staff" ON public.reminders
  FOR SELECT TO authenticated
  USING (public.is_active_staff());

CREATE POLICY "reminders_insert_active_staff" ON public.reminders
  FOR INSERT TO authenticated
  WITH CHECK (public.is_active_staff());

CREATE POLICY "reminders_update_active_staff" ON public.reminders
  FOR UPDATE TO authenticated
  USING (public.is_active_staff())
  WITH CHECK (public.is_active_staff());

-- AUDIT LOGS (Append-only; readable by active admins)
CREATE POLICY "audit_logs_select_admin" ON public.audit_logs
  FOR SELECT TO authenticated
  USING (public.is_active_admin());

CREATE POLICY "audit_logs_insert_staff" ON public.audit_logs
  FOR INSERT TO authenticated
  WITH CHECK (public.is_active_staff());

-- BUSINESS SETTINGS
CREATE POLICY "business_settings_select_staff" ON public.business_settings
  FOR SELECT TO authenticated
  USING (public.is_active_staff());

CREATE POLICY "business_settings_update_admin" ON public.business_settings
  FOR UPDATE TO authenticated
  USING (public.is_active_admin())
  WITH CHECK (public.is_active_admin());
