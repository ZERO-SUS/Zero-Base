import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  CreditCard,
  Edit3,
  RotateCcw,
} from 'lucide-react';
import { AttachmentsPanel } from '../components/attachments/AttachmentsPanel';
import { PaymentFormModal } from '../components/payments/PaymentFormModal';
import { ServiceFormModal } from '../components/services/ServiceFormModal';
import { Badge, PaymentStatusBadge } from '../components/ui/Badge';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { ErrorBanner, SkeletonCard } from '../components/ui/Feedback';
import { Modal } from '../components/ui/Modal';
import { useAuth } from '../context/AuthContext';
import { apiFetch, ApiError } from '../lib/api';
import { formatCurrency, formatServiceDate } from '../lib/format';
import type {
  PaymentMethod,
  PaymentRecord,
  ReminderRecord,
  ServiceFileRecord,
  ServiceRecord,
} from '../types/domain';

interface ServiceDetailResponse {
  service: ServiceRecord;
  payments: PaymentRecord[];
  files: ServiceFileRecord[];
  reminders: ReminderRecord[];
}

export function ServiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { settings } = useAuth();
  const sym = settings.currency_symbol || '₹';

  const [data, setData] = useState<ServiceDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editModalOpen, setEditModalOpen] = useState(false);
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const [correctTarget, setCorrectTarget] = useState<PaymentRecord | null>(null);
  const [correctReason, setCorrectReason] = useState('');
  const [includeReplacement, setIncludeReplacement] = useState(true);
  const [repAmount, setRepAmount] = useState('');
  const [repMethod, setRepMethod] = useState<PaymentMethod>('UPI');
  const [repDate, setRepDate] = useState('');
  const [repRef, setRepRef] = useState('');
  const [correctSubmitting, setCorrectSubmitting] = useState(false);

  const loadDetail = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<ServiceDetailResponse>(`/api/services/${id}`);
      setData(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load service details.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const handleArchiveToggle = async () => {
    if (!data) return;
    setArchiving(true);
    try {
      const endpoint = data.service.archived_at
        ? `/api/services/${data.service.id}/restore`
        : `/api/services/${data.service.id}/archive`;
      await apiFetch(endpoint, { method: 'POST' });
      setArchiveConfirmOpen(false);
      void loadDetail();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update archive status.');
    } finally {
      setArchiving(false);
    }
  };

  const openCorrectModal = (payment: PaymentRecord) => {
    setCorrectTarget(payment);
    setCorrectReason('');
    setIncludeReplacement(true);
    setRepAmount(String(payment.amount));
    setRepMethod(payment.payment_method);
    setRepDate(payment.payment_date);
    setRepRef(payment.reference_number ?? '');
  };

  const handleCorrectSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!correctTarget) return;
    setCorrectSubmitting(true);
    setError(null);
    try {
      await apiFetch(`/api/payments/${correctTarget.id}/correct`, {
        method: 'POST',
        body: JSON.stringify({
          reason: correctReason.trim(),
          replacement: includeReplacement
            ? {
                amount: Number(repAmount),
                payment_type: correctTarget.payment_type,
                payment_method: repMethod,
                reference_number: repRef.trim() || null,
                payment_date: repDate,
              }
            : null,
        }),
      });
      setCorrectTarget(null);
      void loadDetail();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to correct payment.');
    } finally {
      setCorrectSubmitting(false);
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

  if (error && !data) {
    return (
      <div className="space-y-4">
        <Link to="/history" className="inline-flex items-center gap-1.5 text-xs text-accent hover:underline">
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Service History
        </Link>
        <ErrorBanner message={error} onRetry={() => void loadDetail()} />
      </div>
    );
  }

  if (!data) return null;

  const { service, payments, files } = data;
  const outstanding = Number(service.balance_amount ?? Math.max(0, Number(service.total_amount) - Number(service.amount_paid)));

  return (
    <div className="space-y-6">
      {error && <ErrorBanner message={error} />}

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Link
            to="/history"
            className="mb-2 inline-flex items-center gap-1.5 text-xs font-medium text-text-secondary hover:text-text-primary"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Service History
          </Link>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight text-text-primary">
              {service.service_type} — {formatServiceDate(service.service_date)}
            </h1>
            <PaymentStatusBadge status={service.payment_status} />
            {service.archived_at && <Badge variant="warning">Archived</Badge>}
          </div>
          {service.customers && (
            <p className="mt-1 text-sm text-text-secondary">
              Customer:{' '}
              <Link
                to={`/customers/${service.customer_id}`}
                className="font-medium text-accent hover:underline"
              >
                {service.customers.full_name} ({service.customers.customer_code})
              </Link>{' '}
              • {service.customers.phone_number}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setEditModalOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-xs font-medium text-text-primary hover:bg-bg"
          >
            <Edit3 className="h-3.5 w-3.5" />
            Edit Service
          </button>
          <button
            type="button"
            onClick={() => setArchiveConfirmOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg"
          >
            {service.archived_at ? (
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
          {!service.archived_at && (
            <button
              type="button"
              onClick={() => setPaymentModalOpen(true)}
              className="zb-btn-primary inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-medium"
            >
              <CreditCard className="h-3.5 w-3.5" />
              Record Payment
            </button>
          )}
        </div>
      </div>

      {/* Financial Summary */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <div className="zb-card p-4">
          <p className="text-[11px] uppercase tracking-wider text-text-muted">Price</p>
          <p className="mt-1 text-lg font-semibold">{formatCurrency(service.price, sym)}</p>
        </div>
        <div className="zb-card p-4">
          <p className="text-[11px] uppercase tracking-wider text-text-muted">Discount</p>
          <p className="mt-1 text-lg font-semibold">{formatCurrency(service.discount, sym)}</p>
        </div>
        <div className="zb-card p-4">
          <p className="text-[11px] uppercase tracking-wider text-text-muted">Total Billed</p>
          <p className="mt-1 text-lg font-semibold">{formatCurrency(service.total_amount, sym)}</p>
        </div>
        <div className="zb-card p-4">
          <p className="text-[11px] uppercase tracking-wider text-text-muted">Amount Paid</p>
          <p className="mt-1 text-lg font-semibold text-success">
            {formatCurrency(service.amount_paid, sym)}
          </p>
        </div>
        <div className="zb-card p-4">
          <p className="text-[11px] uppercase tracking-wider text-text-muted">Balance</p>
          <p className={`mt-1 text-lg font-semibold ${outstanding > 0 ? 'text-error' : ''}`}>
            {formatCurrency(outstanding, sym)}
          </p>
        </div>
      </div>

      {/* Metadata Details */}
      <div className="zb-card p-5 grid grid-cols-1 gap-4 sm:grid-cols-3 text-sm">
        <div>
          <p className="text-xs text-text-muted">Tank Details</p>
          <p className="mt-0.5 font-medium">{service.tank_details || '—'}</p>
        </div>
        <div>
          <p className="text-xs text-text-muted">Next Due Date</p>
          <p className="mt-0.5 font-medium">{formatServiceDate(service.next_due_date)}</p>
        </div>
        <div>
          <p className="text-xs text-text-muted">Description / Notes</p>
          <p className="mt-0.5 text-text-secondary">
            {[service.description, service.notes].filter(Boolean).join(' — ') || '—'}
          </p>
        </div>
      </div>

      {/* Payments Table */}
      <div className="zb-card overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">
              Payment History ({payments.length})
            </h2>
            <p className="text-xs text-text-secondary">
              Server-verified totals • Corrections preserve full audit history
            </p>
          </div>
          {!service.archived_at && (
            <button
              type="button"
              onClick={() => setPaymentModalOpen(true)}
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-bg"
            >
              + Add Payment
            </button>
          )}
        </div>

        {payments.length === 0 ? (
          <div className="p-6 text-center text-xs text-text-muted">
            No payments recorded for this service yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-bg text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                <tr>
                  <th className="px-4 py-2.5">Date</th>
                  <th className="px-4 py-2.5">Type</th>
                  <th className="px-4 py-2.5">Method</th>
                  <th className="px-4 py-2.5">Reference</th>
                  <th className="px-4 py-2.5">Amount</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5 text-right">Correction</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {payments.map((p) => (
                  <tr
                    key={p.id}
                    className={p.archived_at ? 'opacity-60 bg-bg/40' : ''}
                  >
                    <td className="px-4 py-3">{formatServiceDate(p.payment_date)}</td>
                    <td className="px-4 py-3 capitalize">
                      <Badge variant={p.payment_type === 'refund' ? 'warning' : 'neutral'}>
                        {p.payment_type}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">{p.payment_method}</td>
                    <td className="px-4 py-3 font-mono text-xs text-text-secondary">
                      {p.reference_number || '—'}
                    </td>
                    <td className="px-4 py-3 font-semibold">
                      {p.payment_type === 'refund' ? '-' : ''}
                      {formatCurrency(p.amount, sym)}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {p.archived_at ? (
                        <span className="text-warning">
                          Superseded ({p.archive_reason})
                        </span>
                      ) : (
                        <Badge variant="success">Active</Badge>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {!p.archived_at && (
                        <button
                          type="button"
                          onClick={() => openCorrectModal(p)}
                          className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-text-secondary hover:bg-bg hover:text-text-primary"
                        >
                          <RotateCcw className="h-3 w-3" />
                          Correct
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Private Supabase Storage Files */}
      <AttachmentsPanel
        serviceId={service.id}
        files={files}
        onChanged={() => void loadDetail()}
      />

      <ServiceFormModal
        open={editModalOpen}
        onClose={() => setEditModalOpen(false)}
        existingService={service}
        onSaved={() => void loadDetail()}
      />

      <PaymentFormModal
        open={paymentModalOpen}
        onClose={() => setPaymentModalOpen(false)}
        serviceId={service.id}
        outstandingAmount={outstanding}
        amountPaid={Number(service.amount_paid)}
        currencySymbol={sym}
        onSaved={() => void loadDetail()}
      />

      <ConfirmDialog
        open={archiveConfirmOpen}
        onClose={() => setArchiveConfirmOpen(false)}
        onConfirm={() => void handleArchiveToggle()}
        title={service.archived_at ? 'Restore Service Record' : 'Archive Service Record'}
        message={
          service.archived_at
            ? 'Restore this service record to active history and reports?'
            : 'Archive this service record? It will be hidden from active metrics while keeping payments and files intact for audit.'
        }
        confirmLabel={service.archived_at ? 'Restore Service' : 'Archive Service'}
        danger={!service.archived_at}
        loading={archiving}
      />

      <Modal
        open={Boolean(correctTarget)}
        onClose={() => setCorrectTarget(null)}
        title="Correct Payment Record"
        subtitle="Original record is archived with reason in audit log—never silently deleted"
      >
        <form onSubmit={handleCorrectSubmit} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-secondary">
              Correction Reason <span className="text-error">*</span>
            </label>
            <input
              type="text"
              required
              minLength={3}
              value={correctReason}
              onChange={(e) => setCorrectReason(e.target.value)}
              placeholder="e.g. Entered wrong amount ₹1500 instead of ₹1200"
              className="w-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>

          <label className="flex items-center gap-2 text-xs font-medium text-text-primary cursor-pointer">
            <input
              type="checkbox"
              checked={includeReplacement}
              onChange={(e) => setIncludeReplacement(e.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
            <span>Create replacement corrected payment entry</span>
          </label>

          {includeReplacement && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 rounded-lg border border-border bg-bg p-3.5">
              <div>
                <label className="mb-1 block text-xs font-medium text-text-secondary">
                  Corrected Amount
                </label>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
                  value={repAmount}
                  onChange={(e) => setRepAmount(e.target.value)}
                  className="w-full rounded-lg border px-3 py-1.5 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-text-secondary">
                  Method
                </label>
                <select
                  value={repMethod}
                  onChange={(e) => setRepMethod(e.target.value as PaymentMethod)}
                  className="w-full rounded-lg border px-3 py-1.5 text-sm"
                >
                  <option value="Cash">Cash</option>
                  <option value="UPI">UPI</option>
                  <option value="Other">Other</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-text-secondary">
                  Payment Date
                </label>
                <input
                  type="date"
                  required
                  value={repDate}
                  onChange={(e) => setRepDate(e.target.value)}
                  className="w-full rounded-lg border px-3 py-1.5 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-text-secondary">
                  Reference Number
                </label>
                <input
                  type="text"
                  value={repRef}
                  onChange={(e) => setRepRef(e.target.value)}
                  className="w-full rounded-lg border px-3 py-1.5 text-sm"
                />
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setCorrectTarget(null)}
              className="rounded-lg border border-border bg-surface px-4 py-2 text-xs font-medium"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={correctSubmitting}
              className="zb-btn-primary rounded-lg px-4 py-2 text-xs font-medium disabled:opacity-50"
            >
              {correctSubmitting ? 'Applying...' : 'Apply Correction'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
