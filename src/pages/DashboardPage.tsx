import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Bell,
  Calendar,
  Plus,
  Search,
  UserPlus,
  Wrench,
} from 'lucide-react';
import { CustomerFormModal } from '../components/customers/CustomerFormModal';
import { ServiceFormModal } from '../components/services/ServiceFormModal';
import { PaymentStatusBadge, ReminderCategoryBadge } from '../components/ui/Badge';
import { EmptyState, ErrorBanner, SkeletonCard } from '../components/ui/Feedback';
import { useAuth } from '../context/AuthContext';
import { apiFetch, ApiError } from '../lib/api';
import { formatCurrency, formatServiceDate } from '../lib/format';
import type {
  Customer,
  DashboardMetrics,
  ReminderRecord,
  ServiceRecord,
} from '../types/domain';

interface DashboardResponse {
  metrics: DashboardMetrics;
  recent_services: ServiceRecord[];
  upcoming_reminders: ReminderRecord[];
}

export function DashboardPage() {
  const navigate = useNavigate();
  const { settings } = useAuth();
  const sym = settings.currency_symbol || '₹';

  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Quick customer search
  const [quickQuery, setQuickQuery] = useState('');
  const [quickResults, setQuickResults] = useState<Customer[]>([]);
  const [searching, setSearching] = useState(false);

  // Modals
  const [customerModalOpen, setCustomerModalOpen] = useState(false);
  const [serviceModalOpen, setServiceModalOpen] = useState(false);

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<DashboardResponse>('/api/dashboard');
      setData(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load dashboard data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    const q = quickQuery.trim();
    if (q.length < 2) {
      setQuickResults([]);
      return;
    }
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const res = await apiFetch<{ customers: Customer[] }>(
          `/api/customers?q=${encodeURIComponent(q)}&limit=8`
        );
        setQuickResults(res.customers);
      } catch {
        // Ignore transient errors in quick search
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [quickQuery]);

  const m = data?.metrics;

  const statItems = m
    ? [
        { label: 'Total Customers', value: String(m.total_customers) },
        { label: 'Total Services', value: String(m.total_services) },
        { label: 'Services This Month', value: String(m.services_this_month) },
        { label: 'Services This Year', value: String(m.services_this_year) },
        { label: "Today's Services", value: String(m.todays_services) },
        { label: 'Upcoming Reminders', value: String(m.upcoming_reminders) },
        { label: 'Due Today', value: String(m.due_today), highlight: m.due_today > 0 ? 'warning' : undefined },
        { label: 'Overdue Services', value: String(m.overdue_services), highlight: m.overdue_services > 0 ? 'error' : undefined },
        {
          label: 'Pending Payments',
          value: formatCurrency(m.pending_payments_amount, sym),
          sub: `${m.pending_payments_count} unpaid/partial`,
        },
        { label: 'Revenue This Month', value: formatCurrency(m.revenue_this_month, sym) },
        { label: 'Revenue This Year', value: formatCurrency(m.revenue_this_year, sym) },
      ]
    : [];

  return (
    <div className="space-y-6">
      {/* Header + Quick Actions */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-text-primary">Dashboard</h1>
          <p className="text-xs text-text-secondary">
            Live business overview {m?.today_ist ? `• Business Date (IST): ${formatServiceDate(m.today_ist)}` : ''}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => setCustomerModalOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3.5 py-2 text-xs font-medium text-text-primary hover:bg-bg"
          >
            <UserPlus className="h-3.5 w-3.5" />
            Add Customer
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

      {/* Quick Customer Search */}
      <div className="relative">
        <div className="zb-card flex items-center gap-2 px-3.5 py-2.5">
          <Search className="h-4 w-4 text-text-muted shrink-0" />
          <input
            type="text"
            value={quickQuery}
            onChange={(e) => setQuickQuery(e.target.value)}
            placeholder="Quick customer search by name, phone number, address, locality, or customer ID..."
            className="w-full border-0 bg-transparent p-0 text-sm focus:ring-0"
          />
          {searching && <span className="text-[11px] text-text-muted">Searching...</span>}
        </div>

        {quickQuery.trim().length >= 2 && quickResults.length > 0 && (
          <div className="absolute left-0 right-0 z-20 mt-1.5 overflow-hidden rounded-xl border border-border bg-elevated shadow-modal divide-y divide-border">
            {quickResults.map((c) => (
              <button
                key={c.customer_id}
                type="button"
                onClick={() => navigate(`/customers/${c.customer_id}`)}
                className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-bg"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-text-primary">{c.full_name}</p>
                  <p className="truncate text-xs text-text-secondary">
                    {c.address} {c.locality ? `• ${c.locality}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="font-mono text-xs text-text-secondary">{c.primary_phone}</span>
                  <ArrowRight className="h-3.5 w-3.5 text-text-muted" />
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {error && <ErrorBanner message={error} onRetry={() => void loadDashboard()} />}

      {/* Metrics Grid */}
      {loading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <SkeletonCard key={i} lines={1} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {statItems.map((item) => (
            <div key={item.label} className="zb-card p-4">
              <p className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
                {item.label}
              </p>
              <p
                className={`mt-1.5 text-xl font-semibold tracking-tight ${
                  item.highlight === 'error'
                    ? 'text-error'
                    : item.highlight === 'warning'
                      ? 'text-warning'
                      : 'text-text-primary'
                }`}
              >
                {item.value}
              </p>
              {item.sub && <p className="mt-0.5 text-[11px] text-text-secondary">{item.sub}</p>}
            </div>
          ))}
        </div>
      )}

      {/* Recent Services + Upcoming Reminders */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Recent Service Records */}
        <section className="zb-card overflow-hidden">
          <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
            <div className="flex items-center gap-2">
              <Wrench className="h-4 w-4 text-accent" />
              <h2 className="text-sm font-semibold text-text-primary">Recent Service Records</h2>
            </div>
            <Link to="/history" className="text-xs font-medium text-accent hover:underline">
              Year-wise History
            </Link>
          </div>

          {loading ? (
            <div className="p-4 space-y-3">
              <SkeletonCard lines={2} />
            </div>
          ) : !data || data.recent_services.length === 0 ? (
            <div className="p-5">
              <EmptyState
                title="No services recorded yet"
                description="Add your first customer and tank cleaning service to populate live history."
                icon={<Calendar className="h-5 w-5" />}
              />
            </div>
          ) : (
            <div className="divide-y divide-border">
              {data.recent_services.map((srv) => (
                <Link
                  key={srv.service_id}
                  to={`/services/${srv.service_id}`}
                  className="flex items-center justify-between gap-3 px-5 py-3 transition hover:bg-bg"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-text-primary">
                      {srv.customers?.full_name ?? 'Customer'}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-text-secondary">
                      {formatServiceDate(srv.service_date)} • {srv.service_type}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="text-sm font-semibold text-text-primary">
                      {formatCurrency(srv.total_amount, sym)}
                    </span>
                    <PaymentStatusBadge status={srv.payment_status} />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>

        {/* Upcoming Reminders */}
        <section className="zb-card overflow-hidden">
          <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
            <div className="flex items-center gap-2">
              <Bell className="h-4 w-4 text-accent" />
              <h2 className="text-sm font-semibold text-text-primary">Upcoming & Due Reminders</h2>
            </div>
            <Link to="/reminders" className="text-xs font-medium text-accent hover:underline">
              Manage All
            </Link>
          </div>

          {loading ? (
            <div className="p-4 space-y-3">
              <SkeletonCard lines={2} />
            </div>
          ) : !data || data.upcoming_reminders.length === 0 ? (
            <div className="p-5">
              <EmptyState
                title="No active reminders"
                description="Reminders appear automatically when services are scheduled with a next due date."
                icon={<Bell className="h-5 w-5" />}
              />
            </div>
          ) : (
            <div className="divide-y divide-border">
              {data.upcoming_reminders.map((rem) => (
                <Link
                  key={rem.reminder_id}
                  to="/reminders"
                  className="flex items-center justify-between gap-3 px-5 py-3 transition hover:bg-bg"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-text-primary">
                      {rem.customers?.full_name ?? 'Customer'}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-text-secondary">
                      Due {formatServiceDate(rem.due_date)} • {rem.customers?.primary_phone}
                    </p>
                  </div>
                  <ReminderCategoryBadge category={rem.category} />
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>

      <CustomerFormModal
        open={customerModalOpen}
        onClose={() => setCustomerModalOpen(false)}
        onSaved={(c) => {
          void loadDashboard();
          navigate(`/customers/${c.customer_id}`);
        }}
      />

      <ServiceFormModal
        open={serviceModalOpen}
        onClose={() => setServiceModalOpen(false)}
        onSaved={() => void loadDashboard()}
      />
    </div>
  );
}
