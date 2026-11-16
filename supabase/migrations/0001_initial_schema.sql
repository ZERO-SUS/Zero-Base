-- ============================================================================
-- ZERO BASE — 0001_initial_schema.sql
-- Normalized PostgreSQL schema with Owner Allowlist & Asia/Kolkata standard
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Helper returning current business date in Asia/Kolkata (IST)
CREATE OR REPLACE FUNCTION public.ist_today()
RETURNS DATE
LANGUAGE sql
STABLE
AS $$
  SELECT (timezone('Asia/Kolkata', now()))::date;
$$;

-- Helper normalizing phone digits for duplicate comparison (stored phone remains untouched)
CREATE OR REPLACE FUNCTION public.normalize_phone_digits(phone_input TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT regexp_replace(COALESCE(phone_input, ''), '\D', '', 'g');
$$;

-- ============================================================================
-- 0. OWNER ALLOWLIST (Three emergency login accounts belonging to ONE owner)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.owner_allowlist (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
  label TEXT NOT NULL DEFAULT 'Owner Emergency Account',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- 1. PROFILES (Linked to Supabase Auth users)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL DEFAULT 'Administrator',
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role = 'admin'),
  theme_mode TEXT NOT NULL DEFAULT 'system' CHECK (theme_mode IN ('light', 'dark', 'system')),
  accent_color TEXT NOT NULL DEFAULT '#2563EB' CHECK (accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- 2. CUSTOMERS
-- ============================================================================
CREATE SEQUENCE IF NOT EXISTS public.customer_code_seq START 1;

CREATE TABLE IF NOT EXISTS public.customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_code TEXT NOT NULL UNIQUE DEFAULT (
    'ZB-' || lpad(nextval('public.customer_code_seq')::text, 5, '0')
  ),
  full_name TEXT NOT NULL CHECK (char_length(trim(full_name)) > 0),
  -- Stored verbatim as entered to preserve leading zeros & country codes
  phone_number TEXT NOT NULL CHECK (char_length(trim(phone_number)) >= 5),
  alternate_phone TEXT,
  address TEXT NOT NULL CHECK (char_length(trim(address)) > 0),
  area TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES public.profiles(id) ON DELETE RESTRICT,
  updated_by UUID REFERENCES public.profiles(id) ON DELETE RESTRICT,
  archived_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_customers_customer_code ON public.customers(customer_code);
CREATE INDEX IF NOT EXISTS idx_customers_phone_number ON public.customers(phone_number);
CREATE INDEX IF NOT EXISTS idx_customers_alternate_phone ON public.customers(alternate_phone) WHERE alternate_phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customers_phone_norm ON public.customers(public.normalize_phone_digits(phone_number));
CREATE INDEX IF NOT EXISTS idx_customers_alt_phone_norm ON public.customers(public.normalize_phone_digits(alternate_phone)) WHERE alternate_phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customers_full_name ON public.customers(full_name);
CREATE INDEX IF NOT EXISTS idx_customers_area ON public.customers(area);
CREATE INDEX IF NOT EXISTS idx_customers_archived_at ON public.customers(archived_at);

-- Trigram indexes for fast case-insensitive partial search
CREATE INDEX IF NOT EXISTS idx_customers_full_name_trgm ON public.customers USING gin (full_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_customers_phone_trgm ON public.customers USING gin (phone_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_customers_address_trgm ON public.customers USING gin (address gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_customers_area_trgm ON public.customers USING gin (COALESCE(area, '') gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_customers_code_trgm ON public.customers USING gin (customer_code gin_trgm_ops);

-- ============================================================================
-- 3. SERVICES
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  -- Actual service date (used for year-wise grouping, independent of created_at)
  service_date DATE NOT NULL,
  service_type TEXT NOT NULL CHECK (char_length(trim(service_type)) > 0),
  tank_details TEXT,
  description TEXT,
  price NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  discount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  total_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  amount_paid NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  balance_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (balance_amount >= 0),
  payment_status TEXT NOT NULL DEFAULT 'Unpaid' CHECK (payment_status IN ('Unpaid', 'Partially Paid', 'Paid', 'Refunded')),
  next_due_date DATE,
  notes TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES public.profiles(id) ON DELETE RESTRICT,
  updated_by UUID REFERENCES public.profiles(id) ON DELETE RESTRICT,
  archived_at TIMESTAMPTZ,
  CONSTRAINT chk_services_discount_lte_price CHECK (discount <= price)
);

CREATE INDEX IF NOT EXISTS idx_services_customer_id ON public.services(customer_id);
CREATE INDEX IF NOT EXISTS idx_services_service_date ON public.services(service_date DESC);
CREATE INDEX IF NOT EXISTS idx_services_next_due_date ON public.services(next_due_date) WHERE next_due_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_services_payment_status ON public.services(payment_status);
CREATE INDEX IF NOT EXISTS idx_services_service_type ON public.services(service_type);
CREATE INDEX IF NOT EXISTS idx_services_archived_at ON public.services(archived_at);

-- ============================================================================
-- 4. PAYMENTS
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id UUID NOT NULL REFERENCES public.services(id) ON DELETE RESTRICT,
  customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  payment_type TEXT NOT NULL DEFAULT 'payment' CHECK (payment_type IN ('payment', 'refund')),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('Cash', 'UPI', 'Other')),
  payment_date DATE NOT NULL,
  reference_number TEXT,
  notes TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES public.profiles(id) ON DELETE RESTRICT,
  archived_at TIMESTAMPTZ,
  archived_by UUID REFERENCES public.profiles(id) ON DELETE RESTRICT,
  archive_reason TEXT,
  superseded_by UUID REFERENCES public.payments(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_payments_service_id ON public.payments(service_id);
CREATE INDEX IF NOT EXISTS idx_payments_customer_id ON public.payments(customer_id);
CREATE INDEX IF NOT EXISTS idx_payments_payment_date ON public.payments(payment_date DESC);
CREATE INDEX IF NOT EXISTS idx_payments_method ON public.payments(payment_method);
CREATE INDEX IF NOT EXISTS idx_payments_reference ON public.payments(reference_number) WHERE reference_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_archived_at ON public.payments(archived_at);

-- ============================================================================
-- 5. REMINDERS
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  service_id UUID REFERENCES public.services(id) ON DELETE RESTRICT,
  due_date DATE NOT NULL,
  reminder_type TEXT NOT NULL DEFAULT 'service_due' CHECK (reminder_type IN ('service_due', 'custom', 'follow_up')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'contacted', 'confirmed', 'snoozed', 'dismissed', 'completed')
  ),
  snoozed_until DATE,
  contacted_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES public.profiles(id) ON DELETE RESTRICT,
  updated_by UUID REFERENCES public.profiles(id) ON DELETE RESTRICT,
  archived_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_reminders_due_date ON public.reminders(due_date);
CREATE INDEX IF NOT EXISTS idx_reminders_status ON public.reminders(status);
CREATE INDEX IF NOT EXISTS idx_reminders_customer_id ON public.reminders(customer_id);
CREATE INDEX IF NOT EXISTS idx_reminders_service_id ON public.reminders(service_id) WHERE service_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reminders_archived_at ON public.reminders(archived_at);

-- Prevent duplicate reminders for the same service & due_date, and prevent multiple active reminders per service
CREATE UNIQUE INDEX IF NOT EXISTS idx_reminders_unique_service_due
  ON public.reminders(service_id, due_date)
  WHERE service_id IS NOT NULL AND archived_at IS NULL AND status <> 'dismissed';

CREATE UNIQUE INDEX IF NOT EXISTS idx_reminders_one_active_per_service
  ON public.reminders(service_id)
  WHERE service_id IS NOT NULL AND archived_at IS NULL AND status IN ('active', 'contacted', 'confirmed', 'snoozed');

-- ============================================================================
-- 6. SERVICE_FILES (Metadata & Supabase Storage paths; binary files in zero-base-files)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.service_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  service_id UUID NOT NULL REFERENCES public.services(id) ON DELETE RESTRICT,
  payment_id UUID REFERENCES public.payments(id) ON DELETE RESTRICT,
  file_name TEXT NOT NULL,
  storage_path TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  file_size BIGINT NOT NULL CHECK (file_size > 0),
  category TEXT NOT NULL DEFAULT 'Other attachments' CHECK (
    category IN (
      'Bill photos',
      'UPI transaction screenshots',
      'Before-cleaning photos',
      'After-cleaning photos',
      'Tank photos',
      'Hose photos',
      'Work-area photos',
      'Other attachments'
    )
  ),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  uploaded_by UUID REFERENCES public.profiles(id) ON DELETE RESTRICT,
  archived_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_service_files_customer_id ON public.service_files(customer_id);
CREATE INDEX IF NOT EXISTS idx_service_files_service_id ON public.service_files(service_id);
CREATE INDEX IF NOT EXISTS idx_service_files_payment_id ON public.service_files(payment_id) WHERE payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_service_files_archived_at ON public.service_files(archived_at);

-- ============================================================================
-- 7. AUDIT LOGS (Append-only)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.audit_logs (
  audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES public.profiles(id) ON DELETE RESTRICT,
  actor_email TEXT,
  action TEXT NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'ARCHIVE', 'RESTORE', 'DELETE_FILE', 'AUTH', 'BACKUP', 'STORAGE_CLEANUP')),
  entity_type TEXT NOT NULL,
  entity_id UUID,
  old_values JSONB,
  new_values JSONB,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON public.audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON public.audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON public.audit_logs(created_at DESC);

-- ============================================================================
-- 8. BUSINESS SETTINGS (Singleton configuration row)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.business_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton_key BOOLEAN NOT NULL DEFAULT true UNIQUE CHECK (singleton_key = true),
  app_name TEXT NOT NULL DEFAULT 'ZERO BASE',
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  currency_code TEXT NOT NULL DEFAULT 'INR',
  currency_symbol TEXT NOT NULL DEFAULT '₹',
  service_types JSONB NOT NULL DEFAULT '[
    "Overhead Tank Cleaning",
    "Underground Sump Cleaning",
    "Loft Tank Cleaning",
    "Commercial Tank Cleaning",
    "Pipeline & Disinfection"
  ]'::jsonb,
  default_reminder_months INTEGER NOT NULL DEFAULT 6 CHECK (default_reminder_months BETWEEN 1 AND 60),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES public.profiles(id) ON DELETE RESTRICT
);

INSERT INTO public.business_settings (singleton_key, app_name, timezone)
VALUES (true, 'ZERO BASE', 'Asia/Kolkata')
ON CONFLICT (singleton_key) DO NOTHING;
