import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, Plus, Search } from 'lucide-react';
import { ServiceFormModal } from '../components/services/ServiceFormModal';
import { PaymentStatusBadge } from '../components/ui/Badge';
import { EmptyState, ErrorBanner, SkeletonCard } from '../components/ui/Feedback';
import { useAuth } from '../context/AuthContext';
import { apiFetch, ApiError } from '../lib/api';
import { formatCurrency, formatDayMonth, getMonthName } from '../lib/format';
import type { YearMonthGroup } from '../types/domain';

interface HistoryResponse {
  total: number;
  grouped: YearMonthGroup[];
}

export function ServiceHistoryPage() {
  const { settings } = useAuth();
  const sym = settings.currency_symbol || '₹';

  const [data, setData] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [yearFilter, setYearFilter] = useState('');
  const [monthFilter, setMonthFilter] = useState('');
  const [serviceTypeFilter, setServiceTypeFilter] = useState('');
  const [paymentStatusFilter, setPaymentStatusFilter] = useState('');

  const [collapsedYears, setCollapsedYears] = useState<Record<number, boolean>>({});
  const [collapsedMonths, setCollapsedMonths] = useState<Record<string, boolean>>({});
  const [serviceModalOpen, setServiceModalOpen] = useState(false);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (yearFilter) params.set('year', yearFilter);
    if (monthFilter) params.set('month', monthFilter);
    if (search.trim()) params.set('q', search.trim());
    if (serviceTypeFilter) params.set('service_type', serviceTypeFilter);
    if (paymentStatusFilter) params.set('payment_status', paymentStatusFilter);

    try {
      const res = await apiFetch<HistoryResponse>(`/api/services/history?${params.toString()}`);
      setData(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load service history.');
    } finally {
      setLoading(false);
    }
  }, [yearFilter, monthFilter, search, serviceTypeFilter, paymentStatusFilter]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadHistory();
    }, 200);
    return () => window.clearTimeout(timer);
  }, [loadHistory]);

  const availableYears = useMemo(() => {
    if (!data) return [];
    return data.grouped.map((g) => g.year);
  }, [data]);

  const toggleYear = (y: number) => {
    setCollapsedYears((prev) => ({ ...prev, [y]: !prev[y] }));
  };

  const toggleMonth = (y: number, m: number) => {
    const key = `${y}-${m}`;
    setCollapsedMonths((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const expandAll = () => {
    setCollapsedYears({});
    setCollapsedMonths({});
  };

  const collapseAll = () => {
    if (!data) return;
    const yrs: Record<number, boolean> = {};
    const mths: Record<string, boolean> = {};
    for (const g of data.grouped) {
      yrs[g.year] = true;
      for (const m of g.months) {
        mths[`${g.year}-${m.month}`] = true;
      }
    }
    setCollapsedYears(yrs);
    setCollapsedMonths(mths);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-text-primary">
            Year-Wise Service History
          </h1>
          <p className="text-xs text-text-secondary">
            Organized chronologically by actual service date (`service_date`) — newest first
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={expandAll}
            className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg hover:text-text-primary"
          >
            Expand All
          </button>
          <button
            type="button"
            onClick={collapseAll}
            className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg hover:text-text-primary"
          >
            Collapse All
          </button>
          <button
            type="button"
            onClick={() => setServiceModalOpen(true)}
            className="zb-btn-primary inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-medium"
          >
            <Plus className="h-3.5 w-3.5" />
            Add Service
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="zb-card p-3.5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="relative lg:col-span-2">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-text-muted" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search customer name, phone, code, address..."
            className="w-full rounded-lg border pl-9 pr-3 py-1.5 text-sm"
          />
        </div>

        <select
          value={yearFilter}
          onChange={(e) => setYearFilter(e.target.value)}
          aria-label="Filter by year"
          className="rounded-lg border px-3 py-1.5 text-sm"
        >
          <option value="">All Years</option>
          {availableYears.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>

        <select
          value={monthFilter}
          onChange={(e) => setMonthFilter(e.target.value)}
          aria-label="Filter by month"
          disabled={!yearFilter}
          className="rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50"
        >
          <option value="">All Months</option>
          {Array.from({ length: 12 }).map((_, idx) => (
            <option key={idx + 1} value={idx + 1}>
              {getMonthName(idx + 1)}
            </option>
          ))}
        </select>

        <div className="grid grid-cols-2 gap-2">
          <select
            value={serviceTypeFilter}
            onChange={(e) => setServiceTypeFilter(e.target.value)}
            aria-label="Filter by service type"
            className="rounded-lg border px-2 py-1.5 text-xs"
          >
            <option value="">All Types</option>
            {settings.service_types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>

          <select
            value={paymentStatusFilter}
            onChange={(e) => setPaymentStatusFilter(e.target.value)}
            aria-label="Filter by payment status"
            className="rounded-lg border px-2 py-1.5 text-xs"
          >
            <option value="">All Status</option>
            <option value="Paid">Paid</option>
            <option value="Partially Paid">Partially Paid</option>
            <option value="Unpaid">Unpaid</option>
            <option value="Refunded">Refunded</option>
          </select>
        </div>
      </div>

      {error && <ErrorBanner message={error} onRetry={() => void loadHistory()} />}

      {loading ? (
        <div className="space-y-4">
          <SkeletonCard lines={4} />
          <SkeletonCard lines={4} />
        </div>
      ) : !data || data.grouped.length === 0 ? (
        <EmptyState
          title="No matching service history"
          description="Try clearing filters or record a new cleaning service."
        />
      ) : (
        <div className="space-y-4">
          {data.grouped.map((yearGroup) => {
            const yearCollapsed = Boolean(collapsedYears[yearGroup.year]);
            const yearTotalServices = yearGroup.months.reduce(
              (sum, m) => sum + m.records.length,
              0
            );
            const yearRevenue = yearGroup.months.reduce(
              (sum, m) =>
                sum + m.records.reduce((ms, r) => ms + Number(r.total_amount ?? 0), 0),
              0
            );

            return (
              <div key={yearGroup.year} className="zb-card overflow-hidden">
                <button
                  type="button"
                  onClick={() => toggleYear(yearGroup.year)}
                  className="flex w-full items-center justify-between bg-surface px-5 py-3.5 text-left transition hover:bg-bg"
                >
                  <div className="flex items-center gap-2.5">
                    {yearCollapsed ? (
                      <ChevronRight className="h-4 w-4 text-text-muted" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-accent" />
                    )}
                    <span className="text-base font-semibold text-text-primary">
                      {yearGroup.year}
                    </span>
                    <span className="rounded-md bg-bg px-2 py-0.5 text-xs text-text-secondary">
                      {yearTotalServices} {yearTotalServices === 1 ? 'service' : 'services'}
                    </span>
                  </div>
                  <span className="text-sm font-semibold text-text-primary">
                    {formatCurrency(yearRevenue, sym)}
                  </span>
                </button>

                {!yearCollapsed && (
                  <div className="border-t border-border divide-y divide-border">
                    {yearGroup.months.map((monthGroup) => {
                      const monthKey = `${yearGroup.year}-${monthGroup.month}`;
                      const monthCollapsed = Boolean(collapsedMonths[monthKey]);
                      const monthTotal = monthGroup.records.reduce(
                        (s, r) => s + Number(r.total_amount ?? 0),
                        0
                      );

                      return (
                        <div key={monthKey}>
                          <button
                            type="button"
                            onClick={() => toggleMonth(yearGroup.year, monthGroup.month)}
                            className="flex w-full items-center justify-between bg-bg/55 px-6 py-2.5 text-left transition hover:bg-bg"
                          >
                            <div className="flex items-center gap-2">
                              {monthCollapsed ? (
                                <ChevronRight className="h-3.5 w-3.5 text-text-muted" />
                              ) : (
                                <ChevronDown className="h-3.5 w-3.5 text-text-secondary" />
                              )}
                              <span className="text-sm font-semibold text-text-primary">
                                {getMonthName(monthGroup.month)}
                              </span>
                              <span className="text-xs text-text-muted">
                                ({monthGroup.records.length})
                              </span>
                            </div>
                            <span className="text-xs font-medium text-text-secondary">
                              {formatCurrency(monthTotal, sym)}
                            </span>
                          </button>

                          {!monthCollapsed && (
                            <div className="divide-y divide-border bg-surface">
                              {monthGroup.records.map((srv) => (
                                <Link
                                  key={srv.id}
                                  to={`/services/${srv.id}`}
                                  className="flex flex-col gap-1.5 px-8 py-3 transition hover:bg-bg sm:flex-row sm:items-center sm:justify-between"
                                >
                                  <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2 text-sm">
                                      <span className="font-medium text-accent">
                                        {formatDayMonth(srv.service_date)}
                                      </span>
                                      <span className="text-text-muted">—</span>
                                      <span className="font-semibold text-text-primary">
                                        {srv.customers?.full_name}
                                      </span>
                                      <span className="text-text-muted">—</span>
                                      <span className="font-semibold text-text-primary">
                                        {formatCurrency(srv.total_amount, sym)}
                                      </span>
                                    </div>
                                    <p className="mt-0.5 text-xs text-text-secondary">
                                      {srv.service_type}
                                      {srv.tank_details ? ` • ${srv.tank_details}` : ''}
                                      {srv.customers?.area ? ` • ${srv.customers.area}` : ''}
                                      {srv.customers?.phone_number
                                        ? ` • ${srv.customers.phone_number}`
                                        : ''}
                                    </p>
                                  </div>

                                  <div className="flex items-center gap-2.5 shrink-0">
                                    <PaymentStatusBadge status={srv.payment_status} />
                                  </div>
                                </Link>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <ServiceFormModal
        open={serviceModalOpen}
        onClose={() => setServiceModalOpen(false)}
        onSaved={() => void loadHistory()}
      />
    </div>
  );
}
