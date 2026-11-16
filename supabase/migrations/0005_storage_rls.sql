-- ============================================================================
-- ZERO BASE — 0005_storage_rls.sql
-- Replaces overly broad authenticated Storage policies on bucket `zero-base-files`
-- with strict Owner-Allowlist authorization (`public.is_authorized_owner()`).
-- ============================================================================

-- Ensure bucket `zero-base-files` remains strictly private
UPDATE storage.buckets
SET public = false
WHERE id = 'zero-base-files';

-- Drop any pre-existing broad policies on storage.objects for this bucket
DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND (
        qual ILIKE '%zero-base-files%'
        OR with_check ILIKE '%zero-base-files%'
        OR policyname ILIKE '%authenticated%'
        OR policyname ILIKE '%zero-base%'
      )
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', pol.policyname);
  END LOOP;
END $$;

-- Strict owner-allowlist policies for private bucket `zero-base-files`
CREATE POLICY "zero_base_files_owner_select"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'zero-base-files'
    AND public.is_authorized_owner()
  );

CREATE POLICY "zero_base_files_owner_insert"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'zero-base-files'
    AND public.is_authorized_owner()
  );

CREATE POLICY "zero_base_files_owner_update"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'zero-base-files'
    AND public.is_authorized_owner()
  )
  WITH CHECK (
    bucket_id = 'zero-base-files'
    AND public.is_authorized_owner()
  );

CREATE POLICY "zero_base_files_owner_delete"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'zero-base-files'
    AND public.is_authorized_owner()
  );
