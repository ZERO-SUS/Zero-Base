import { Hono } from 'hono';
import {
  ALLOWED_ATTACHMENT_CATEGORIES,
  ALLOWED_MIME_TYPES,
  buildStorageKey,
  detectMimeFromMagicBytes,
} from '../lib/fileValidation';
import { requireAdmin } from '../lib/auth';
import { signFileAccessToken, verifyFileAccessToken } from '../lib/signing';
import type { AppBindings } from '../types';

export const attachmentRoutes = new Hono<AppBindings>();
export const publicSignedFileRoutes = new Hono<AppBindings>();

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Streams a private R2 object using a short-lived HMAC-signed access token
publicSignedFileRoutes.get('/attachments/:id/file', async (c) => {
  const attachmentId = c.req.param('id');
  const token = c.req.query('token');
  const download = c.req.query('download') === '1';

  if (!uuidRegex.test(attachmentId)) {
    return c.json({ error: 'Invalid attachment ID' }, 400);
  }

  if (!token) {
    return c.json({ error: 'Signed access token required' }, 401);
  }

  const verified = await verifyFileAccessToken(token, c.env.FILE_SIGNING_SECRET);
  if (!verified || verified.attachmentId !== attachmentId) {
    return c.json({ error: 'Invalid or expired file access link' }, 403);
  }

  const obj = await c.env.FILES_BUCKET.get(verified.storageKey);
  if (!obj) {
    return c.json({ error: 'File object not found in R2 storage' }, 404);
  }

  const contentType = obj.httpMetadata?.contentType ?? 'application/octet-stream';
  const originalName = obj.customMetadata?.originalFilename ?? 'attachment';

  const headers = new Headers();
  headers.set('Content-Type', contentType);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cache-Control', 'private, no-store, max-age=0');
  headers.set(
    'Content-Disposition',
    `${download ? 'attachment' : 'inline'}; filename="${originalName.replace(/"/g, '')}"`
  );

  return new Response(obj.body, { status: 200, headers });
});

// Upload a file to private R2 bucket and save metadata in PostgreSQL
attachmentRoutes.post('/services/:serviceId/attachments', async (c) => {
  const supabase = c.get('supabase');
  const user = c.get('authUser');
  const serviceId = c.req.param('serviceId');

  if (!uuidRegex.test(serviceId)) {
    return c.json({ error: 'Invalid service ID' }, 400);
  }

  const { data: service, error: srvErr } = await supabase
    .from('services')
    .select('service_id, customer_id, archived_at')
    .eq('service_id', serviceId)
    .single();

  if (srvErr || !service) {
    return c.json({ error: 'Service record not found' }, 404);
  }
  if (service.archived_at) {
    return c.json({ error: 'Cannot upload attachments to an archived service' }, 400);
  }

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ error: 'Expected multipart/form-data upload' }, 400);
  }

  const fileEntry = formData.get('file');
  const category = String(formData.get('category') ?? '').trim();

  if (!fileEntry || typeof fileEntry === 'string') {
    return c.json({ error: 'File field is required' }, 400);
  }

  if (!ALLOWED_ATTACHMENT_CATEGORIES.includes(category as (typeof ALLOWED_ATTACHMENT_CATEGORIES)[number])) {
    return c.json(
      {
        error: 'Invalid attachment category',
        allowed_categories: ALLOWED_ATTACHMENT_CATEGORIES,
      },
      400
    );
  }

  const maxBytes = Number(c.env.MAX_UPLOAD_BYTES ?? 15_728_640);
  const file = fileEntry as File;
  if (file.size <= 0 || file.size > maxBytes) {
    return c.json(
      {
        error: `File size must be between 1 byte and ${Math.round(maxBytes / (1024 * 1024))} MB`,
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
        error: 'Unsupported or invalid file format. Allowed formats: JPEG, PNG, WebP, GIF, PDF.',
      },
      400
    );
  }

  const attachmentId = crypto.randomUUID();
  const storageKey = buildStorageKey({
    customerId: service.customer_id,
    serviceId,
    attachmentId,
    filename: file.name || 'upload',
  });

  // Step 1: Upload to private R2 bucket
  try {
    await c.env.FILES_BUCKET.put(storageKey, arrayBuffer, {
      httpMetadata: {
        contentType: detectedMime,
      },
      customMetadata: {
        attachmentId,
        serviceId,
        customerId: service.customer_id,
        originalFilename: file.name || 'upload',
        uploadedBy: user.id,
      },
    });
  } catch {
    return c.json(
      {
        error: 'Failed to store file in cloud storage (R2). Please retry.',
        retryable: true,
      },
      502
    );
  }

  // Step 2: Persist metadata in Supabase PostgreSQL
  const { data: record, error: dbErr } = await supabase
    .from('attachments')
    .insert({
      attachment_id: attachmentId,
      service_id: serviceId,
      storage_key: storageKey,
      original_filename: file.name || 'upload',
      mime_type: detectedMime,
      file_size: file.size,
      category,
      uploaded_by: user.id,
    })
    .select('*')
    .single();

  if (dbErr || !record) {
    // Compensating rollback in R2 so orphaned files aren't silently left behind
    let rollbackSuccess = false;
    try {
      await c.env.FILES_BUCKET.delete(storageKey);
      rollbackSuccess = true;
    } catch {
      rollbackSuccess = false;
    }

    return c.json(
      {
        error: 'File uploaded to R2, but database metadata failed to save. Please retry.',
        retryable: true,
        orphaned_storage_key: rollbackSuccess ? null : storageKey,
      },
      500
    );
  }

  return c.json({ attachment: record }, 201);
});

