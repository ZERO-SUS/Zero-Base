-- ============================================================================
-- ZERO BASE — 0003_rls_policies.sql
-- Strict Owner-Allowlist Row Level Security (Three Emergency Admin Accounts)
-- ============================================================================

ALTER TABLE public.owner_allowlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_settings ENABLE ROW LEVEL SECURITY;

-- Authorization check: caller must be authenticated AND listed in active owner_allowlist
CREATE OR REPLACE FUNCTION public.is_authorized_owner()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.owner_allowlist oa
      WHERE oa.user_id = auth.uid()
        AND oa.is_active = true
    );
$$;

-- OWNER_ALLOWLIST (Read own membership only; managed via SQL/migrations)
CREATE POLICY "owner_allowlist_select_own" ON public.owner_allowlist
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND is_active = true);

-- PROFILES (Authorized owners only)
CREATE POLICY "profiles_select_owner" ON public.profiles
  FOR SELECT TO authenticated
  USING (public.is_authorized_owner());

CREATE POLICY "profiles_insert_owner" ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK (public.is_authorized_owner() AND id = auth.uid());

CREATE POLICY "profiles_update_owner" ON public.profiles
  FOR UPDATE TO authenticated
  USING (public.is_authorized_owner() AND id = auth.uid())
  WITH CHECK (public.is_authorized_owner() AND id = auth.uid());

-- CUSTOMERS (No hard DELETE allowed; soft-archive via archived_at)
CREATE POLICY "customers_select_owner" ON public.customers
  FOR SELECT TO authenticated
  USING (public.is_authorized_owner());

CREATE POLICY "customers_insert_owner" ON public.customers
  FOR INSERT TO authenticated
  WITH CHECK (public.is_authorized_owner());

CREATE POLICY "customers_update_owner" ON public.customers
  FOR UPDATE TO authenticated
  USING (public.is_authorized_owner())
  WITH CHECK (public.is_authorized_owner());

-- SERVICES
CREATE POLICY "services_select_owner" ON public.services
  FOR SELECT TO authenticated
  USING (public.is_authorized_owner());

CREATE POLICY "services_insert_owner" ON public.services
  FOR INSERT TO authenticated
  WITH CHECK (public.is_authorized_owner());

CREATE POLICY "services_update_owner" ON public.services
  FOR UPDATE TO authenticated
  USING (public.is_authorized_owner())
  WITH CHECK (public.is_authorized_owner());

-- PAYMENTS
CREATE POLICY "payments_select_owner" ON public.payments
  FOR SELECT TO authenticated
  USING (public.is_authorized_owner());

CREATE POLICY "payments_insert_owner" ON public.payments
  FOR INSERT TO authenticated
  WITH CHECK (public.is_authorized_owner());

CREATE POLICY "payments_update_owner" ON public.payments
  FOR UPDATE TO authenticated
  USING (public.is_authorized_owner())
  WITH CHECK (public.is_authorized_owner());

-- REMINDERS
CREATE POLICY "reminders_select_owner" ON public.reminders
  FOR SELECT TO authenticated
  USING (public.is_authorized_owner());

CREATE POLICY "reminders_insert_owner" ON public.reminders
  FOR INSERT TO authenticated
  WITH CHECK (public.is_authorized_owner());

CREATE POLICY "reminders_update_owner" ON public.reminders
  FOR UPDATE TO authenticated
  USING (public.is_authorized_owner())
  WITH CHECK (public.is_authorized_owner());

-- SERVICE_FILES (Authorized owners can read, upload metadata, archive, or delete orphaned/removed metadata)
CREATE POLICY "service_files_select_owner" ON public.service_files
  FOR SELECT TO authenticated
  USING (public.is_authorized_owner());

CREATE POLICY "service_files_insert_owner" ON public.service_files
  FOR INSERT TO authenticated
  WITH CHECK (public.is_authorized_owner());

CREATE POLICY "service_files_update_owner" ON public.service_files
  FOR UPDATE TO authenticated
  USING (public.is_authorized_owner())
  WITH CHECK (public.is_authorized_owner());

CREATE POLICY "service_files_delete_owner" ON public.service_files
  FOR DELETE TO authenticated
  USING (public.is_authorized_owner());

-- AUDIT LOGS (Append-only for authorized owners)
CREATE POLICY "audit_logs_select_owner" ON public.audit_logs
  FOR SELECT TO authenticated
  USING (public.is_authorized_owner());

CREATE POLICY "audit_logs_insert_owner" ON public.audit_logs
  FOR INSERT TO authenticated
  WITH CHECK (public.is_authorized_owner());

-- BUSINESS SETTINGS
CREATE POLICY "business_settings_select_owner" ON public.business_settings
  FOR SELECT TO authenticated
  USING (public.is_authorized_owner());

CREATE POLICY "business_settings_update_owner" ON public.business_settings
  FOR UPDATE TO authenticated
  USING (public.is_authorized_owner())
  WITH CHECK (public.is_authorized_owner());
