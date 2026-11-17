-- ============================================================================
-- ZERO BASE — 0008_service_drafts_and_reliable_uploads.sql
-- Adds:
--   1. Storage bucket configuration hardening (`zero-base-files` private, 15 MB)
--   2. Server-side per-owner persistent service drafts (`public.service_drafts`)
--   3. Draft attachment tracking (`public.service_draft_files`)
--   4. Atomic draft-to-service attachment linking RPC (`complete_draft_attachments`)
-- Preserves all existing customers, services, payments, files, reminders, and logs.
-- ============================================================================

-- 1. Ensure private bucket `zero-base-files` exists with clean 15 MB limit and private access
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('zero-base-files', 'zero-base-files', false, 15728640, NULL)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = 15728640,
    allowed_mime_types = NULL;

-- 2. Persistent Service Drafts (scoped to authenticated owner via owner_id = auth.uid())
CREATE TABLE IF NOT EXISTS public.service_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE CASCADE,
  draft_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'discarded')),
  completed_service_id UUID REFERENCES public.services(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_service_drafts_owner_status
  ON public.service_drafts(owner_id, status, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_service_drafts_one_active_per_owner
  ON public.service_drafts(owner_id)
  WHERE status = 'active';

DROP TRIGGER IF EXISTS trg_service_drafts_updated_at ON public.service_drafts;
CREATE TRIGGER trg_service_drafts_updated_at
  BEFORE UPDATE ON public.service_drafts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 3. Draft Attachment References & Upload Status Tracking
CREATE TABLE IF NOT EXISTS public.service_draft_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id UUID NOT NULL REFERENCES public.service_drafts(id) ON DELETE CASCADE,
  owner_id UUID NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  storage_path TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  file_size BIGINT NOT NULL CHECK (file_size > 0),
  category TEXT NOT NULL DEFAULT 'Other Attachments' CHECK (
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
  ),
  upload_status TEXT NOT NULL DEFAULT 'uploaded' CHECK (
    upload_status IN ('uploading', 'uploaded', 'failed')
  ),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_service_draft_files_draft_id
  ON public.service_draft_files(draft_id, created_at);
CREATE INDEX IF NOT EXISTS idx_service_draft_files_owner_id
  ON public.service_draft_files(owner_id);

-- 4. Enable RLS & strict per-owner policies
ALTER TABLE public.service_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_draft_files ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_drafts_owner_select" ON public.service_drafts;
CREATE POLICY "service_drafts_owner_select"
  ON public.service_drafts FOR SELECT TO authenticated
  USING (public.is_authorized_owner() AND owner_id = auth.uid());

DROP POLICY IF EXISTS "service_drafts_owner_insert" ON public.service_drafts;
CREATE POLICY "service_drafts_owner_insert"
  ON public.service_drafts FOR INSERT TO authenticated
  WITH CHECK (public.is_authorized_owner() AND owner_id = auth.uid());

DROP POLICY IF EXISTS "service_drafts_owner_update" ON public.service_drafts;
CREATE POLICY "service_drafts_owner_update"
  ON public.service_drafts FOR UPDATE TO authenticated
  USING (public.is_authorized_owner() AND owner_id = auth.uid())
  WITH CHECK (public.is_authorized_owner() AND owner_id = auth.uid());

DROP POLICY IF EXISTS "service_drafts_owner_delete" ON public.service_drafts;
CREATE POLICY "service_drafts_owner_delete"
  ON public.service_drafts FOR DELETE TO authenticated
  USING (public.is_authorized_owner() AND owner_id = auth.uid());

DROP POLICY IF EXISTS "service_draft_files_owner_select" ON public.service_draft_files;
CREATE POLICY "service_draft_files_owner_select"
  ON public.service_draft_files FOR SELECT TO authenticated
  USING (public.is_authorized_owner() AND owner_id = auth.uid());

DROP POLICY IF EXISTS "service_draft_files_owner_insert" ON public.service_draft_files;
CREATE POLICY "service_draft_files_owner_insert"
  ON public.service_draft_files FOR INSERT TO authenticated
  WITH CHECK (public.is_authorized_owner() AND owner_id = auth.uid());

DROP POLICY IF EXISTS "service_draft_files_owner_update" ON public.service_draft_files;
CREATE POLICY "service_draft_files_owner_update"
  ON public.service_draft_files FOR UPDATE TO authenticated
  USING (public.is_authorized_owner() AND owner_id = auth.uid())
  WITH CHECK (public.is_authorized_owner() AND owner_id = auth.uid());

DROP POLICY IF EXISTS "service_draft_files_owner_delete" ON public.service_draft_files;
CREATE POLICY "service_draft_files_owner_delete"
  ON public.service_draft_files FOR DELETE TO authenticated
  USING (public.is_authorized_owner() AND owner_id = auth.uid());

-- 5. Atomic Draft -> Service File Promotion & Draft Completion RPC
CREATE OR REPLACE FUNCTION public.complete_draft_attachments(
  p_draft_id UUID,
  p_service_id UUID,
  p_customer_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_draft RECORD;
  v_linked_count INTEGER := 0;
BEGIN
  IF NOT public.is_authorized_owner() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT * INTO v_draft
  FROM public.service_drafts
  WHERE id = p_draft_id AND owner_id = auth.uid()
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('linked_count', 0, 'draft_found', false);
  END IF;

  WITH moved AS (
    INSERT INTO public.service_files (
      id,
      customer_id,
      service_id,
      payment_id,
      file_name,
      storage_path,
      mime_type,
      file_size,
      category,
      uploaded_by
    )
    SELECT
      df.id,
      p_customer_id,
      p_service_id,
      NULL,
      df.file_name,
      df.storage_path,
      df.mime_type,
      df.file_size,
      df.category,
      df.owner_id
    FROM public.service_draft_files df
    WHERE df.draft_id = p_draft_id
      AND df.owner_id = auth.uid()
      AND df.upload_status = 'uploaded'
    ON CONFLICT (storage_path) DO NOTHING
    RETURNING id
  )
  SELECT COUNT(*) INTO v_linked_count FROM moved;

  DELETE FROM public.service_draft_files
  WHERE draft_id = p_draft_id AND owner_id = auth.uid();

  UPDATE public.service_drafts
  SET status = 'completed',
      completed_service_id = p_service_id,
      updated_at = now()
  WHERE id = p_draft_id AND owner_id = auth.uid();

  RETURN jsonb_build_object(
    'draft_found', true,
    'linked_count', v_linked_count
  );
END;
$$;
