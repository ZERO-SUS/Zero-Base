import React, { useRef, useState } from 'react';
import {
  Archive,
  Download,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  RefreshCw,
  Upload,
} from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { formatBytes, formatDateTimeIst } from '../../lib/format';
import {
  ATTACHMENT_CATEGORIES,
  type AttachmentCategory,
  type AttachmentRecord,
} from '../../types/domain';
import { Badge } from '../ui/Badge';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Modal } from '../ui/Modal';

interface FailedUpload {
  id: string;
  file: File;
  category: AttachmentCategory;
  error: string;
}

interface AttachmentsPanelProps {
  serviceId: string;
  attachments: AttachmentRecord[];
  onChanged: () => void;
}

export function AttachmentsPanel({
  serviceId,
  attachments,
  onChanged,
}: AttachmentsPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState<AttachmentCategory>('Before-cleaning photos');
  const [uploading, setUploading] = useState(false);
  const [failedUploads, setFailedUploads] = useState<FailedUpload[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [previewItem, setPreviewItem] = useState<{
    record: AttachmentRecord;
    url: string;
    downloadUrl: string;
  } | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<AttachmentRecord | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const uploadSingleFile = async (file: File, cat: AttachmentCategory, retryId?: string) => {
    const form = new FormData();
    form.append('file', file);
    form.append('category', cat);

    try {
      await apiFetch<{ attachment: AttachmentRecord }>(
        `/api/services/${serviceId}/attachments`,
        {
          method: 'POST',
          body: form,
        }
      );
      if (retryId) {
        setFailedUploads((prev) => prev.filter((item) => item.id !== retryId));
      }
      onChanged();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Upload failed due to network error';
      if (retryId) {
        setFailedUploads((prev) =>
          prev.map((item) => (item.id === retryId ? { ...item, error: message } : item))
        );
      } else {
        setFailedUploads((prev) => [
          ...prev,
          { id: crypto.randomUUID(), file, category: cat, error: message },
        ]);
      }
      setError(message);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;

    setError(null);
    setUploading(true);
    for (const file of files) {
      await uploadSingleFile(file, category);
    }
    setUploading(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const openAttachment = async (record: AttachmentRecord, mode: 'preview' | 'download') => {
    setLoadingId(record.attachment_id);
    setError(null);
    try {
      const link = await apiFetch<{ url: string; download_url: string; expires_at: string }>(
        `/api/attachments/${record.attachment_id}/access-link`
      );
      if (mode === 'download') {
        window.open(link.download_url, '_blank', 'noopener,noreferrer');
      } else if (record.mime_type.startsWith('image/')) {
        setPreviewItem({ record, url: link.url, downloadUrl: link.download_url });
      } else {
        window.open(link.url, '_blank', 'noopener,noreferrer');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to generate temporary access link');
    } finally {
      setLoadingId(null);
    }
  };

  const handleArchive = async () => {
    if (!archiveTarget) return;
    setLoadingId(archiveTarget.attachment_id);
    try {
      await apiFetch(`/api/attachments/${archiveTarget.attachment_id}/archive`, {
        method: 'POST',
      });
      setArchiveTarget(null);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to archive attachment');
    } finally {
      setLoadingId(null);
    }
  };

  return (
    <div className="zb-card p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">
            Cloud Photos & Documents (Private R2)
          </h3>
          <p className="text-xs text-text-secondary">
            Stored privately in Cloudflare R2 with short-lived authorized access links
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as AttachmentCategory)}
            aria-label="Upload category"
            className="rounded-lg border px-3 py-1.5 text-xs"
          >
            {ATTACHMENT_CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"
            onChange={handleFileChange}
            className="hidden"
          />
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
            className="zb-btn-primary inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-50"
          >
            <Upload className="h-3.5 w-3.5" />
            {uploading ? 'Uploading...' : 'Upload Files'}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-error/30 bg-error-soft px-3.5 py-2 text-xs text-error">
          {error}
        </div>
      )}

      {failedUploads.length > 0 && (
        <div className="space-y-2 rounded-lg border border-warning/30 bg-warning-soft p-3">
          <p className="text-xs font-semibold text-warning">
            Failed Uploads — Retry Available
          </p>
          {failedUploads.map((item) => (
            <div
              key={item.id}
              className="flex items-center justify-between gap-2 rounded-md bg-surface px-3 py-2 text-xs"
            >
              <div className="min-w-0">
                <p className="truncate font-medium text-text-primary">{item.file.name}</p>
                <p className="text-error">{item.error}</p>
              </div>
              <button
                type="button"
                onClick={() => void uploadSingleFile(item.file, item.category, item.id)}
                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-bg"
              >
                <RefreshCw className="h-3 w-3" />
                Retry
              </button>
            </div>
          ))}
        </div>
      )}

      {attachments.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-8 text-center text-xs text-text-muted">
          No photos or bills uploaded yet for this service.
        </div>
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border">
          {attachments.map((att) => {
            const isImage = att.mime_type.startsWith('image/');
            const busy = loadingId === att.attachment_id;
            return (
              <div
                key={att.attachment_id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="rounded-lg border border-border bg-bg p-2 text-text-secondary">
                    {isImage ? (
                      <ImageIcon className="h-4 w-4" />
                    ) : (
                      <FileText className="h-4 w-4" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-text-primary">
                      {att.original_filename}
                    </p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
                      <Badge variant="accent">{att.category}</Badge>
                      <span>{formatBytes(att.file_size)}</span>
                      <span>• {formatDateTimeIst(att.uploaded_at)}</span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void openAttachment(att, 'preview')}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-text-primary hover:bg-bg disabled:opacity-50"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    View
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void openAttachment(att, 'download')}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-text-primary hover:bg-bg disabled:opacity-50"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Download
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setArchiveTarget(att)}
                    aria-label={`Archive ${att.original_filename}`}
                    className="rounded-md p-1.5 text-text-muted hover:bg-error-soft hover:text-error"
                  >
                    <Archive className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Modal
        open={Boolean(previewItem)}
        onClose={() => setPreviewItem(null)}
        title={previewItem?.record.original_filename ?? 'Attachment Preview'}
        subtitle={previewItem?.record.category}
        maxWidthClass="max-w-3xl"
      >
        {previewItem && (
          <div className="space-y-4">
            <div className="overflow-hidden rounded-lg border border-border bg-bg text-center">
              <img
                src={previewItem.url}
                alt={previewItem.record.original_filename}
                className="mx-auto max-h-[65vh] w-auto object-contain"
              />
            </div>
            <div className="flex justify-end">
              <a
                href={previewItem.downloadUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="zb-btn-primary inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-medium"
              >
                <Download className="h-3.5 w-3.5" />
                Download Original
              </a>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(archiveTarget)}
        onClose={() => setArchiveTarget(null)}
        onConfirm={() => void handleArchive()}
        title="Archive Attachment"
        message={`Archive "${archiveTarget?.original_filename}"? The file metadata will be hidden from active views and retained in audit/backup history.`}
        confirmLabel="Archive File"
        danger
        loading={Boolean(archiveTarget && loadingId === archiveTarget.attachment_id)}
      />
    </div>
  );
}
