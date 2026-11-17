import { Hono } from 'hono';
import {
  ALLOWED_FILE_CATEGORIES,
  ALLOWED_MIME_TYPES,
  buildDraftStoragePath,
  detectMimeFromMagicBytes,
} from '../lib/fileValidation';
import type { AppBindings } from '../types';

export const draftRoutes = new Hono<AppBindings>();

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SENSITIVE_KEYS = new Set([
  'token',
  'access_token',
  'refresh_token',
  'jwt',
  'secret',
  'password',
  'authorization',
]);

function getBucketName(env: AppBindings['Bindings']): string {
  return env.STORAGE_BUCKET || 'zero-base-files';
}

function sanitizeDraftPayload(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = sanitizeDraftPayload(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// GET /api/drafts/active — Retrieve current authenticated owner's active draft + signed attachment previews
draftRoutes.get('/drafts/active', async (c) => {
  const supabase = c.get('supabase');
  const user = c.get('authUser');
  const bucket = getBucketName(c.env);

  const { data: draft, error } = await supabase
    .from('service_drafts')
    .select('id, owner_id, draft_payload, status, idempotency_key, created_at, updated_at')
    .eq('owner_id', user.id)
    .eq('status', 'active')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error(`[${c.get('requestId')}] Failed loading active draft:`, error.message);
    return c.json({ error: "Saved draft couldn't be loaded." }, 500);
  }

  if (!draft) {
    return c.json({ draft: null, files: [] });
  }

  const { data: draftFiles, error: filesErr } = await supabase
    .from('service_draft_files')
    .select('*')
    .eq('draft_id', draft.id)
    .eq('owner_id', user.id)
    .order('created_at', { ascending: true });

  if (filesErr) {
    console.error(`[${c.get('requestId')}] Failed loading draft files:`, filesErr.message);
    return c.json({ draft, files: [] });
  }

  const enrichedFiles = await Promise.all(
    (draftFiles ?? []).map(async (fileRow) => {
      if (fileRow.upload_status !== 'uploaded') {
        return { ...fileRow, signed_url: null };
      }
      const { data: signed } = await supabase.storage
        .from(bucket)
        .createSignedUrl(fileRow.storage_path, 3600);
      return {
        ...fileRow,
        signed_url: signed?.signedUrl ?? null,
      };
    })
  );

  return c.json({ draft, files: enrichedFiles });
});

// PUT /api/drafts/active — Create or update the authenticated owner's active draft
draftRoutes.put('/drafts/active', async (c) => {
  const supabase = c.get('supabase');
  const user = c.get('authUser');

  let body: { draft_payload?: unknown; idempotency_key?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid draft data.' }, 400);
  }

  const cleanPayload = sanitizeDraftPayload(body.draft_payload ?? {});
  const idempotencyKey =
    typeof body.idempotency_key === 'string' && body.idempotency_key.trim().length > 0
      ? body.idempotency_key.trim().slice(0, 120)
      : crypto.randomUUID();

  const { data: existing } = await supabase
    .from('service_drafts')
    .select('id, idempotency_key')
    .eq('owner_id', user.id)
    .eq('status', 'active')
    .limit(1)
    .maybeSingle();

  if (existing) {
    const { data: updated, error: updErr } = await supabase
      .from('service_drafts')
      .update({
        draft_payload: cleanPayload,
      })
      .eq('id', existing.id)
      .eq('owner_id', user.id)
      .select('id, owner_id, draft_payload, status, idempotency_key, created_at, updated_at')
      .single();

    if (updErr || !updated) {
      console.error(`[${c.get('requestId')}] Draft update failed:`, updErr?.message);
      return c.json({ error: "Your changes couldn't be saved. Please try again." }, 500);
    }
    return c.json({ draft: updated });
  }

  const { data: inserted, error: insErr } = await supabase
    .from('service_drafts')
    .insert({
      owner_id: user.id,
      draft_payload: cleanPayload,
      status: 'active',
      idempotency_key: idempotencyKey,
    })
    .select('id, owner_id, draft_payload, status, idempotency_key, created_at, updated_at')
    .single();

  if (insErr || !inserted) {
    console.error(`[${c.get('requestId')}] Draft insert failed:`, insErr?.message);
    return c.json({ error: "Your changes couldn't be saved. Please try again." }, 500);
  }

  return c.json({ draft: inserted }, 201);
});

// DELETE /api/drafts/:id — Explicitly discard active draft and clean its unlinked storage objects
draftRoutes.delete('/drafts/:id', async (c) => {
  const supabase = c.get('supabase');
  const user = c.get('authUser');
  const draftId = c.req.param('id');
  const bucket = getBucketName(c.env);

  if (!uuidRegex.test(draftId)) {
    return c.json({ error: 'Invalid draft ID' }, 400);
  }

  const { data: draft, error: findErr } = await supabase
    .from('service_drafts')
    .select('id, status')
    .eq('id', draftId)
    .eq('owner_id', user.id)
    .maybeSingle();

  if (findErr || !draft) {
    return c.json({ error: 'Draft not found' }, 404);
  }

  if (draft.status === 'active') {
    const { data: draftFiles } = await supabase
      .from('service_draft_files')
      .select('id, storage_path')
      .eq('draft_id', draftId)
      .eq('owner_id', user.id);

    const paths = (draftFiles ?? []).map((f) => f.storage_path).filter(Boolean);
    if (paths.length > 0) {
      await supabase.storage.from(bucket).remove(paths);
    }
    await supabase
      .from('service_draft_files')
      .delete()
      .eq('draft_id', draftId)
      .eq('owner_id', user.id);

    await supabase
      .from('service_drafts')
      .update({ status: 'discarded' })
      .eq('id', draftId)
      .eq('owner_id', user.id);
  }

  return c.json({ discarded: true, id: draftId });
});

// POST /api/drafts/:draftId/files — Upload photo/file directly to draft inside private bucket
draftRoutes.post('/drafts/:draftId/files', async (c) => {
  const supabase = c.get('supabase');
  const user = c.get('authUser');
  const draftId = c.req.param('draftId');
  const bucket = getBucketName(c.env);

  if (!uuidRegex.test(draftId)) {
    return c.json({ error: 'Invalid draft ID' }, 400);
  }

  const { data: draft, error: draftErr } = await supabase
    .from('service_drafts')
    .select('id, status')
    .eq('id', draftId)
    .eq('owner_id', user.id)
    .maybeSingle();

  if (draftErr || !draft) {
    return c.json({ error: 'Draft not found' }, 404);
  }
  if (draft.status !== 'active') {
    return c.json({ error: 'This service has already been saved.' }, 400);
  }

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ error: "Photo couldn't be uploaded. Please try again." }, 400);
  }

  const fileEntry = formData.get('file');
  const category = String(formData.get('category') ?? 'Other Attachments').trim();

  if (!fileEntry || typeof fileEntry === 'string') {
    return c.json({ error: 'Please select a photo or file to upload.' }, 400);
  }

  if (!ALLOWED_FILE_CATEGORIES.includes(category as (typeof ALLOWED_FILE_CATEGORIES)[number])) {
    return c.json({ error: 'Unsupported photo category.' }, 400);
  }

  const maxBytes = Number(c.env.MAX_UPLOAD_BYTES ?? 15_728_640);
  const file = fileEntry as File;
  if (file.size <= 0 || file.size > maxBytes) {
    return c.json(
      {
        error: `This file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB. Please choose a smaller photo or file.`,
      },
      400
    );
  }

  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const detectedMime = detectMimeFromMagicBytes(bytes);

  if (!detectedMime || !ALLOWED_MIME_TYPES.has(detectedMime)) {
    return c.json(
      {
        error: 'This file type is not supported. Please choose a JPG, PNG, WEBP photo or PDF document.',
      },
      400
    );
  }

  const fileId = crypto.randomUUID();
  const storagePath = buildDraftStoragePath({
    draftId,
    fileId,
    filename: file.name || 'photo',
  });

  const { error: uploadErr } = await supabase.storage
    .from(bucket)
    .upload(storagePath, bytes, {
      contentType: detectedMime,
      upsert: false,
    });

  if (uploadErr) {
    console.error(`[${c.get('requestId')}] Draft storage upload failed:`, uploadErr.message);
    return c.json(
      {
        error: "Photo couldn't be uploaded. Please try again.",
        retryable: true,
      },
      502
    );
  }

  const { data: record, error: dbErr } = await supabase
    .from('service_draft_files')
    .insert({
      id: fileId,
      draft_id: draftId,
      owner_id: user.id,
      file_name: file.name || 'photo',
      storage_path: storagePath,
      mime_type: detectedMime,
      file_size: file.size,
      category,
      upload_status: 'uploaded',
    })
    .select('*')
    .single();

  if (dbErr || !record) {
    console.error(`[${c.get('requestId')}] Draft file metadata insert failed:`, dbErr?.message);
    await supabase.storage.from(bucket).remove([storagePath]);
    return c.json(
      {
        error: "Photo couldn't be uploaded. Please try again.",
        retryable: true,
      },
      500
    );
  }

  const { data: signed } = await supabase.storage
    .from(bucket)
    .createSignedUrl(storagePath, 3600);

  return c.json(
    {
      file: {
        ...record,
        signed_url: signed?.signedUrl ?? null,
      },
    },
    201
  );
});

