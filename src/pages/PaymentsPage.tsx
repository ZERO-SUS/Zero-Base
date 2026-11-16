import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CreditCard } from 'lucide-react';
import { PaymentFormModal } from '../components/payments/PaymentFormModal';
import { Badge, PaymentStatusBadge } from '../components/ui/Badge';
import { EmptyState, ErrorBanner, SkeletonCard } from '../components/ui/Feedback';
import { useAuth } from '../context/AuthContext';
import { apiFetch, ApiError } from '../lib/api';
import { formatCurrency, formatServiceDate } from '../lib/format';
import type { PaymentRecord, ServiceRecord } from '../types/domain';

interface PaymentsResponse {
  payments: PaymentRecord[];
  outstanding_services: ServiceRecord[];
}

export function PaymentsPage() {
  const { settings } = useAuth();
  const sym = settings.currency_symbol || '₹';

  const [data, setData] = useState<PaymentsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [methodFilter, setMethodFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [payModalService, setPayModalService] = useState<ServiceRecord | null>(null);

  const loadPayments = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (methodFilter) params.set('payment_method', methodFilter);
    if (typeFilter) params.set('payment_type', typeFilter);

    try {
      const res = await apiFetch<PaymentsResponse>(`/api/payments?${params.toString()}`);
      setData(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load payments.');
    } finally {
      setLoading(false);
    }
  }, [methodFilter, typeFilter]);

  useEffect(() => {
    void loadPayments();
  }, [loadPayments]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-text-primary">Payments</h1>
        <p className="text-xs text-text-secondary">
          Track Cash, UPI, and Other payments, partial collections, refunds, and outstanding balances
        </p>
      </div>

      {error && <ErrorBanner message={error} onRetry={() => void loadPayments()} />}

      {/* Outstanding Services */}
      <section className="zb-card overflow-hidden">
        <div className="border-b border-border px-5 py-3.5">
          <h2 className="text-sm font-semibold text-text-primary">
            Outstanding Balances ({data?.outstanding_services.length ?? 0})
          </h2>
        </div>

        {loading ? (
          <div className="p-4">
            <SkeletonCard lines={2} />
          </div>
        ) : !data || data.outstanding_services.length === 0 ? (
          <div className="px-5 py-6 text-center text-xs text-text-muted">
            All active service bills are fully settled.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {data.outstanding_services.map((srv) => {
              const due = Math.max(0, Number(srv.total_amount) - Number(srv.amount_paid));
              return (
                <div
                  key={srv.service_id}
                  className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        to={`/services/${srv.service_id}`}
                        className="text-sm font-semibold text-text-primary hover:text-accent"
                      >
                        {srv.customers?.full_name}
                      </Link>
                      <PaymentStatusBadge status={srv.payment_status} />
                    </div>
                    <p className="text-xs text-text-secondary">
                      {formatServiceDate(srv.service_date)} • {srv.service_type} • Billed{' '}
                      {formatCurrency(srv.total_amount, sym)} • Paid{' '}
                      {formatCurrency(srv.amount_paid, sym)}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-sm font-semibold text-error">
                      Due: {formatCurrency(due, sym)}
                    </span>
                    <button
                      type="button"
                      onClick={() => setPayModalService(srv)}
                      className="zb-btn-primary inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium"
                    >
                      <CreditCard className="h-3.5 w-3.5" />
                      Collect
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Complete Payments Ledger */}
      <section className="zb-card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3.5">
          <h2 className="text-sm font-semibold text-text-primary">Payment Ledger</h2>
          <div className="flex items-center gap-2">
            <select
              value={methodFilter}
              onChange={(e) => setMethodFilter(e.target.value)}
              aria-label="Filter by payment method"
              className="rounded-lg border px-2.5 py-1 text-xs"
            >
              <option value="">All Methods</option>
              <option value="Cash">Cash</option>
              <option value="UPI">UPI</option>
              <option value="Other">Other</option>
            </select>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              aria-label="Filter by payment type"
              className="rounded-lg border px-2.5 py-1 text-xs"
            >
              <option value="">All Types</option>
              <option value="payment">Payments</option>
              <option value="refund">Refunds</option>
            </select>
          </div>
        </div>

        {loading ? (
          <div className="p-4">
            <SkeletonCard lines={3} />
          </div>
        ) : !data || data.payments.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title="No payment transactions found"
              description="Payments recorded on service records will appear in this ledger."
              icon={<CreditCard className="h-5 w-5" />}
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-bg text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                <tr>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Customer / Service</th>
                  <th className="px-4 py-3">Method</th>
                  <th className="px-4 py-3">Reference</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.payments.map((p) => (
                  <tr key={p.payment_id} className="hover:bg-bg/70">
                    <td className="px-4 py-3 text-xs text-text-secondary">
                      {formatServiceDate(p.payment_date)}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        to={`/services/${p.service_id}`}
                        className="font-medium text-text-primary hover:text-accent"
                      >
                        {p.services?.customers?.full_name ?? 'Customer'}
                      </Link>
                      <p className="text-xs text-text-muted">{p.services?.service_type}</p>
                    </td>
                    <td className="px-4 py-3">{p.payment_method}</td>
                    <td className="px-4 py-3 font-mono text-xs text-text-secondary">
                      {p.transaction_reference || '—'}
                    </td>
                    <td className="px-4 py-3 capitalize">
                      <Badge variant={p.payment_type === 'refund' ? 'warning' : 'success'}>
                        {p.payment_type}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right font-semibold">
                      {p.payment_type === 'refund' ? '-' : ''}
                      {formatCurrency(p.amount, sym)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {payModalService && (
        <PaymentFormModal
          open={Boolean(payModalService)}
          onClose={() => setPayModalService(null)}
          serviceId={payModalService.service_id}
          outstandingAmount={Math.max(
            0,
            Number(payModalService.total_amount) - Number(payModalService.amount_paid)
          )}
          amountPaid={Number(payModalService.amount_paid)}
          currencySymbol={sym}
          onSaved={() => void loadPayments()}
        />
      )}
    </div>
  );
}
