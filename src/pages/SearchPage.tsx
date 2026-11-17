import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, RotateCcw, Search } from 'lucide-react';
import { Badge, PaymentStatusBadge } from '../components/ui/Badge';
import { EmptyState, ErrorBanner, SkeletonCard } from '../components/ui/Feedback';
import { useAuth } from '../context/AuthContext';
import { apiFetch, ApiError } from '../lib/api';
import {
  formatCurrency,
  formatDateTimeIst,
  formatServiceDate,
  getMonthName,
} from '../lib/format';
import type { ServiceRecord } from '../types/domain';

interface SearchResponse {
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
  items: ServiceRecord[];
  facets: {
    areas: string[];
    years: number[];
  };
}

export function SearchPage() {
  const { settings } = useAuth();
  const sym = settings.currency_symbol || '₹';

  const [q, setQ] = useState('');
  const [year, setYear] = useState('');
  const [month, setMonth] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [area, setArea] = useState('');
  const [paymentStatus, setPaymentStatus] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('');
  const [reminderStatus, setReminderStatus] = useState('');
  const [serviceType, setServiceType] = useState('');
  const [sort, setSort] = useState('newest');
  const [page, setPage] = useState(1);

  const [data, setData] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const runSearch = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ page: String(page), page_size: '25', sort });
    if (q.trim()) params.set('q', q.trim());
    if (year) params.set('year', year);
    if (month) params.set('month', month);
    if (startDate) params.set('start_date', startDate);
    if (endDate) params.set('end_date', endDate);
    if (area) params.set('area', area);
    if (paymentStatus) params.set('payment_status', paymentStatus);
    if (paymentMethod) params.set('payment_method', paymentMethod);
    if (reminderStatus) params.set('reminder_status', reminderStatus);
    if (serviceType) params.set('service_type', serviceType);

    try {
      const res = await apiFetch<SearchResponse>(`/api/search?${params.toString()}`);
      setData(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Search failed.');
    } finally {
      setLoading(false);
    }
  }, [
    q,
    year,
    month,
    startDate,
    endDate,
    area,
    paymentStatus,
    paymentMethod,
    reminderStatus,
    serviceType,
    sort,
    page,
  ]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void runSearch();
    }, 280);
    return () => window.clearTimeout(timer);
  }, [runSearch]);

  const clearFilters = () => {
    setQ('');
    setYear('');
    setMonth('');
    setStartDate('');
    setEndDate('');
    setArea('');
    setPaymentStatus('');
    setPaymentMethod('');
    setReminderStatus('');
    setServiceType('');
    setSort('newest');
    setPage(1);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-text-primary">
            Global Search &amp; Filter Engine
          </h1>
          <p className="text-xs text-text-secondary">
            Search across customer names, phones, customer codes, addresses, areas, service IDs, notes, and dates
          </p>
        </div>

        <button
          type="button"
          onClick={clearFilters}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg hover:text-text-primary self-start"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Clear All Filters
        </button>
      </div>

      {/* Search + Combined Filters */}
      <div className="zb-card p-4 space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-text-muted" />
            <input
              type="text"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
              placeholder="Search name, phone (normalized), ZB-00001, address, area, service ID, notes, or YYYY-MM-DD..."
              className="w-full rounded-lg border pl-9 pr-3 py-2 text-sm"
            />
          </div>
          <select
            value={sort}
            onChange={(e) => {
              setSort(e.target.value);
              setPage(1);
            }}
            aria-label="Sort results"
            className="rounded-lg border px-3 py-2 text-sm"
          >
            <option value="newest">Newest service first</option>
            <option value="oldest">Oldest service first</option>
            <option value="customer_name">Customer name (A–Z)</option>
            <option value="amount_desc">Highest service amount</option>
            <option value="amount_asc">Lowest service amount</option>
          </select>
        </div>

        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
          <select
            value={year}
            onChange={(e) => {
              setYear(e.target.value);
              setPage(1);
            }}
            aria-label="Filter by year"
            className="rounded-lg border px-2.5 py-1.5 text-xs"
          >
            <option value="">All Years</option>
            {(data?.facets.years ?? []).map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>

          <select
            value={month}
            onChange={(e) => {
              setMonth(e.target.value);
              setPage(1);
            }}
            disabled={!year}
            aria-label="Filter by month"
            className="rounded-lg border px-2.5 py-1.5 text-xs disabled:opacity-50"
          >
            <option value="">All Months</option>
            {Array.from({ length: 12 }).map((_, i) => (
              <option key={i + 1} value={i + 1}>
                {getMonthName(i + 1)}
              </option>
            ))}
          </select>

          <select
            value={area}
            onChange={(e) => {
              setArea(e.target.value);
              setPage(1);
            }}
            aria-label="Filter by area"
            className="rounded-lg border px-2.5 py-1.5 text-xs"
          >
            <option value="">All Areas</option>
            {(data?.facets.areas ?? []).map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>

          <select
            value={serviceType}
            onChange={(e) => {
              setServiceType(e.target.value);
              setPage(1);
            }}
            aria-label="Filter by service type"
            className="rounded-lg border px-2.5 py-1.5 text-xs"
          >
            <option value="">All Service Types</option>
            {settings.service_types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>

          <select
            value={paymentStatus}
            onChange={(e) => {
              setPaymentStatus(e.target.value);
              setPage(1);
            }}
            aria-label="Filter by payment status"
            className="rounded-lg border px-2.5 py-1.5 text-xs"
          >
            <option value="">All Payment Status</option>
            <option value="Paid">Paid</option>
            <option value="Partially Paid">Partially Paid</option>
            <option value="Unpaid">Unpaid</option>
            <option value="Refunded">Refunded</option>
          </select>

          <select
            value={paymentMethod}
            onChange={(e) => {
              setPaymentMethod(e.target.value);
              setPage(1);
            }}
            aria-label="Filter by payment method"
            className="rounded-lg border px-2.5 py-1.5 text-xs"
          >
            <option value="">All Payment Methods</option>
            <option value="Cash">Cash</option>
            <option value="UPI">UPI</option>
            <option value="Other">Other</option>
          </select>

          <select
            value={reminderStatus}
            onChange={(e) => {
              setReminderStatus(e.target.value);
              setPage(1);
            }}
            aria-label="Filter by reminder status"
            className="rounded-lg border px-2.5 py-1.5 text-xs"
          >
            <option value="">All Reminder Status</option>
            <option value="active">Active</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </select>

          <input
            type="date"
            value={startDate}
            onChange={(e) => {
              setStartDate(e.target.value);
              setPage(1);
            }}
            aria-label="From date"
            className="rounded-lg border px-2.5 py-1.5 text-xs"
          />

          <input
            type="date"
            value={endDate}
            onChange={(e) => {
              setEndDate(e.target.value);
              setPage(1);
            }}
            aria-label="To date"
            className="rounded-lg border px-2.5 py-1.5 text-xs"
          />
        </div>
      </div>

      {error && <ErrorBanner message={error} onRetry={() => void runSearch()} />}

      {/* Result count */}
      {!loading && data && (
        <div className="flex items-center justify-between text-xs text-text-secondary">
          <span>
            Showing <strong className="text-text-primary">{data.items.length}</strong> of{' '}
            <strong className="text-text-primary">{data.total}</strong> matching records
          </span>
          {data.total_pages > 1 && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="rounded border border-border p-1 disabled:opacity-40"
                aria-label="Previous page"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <span>
                Page {data.page} of {data.total_pages}
              </span>
              <button
                type="button"
                disabled={page >= data.total_pages}
                onClick={() => setPage((p) => Math.min(data.total_pages, p + 1))}
                className="rounded border border-border p-1 disabled:opacity-40"
                aria-label="Next page"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          <SkeletonCard lines={2} />
          <SkeletonCard lines={2} />
        </div>
      ) : !data || data.items.length === 0 ? (
        <EmptyState
          title="No matching records"
          description="Try broadening your search terms or clearing active filters."
        />
      ) : (
        <div className="zb-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-bg text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                <tr>
                  <th className="px-4 py-3">Service Date</th>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Service</th>
                  <th className="px-4 py-3">Amount / Balance</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.items.map((srv) => (
                  <tr key={srv.id} className="hover:bg-bg/70">
                    <td className="px-4 py-3">
                      <p className="font-medium text-text-primary">
                        {formatServiceDate(srv.service_date)}
                      </p>
                      <p className="text-[10px] text-text-muted">
                        Uploaded: {formatDateTimeIst(srv.created_at)}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        to={`/customers/${srv.customer_id}`}
                        className="font-semibold text-text-primary hover:text-accent"
                      >
                        {srv.customers?.full_name}
                      </Link>
                      <p className="font-mono text-xs text-text-secondary">
                        {srv.customers?.phone_number} • {srv.customers?.customer_code}
                      </p>
                      {srv.customers?.area && (
                        <p className="text-[11px] text-text-muted">{srv.customers.area}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-text-secondary">
                      {srv.service_categories_snapshot &&
                      srv.service_categories_snapshot.length > 0 ? (
                        <div className="flex flex-wrap gap-1 mb-0.5">
                          {srv.service_categories_snapshot.map((cat) => (
                            <Badge key={cat} variant="neutral">
                              {cat}
                            </Badge>
                          ))}
                        </div>
                      ) : (
                        <p className="font-medium text-text-primary">{srv.service_type}</p>
                      )}
                      {srv.tank_details && (
                        <p className="truncate max-w-xs text-[11px] text-text-muted">
                          {srv.tank_details}
                        </p>
                      )}
                      {srv.notes && <p className="truncate max-w-xs">{srv.notes}</p>}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <p className="font-semibold text-text-primary">
                        {formatCurrency(srv.total_amount, sym)}
                      </p>
                      {Number(srv.balance_amount) > 0 && (
                        <p className="text-error">
                          Bal: {formatCurrency(srv.balance_amount, sym)}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <PaymentStatusBadge status={srv.payment_status} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        to={`/services/${srv.id}`}
                        className="rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-bg"
                      >
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