// DELETE /api/drafts/:draftId/files/:fileId — Remove a photo/document from draft + storage
draftRoutes.delete('/drafts/:draftId/files/:fileId', async (c) => {
  const supabase = c.get('supabase');
  const user = c.get('authUser');
  const draftId = c.req.param('draftId');
  const fileId = c.req.param('fileId');
  const bucket = getBucketName(c.env);

  if (!uuidRegex.test(draftId) || !uuidRegex.test(fileId)) {
    return c.json({ error: 'Invalid ID' }, 400);
  }

  const { data: fileRow, error: findErr } = await supabase
    .from('service_draft_files')
    .select('id, storage_path')
    .eq('id', fileId)
    .eq('draft_id', draftId)
    .eq('owner_id', user.id)
    .maybeSingle();

  if (findErr || !fileRow) {
    return c.json({ error: 'Photo not found' }, 404);
  }

  const { error: rmErr } = await supabase.storage.from(bucket).remove([fileRow.storage_path]);
  if (rmErr) {
    console.error(`[${c.get('requestId')}] Draft storage delete failed:`, rmErr.message);
    return c.json({ error: "Photo couldn't be removed. Please try again." }, 500);
  }

  await supabase
    .from('service_draft_files')
    .delete()
    .eq('id', fileId)
    .eq('draft_id', draftId)
    .eq('owner_id', user.id);

  return c.json({ deleted: true, id: fileId });
});
