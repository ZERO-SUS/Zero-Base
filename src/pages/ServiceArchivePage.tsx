import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  Calendar as CalendarIcon,
  ChevronRight,
  List,
  Search,
} from 'lucide-react';
import { PaymentStatusBadge } from '../components/ui/Badge';
import { EmptyState, ErrorBanner, SkeletonCard } from '../components/ui/Feedback';
import { useAuth } from '../context/AuthContext';
import { apiFetch, ApiError } from '../lib/api';
import {
  formatCurrency,
  formatDateTimeIst,
  formatServiceDate,
  getMonthName,
} from '../lib/format';

interface ArchiveServiceRow {
  id: string;
  customer_id: string;
  service_date: string;
  service_type: string;
  tank_details: string | null;
  total_amount: number;
  amount_paid: number;
  balance_amount: number;
  payment_status: 'Unpaid' | 'Partially Paid' | 'Paid' | 'Refunded';
  created_at: string;
  customers: {
    id: string;
    customer_code: string;
    full_name: string;
    phone_number: string;
    area: string | null;
  };
}

interface ArchiveYear {
  year: number;
  count: number;
  revenue: number;
  months: Array<{
    month: number;
    count: number;
    revenue: number;
  }>;
}

interface ArchiveResponse {
  years: ArchiveYear[];
  month_services: ArchiveServiceRow[];
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function ServiceArchivePage() {
  const { settings } = useAuth();
  const sym = settings.currency_symbol || '₹';

  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const [selectedMonth, setSelectedMonth] = useState<number | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'calendar' | 'list'>('calendar');

  const [search, setSearch] = useState('');
  const [paymentStatus, setPaymentStatus] = useState('');
  const [serviceType, setServiceType] = useState('');

  const [data, setData] = useState<ArchiveResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadArchive = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (selectedYear) params.set('year', String(selectedYear));
    if (selectedMonth) params.set('month', String(selectedMonth));
    if (search.trim()) params.set('q', search.trim());
    if (paymentStatus) params.set('payment_status', paymentStatus);
    if (serviceType) params.set('service_type', serviceType);

    try {
      const res = await apiFetch<ArchiveResponse>(`/api/archive/summary?${params.toString()}`);
      setData(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load service archive.');
    } finally {
      setLoading(false);
    }
  }, [selectedYear, selectedMonth, search, paymentStatus, serviceType]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadArchive();
    }, 200);
    return () => window.clearTimeout(timer);
  }, [loadArchive]);

  const activeYearObj = useMemo(
    () => data?.years.find((y) => y.year === selectedYear) ?? null,
    [data, selectedYear]
  );

  // Build calendar grid for selectedYear + selectedMonth
  const calendarCells = useMemo(() => {
    if (!selectedYear || !selectedMonth) return [];
    const firstDayOfWeek = new Date(Date.UTC(selectedYear, selectedMonth - 1, 1)).getUTCDay();
    const daysInMonth = new Date(Date.UTC(selectedYear, selectedMonth, 0)).getUTCDate();

    const byDate = new Map<string, ArchiveServiceRow[]>();
    for (const s of data?.month_services ?? []) {
      const list = byDate.get(s.service_date) ?? [];
      list.push(s);
      byDate.set(s.service_date, list);
    }

    const cells: Array<{
      day: number | null;
      isoDate: string | null;
      records: ArchiveServiceRow[];
    }> = [];

    for (let i = 0; i < firstDayOfWeek; i += 1) {
      cells.push({ day: null, isoDate: null, records: [] });
    }
    for (let day = 1; day <= daysInMonth; day += 1) {
      const isoDate = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      cells.push({
        day,
        isoDate,
        records: byDate.get(isoDate) ?? [],
      });
    }
    return cells;
  }, [selectedYear, selectedMonth, data?.month_services]);

  const selectedDateRecords = useMemo(() => {
    if (!selectedDate) return [];
    return (data?.month_services ?? []).filter((s) => s.service_date === selectedDate);
  }, [selectedDate, data?.month_services]);

  return (
    <div className="space-y-5">
      {/* Header + Breadcrumb */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-text-primary">
            Service Archive
          </h1>
          <p className="text-xs text-text-secondary">
            Calendar-inspired historical browser organized by actual <code>service_date</code>
          </p>
        </div>

        {/* Breadcrumb navigation */}
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <button
            type="button"
            onClick={() => {
              setSelectedYear(null);
              setSelectedMonth(null);
              setSelectedDate(null);
            }}
            className={`rounded-md px-2.5 py-1 font-medium ${
              !selectedYear ? 'bg-accent text-accent-fg' : 'bg-surface border border-border hover:bg-bg'
            }`}
          >
            All Years
          </button>
          {selectedYear && (
            <>
              <ChevronRight className="h-3.5 w-3.5 text-text-muted" />
              <button
                type="button"
                onClick={() => {
                  setSelectedMonth(null);
                  setSelectedDate(null);
                }}
                className={`rounded-md px-2.5 py-1 font-medium ${
                  !selectedMonth
                    ? 'bg-accent text-accent-fg'
                    : 'bg-surface border border-border hover:bg-bg'
                }`}
              >
                {selectedYear}
              </button>
            </>
          )}
          {selectedYear && selectedMonth && (
            <>
              <ChevronRight className="h-3.5 w-3.5 text-text-muted" />
              <button
                type="button"
                onClick={() => setSelectedDate(null)}
                className={`rounded-md px-2.5 py-1 font-medium ${
                  !selectedDate
                    ? 'bg-accent text-accent-fg'
                    : 'bg-surface border border-border hover:bg-bg'
                }`}
              >
                {getMonthName(selectedMonth)}
              </button>
            </>
          )}
          {selectedDate && (
            <>
              <ChevronRight className="h-3.5 w-3.5 text-text-muted" />
              <span className="rounded-md bg-accent px-2.5 py-1 font-medium text-accent-fg">
                {formatServiceDate(selectedDate)}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Archive Search & Filter Bar */}
      <div className="zb-card p-3.5 grid grid-cols-1 gap-3 sm:grid-cols-4">
        <div className="relative sm:col-span-2">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-text-muted" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter archive by customer name, phone, code, area, or type..."
            className="w-full rounded-lg border pl-9 pr-3 py-1.5 text-sm"
          />
        </div>
        <select
          value={serviceType}
          onChange={(e) => setServiceType(e.target.value)}
          aria-label="Filter archive by service type"
          className="rounded-lg border px-3 py-1.5 text-sm"
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
          onChange={(e) => setPaymentStatus(e.target.value)}
          aria-label="Filter archive by payment status"
          className="rounded-lg border px-3 py-1.5 text-sm"
        >
          <option value="">All Payment Status</option>
          <option value="Paid">Paid</option>
          <option value="Partially Paid">Partially Paid</option>
          <option value="Unpaid">Unpaid</option>
        </select>
      </div>

      {error && <ErrorBanner message={error} onRetry={() => void loadArchive()} />}

      {loading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <SkeletonCard lines={2} />
          <SkeletonCard lines={2} />
          <SkeletonCard lines={2} />
        </div>
      ) : !data || data.years.length === 0 ? (
        <EmptyState
          title="No archived service records found"
          description="Matching cleaning services will automatically populate the year and month archive."
          icon={<CalendarIcon className="h-5 w-5" />}
        />
      ) : !selectedYear ? (
        /* LEVEL 1 — YEAR SELECTION */
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {data.years.map((yr) => (
            <button
              key={yr.year}
              type="button"
              onClick={() => {
                setSelectedYear(yr.year);
                setSelectedMonth(null);
                setSelectedDate(null);
              }}
              className="zb-card group p-5 text-left transition hover:border-accent"
            >
              <div className="flex items-center justify-between">
                <span className="text-2xl font-bold tracking-tight text-text-primary group-hover:text-accent">
                  {yr.year}
                </span>
                <span className="rounded-md bg-accent-soft px-2.5 py-0.5 text-xs font-semibold text-accent">
                  {yr.count} {yr.count === 1 ? 'service' : 'services'}
                </span>
              </div>
              <p className="mt-3 text-xs text-text-secondary">
                Total Billed:{' '}
                <strong className="text-text-primary">{formatCurrency(yr.revenue, sym)}</strong>
              </p>
              <p className="mt-1 text-[11px] text-text-muted">
                {yr.months.length} active {yr.months.length === 1 ? 'month' : 'months'}
              </p>
            </button>
          ))}
        </div>
      ) : !selectedMonth ? (
        /* LEVEL 2 — 12-MONTH SELECTION */
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => setSelectedYear(null)}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-text-secondary hover:text-text-primary"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to All Years
          </button>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 12 }).map((_, idx) => {
              const monthNum = idx + 1;
              const stats = activeYearObj?.months.find((m) => m.month === monthNum);
              const hasRecords = Boolean(stats && stats.count > 0);
              return (
                <button
                  key={monthNum}
                  type="button"
                  onClick={() => {
                    setSelectedMonth(monthNum);
                    setSelectedDate(null);
                  }}
                  className={`zb-card p-4 text-left transition ${
                    hasRecords
                      ? 'border-border hover:border-accent'
                      : 'opacity-55 hover:opacity-85'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-text-primary">
                      {getMonthName(monthNum)}
                    </span>
                    {hasRecords ? (
                      <span className="rounded-md bg-accent px-2 py-0.5 text-[11px] font-semibold text-accent-fg">
                        {stats!.count}
                      </span>
                    ) : (
                      <span className="text-[11px] text-text-muted">0</span>
                    )}
                  </div>
                  <p className="mt-2 text-xs text-text-secondary">
                    {hasRecords ? formatCurrency(stats!.revenue, sym) : 'No services'}
                  </p>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        /* LEVEL 3 & 4 — CALENDAR GRID / LIST + SELECTED DATE SERVICES */
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => {
                setSelectedMonth(null);
                setSelectedDate(null);
              }}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-text-secondary hover:text-text-primary"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to {selectedYear} Months
            </button>

            <div className="inline-flex rounded-lg border border-border bg-surface p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setViewMode('calendar')}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium ${
                  viewMode === 'calendar'
                    ? 'bg-accent text-accent-fg'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                <CalendarIcon className="h-3.5 w-3.5" />
                Calendar View
              </button>
              <button
                type="button"
                onClick={() => setViewMode('list')}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium ${
                  viewMode === 'list'
                    ? 'bg-accent text-accent-fg'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                <List className="h-3.5 w-3.5" />
                Chronological List
              </button>
            </div>
          </div>

          {viewMode === 'calendar' ? (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
              {/* Calendar Grid */}
              <div className="zb-card p-4 lg:col-span-2">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-text-primary">
                    {getMonthName(selectedMonth)} {selectedYear}
                  </h2>
                  <span className="text-xs text-text-muted">
                    {data.month_services.length} total records
                  </span>
                </div>

                <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-semibold uppercase tracking-wider text-text-muted pb-2">
                  {WEEKDAYS.map((d) => (
                    <div key={d}>{d}</div>
                  ))}
                </div>

                <div className="grid grid-cols-7 gap-1.5">
                  {calendarCells.map((cell, idx) => {
                    if (!cell.day || !cell.isoDate) {
                      return <div key={`empty-${idx}`} className="h-14 sm:h-16 rounded-lg bg-bg/30" />;
                    }
                    const has = cell.records.length > 0;
                    const isSelected = selectedDate === cell.isoDate;
                    return (
                      <button
                        key={cell.isoDate}
                        type="button"
                        onClick={() => setSelectedDate(cell.isoDate)}
                        className={`flex h-14 sm:h-16 flex-col items-start justify-between rounded-lg border p-1.5 text-left transition ${
                          isSelected
                            ? 'border-accent bg-accent-soft'
                            : has
                              ? 'border-border bg-surface hover:border-accent'
                              : 'border-border/50 bg-bg/40 text-text-muted hover:bg-bg'
                        }`}
                      >
                        <span
                          className={`text-xs font-semibold ${
                            isSelected ? 'text-accent' : has ? 'text-text-primary' : 'text-text-muted'
                          }`}
                        >
                          {cell.day}
                        </span>
                        {has && (
                          <span className="self-end rounded bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-accent-fg">
                            {cell.records.length}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* LEVEL 4 — SELECTED DATE DETAILS */}
              <div className="zb-card p-4 space-y-3">
                <h3 className="text-sm font-semibold text-text-primary">
                  {selectedDate ? formatServiceDate(selectedDate) : 'Select a Date'}
                </h3>
                {!selectedDate ? (
                  <p className="text-xs text-text-secondary">
                    Click any marked date on the calendar to inspect the services performed on that day.
                  </p>
                ) : selectedDateRecords.length === 0 ? (
                  <p className="text-xs text-text-muted">
                    No services performed on {formatServiceDate(selectedDate)}.
                  </p>
                ) : (
                  <div className="space-y-2.5">
                    {selectedDateRecords.map((srv) => (
                      <div
                        key={srv.id}
                        className="rounded-lg border border-border bg-bg p-3 space-y-1.5"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="text-sm font-semibold text-text-primary">
                              {srv.customers.full_name}
                            </p>
                            <p className="font-mono text-[11px] text-text-secondary">
                              {srv.customers.phone_number}
                              {srv.customers.area ? ` • ${srv.customers.area}` : ''}
                            </p>
                          </div>
                          <PaymentStatusBadge status={srv.payment_status} />
                        </div>
                        <p className="text-xs text-text-secondary">
                          {srv.service_type} •{' '}
                          <strong className="text-text-primary">
                            {formatCurrency(srv.total_amount, sym)}
                          </strong>
                        </p>
                        <p className="text-[10px] text-text-muted">
                          Uploaded (IST): {formatDateTimeIst(srv.created_at)}
                        </p>
                        <div className="pt-1">
                          <Link
                            to={`/services/${srv.id}`}
                            className="inline-flex items-center rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-accent-fg hover:bg-accent-hover"
                          >
                            Open Full Record
                          </Link>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            /* CHRONOLOGICAL LIST VIEW */
            <div className="zb-card overflow-hidden">
              <div className="border-b border-border px-5 py-3.5">
                <h2 className="text-sm font-semibold text-text-primary">
                  {getMonthName(selectedMonth)} {selectedYear} — Chronological List (
                  {data.month_services.length})
                </h2>
              </div>
              {data.month_services.length === 0 ? (
                <div className="p-6 text-center text-xs text-text-muted">
                  No services recorded in {getMonthName(selectedMonth)} {selectedYear}.
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {data.month_services.map((srv) => (
                    <div
                      key={srv.id}
                      className="flex flex-col gap-2 px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between hover:bg-bg/70"
                    >
                      <div className="space-y-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs font-semibold text-accent">
                            {formatServiceDate(srv.service_date)}
                          </span>
                          <span className="text-sm font-semibold text-text-primary">
                            {srv.customers.full_name}
                          </span>
                          <span className="font-mono text-xs text-text-muted">
                            {srv.customers.phone_number}
                          </span>
                        </div>
                        <p className="text-xs text-text-secondary">
                          {srv.service_type}
                          {srv.customers.area ? ` • ${srv.customers.area}` : ''} • Recorded{' '}
                          {formatDateTimeIst(srv.created_at)}
                        </p>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <span className="text-sm font-semibold">
                          {formatCurrency(srv.total_amount, sym)}
                        </span>
                        <PaymentStatusBadge status={srv.payment_status} />
                        <Link
                          to={`/services/${srv.id}`}
                          className="rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-bg"
                        >
                          View
                        </Link>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
