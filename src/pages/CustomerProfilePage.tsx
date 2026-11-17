import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Bell,
  Download,
  Edit3,
  FileText,
  Image as ImageIcon,
  MapPin,
  Phone,
  Plus,
  Trash2,
} from 'lucide-react';
import { CustomerFormModal } from '../components/customers/CustomerFormModal';
import { ServiceFormModal } from '../components/services/ServiceFormModal';
import { Badge, PaymentStatusBadge, ReminderCategoryBadge } from '../components/ui/Badge';
import { EmptyState, ErrorBanner, SkeletonCard } from '../components/ui/Feedback';
import { Modal } from '../components/ui/Modal';
import { useAuth } from '../context/AuthContext';
import { apiFetch, ApiError } from '../lib/api';
import {
  formatBytes,
  formatCurrency,
  formatDateTimeIst,
  formatDayMonth,
  formatServiceDate,
  getMonthName,
} from '../lib/format';
import type {
  Customer,
  PaymentRecord,
  ReminderCategory,
  ReminderRecord,
  ServiceFileRecord,
  ServiceRecord,
  YearMonthGroup,
} from '../types/domain';

interface CustomerProfileResponse {
  customer: Customer;
  summary: {
    total_services: number;
    first_service_date?: string | null;
    last_service_date: string | null;
    total_billed: number;
    total_paid: number;
    outstanding_amount: number;
    next_scheduled_service: string | null;
  };
  services: ServiceRecord[];
  services_grouped?: YearMonthGroup[];
  payments: PaymentRecord[];
  reminders: ReminderRecord[];
  files: ServiceFileRecord[];
}

interface DeletionImpact {
  services_count: number;
  payments_count: number;
  reminders_count: number;
  files_count: number;
}

