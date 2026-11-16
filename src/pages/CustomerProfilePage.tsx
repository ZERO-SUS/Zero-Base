import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Download,
  Edit3,
  FileText,
  Image as ImageIcon,
  MapPin,
  Phone,
  Plus,
} from 'lucide-react';
import { CustomerFormModal } from '../components/customers/CustomerFormModal';
import { ServiceFormModal } from '../components/services/ServiceFormModal';
import { Badge, PaymentStatusBadge } from '../components/ui/Badge';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { EmptyState, ErrorBanner, SkeletonCard } from '../components/ui/Feedback';
import { useAuth } from '../context/AuthContext';
import { apiFetch, ApiError } from '../lib/api';
import { formatBytes, formatCurrency, formatServiceDate } from '../lib/format';
import type {
  Customer,
  PaymentRecord,
  ReminderRecord,
  ServiceFileRecord,
  ServiceRecord,
} from '../types/domain';

interface CustomerProfileResponse {
  customer: Customer;
  summary: {
    total_services: number;
    last_service_date: string | null;
    total_billed: number;
    total_paid: number;
    outstanding_amount: number;
    next_scheduled_service: string | null;
  };
  services: ServiceRecord[];
  payments: PaymentRecord[];
  reminders: ReminderRecord[];
  files: ServiceFileRecord[];
}

export function CustomerProfilePage() {
  const { id } = useParams<{ id: string }>();
  const { settings } = useAuth();
  const sym = settings.currency_symbol || '₹';

  const [data, setData] = useState<CustomerProfileResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editModalOpen, setEditModalOpen] = useState(false);
  const [serviceModalOpen, setServiceModalOpen] = useState(false);
  const [confirmArchiveOpen, setConfirmArchiveOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);

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

  const handleArchiveToggle = async () => {
    if (!data) return;
    setArchiving(true);
    try {
      const endpoint = data.customer.archived_at
        ? `/api/customers/${data.customer.id}/restore`
        : `/api/customers/${data.customer.id}/archive`;
      await apiFetch(endpoint, { method: 'POST' });
      setConfirmArchiveOpen(false);
      void loadProfile();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update archive status.');
    } finally {
      setArchiving(false);
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

  const { customer, summary, services, payments, files } = data;

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
            onClick={() => setConfirmArchiveOpen(true)}
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
          {!customer.archived_at && (
            <button
              type="button"
              onClick={() => setServiceModalOpen(true)}
              className="zb-btn-primary inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-medium"
            >
              <Plus className="h-3.5 w-3.5" />
              Add New Service
            </button>
          )}
        </div>
      </div>

      {/* Contact & Summary */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="zb-card p-5 space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
            Contact & Address
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
              Last Service Date
            </p>
            <p className="mt-1.5 text-base font-semibold text-text-primary">
              {formatServiceDate(summary.last_service_date)}
            </p>
          </div>
          <div className="zb-card p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
              Next Scheduled Service
            </p>
            <p className="mt-1.5 text-base font-semibold text-accent">
              {formatServiceDate(summary.next_scheduled_service)}
            </p>
          </div>
          <div className="zb-card p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
              Total Billed
            </p>
            <p className="mt-1.5 text-xl font-semibold text-text-primary">
              {formatCurrency(summary.total_billed, sym)}
            </p>
          </div>
          <div className="zb-card p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
              Total Paid
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

      {/* Complete Service History */}
      <section className="zb-card overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h2 className="text-sm font-semibold text-text-primary">
            Complete Service History ({services.length})
          </h2>
        </div>

        {services.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title="No cleaning services recorded for this customer"
              description="Click 'Add New Service' above to record their first tank cleaning operation."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-bg text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                <tr>
                  <th className="px-4 py-3">Service Date</th>
                  <th className="px-4 py-3">Service Type</th>
                  <th className="px-4 py-3">Billed</th>
                  <th className="px-4 py-3">Paid</th>
                  <th className="px-4 py-3">Balance</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {services.map((srv) => (
                  <tr key={srv.id} className="hover:bg-bg/70">
                    <td className="px-4 py-3 font-medium text-text-primary">
                      {formatServiceDate(srv.service_date)}
                    </td>
                    <td className="px-4 py-3 text-text-secondary">
                      {srv.service_type}
                      {srv.tank_details ? ` (${srv.tank_details})` : ''}
                    </td>
                    <td className="px-4 py-3 font-medium">
                      {formatCurrency(srv.total_amount, sym)}
                    </td>
                    <td className="px-4 py-3 text-text-secondary">
                      {formatCurrency(srv.amount_paid, sym)}
                    </td>
                    <td className="px-4 py-3 text-text-secondary">
                      {formatCurrency(srv.balance_amount, sym)}
                    </td>
                    <td className="px-4 py-3">
                      <PaymentStatusBadge status={srv.payment_status} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        to={`/services/${srv.id}`}
                        className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-text-primary hover:bg-bg"
                      >
                        Open Service
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Previous Payments & Uploaded Files for this Customer */}
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

      <ConfirmDialog
        open={confirmArchiveOpen}
        onClose={() => setConfirmArchiveOpen(false)}
        onConfirm={() => void handleArchiveToggle()}
        title={customer.archived_at ? 'Restore Customer' : 'Archive Customer'}
        message={
          customer.archived_at
            ? `Restore ${customer.full_name} to active customer lists?`
            : `Archive ${customer.full_name}? Historical services, payments, and files remain intact and can be restored anytime.`
        }
        confirmLabel={customer.archived_at ? 'Restore Customer' : 'Archive Customer'}
        danger={!customer.archived_at}
        loading={archiving}
      />
    </div>
  );
}
