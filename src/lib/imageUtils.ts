export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const COMPRESS_THRESHOLD_BYTES = 2 * 1024 * 1024;
const MAX_DIMENSION_PX = 2048;

const SUPPORTED_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'pdf',
]);

const MIME_ALIAS_MAP: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
};

export function inferFriendlyMimeType(file: File): string {
  const raw = (file.type || '').toLowerCase().trim();
  const normalized = MIME_ALIAS_MAP[raw] || raw;
  if (
    normalized === 'image/jpeg' ||
    normalized === 'image/png' ||
    normalized === 'image/webp' ||
    normalized === 'image/gif' ||
    normalized === 'application/pdf'
  ) {
    return normalized;
  }

  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'pdf') return 'application/pdf';
  return normalized;
}

export function isSupportedUploadFile(file: File): boolean {
  const mime = inferFriendlyMimeType(file);
  if (
    mime === 'image/jpeg' ||
    mime === 'image/png' ||
    mime === 'image/webp' ||
    mime === 'image/gif' ||
    mime === 'application/pdf'
  ) {
    return true;
  }
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}

/**
 * Resizes large mobile camera photos (> 2 MB or > 2048px) so uploads succeed
 * reliably over slow mobile data without hitting size limits.
 */
async function compressLargeImage(file: File, mime: string): Promise<File> {
  if (
    mime === 'application/pdf' ||
    mime === 'image/gif' ||
    typeof document === 'undefined' ||
    typeof createImageBitmap !== 'function'
  ) {
    return file;
  }

  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    const needsResize = width > MAX_DIMENSION_PX || height > MAX_DIMENSION_PX;
    const needsCompress = file.size > COMPRESS_THRESHOLD_BYTES;

    if (!needsResize && !needsCompress) {
      bitmap.close?.();
      return file;
    }

    const scale = needsResize ? Math.min(MAX_DIMENSION_PX / width, MAX_DIMENSION_PX / height) : 1;
    const targetW = Math.max(1, Math.round(width * scale));
    const targetH = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close?.();
      return file;
    }

    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    bitmap.close?.();

    const outputMime = mime === 'image/png' ? 'image/png' : 'image/jpeg';
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, outputMime, 0.85)
    );

    if (!blob || blob.size >= file.size) {
      return file;
    }

    const cleanBase = file.name.replace(/\.[^.]+$/, '') || 'photo';
    const nextExt = outputMime === 'image/png' ? 'png' : 'jpg';
    return new File([blob], `${cleanBase}.${nextExt}`, {
      type: outputMime,
      lastModified: Date.now(),
    });
  } catch {
    return file;
  }
}

export async function validateAndPrepareUploadFile(
  file: File
): Promise<{ ok: true; file: File; mime: string } | { ok: false; error: string }> {
  if (!isSupportedUploadFile(file)) {
    return {
      ok: false,
      error: `"${file.name}" cannot be uploaded. Please choose a photo (JPG, PNG, WEBP) or PDF document.`,
    };
  }

  if (file.size <= 0) {
    return {
      ok: false,
      error: `"${file.name}" appears empty. Please select another photo or file.`,
    };
  }

  const mime = inferFriendlyMimeType(file);
  const prepared = await compressLargeImage(file, mime);

  if (prepared.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      error: `"${file.name}" is larger than 15 MB. Please choose a smaller photo or file.`,
    };
  }

  return { ok: true, file: prepared, mime: prepared.type || mime };
}
