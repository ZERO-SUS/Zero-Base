-- ============================================================================
-- ZERO BASE — 0001_initial_schema.sql
-- Normalized PostgreSQL schema for Water-Tank Cleaning Business Management
-- Timezone standard: Asia/Kolkata
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Helper returning current business date in Asia/Kolkata
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
-- 1. PROFILES (Linked to Supabase Auth users)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL DEFAULT 'Administrator',
  role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'staff')),
  is_active BOOLEAN NOT NULL DEFAULT false,
  theme_mode TEXT NOT NULL DEFAULT 'system' CHECK (theme_mode IN ('light', 'dark', 'system')),
  accent_color TEXT NOT NULL DEFAULT '#2563EB' CHECK (accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- 2. CUSTOMERS
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.customers (
  customer_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL CHECK (char_length(trim(full_name)) > 0),
  -- Stored as TEXT to preserve leading zeros and country codes (+91, 0, etc.)
  primary_phone TEXT NOT NULL CHECK (char_length(trim(primary_phone)) >= 5),
  secondary_phone TEXT,
  address TEXT NOT NULL CHECK (char_length(trim(address)) > 0),
  locality TEXT,
  landmark TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES public.profiles(id) ON DELETE RESTRICT,
  updated_by UUID REFERENCES public.profiles(id) ON DELETE RESTRICT,
  archived_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_customers_primary_phone ON public.customers(primary_phone);
CREATE INDEX IF NOT EXISTS idx_customers_secondary_phone ON public.customers(secondary_phone) WHERE secondary_phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customers_primary_phone_norm ON public.customers(public.normalize_phone_digits(primary_phone));
CREATE INDEX IF NOT EXISTS idx_customers_secondary_phone_norm ON public.customers(public.normalize_phone_digits(secondary_phone)) WHERE secondary_phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customers_full_name ON public.customers(full_name);
CREATE INDEX IF NOT EXISTS idx_customers_locality ON public.customers(locality);
CREATE INDEX IF NOT EXISTS idx_customers_archived_at ON public.customers(archived_at);

-- Trigram indexes for fast partial search across name, phones, address, locality
CREATE INDEX IF NOT EXISTS idx_customers_full_name_trgm ON public.customers USING gin (full_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_customers_primary_phone_trgm ON public.customers USING gin (primary_phone gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_customers_address_trgm ON public.customers USING gin (address gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_customers_locality_trgm ON public.customers USING gin (COALESCE(locality, '') gin_trgm_ops);

-- ============================================================================
-- 3. SERVICES
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.services (
  service_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES public.customers(customer_id) ON DELETE RESTRICT,
  -- Business date the cleaning actually occurred (used for year-wise grouping)
  service_date DATE NOT NULL,
  service_type TEXT NOT NULL CHECK (char_length(trim(service_type)) > 0),
  tank_capacity TEXT,
  price NUMERIC(12, 2) NOT NULL CHECK (price >= 0),
  discount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  total_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  amount_paid NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
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
  payment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id UUID NOT NULL REFERENCES public.services(service_id) ON DELETE RESTRICT,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  payment_type TEXT NOT NULL DEFAULT 'payment' CHECK (payment_type IN ('payment', 'refund')),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('Cash', 'UPI', 'Other')),
  transaction_reference TEXT,
  payment_date DATE NOT NULL,
  notes TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES public.profiles(id) ON DELETE RESTRICT,
  archived_at TIMESTAMPTZ,
  archived_by UUID REFERENCES public.profiles(id) ON DELETE RESTRICT,
  archive_reason TEXT,
  superseded_by UUID REFERENCES public.payments(payment_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_payments_service_id ON public.payments(service_id);
CREATE INDEX IF NOT EXISTS idx_payments_payment_date ON public.payments(payment_date DESC);
CREATE INDEX IF NOT EXISTS idx_payments_method ON public.payments(payment_method);
CREATE INDEX IF NOT EXISTS idx_payments_archived_at ON public.payments(archived_at);

-- ============================================================================
-- 5. ATTACHMENTS (Metadata & R2 Storage Keys only; binary files live in R2)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.attachments (
  attachment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id UUID NOT NULL REFERENCES public.services(service_id) ON DELETE RESTRICT,
  storage_key TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size BIGINT NOT NULL CHECK (file_size > 0),
  category TEXT NOT NULL CHECK (
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

CREATE INDEX IF NOT EXISTS idx_attachments_service_id ON public.attachments(service_id);
CREATE INDEX IF NOT EXISTS idx_attachments_category ON public.attachments(category);
CREATE INDEX IF NOT EXISTS idx_attachments_archived_at ON public.attachments(archived_at);

-- ============================================================================
-- 6. REMINDERS
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.reminders (
  reminder_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id UUID NOT NULL REFERENCES public.services(service_id) ON DELETE RESTRICT,
  customer_id UUID NOT NULL REFERENCES public.customers(customer_id) ON DELETE RESTRICT,
  due_date DATE NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_reminders_archived_at ON public.reminders(archived_at);

-- Prevent duplicate active reminders for the same service
CREATE UNIQUE INDEX IF NOT EXISTS idx_reminders_one_active_per_service
  ON public.reminders(service_id)
  WHERE archived_at IS NULL AND status IN ('active', 'contacted', 'confirmed', 'snoozed');

-- ============================================================================
-- 7. AUDIT LOGS (Append-only)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.audit_logs (
  audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES public.profiles(id) ON DELETE RESTRICT,
  actor_email TEXT,
  action TEXT NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'ARCHIVE', 'RESTORE', 'AUTH', 'BACKUP', 'STORAGE_CLEANUP')),
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