export function CustomerProfilePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { settings } = useAuth();
  const sym = settings.currency_symbol || '₹';

  const [data, setData] = useState<CustomerProfileResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editModalOpen, setEditModalOpen] = useState(false);
  const [serviceModalOpen, setServiceModalOpen] = useState(false);

  // Safe deletion modal (Archive vs Permanent Delete with impact check)
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleteMode, setDeleteMode] = useState<'archive' | 'permanent'>('archive');
  const [deletionImpact, setDeletionImpact] = useState<DeletionImpact | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadProfile = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<CustomerProfileResponse>(`/api/customers/${id}`);
      setData(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load customer profile.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  const openDeleteDialog = async (mode: 'archive' | 'permanent') => {
    if (!data) return;
    setDeleteMode(mode);
    setDeleteModalOpen(true);
    setDeletionImpact(null);
    try {
      const res = await apiFetch<{ impact: DeletionImpact }>(
        `/api/customers/${data.customer.id}/deletion-impact`
      );
      setDeletionImpact(res.impact);
    } catch {
      // Non-blocking fallback
    }
  };

  const handleConfirmDelete = async () => {
    if (!data) return;
    setDeleting(true);
    setError(null);
    try {
      if (data.customer.archived_at && deleteMode === 'archive') {
        await apiFetch(`/api/customers/${data.customer.id}/restore`, { method: 'POST' });
        setDeleteModalOpen(false);
        void loadProfile();
      } else if (deleteMode === 'permanent') {
        await apiFetch(`/api/customers/${data.customer.id}?mode=permanent`, {
          method: 'DELETE',
        });
        setDeleteModalOpen(false);
        navigate('/customers', { replace: true });
      } else {
        await apiFetch(`/api/customers/${data.customer.id}?mode=archive`, {
          method: 'DELETE',
        });
        setDeleteModalOpen(false);
        void loadProfile();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to complete customer action.');
    } finally {
      setDeleting(false);
    }
  };

  const openSignedFile = async (fileId: string) => {
    try {
      const res = await apiFetch<{ url: string }>(`/api/files/${fileId}`);
      window.open(res.url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to open file.');
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <SkeletonCard lines={4} />
        <SkeletonCard lines={4} />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <Link to="/customers" className="inline-flex items-center gap-1.5 text-xs text-accent hover:underline">
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Customers
        </Link>
        <ErrorBanner message={error ?? 'Customer not found'} onRetry={() => void loadProfile()} />
      </div>
    );
  }

  const { customer, summary, services, services_grouped, payments, reminders, files } = data;
  const firstDate =
    summary.first_service_date ??
    (services.length > 0 ? services[services.length - 1].service_date : null);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Link
            to="/customers"
            className="mb-2 inline-flex items-center gap-1.5 text-xs font-medium text-text-secondary hover:text-text-primary"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            All Customers
          </Link>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight text-text-primary">
              {customer.full_name}
            </h1>
            <Badge variant="accent">{customer.customer_code}</Badge>
            {customer.archived_at && <Badge variant="warning">Archived</Badge>}
          </div>
          <p className="mt-0.5 font-mono text-xs text-text-muted">UUID: {customer.id}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setEditModalOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-xs font-medium text-text-primary hover:bg-bg"
          >
            <Edit3 className="h-3.5 w-3.5" />
            Edit
          </button>
          <button
            type="button"
            onClick={() => void openDeleteDialog('archive')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg hover:text-text-primary"
          >
            {customer.archived_at ? (
              <>
                <ArchiveRestore className="h-3.5 w-3.5" />
                Restore
              </>
            ) : (
              <>
                <Archive className="h-3.5 w-3.5" />
                Archive
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => void openDeleteDialog('permanent')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-error/30 bg-surface px-3 py-2 text-xs font-medium text-error hover:bg-error-soft"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </button>
          {!customer.archived_at && (
            <button
              type="button"
              onClick={() => setServiceModalOpen(true)}
              className="zb-btn-primary inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-medium"
            >
              <Plus className="h-3.5 w-3.5" />
              Add Service
            </button>
          )}
        </div>
      </div>

      {/* Contact & Summary */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="zb-card p-5 space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
            Contact &amp; Address
          </h2>
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <Phone className="h-4 w-4 text-text-muted shrink-0" />
              <span className="font-mono text-text-primary">{customer.phone_number}</span>
            </div>
            {customer.alternate_phone && (
              <div className="flex items-center gap-2">
                <Phone className="h-4 w-4 text-text-muted shrink-0" />
                <span className="font-mono text-text-secondary">{customer.alternate_phone}</span>
              </div>
            )}
            <div className="flex items-start gap-2">
              <MapPin className="mt-0.5 h-4 w-4 text-text-muted shrink-0" />
              <div className="text-text-secondary">
                <p className="text-text-primary">{customer.address}</p>
                {customer.area && <p>{customer.area}</p>}
              </div>
            </div>
          </div>
          {customer.notes && (
            <div className="rounded-lg border border-border bg-bg p-3 text-xs text-text-secondary">
              {customer.notes}
            </div>
          )}
        </div>

        <div className="lg:col-span-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="zb-card p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
              Total Services
            </p>
            <p className="mt-1.5 text-xl font-semibold text-text-primary">
              {summary.total_services}
            </p>
          </div>
          <div className="zb-card p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
              First Recorded Service
            </p>
            <p className="mt-1.5 text-base font-semibold text-text-primary">
              {formatServiceDate(firstDate)}
            </p>
          </div>
          <div className="zb-card p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
              Most Recent Service
            </p>
            <p className="mt-1.5 text-base font-semibold text-text-primary">
              {formatServiceDate(summary.last_service_date)}
            </p>
          </div>
          <div className="zb-card p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
              Total Service Value
            </p>
            <p className="mt-1.5 text-xl font-semibold text-text-primary">
              {formatCurrency(summary.total_billed, sym)}
            </p>
          </div>
          <div className="zb-card p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
              Total Amount Paid
            </p>
            <p className="mt-1.5 text-xl font-semibold text-success">
              {formatCurrency(summary.total_paid, sym)}
            </p>
          </div>
          <div className="zb-card p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
              Outstanding Balance
            </p>
            <p
              className={`mt-1.5 text-xl font-semibold ${
                summary.outstanding_amount > 0 ? 'text-error' : 'text-text-primary'
              }`}
            >
              {formatCurrency(summary.outstanding_amount, sym)}
            </p>
          </div>
        </div>
      </div>

      {/* Upcoming Reminders for Customer */}
      {reminders.length > 0 && (
        <section className="zb-card p-4 space-y-2.5">
          <div className="flex items-center gap-2">
            <Bell className="h-4 w-4 text-accent" />
            <h2 className="text-sm font-semibold text-text-primary">
              Upcoming &amp; Active Reminders ({reminders.length})
            </h2>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {reminders.map((r) => (
              <div
                key={r.id}
                className="flex items-center justify-between rounded-lg border border-border bg-bg px-3.5 py-2.5 text-xs"
              >
                <div>
                  <p className="font-semibold text-text-primary">
                    Due {formatServiceDate(r.due_date)}
                  </p>
                  {r.notes && <p className="text-text-secondary">{r.notes}</p>}
                </div>
                <ReminderCategoryBadge category={(r.category ?? 'Upcoming') as ReminderCategory} />
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Year-Wise Grouped Customer Service History (Newest First) */}
      <section className="zb-card overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h2 className="text-sm font-semibold text-text-primary">
            Year-Wise Service History ({services.length})
          </h2>
          <span className="text-[11px] text-text-muted">Grouped by service_date (newest first)</span>
        </div>

        {services.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title="No cleaning services recorded for this customer"
              description="Click 'Add Service' above to record their first tank cleaning operation."
            />
          </div>
        ) : services_grouped && services_grouped.length > 0 ? (
          <div className="divide-y divide-border">
            {services_grouped.map((yr) => (
              <div key={yr.year} className="p-5 space-y-4">
                <h3 className="text-base font-bold text-text-primary">{yr.year}</h3>
                <div className="space-y-3 pl-3 border-l-2 border-border">
                  {yr.months.map((m) => (
                    <div key={`${yr.year}-${m.month}`} className="space-y-2">
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
                        {getMonthName(m.month)}
                      </h4>
                      <div className="divide-y divide-border rounded-lg border border-border bg-bg/40">
                        {m.records.map((srv) => (
                          <Link
                            key={srv.id}
                            to={`/services/${srv.id}`}
                            className="flex flex-col gap-2 px-4 py-3 transition hover:bg-bg sm:flex-row sm:items-center sm:justify-between"
                          >
                            <div>
                              <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-text-primary">
                                <span className="text-accent font-semibold">
                                  {formatDayMonth(srv.service_date)}
                                </span>
                                <span className="text-text-muted">—</span>
                                {srv.service_categories_snapshot &&
                                srv.service_categories_snapshot.length > 0 ? (
                                  <span className="inline-flex flex-wrap items-center gap-1">
                                    {srv.service_categories_snapshot.map((cat) => (
                                      <Badge key={cat} variant="neutral">
                                        {cat}
                                      </Badge>
                                    ))}
                                  </span>
                                ) : (
                                  <span>{srv.service_type}</span>
                                )}
                                {srv.tank_details && (
                                  <span className="text-xs text-text-secondary">
                                    ({srv.tank_details})
                                  </span>
                                )}
                              </div>
                              <p className="text-[11px] text-text-muted mt-0.5">
                                Recorded (IST): {formatDateTimeIst(srv.created_at)}
                              </p>
                            </div>
                            <div className="flex items-center gap-3 shrink-0">
                              <span className="text-sm font-semibold text-text-primary">
                                {formatCurrency(srv.total_amount, sym)}
                              </span>
                              <PaymentStatusBadge status={srv.payment_status} />
                            </div>
                          </Link>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      {/* Previous Payments & Uploaded Files */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="zb-card overflow-hidden">
          <div className="border-b border-border px-5 py-3.5">
            <h2 className="text-sm font-semibold text-text-primary">
              Payment Transactions ({payments.length})
            </h2>
          </div>
          {payments.length === 0 ? (
            <div className="p-5 text-xs text-text-muted">No payments recorded for this customer yet.</div>
          ) : (
            <div className="divide-y divide-border">
              {payments.map((p) => (
                <div key={p.id} className="flex items-center justify-between px-5 py-3 text-xs">
                  <div>
                    <p className="font-medium text-text-primary">
                      {formatServiceDate(p.payment_date)} • {p.payment_method}
                    </p>
                    <p className="text-text-muted">
                      {p.reference_number ? `Ref: ${p.reference_number}` : 'No reference'}
                    </p>
                  </div>
                  <span className="text-sm font-semibold text-text-primary">
                    {p.payment_type === 'refund' ? '-' : ''}
                    {formatCurrency(p.amount, sym)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="zb-card overflow-hidden">
          <div className="border-b border-border px-5 py-3.5">
            <h2 className="text-sm font-semibold text-text-primary">
              Uploaded Files ({files.length})
            </h2>
          </div>
          {files.length === 0 ? (
            <div className="p-5 text-xs text-text-muted">No files uploaded for this customer yet.</div>
          ) : (
            <div className="divide-y divide-border">
              {files.map((f) => (
                <div key={f.id} className="flex items-center justify-between gap-3 px-5 py-3 text-xs">
                  <div className="flex items-center gap-2.5 min-w-0">
                    {f.mime_type.startsWith('image/') ? (
                      <ImageIcon className="h-4 w-4 shrink-0 text-text-muted" />
                    ) : (
                      <FileText className="h-4 w-4 shrink-0 text-text-muted" />
                    )}
                    <div className="min-w-0">
                      <p className="truncate font-medium text-text-primary">{f.file_name}</p>
                      <p className="text-text-muted">
                        {f.category} • {formatBytes(f.file_size)}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void openSignedFile(f.id)}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-bg"
                  >
                    <Download className="h-3 w-3" />
                    Open
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <CustomerFormModal
        open={editModalOpen}
        onClose={() => setEditModalOpen(false)}
        existingCustomer={customer}
        onSaved={() => void loadProfile()}
      />

      <ServiceFormModal
        open={serviceModalOpen}
        onClose={() => setServiceModalOpen(false)}
        fixedCustomer={customer}
        onSaved={() => void loadProfile()}
      />

      {/* Safe Deletion / Archive Confirmation Dialog */}
      <Modal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        title={
          deleteMode === 'permanent'
            ? 'Permanently Delete Customer'
            : customer.archived_at
              ? 'Restore Customer'
              : 'Archive Customer'
        }
        maxWidthClass="max-w-md"
      >
        <div className="space-y-4">
          {deleteMode === 'permanent' ? (
            <div className="rounded-lg border border-error/30 bg-error-soft p-3.5 text-xs text-error space-y-2">
              <div className="flex items-center gap-2 font-semibold">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>Permanent Deletion Cannot Be Undone</span>
              </div>
              <p>
                Deleting <strong>{customer.full_name}</strong> ({customer.customer_code}) will
                permanently remove this customer and all associated records:
              </p>
              {deletionImpact ? (
                <ul className="list-disc pl-5 space-y-0.5">
                  <li>{deletionImpact.services_count} service record(s)</li>
                  <li>{deletionImpact.payments_count} payment transaction(s)</li>
                  <li>{deletionImpact.reminders_count} reminder(s)</li>
                  <li>{deletionImpact.files_count} file(s) from private storage</li>
                </ul>
              ) : (
                <p>Calculating affected records...</p>
              )}
            </div>
          ) : (
            <p className="text-sm text-text-secondary">
              {customer.archived_at
                ? `Restore ${customer.full_name} to active customer lists?`
                : `Archive ${customer.full_name}? All ${deletionImpact?.services_count ?? summary.total_services} service record(s), payments, and files remain safely stored and recoverable.`}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setDeleteModalOpen(false)}
              disabled={deleting}
              className="rounded-lg border border-border px-4 py-2 text-xs font-medium"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={deleting}
              onClick={() => void handleConfirmDelete()}
              className={`rounded-lg px-4 py-2 text-xs font-medium disabled:opacity-50 ${
                deleteMode === 'permanent' || !customer.archived_at
                  ? 'bg-error text-white hover:opacity-90'
                  : 'zb-btn-primary'
              }`}
            >
              {deleting
                ? 'Processing...'
                : deleteMode === 'permanent'
                  ? 'Permanently Delete Everything'
                  : customer.archived_at
                    ? 'Restore Customer'
                    : 'Archive Customer'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
