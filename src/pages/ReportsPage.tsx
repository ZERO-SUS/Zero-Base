import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BarChart3, Download } from 'lucide-react';
import { PaymentStatusBadge } from '../components/ui/Badge';
import { EmptyState, ErrorBanner, SkeletonCard } from '../components/ui/Feedback';
import { useAuth } from '../context/AuthContext';
import { apiDownloadBlob, apiFetch, ApiError } from '../lib/api';
import { formatCurrency, formatServiceDate, getTodayIstInputDate } from '../lib/format';
import type { ReportSummary, ServiceRecord } from '../types/domain';

type Period = 'daily' | 'monthly' | 'yearly' | 'custom';

interface ReportsResponse {
  summary: ReportSummary;
  services: ServiceRecord[];
}

export function ReportsPage() {
  const { settings } = useAuth();
  const sym = settings.currency_symbol || '₹';
  const todayIst = getTodayIstInputDate();

  const [period, setPeriod] = useState<Period>('monthly');
  const [date, setDate] = useState(todayIst);
  const [month, setMonth] = useState(todayIst.slice(0, 7));
  const [year, setYear] = useState(todayIst.slice(0, 4));
  const [startDate, setStartDate] = useState(`${todayIst.slice(0, 7)}-01`);
  const [endDate, setEndDate] = useState(todayIst);

  const [data, setData] = useState<ReportsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buildQuery = useCallback(() => {
    const params = new URLSearchParams({ period });
    if (period === 'daily') params.set('date', date);
    if (period === 'monthly') params.set('month', month);
    if (period === 'yearly') params.set('year', year);
    if (period === 'custom') {
      params.set('start_date', startDate);
      params.set('end_date', endDate);
    }
    return params.toString();
  }, [period, date, month, year, startDate, endDate]);

  const loadReports = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<ReportsResponse>(`/api/reports?${buildQuery()}`);
      setData(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load report analytics.');
    } finally {
      setLoading(false);
    }
  }, [buildQuery]);

  useEffect(() => {
    void loadReports();
  }, [loadReports]);

  const handleExportCsv = async () => {
    setExporting(true);
    setError(null);
    try {
      const blob = await apiDownloadBlob(`/api/reports/export.csv?${buildQuery()}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `zero-base-report-${period}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to export CSV.');
    } finally {
      setExporting(false);
    }
  };

  const s = data?.summary;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-text-primary">
            Reports & Analytics
          </h1>
          <p className="text-xs text-text-secondary">
            Real-time financial and operational breakdown calculated directly from PostgreSQL records
          </p>
        </div>

        <button
          type="button"
          disabled={exporting || loading}
          onClick={() => void handleExportCsv()}
          className="zb-btn-primary inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-medium self-start sm:self-auto disabled:opacity-50"
        >
          <Download className="h-3.5 w-3.5" />
          {exporting ? 'Exporting...' : 'Export CSV'}
        </button>
      </div>

      {/* Period Selector */}
      <div className="zb-card p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1.5">
          {(['daily', 'monthly', 'yearly', 'custom'] as Period[]).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium capitalize transition ${
                period === p
                  ? 'bg-accent text-accent-fg'
                  : 'border border-border bg-surface text-text-secondary hover:bg-bg'
              }`}
            >
              {p}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {period === 'daily' && (
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="rounded-lg border px-3 py-1.5 text-sm"
            />
          )}
          {period === 'monthly' && (
            <input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="rounded-lg border px-3 py-1.5 text-sm"
            />
          )}
          {period === 'yearly' && (
            <input
              type="number"
              min="2000"
              max="2100"
              value={year}
              onChange={(e) => setYear(e.target.value)}
              className="w-28 rounded-lg border px-3 py-1.5 text-sm"
            />
          )}
          {period === 'custom' && (
            <>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="rounded-lg border px-3 py-1.5 text-sm"
              />
              <span className="text-xs text-text-muted">to</span>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="rounded-lg border px-3 py-1.5 text-sm"
              />
            </>
          )}
        </div>
      </div>

      {error && <ErrorBanner message={error} onRetry={() => void loadReports()} />}

      {loading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 7 }).map((_, i) => (
            <SkeletonCard key={i} lines={1} />
          ))}
        </div>
      ) : s ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="zb-card p-4">
              <p className="text-[11px] uppercase tracking-wider text-text-muted">Total Services</p>
              <p className="mt-1 text-xl font-semibold">{s.total_services}</p>
            </div>
            <div className="zb-card p-4">
              <p className="text-[11px] uppercase tracking-wider text-text-muted">Total Billed</p>
              <p className="mt-1 text-xl font-semibold">{formatCurrency(s.total_billed, sym)}</p>
            </div>
            <div className="zb-card p-4">
              <p className="text-[11px] uppercase tracking-wider text-text-muted">Total Collected</p>
              <p className="mt-1 text-xl font-semibold text-success">
                {formatCurrency(s.total_collected, sym)}
              </p>
            </div>
            <div className="zb-card p-4">
              <p className="text-[11px] uppercase tracking-wider text-text-muted">Outstanding</p>
              <p className={`mt-1 text-xl font-semibold ${s.outstanding_balance > 0 ? 'text-error' : ''}`}>
                {formatCurrency(s.outstanding_balance, sym)}
              </p>
            </div>
            <div className="zb-card p-4">
              <p className="text-[11px] uppercase tracking-wider text-text-muted">Cash Payments</p>
              <p className="mt-1 text-lg font-semibold">{formatCurrency(s.cash_payments, sym)}</p>
            </div>
            <div className="zb-card p-4">
              <p className="text-[11px] uppercase tracking-wider text-text-muted">UPI Payments</p>
              <p className="mt-1 text-lg font-semibold">{formatCurrency(s.upi_payments, sym)}</p>
            </div>
            <div className="zb-card p-4">
              <p className="text-[11px] uppercase tracking-wider text-text-muted">Other Payments</p>
              <p className="mt-1 text-lg font-semibold">{formatCurrency(s.other_payments, sym)}</p>
            </div>
          </div>

          {/* Service Type Breakdown */}
          <section className="zb-card p-5 space-y-4">
            <div className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-accent" />
              <h2 className="text-sm font-semibold text-text-primary">Service Type Breakdown</h2>
            </div>

            {s.service_type_breakdown.length === 0 ? (
              <p className="text-xs text-text-muted">No services in the selected period.</p>
            ) : (
              <div className="space-y-3">
                {s.service_type_breakdown.map((row) => {
                  const pct =
                    s.total_billed > 0
                      ? Math.round((Number(row.total_billed) / Number(s.total_billed)) * 100)
                      : 0;
                  return (
                    <div key={row.service_type} className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium text-text-primary">
                          {row.service_type} ({row.service_count})
                        </span>
                        <span className="text-text-secondary">
                          Billed {formatCurrency(row.total_billed, sym)} • Paid{' '}
                          {formatCurrency(row.total_paid, sym)} ({pct}%)
                        </span>
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded-full bg-bg">
                        <div
                          className="h-full rounded-full bg-accent transition-all"
                          style={{ width: `${Math.max(2, pct)}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Detailed Services in Period */}
          <section className="zb-card overflow-hidden">
            <div className="border-b border-border px-5 py-3.5">
              <h2 className="text-sm font-semibold text-text-primary">
                Services in Period ({formatServiceDate(s.start_date)} – {formatServiceDate(s.end_date)})
              </h2>
            </div>
            {data.services.length === 0 ? (
              <div className="p-5">
                <EmptyState
                  title="No services for this date range"
                  description="Adjust the report filter dates above to inspect another period."
                />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-border bg-bg text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                    <tr>
                      <th className="px-4 py-2.5">Date</th>
                      <th className="px-4 py-2.5">Customer</th>
                      <th className="px-4 py-2.5">Service Type</th>
                      <th className="px-4 py-2.5">Billed</th>
                      <th className="px-4 py-2.5">Paid</th>
                      <th className="px-4 py-2.5">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data.services.map((srv) => (
                      <tr key={srv.service_id} className="hover:bg-bg/70">
                        <td className="px-4 py-2.5 text-xs">
                          <Link
                            to={`/services/${srv.service_id}`}
                            className="font-medium text-accent hover:underline"
                          >
                            {formatServiceDate(srv.service_date)}
                          </Link>
                        </td>
                        <td className="px-4 py-2.5 font-medium">{srv.customers?.full_name}</td>
                        <td className="px-4 py-2.5 text-text-secondary">{srv.service_type}</td>
                        <td className="px-4 py-2.5">{formatCurrency(srv.total_amount, sym)}</td>
                        <td className="px-4 py-2.5">{formatCurrency(srv.amount_paid, sym)}</td>
                        <td className="px-4 py-2.5">
                          <PaymentStatusBadge status={srv.payment_status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
