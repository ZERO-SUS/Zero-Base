import { useRef, useState } from 'react';
import {
  Camera,
  CheckCircle2,
  Download,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  XCircle,
} from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { formatBytes, formatDateTimeIst } from '../../lib/format';
import { validateAndPrepareUploadFile } from '../../lib/imageUtils';
import {
  type FileCategory,
  type ServiceFileRecord,
} from '../../types/domain';
import { Badge } from '../ui/Badge';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Modal } from '../ui/Modal';

interface ActiveUploadItem {
  id: string;
  file: File;
  category: FileCategory;
  previewUrl: string | null;
  status: 'uploading' | 'uploaded' | 'failed';
  error?: string;
}

const SIMPLE_SECTIONS: Array<{
  title: string;
  category: FileCategory;
  buttonLabel: string;
  accept: string;
  isImageSection: boolean;
}> = [
  {
    title: 'BEFORE SERVICE',
    category: 'Before-Service Area Photos',
    buttonLabel: 'Add Photo',
    accept: 'image/jpeg,image/png,image/webp,image/gif,image/*',
    isImageSection: true,
  },
  {
    title: 'AFTER SERVICE',
    category: 'After-Service Area Photos',
    buttonLabel: 'Add Photo',
    accept: 'image/jpeg,image/png,image/webp,image/gif,image/*',
    isImageSection: true,
  },
  {
    title: 'OTHER DOCUMENTS',
    category: 'Other Attachments',
    buttonLabel: 'Add File',
    accept: 'image/jpeg,image/png,image/webp,image/gif,application/pdf,.pdf,image/*',
    isImageSection: false,
  },
];

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
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const cameraRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [queueItems, setQueueItems] = useState<ActiveUploadItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [previewItem, setPreviewItem] = useState<{
    record: ServiceFileRecord;
    url: string;
    downloadUrl: string;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ServiceFileRecord | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const uploadSingleItem = async (item: ActiveUploadItem) => {
    setQueueItems((prev) =>
      prev.map((q) => (q.id === item.id ? { ...q, status: 'uploading', error: undefined } : q))
    );

    const form = new FormData();
    form.append('file', item.file);
    form.append('service_id', serviceId);
    form.append('category', item.category);

    try {
      await apiFetch<{ file: ServiceFileRecord }>('/api/files/upload', {
        method: 'POST',
        body: form,
      });
      setQueueItems((prev) =>
        prev.map((q) => (q.id === item.id ? { ...q, status: 'uploaded', error: undefined } : q))
      );
      onChanged();
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : "Photo couldn't be uploaded. Please try again.";
      setQueueItems((prev) =>
        prev.map((q) => (q.id === item.id ? { ...q, status: 'failed', error: message } : q))
      );
    }
  };

  const processFiles = async (selected: File[], cat: FileCategory) => {
    if (selected.length === 0) return;
    setError(null);

    const preparedItems: ActiveUploadItem[] = [];
    for (const rawFile of selected) {
      const prep = await validateAndPrepareUploadFile(rawFile);
      if (!prep.ok) {
        setError(prep.error);
        continue;
      }
      const isImg = prep.mime.startsWith('image/');
      preparedItems.push({
        id: crypto.randomUUID(),
        file: prep.file,
        category: cat,
        previewUrl: isImg ? URL.createObjectURL(prep.file) : null,
        status: 'uploading',
      });
    }

    if (preparedItems.length === 0) return;
    setQueueItems((prev) => [...prev, ...preparedItems]);

    // Upload sequentially/independently so one failure never stops the rest
    for (const item of preparedItems) {
      await uploadSingleItem(item);
    }
  };

  const removeQueueItem = (id: string) => {
    setQueueItems((prev) => {
      const target = prev.find((q) => q.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((q) => q.id !== id);
    });
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
    <div className="zb-card p-5 space-y-4">
      <div>
        <h3 className="text-base font-semibold text-text-primary">Photos &amp; Documents</h3>
        <p className="text-xs text-text-secondary">
          Add Before Service photos, After Service photos, or bills &amp; receipts (max 15 MB per file).
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-error/30 bg-error-soft px-3.5 py-2.5 text-xs text-error">
          {error}
        </div>
      )}

      {/* Simple 3-section upload buttons */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {SIMPLE_SECTIONS.map((sec) => {
          const sectionQueue = queueItems.filter((q) => q.category === sec.category);
          return (
            <div
              key={sec.category}
              className="rounded-xl border border-border bg-bg p-3.5 space-y-2.5"
            >
              <p className="text-xs font-bold uppercase tracking-wider text-text-primary">
                {sec.title}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => inputRefs.current[sec.category]?.click()}
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-xs font-semibold text-text-primary hover:bg-elevated"
                >
                  <Plus className="h-3.5 w-3.5 text-accent" />
                  {sec.buttonLabel}
                </button>
                {sec.isImageSection && (
                  <button
                    type="button"
                    onClick={() => cameraRefs.current[sec.category]?.click()}
                    className="inline-flex items-center justify-center gap-1 rounded-lg border border-border bg-surface px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary sm:hidden"
                    aria-label={`Take camera photo for ${sec.title}`}
                  >
                    <Camera className="h-3.5 w-3.5" />
                    Camera
                  </button>
                )}
              </div>

              <input
                ref={(el) => {
                  inputRefs.current[sec.category] = el;
                }}
                type="file"
                multiple
                accept={sec.accept}
                className="hidden"
                onChange={(e) => {
                  const list = Array.from(e.target.files ?? []);
                  void processFiles(list, sec.category);
                  e.target.value = '';
                }}
              />
              {sec.isImageSection && (
                <input
                  ref={(el) => {
                    cameraRefs.current[sec.category] = el;
                  }}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={(e) => {
                    const list = Array.from(e.target.files ?? []);
                    void processFiles(list, sec.category);
                    e.target.value = '';
                  }}
                />
              )}

              {sectionQueue.length > 0 && (
                <div className="space-y-2 pt-1">
                  {sectionQueue.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface p-2 text-xs"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {item.previewUrl ? (
                          <img
                            src={item.previewUrl}
                            alt={item.file.name}
                            className="h-10 w-10 rounded object-cover shrink-0"
                          />
                        ) : (
                          <FileText className="h-7 w-7 text-text-muted shrink-0" />
                        )}
                        <div className="min-w-0">
                          <p className="truncate font-medium text-text-primary">{item.file.name}</p>
                          {item.status === 'uploading' && (
                            <span className="inline-flex items-center gap-1 text-[11px] text-accent">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              Uploading...
                            </span>
                          )}
                          {item.status === 'uploaded' && (
                            <span className="inline-flex items-center gap-1 text-[11px] text-success">
                              <CheckCircle2 className="h-3 w-3" />
                              Uploaded
                            </span>
                          )}
                          {item.status === 'failed' && (
                            <span className="inline-flex items-center gap-1 text-[11px] text-error">
                              <XCircle className="h-3 w-3" />
                              {item.error || 'Failed'}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        {item.status === 'failed' && (
                          <button
                            type="button"
                            onClick={() => void uploadSingleItem(item)}
                            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] font-medium hover:bg-bg"
                          >
                            <RefreshCw className="h-3 w-3" />
                            Retry
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => removeQueueItem(item.id)}
                          className="p-1 text-text-muted hover:text-error"
                          aria-label="Remove"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {files.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-8 text-center text-xs text-text-muted">
          No photos or documents saved for this service yet.
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
