import { Hono } from 'hono';
import {
  ALLOWED_FILE_CATEGORIES,
  ALLOWED_MIME_TYPES,
  buildStoragePath,
  detectMimeFromMagicBytes,
} from '../lib/fileValidation';
import { requireAdmin } from '../lib/auth';
import type { AppBindings } from '../types';

export const fileRoutes = new Hono<AppBindings>();

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getBucketName(env: AppBindings['Bindings']): string {
  return env.STORAGE_BUCKET || 'zero-base-files';
}

async function listStoragePathsRecursive(
  supabase: AppBindings['Variables']['supabase'],
  bucket: string,
  prefix: string
): Promise<Array<{ path: string; size: number; updated_at: string }>> {
  const results: Array<{ path: string; size: number; updated_at: string }> = [];
  const { data: items, error } = await supabase.storage.from(bucket).list(prefix, { limit: 1000 });
  if (error || !items) return results;

  for (const item of items) {
    const fullPath = prefix ? `${prefix}/${item.name}` : item.name;
    // Supabase Storage returns id === null for folder prefixes
    if (item.id === null) {
      const nested = await listStoragePathsRecursive(supabase, bucket, fullPath);
      results.push(...nested);
    } else {
      const metaSize =
        typeof (item.metadata as { size?: unknown } | null)?.size === 'number'
          ? Number((item.metadata as { size: number }).size)
          : 0;
      results.push({
        path: fullPath,
        size: metaSize,
        updated_at: item.updated_at ?? item.created_at ?? new Date().toISOString(),
      });
    }
  }
  return results;
}

// POST /api/files/upload — Upload file to private Supabase Storage bucket `zero-base-files`
fileRoutes.post('/files/upload', async (c) => {
  const supabase = c.get('supabase');
  const user = c.get('authUser');
  const bucket = getBucketName(c.env);

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ error: 'Expected multipart/form-data upload' }, 400);
  }

  const fileEntry = formData.get('file');
  const serviceId = String(formData.get('service_id') ?? '').trim();
  const paymentIdRaw = String(formData.get('payment_id') ?? '').trim();
  const category = String(formData.get('category') ?? 'Other attachments').trim();

  if (!uuidRegex.test(serviceId)) {
    return c.json({ error: 'Valid service_id is required' }, 400);
  }

  if (paymentIdRaw && !uuidRegex.test(paymentIdRaw)) {
    return c.json({ error: 'Invalid payment_id format' }, 400);
  }

  if (!fileEntry || typeof fileEntry === 'string') {
    return c.json({ error: 'File field is required' }, 400);
  }

  if (
    !ALLOWED_FILE_CATEGORIES.includes(category as (typeof ALLOWED_FILE_CATEGORIES)[number])
  ) {
    return c.json(
      {
        error: 'Invalid file category',
        allowed_categories: ALLOWED_FILE_CATEGORIES,
      },
      400
    );
  }

  const { data: service, error: srvErr } = await supabase
    .from('services')
    .select('id, customer_id, archived_at')
    .eq('id', serviceId)
    .single();

  if (srvErr || !service) {
    return c.json({ error: 'Service record not found' }, 404);
  }
  if (service.archived_at) {
    return c.json({ error: 'Cannot upload files to an archived service' }, 400);
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
        error: 'Unsupported or invalid file content. Allowed formats: JPEG, PNG, WebP, GIF, PDF.',
      },
      400
    );
  }

  const fileId = crypto.randomUUID();
  const storagePath = buildStoragePath({
    customerId: service.customer_id,
    serviceId,
    fileId,
    filename: file.name || 'upload',
  });

  // Step 1: Upload to private Supabase Storage bucket
  const { error: uploadErr } = await supabase.storage
    .from(bucket)
    .upload(storagePath, bytes, {
      contentType: detectedMime,
      upsert: false,
    });

  if (uploadErr) {
    return c.json(
      {
        error: 'Failed to store file in private Supabase Storage. Please retry.',
        retryable: true,
      },
      502
    );
  }

  // Step 2: Persist metadata in public.service_files
  const { data: record, error: dbErr } = await supabase
    .from('service_files')
    .insert({
      id: fileId,
      customer_id: service.customer_id,
      service_id: serviceId,
      payment_id: paymentIdRaw || null,
      file_name: file.name || 'upload',
      storage_path: storagePath,
      mime_type: detectedMime,
      file_size: file.size,
      category,
      uploaded_by: user.id,
    })
    .select('*')
    .single();

  if (dbErr || !record) {
    // Compensating rollback in Supabase Storage so orphaned objects aren't left behind
    const { error: rmErr } = await supabase.storage.from(bucket).remove([storagePath]);
    return c.json(
      {
        error: 'File uploaded to storage, but database metadata failed to save. Please retry.',
        retryable: true,
        orphaned_storage_path: rmErr ? storagePath : null,
      },
      500
    );
  }

  return c.json({ file: record }, 201);
});