// Generate short-lived temporary access link (5 minutes)
attachmentRoutes.get('/attachments/:id/access-link', async (c) => {
  const supabase = c.get('supabase');
  const user = c.get('authUser');
  const attachmentId = c.req.param('id');

  if (!uuidRegex.test(attachmentId)) {
    return c.json({ error: 'Invalid attachment ID' }, 400);
  }

  const { data: attachment, error } = await supabase
    .from('attachments')
    .select('attachment_id, storage_key, original_filename, mime_type, archived_at')
    .eq('attachment_id', attachmentId)
    .single();

  if (error || !attachment) {
    return c.json({ error: 'Attachment not found' }, 404);
  }

  const { token, expiresAt } = await signFileAccessToken(
    {
      attachmentId: attachment.attachment_id,
      storageKey: attachment.storage_key,
      userId: user.id,
    },
    c.env.FILE_SIGNING_SECRET,
    300
  );

  const origin = new URL(c.req.url).origin;
  return c.json({
    url: `${origin}/api/attachments/${attachment.attachment_id}/file?token=${encodeURIComponent(token)}`,
    download_url: `${origin}/api/attachments/${attachment.attachment_id}/file?token=${encodeURIComponent(token)}&download=1`,
    expires_at: expiresAt,
  });
});

attachmentRoutes.post('/attachments/:id/archive', async (c) => {
  const supabase = c.get('supabase');
  const attachmentId = c.req.param('id');

  if (!uuidRegex.test(attachmentId)) {
    return c.json({ error: 'Invalid attachment ID' }, 400);
  }

  const { data, error } = await supabase
    .from('attachments')
    .update({ archived_at: new Date().toISOString() })
    .eq('attachment_id', attachmentId)
    .select('*')
    .single();

  if (error || !data) {
    return c.json({ error: 'Failed to archive attachment' }, 500);
  }

  return c.json({ attachment: data });
});

attachmentRoutes.post('/attachments/:id/restore', async (c) => {
  const supabase = c.get('supabase');
  const attachmentId = c.req.param('id');

  if (!uuidRegex.test(attachmentId)) {
    return c.json({ error: 'Invalid attachment ID' }, 400);
  }

  const { data, error } = await supabase
    .from('attachments')
    .update({ archived_at: null })
    .eq('attachment_id', attachmentId)
    .select('*')
    .single();

  if (error || !data) {
    return c.json({ error: 'Failed to restore attachment' }, 500);
  }

  return c.json({ attachment: data });
});

// Admin-only R2 orphan detection
attachmentRoutes.get('/attachments/orphans', requireAdmin, async (c) => {
  const supabase = c.get('supabase');

  const { data: dbAttachments, error } = await supabase
    .from('attachments')
    .select('attachment_id, storage_key, original_filename, service_id, archived_at');

  if (error) {
    return c.json({ error: 'Failed to fetch attachment metadata' }, 500);
  }

  const dbKeys = new Set((dbAttachments ?? []).map((a) => a.storage_key));
  const r2Objects: Array<{ key: string; size: number; uploaded: string }> = [];
  const r2Keys = new Set<string>();

  let cursor: string | undefined;
  do {
    const listed = await c.env.FILES_BUCKET.list({ prefix: 'customers/', cursor, limit: 1000 });
    for (const obj of listed.objects) {
      r2Keys.add(obj.key);
      r2Objects.push({
        key: obj.key,
        size: obj.size,
        uploaded: obj.uploaded.toISOString(),
      });
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  const r2OnlyOrphans = r2Objects.filter((o) => !dbKeys.has(o.key));
  const missingInR2 = (dbAttachments ?? []).filter((a) => !r2Keys.has(a.storage_key));

  return c.json({
    total_db_attachments: (dbAttachments ?? []).length,
    total_r2_objects: r2Objects.length,
    r2_only_orphans: r2OnlyOrphans,
    missing_in_r2: missingInR2,
  });
});

// Admin-only cleanup of confirmed R2-only orphans (never deletes DB-tracked files)
attachmentRoutes.delete('/attachments/orphans', requireAdmin, async (c) => {
  const supabase = c.get('supabase');
  const user = c.get('authUser');

  let body: { keys?: string[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON request body' }, 400);
  }

  const keys = Array.isArray(body.keys) ? body.keys.filter((k) => typeof k === 'string') : [];
  if (keys.length === 0) {
    return c.json({ error: 'Provide storage keys to clean up' }, 400);
  }

  // Re-verify none of these keys exist in attachments table
  const { data: tracked } = await supabase
    .from('attachments')
    .select('storage_key')
    .in('storage_key', keys);

  const trackedSet = new Set((tracked ?? []).map((t) => t.storage_key));
  const safeToDelete = keys.filter((k) => k.startsWith('customers/') && !trackedSet.has(k));

  if (safeToDelete.length > 0) {
    await c.env.FILES_BUCKET.delete(safeToDelete);
    await supabase.from('audit_logs').insert({
      actor_id: user.id,
      actor_email: user.email,
      action: 'STORAGE_CLEANUP',
      entity_type: 'r2_orphans',
      new_values: { deleted_keys: safeToDelete },
    });
  }

  return c.json({
    deleted_count: safeToDelete.length,
    deleted_keys: safeToDelete,
    skipped_tracked_keys: Array.from(trackedSet),
  });
});
