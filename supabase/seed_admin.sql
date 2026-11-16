-- ============================================================================
-- ZERO BASE — Admin Bootstrap Helper (Run manually in Supabase SQL Editor)
-- ============================================================================
-- 1. First, create your administrator user in Supabase Dashboard:
--    Authentication -> Users -> Add user (Email + strong Password, Auto Confirm)
--    AND disable "Enable Sign Ups" under Authentication -> Providers -> Email.
--
-- 2. Then run this SQL replacing ONLY the email below to activate that user
--    as the primary ZERO BASE administrator:

UPDATE public.profiles
SET
  role = 'admin',
  is_active = true,
  full_name = 'Primary Administrator'
WHERE email = 'admin@your-business-domain.com';