// GET /api/files/orphans — Compare Supabase Storage `zero-base-files` vs `service_files`
fileRoutes.get('/files/orphans', requireAdmin, async (c) => {
  const supabase = c.get('supabase');
  const bucket = getBucketName(c.env);

  const { data: dbFiles, error } = await supabase
    .from('service_files')
    .select('id, storage_path, file_name, service_id, archived_at');

  if (error) {
    return c.json({ error: 'Failed to fetch service_files metadata' }, 500);
  }

  const dbPaths = new Set((dbFiles ?? []).map((f) => f.storage_path));
  const storageObjects = await listStoragePathsRecursive(supabase, bucket, 'customers');
  const storagePaths = new Set(storageObjects.map((o) => o.path));

  const storageOnlyOrphans = storageObjects.filter((o) => !dbPaths.has(o.path));
  const missingInStorage = (dbFiles ?? []).filter((f) => !storagePaths.has(f.storage_path));

  return c.json({
    total_db_files: (dbFiles ?? []).length,
    total_storage_objects: storageObjects.length,
    storage_only_orphans: storageOnlyOrphans,
    missing_in_storage: missingInStorage,
  });
});

// DELETE /api/files/orphans — Remove confirmed storage-only orphan objects
fileRoutes.delete('/files/orphans', requireAdmin, async (c) => {
  const supabase = c.get('supabase');
  const user = c.get('authUser');
  const bucket = getBucketName(c.env);

  let body: { paths?: string[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON request body' }, 400);
  }

  const paths = Array.isArray(body.paths) ? body.paths.filter((p) => typeof p === 'string') : [];
  if (paths.length === 0) {
    return c.json({ error: 'Provide storage paths to clean up' }, 400);
  }

  const { data: tracked } = await supabase
    .from('service_files')
    .select('storage_path')
    .in('storage_path', paths);

  const trackedSet = new Set((tracked ?? []).map((t) => t.storage_path));
  const safeToDelete = paths.filter((p) => p.startsWith('customers/') && !trackedSet.has(p));

  if (safeToDelete.length > 0) {
    const { error: rmErr } = await supabase.storage.from(bucket).remove(safeToDelete);
    if (rmErr) {
      return c.json({ error: 'Failed to remove orphaned objects from storage' }, 500);
    }

    await supabase.from('audit_logs').insert({
      actor_id: user.id,
      actor_email: user.email,
      action: 'STORAGE_CLEANUP',
      entity_type: 'storage_orphans',
      new_values: { deleted_paths: safeToDelete },
    });
  }

  return c.json({
    deleted_count: safeToDelete.length,
    deleted_paths: safeToDelete,
    skipped_tracked_paths: Array.from(trackedSet),
  });
});

// GET /api/files/:id — Generate short-lived signed access URLs (5 minutes, never permanent)
fileRoutes.get('/files/:id', async (c) => {
  const supabase = c.get('supabase');
  const fileId = c.req.param('id');
  const bucket = getBucketName(c.env);

  if (!uuidRegex.test(fileId)) {
    return c.json({ error: 'Invalid file ID' }, 400);
  }

  const { data: fileRow, error } = await supabase
    .from('service_files')
    .select('id, storage_path, file_name, mime_type, file_size, category, archived_at')
    .eq('id', fileId)
    .single();

  if (error || !fileRow) {
    return c.json({ error: 'File metadata not found' }, 404);
  }

  const [viewRes, downloadRes] = await Promise.all([
    supabase.storage.from(bucket).createSignedUrl(fileRow.storage_path, 300),
    supabase.storage
      .from(bucket)
      .createSignedUrl(fileRow.storage_path, 300, { download: fileRow.file_name }),
  ]);

  if (viewRes.error || !viewRes.data?.signedUrl) {
    return c.json({ error: 'Unable to generate temporary signed URL for file' }, 500);
  }

  return c.json({
    file: fileRow,
    url: viewRes.data.signedUrl,
    download_url: downloadRes.data?.signedUrl ?? viewRes.data.signedUrl,
    expires_in_seconds: 300,
    expires_at: new Date(Date.now() + 300_000).toISOString(),
  });
});

// DELETE /api/files/:id — Authorized file deletion (removes storage object + metadata row)
fileRoutes.delete('/files/:id', async (c) => {
  const supabase = c.get('supabase');
  const fileId = c.req.param('id');
  const bucket = getBucketName(c.env);

  if (!uuidRegex.test(fileId)) {
    return c.json({ error: 'Invalid file ID' }, 400);
  }

  const { data: fileRow, error: findErr } = await supabase
    .from('service_files')
    .select('id, storage_path, file_name')
    .eq('id', fileId)
    .single();

  if (findErr || !fileRow) {
    return c.json({ error: 'File metadata not found' }, 404);
  }

  const { error: storageErr } = await supabase.storage
    .from(bucket)
    .remove([fileRow.storage_path]);

  if (storageErr) {
    return c.json({ error: 'Failed to delete file from Supabase Storage' }, 500);
  }

  const { error: dbErr } = await supabase
    .from('service_files')
    .delete()
    .eq('id', fileId);

  if (dbErr) {
    return c.json({ error: 'File deleted from storage, but failed to remove metadata record' }, 500);
  }

  return c.json({ deleted: true, id: fileId });
});
