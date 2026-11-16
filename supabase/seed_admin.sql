-- ============================================================================
-- ZERO BASE — Configure Three Emergency Owner Accounts (Supabase SQL Editor)
-- ============================================================================
-- All three existing Supabase Auth accounts belong to ONE owner.
-- 1. Copy the 3 User UIDs from Supabase Dashboard -> Authentication -> Users.
-- 2. Replace the three placeholder UUIDs below and run this script once.
-- 3. This grants identical full administrator privileges to those 3 UIDs only,
--    and synchronizes their profiles rows.

INSERT INTO public.owner_allowlist (user_id, label, is_active)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'Owner Primary Login', true),
  ('00000000-0000-0000-0000-000000000002', 'Owner Emergency Login 2', true),
  ('00000000-0000-0000-0000-000000000003', 'Owner Emergency Login 3', true)
ON CONFLICT (user_id) DO UPDATE
SET is_active = EXCLUDED.is_active,
    label = EXCLUDED.label;

-- Backfill profiles rows for the three existing auth.users accounts
INSERT INTO public.profiles (id, email, full_name, role)
SELECT
  u.id,
  u.email,
  COALESCE(u.raw_user_meta_data->>'full_name', 'Owner Administrator'),
  'admin'
FROM auth.users u
JOIN public.owner_allowlist oa ON oa.user_id = u.id
ON CONFLICT (id) DO UPDATE
SET role = 'admin',
    email = EXCLUDED.email;
