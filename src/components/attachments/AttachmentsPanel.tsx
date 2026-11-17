import React, { useRef, useState } from 'react';
import {
  Download,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { formatBytes, formatDateTimeIst } from '../../lib/format';
import {
  FILE_CATEGORIES,
  type FileCategory,
  type ServiceFileRecord,
} from '../../types/domain';
import { Badge } from '../ui/Badge';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Modal } from '../ui/Modal';

interface FailedUpload {
  id: string;
  file: File;
  category: FileCategory;
  error: string;
}

interface AttachmentsPanelProps {
  serviceId: string;
  files: ServiceFileRecord[];
  onChanged: () => void;
}

export function AttachmentsPanel({
  serviceId,
  files,
  onChanged,
}: AttachmentsPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState<FileCategory>('Before-Service Area Photos');
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [failedUploads, setFailedUploads] = useState<FailedUpload[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [previewItem, setPreviewItem] = useState<{
    record: ServiceFileRecord;
    url: string;
    downloadUrl: string;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ServiceFileRecord | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const uploadSingleFile = async (file: File, cat: FileCategory, retryId?: string) => {
    const form = new FormData();
    form.append('file', file);
    form.append('service_id', serviceId);
    form.append('category', cat);

    try {
      await apiFetch<{ file: ServiceFileRecord }>('/api/files/upload', {
        method: 'POST',
        body: form,
      });
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

  const processFiles = async (selected: File[]) => {
    if (selected.length === 0) return;
    setError(null);
    setUploading(true);
    for (const file of selected) {
      await uploadSingleFile(file, category);
    }
    setUploading(false);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files ?? []);
    await processFiles(selected);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const openFile = async (record: ServiceFileRecord, mode: 'preview' | 'download') => {
    setLoadingId(record.id);
    setError(null);
    try {
      const link = await apiFetch<{ url: string; download_url: string; expires_at: string }>(
        `/api/files/${record.id}`
      );
      if (mode === 'download') {
        window.open(link.download_url, '_blank', 'noopener,noreferrer');
      } else if (record.mime_type.startsWith('image/')) {
        setPreviewItem({ record, url: link.url, downloadUrl: link.download_url });
      } else {
        window.open(link.url, '_blank', 'noopener,noreferrer');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to generate temporary signed link');
    } finally {
      setLoadingId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setLoadingId(deleteTarget.id);
    try {
      await apiFetch(`/api/files/${deleteTarget.id}`, {
        method: 'DELETE',
      });
      setDeleteTarget(null);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete file');
    } finally {
      setLoadingId(null);
    }
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        void processFiles(Array.from(e.dataTransfer.files));
      }}
      className={`zb-card p-5 space-y-4 transition ${dragOver ? 'border-accent bg-accent-soft/30' : ''}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">
            Service Attachments &amp; Photos (Private Supabase Storage)
          </h3>
          <p className="text-xs text-text-secondary">
            Drag &amp; drop files here or click Upload • Stored privately in <code>zero-base-files</code>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as FileCategory)}
            aria-label="Upload category"
            className="rounded-lg border px-3 py-1.5 text-xs"
          >
            {FILE_CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp,application/pdf"
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

      {files.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-8 text-center text-xs text-text-muted">
          No photos or bills uploaded yet for this service. Drag files here to upload.
        </div>
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border">
          {files.map((f) => {
            const isImage = f.mime_type.startsWith('image/');
            const busy = loadingId === f.id;
            return (
              <div
                key={f.id}
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
                      {f.file_name}
                    </p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
                      <Badge variant="accent">{f.category}</Badge>
                      <span>{formatBytes(f.file_size)}</span>
                      <span>• Uploaded {formatDateTimeIst(f.uploaded_at)}</span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void openFile(f, 'preview')}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-text-primary hover:bg-bg disabled:opacity-50"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    View
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void openFile(f, 'download')}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-text-primary hover:bg-bg disabled:opacity-50"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Download
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setDeleteTarget(f)}
                    aria-label={`Delete ${f.file_name}`}
                    className="rounded-md p-1.5 text-text-muted hover:bg-error-soft hover:text-error"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
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
        title={previewItem?.record.file_name ?? 'File Preview'}
        subtitle={previewItem?.record.category}
        maxWidthClass="max-w-3xl"
      >
        {previewItem && (
          <div className="space-y-4">
            <div className="overflow-hidden rounded-lg border border-border bg-bg text-center">
              <img
                src={previewItem.url}
                alt={previewItem.record.file_name}
                loading="lazy"
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
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void handleDelete()}
        title="Delete File"
        message={`Permanently delete "${deleteTarget?.file_name}" from Supabase Storage (zero-base-files) and remove its metadata record?`}
        confirmLabel="Delete File"
        danger
        loading={Boolean(deleteTarget && loadingId === deleteTarget.id)}
      />
    </div>
  );
}
