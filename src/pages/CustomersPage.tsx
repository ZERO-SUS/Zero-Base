import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArchiveRestore, MapPin, Phone, Search, UserPlus } from 'lucide-react';
import { CustomerFormModal } from '../components/customers/CustomerFormModal';
import { Badge } from '../components/ui/Badge';
import { EmptyState, ErrorBanner, SkeletonCard } from '../components/ui/Feedback';
import { apiFetch, ApiError } from '../lib/api';
import type { Customer } from '../types/domain';

export function CustomersPage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const loadCustomers = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (query.trim()) params.set('q', query.trim());
    if (includeArchived) params.set('include_archived', 'true');

    try {
      const res = await apiFetch<{ customers: Customer[] }>(
        `/api/customers?${params.toString()}`
      );
      setCustomers(res.customers);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load customers.');
    } finally {
      setLoading(false);
    }
  }, [query, includeArchived]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadCustomers();
    }, 220);
    return () => window.clearTimeout(timer);
  }, [loadCustomers]);

  const handleRestore = async (customerId: string) => {
    try {
      await apiFetch(`/api/customers/${customerId}/restore`, { method: 'POST' });
      void loadCustomers();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to restore customer.');
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-text-primary">Customers</h1>
          <p className="text-xs text-text-secondary">
            Search by full/partial name, primary or secondary phone, address, locality, or customer ID
          </p>
        </div>

        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="zb-btn-primary inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-medium self-start sm:self-auto"
        >
          <UserPlus className="h-3.5 w-3.5" />
          Add Customer
        </button>
      </div>

      <div className="zb-card flex flex-col gap-3 p-3.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-text-muted" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, phone (e.g. 98765), address, locality, or UUID..."
            className="w-full rounded-lg border pl-9 pr-3 py-1.5 text-sm"
          />
        </div>

        <label className="flex items-center gap-2 text-xs font-medium text-text-secondary cursor-pointer select-none">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
            className="h-4 w-4 rounded border-border"
          />
          <span>Show archived</span>
        </label>
      </div>

      {error && <ErrorBanner message={error} onRetry={() => void loadCustomers()} />}

      {loading ? (
        <div className="space-y-3">
          <SkeletonCard lines={2} />
          <SkeletonCard lines={2} />
        </div>
      ) : customers.length === 0 ? (
        <EmptyState
          title="No customers found"
          description={
            query
              ? 'No customer records matched your search query.'
              : 'Add your first customer to begin tracking services and payments.'
          }
          action={
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="zb-btn-primary rounded-lg px-4 py-2 text-xs font-medium"
            >
              Add Customer
            </button>
          }
        />
      ) : (
        <div className="zb-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-bg text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                <tr>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Phone</th>
                  <th className="px-4 py-3">Location</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {customers.map((c) => (
                  <tr key={c.customer_id} className="transition hover:bg-bg/70">
                    <td className="px-4 py-3">
                      <Link
                        to={`/customers/${c.customer_id}`}
                        className="font-semibold text-text-primary hover:text-accent"
                      >
                        {c.full_name}
                      </Link>
                      {c.archived_at && (
                        <Badge variant="warning" className="ml-2">
                          Archived
                        </Badge>
                      )}
                      <p className="mt-0.5 font-mono text-[11px] text-text-muted">
                        {c.customer_id}
                      </p>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-text-primary">
                      <div className="flex items-center gap-1.5">
                        <Phone className="h-3.5 w-3.5 text-text-muted" />
                        <span>{c.primary_phone}</span>
                      </div>
                      {c.secondary_phone && (
                        <p className="mt-0.5 pl-5 text-text-muted">{c.secondary_phone}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-text-secondary">
                      <div className="flex items-start gap-1.5">
                        <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted" />
                        <div>
                          <p className="text-text-primary">{c.address}</p>
                          {c.locality && <p className="text-text-muted">{c.locality}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {c.archived_at ? (
                        <button
                          type="button"
                          onClick={() => void handleRestore(c.customer_id)}
                          className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-text-primary hover:bg-bg"
                        >
                          <ArchiveRestore className="h-3.5 w-3.5" />
                          Restore
                        </button>
                      ) : (
                        <Link
                          to={`/customers/${c.customer_id}`}
                          className="inline-flex items-center rounded-md border border-border px-2.5 py-1 text-xs font-medium text-text-primary hover:bg-bg"
                        >
                          Open Profile
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <CustomerFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSaved={(c) => {
          navigate(`/customers/${c.customer_id}`);
        }}
      />
    </div>
  );
}
