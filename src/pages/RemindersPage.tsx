import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Bell,
  Calendar,
  Check,
  Edit3,
  Plus,
  Search,
  XCircle,
} from 'lucide-react';
import { ServiceFormModal } from '../components/services/ServiceFormModal';
import { ReminderCategoryBadge } from '../components/ui/Badge';
import { EmptyState, ErrorBanner, SkeletonCard } from '../components/ui/Feedback';
import { Modal } from '../components/ui/Modal';
import { apiFetch, ApiError } from '../lib/api';
import { formatServiceDate, getTodayIstInputDate } from '../lib/format';
import type { Customer, ReminderCategory, ReminderRecord } from '../types/domain';

interface RemindersResponse {
  today_ist: string;
  counts: Record<string, number>;
  reminders: ReminderRecord[];
}

const TABS: Array<{ label: string; value: string }> = [
  { label: 'All Active', value: '' },
  { label: 'Upcoming', value: 'Upcoming' },
  { label: 'Due Today', value: 'Due Today' },
  { label: 'Overdue', value: 'Overdue' },
  { label: 'Completed', value: 'Completed' },
  { label: 'Cancelled', value: 'Cancelled' },
];

export function RemindersPage() {
  const [selectedTab, setSelectedTab] = useState('');
  const [data, setData] = useState<RemindersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [editModal, setEditModal] = useState<ReminderRecord | null>(null);
  const [editDate, setEditDate] = useState('');
  const [editNotes, setEditNotes] = useState('');

  const [createOpen, setCreateOpen] = useState(false);
  const [custQuery, setCustQuery] = useState('');
  const [custResults, setCustResults] = useState<Customer[]>([]);
  const [pickedCustomer, setPickedCustomer] = useState<Customer | null>(null);
  const [newDueDate, setNewDueDate] = useState(getTodayIstInputDate());
  const [newNotes, setNewNotes] = useState('');
  const [creating, setCreating] = useState(false);

  const [serviceFromReminder, setServiceFromReminder] = useState<{
    reminder: ReminderRecord;
    customer: Customer;
  } | null>(null);

  const loadReminders = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = selectedTab
      ? `?category=${encodeURIComponent(selectedTab)}&include_completed=true`
      : '';
    try {
      const res = await apiFetch<RemindersResponse>(`/api/reminders${params}`);
      setData(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load reminders.');
    } finally {
      setLoading(false);
    }
  }, [selectedTab]);

  useEffect(() => {
    void loadReminders();
  }, [loadReminders]);

  useEffect(() => {
    if (!createOpen) return;
    const q = custQuery.trim();
    if (q.length < 2) {
      setCustResults([]);
      return;
    }
    const timer = window.setTimeout(async () => {
      try {
        const res = await apiFetch<{ customers: Customer[] }>(
          `/api/customers?q=${encodeURIComponent(q)}&limit=8`
        );
        setCustResults(res.customers);
      } catch {
        // Ignore transient search error
      }
    }, 220);
    return () => window.clearTimeout(timer);
  }, [custQuery, createOpen]);

  const updateReminderStatus = async (
    reminderId: string,
    payload: Record<string, unknown>
  ) => {
    setBusyId(reminderId);
    setError(null);
    try {
      await apiFetch(`/api/reminders/${reminderId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      await loadReminders();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update reminder.');
    } finally {
      setBusyId(null);
    }
  };

  const handleCreateCustomReminder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pickedCustomer) return;
    setCreating(true);
    setError(null);
    try {
      await apiFetch('/api/reminders', {
        method: 'POST',
        body: JSON.stringify({
          customer_id: pickedCustomer.id,
          due_date: newDueDate,
          reminder_type: 'custom',
          notes: newNotes.trim() || null,
        }),
      });
      setCreateOpen(false);
      setPickedCustomer(null);
      setCustQuery('');
      setNewNotes('');
      await loadReminders();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create reminder.');
    } finally {
      setCreating(false);
    }
  };

  const handleCreateServiceFromReminder = (r: ReminderRecord) => {
    if (!r.customers) return;
    const customer: Customer = {
      id: r.customers.id,
      customer_code: r.customers.customer_code,
      full_name: r.customers.full_name,
      phone_number: r.customers.phone_number,
      alternate_phone: r.customers.alternate_phone ?? null,
      address: r.customers.address ?? '',
      area: r.customers.area ?? null,
      notes: null,
      created_at: '',
      updated_at: '',
      archived_at: null,
    };
    setServiceFromReminder({ reminder: r, customer });
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-text-primary">Reminders</h1>
          <p className="text-xs text-text-secondary">
            Optional follow-ups calculated in Asia/Kolkata (IST). Never auto-creates completed services.
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            setPickedCustomer(null);
            setCustQuery('');
            setNewDueDate(getTodayIstInputDate());
            setNewNotes('');
            setCreateOpen(true);
          }}
          className="zb-btn-primary inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-medium self-start sm:self-auto"
        >
          <Plus className="h-3.5 w-3.5" />
          New Reminder
        </button>
      </div>

      {/* Category Tabs */}
      <div className="flex flex-wrap gap-1.5 border-b border-border pb-3">
        {TABS.map((tab) => {
          const active = selectedTab === tab.value;
          const count = tab.value && data?.counts ? data.counts[tab.value] : undefined;
          return (
            <button
              key={tab.label}
              type="button"
              onClick={() => setSelectedTab(tab.value)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                active
                  ? 'bg-accent text-accent-fg'
                  : 'border border-border bg-surface text-text-secondary hover:bg-bg hover:text-text-primary'
              }`}
            >
              <span>{tab.label}</span>
              {count !== undefined && (
                <span
                  className={`rounded px-1.5 py-0.2 text-[10px] ${
                    active ? 'bg-black/20' : 'bg-bg text-text-muted'
                  }`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {error && <ErrorBanner message={error} onRetry={() => void loadReminders()} />}

      {loading ? (
        <div className="space-y-3">
          <SkeletonCard lines={2} />
          <SkeletonCard lines={2} />
        </div>
      ) : !data || data.reminders.length === 0 ? (
        <EmptyState
          title="No reminders in this category"
          description="Reminders are optional. Schedule one when creating a service or click 'New Reminder'."
          icon={<Bell className="h-5 w-5" />}
        />
      ) : (
        <div className="space-y-3">
          {data.reminders.map((rem) => {
            const busy = busyId === rem.id;
            const isClosed = ['completed', 'cancelled', 'dismissed'].includes(rem.status);
            return (
              <div
                key={rem.id}
                className="zb-card flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="space-y-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      to={`/customers/${rem.customer_id}`}
                      className="text-sm font-semibold text-text-primary hover:text-accent"
                    >
                      {rem.customers?.full_name}
                    </Link>
                    <ReminderCategoryBadge category={rem.category as ReminderCategory} />
                  </div>
                  <p className="text-xs text-text-secondary">
                    Due Date: <strong className="text-text-primary">{formatServiceDate(rem.due_date)}</strong> •{' '}
                    <span className="font-mono">{rem.customers?.phone_number}</span>
                    {rem.customers?.area ? ` • ${rem.customers.area}` : ''}
                  </p>
                  {rem.services && (
                    <p className="text-[11px] text-text-muted">
                      Linked service:{' '}
                      <Link to={`/services/${rem.services.id}`} className="text-accent hover:underline">
                        {rem.services.service_type} ({formatServiceDate(rem.services.service_date)})
                      </Link>
                    </p>
                  )}
                  {rem.notes && <p className="text-[11px] text-text-secondary">{rem.notes}</p>}
                </div>

                <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setEditModal(rem);
                      setEditDate(rem.due_date);
                      setEditNotes(rem.notes ?? '');
                    }}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium hover:bg-bg disabled:opacity-50"
                  >
                    <Edit3 className="h-3.5 w-3.5" />
                    Edit / Reschedule
                  </button>

                  {!isClosed && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void updateReminderStatus(rem.id, { status: 'completed' })
                      }
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-success hover:bg-success-soft disabled:opacity-50"
                    >
                      <Check className="h-3.5 w-3.5" />
                      Completed
                    </button>
                  )}

                  {!isClosed && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void updateReminderStatus(rem.id, { status: 'cancelled' })
                      }
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-text-muted hover:bg-error-soft hover:text-error disabled:opacity-50"
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      Cancel
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handleCreateServiceFromReminder(rem)}
                    className="zb-btn-primary inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium disabled:opacity-50"
                  >
                    <Calendar className="h-3.5 w-3.5" />
                    Add Service
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Edit / Reschedule Reminder Modal */}
      <Modal
        open={Boolean(editModal)}
        onClose={() => setEditModal(null)}
        title="Edit / Reschedule Reminder"
        maxWidthClass="max-w-sm"
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!editModal) return;
            await updateReminderStatus(editModal.id, {
              due_date: editDate,
              notes: editNotes.trim() || null,
              status: 'active',
            });
            setEditModal(null);
          }}
          className="space-y-4"
        >
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-secondary">
              Due Date
            </label>
            <input
              type="date"
              required
              value={editDate}
              onChange={(e) => setEditDate(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-secondary">
              Notes
            </label>
            <textarea
              rows={2}
              value={editNotes}
              onChange={(e) => setEditNotes(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditModal(null)}
              className="rounded-lg border border-border px-3.5 py-1.5 text-xs font-medium"
            >
              Cancel
            </button>
            <button type="submit" className="zb-btn-primary rounded-lg px-3.5 py-1.5 text-xs font-medium">
              Save Reminder
            </button>
          </div>
        </form>
      </Modal>

      {/* Custom Reminder Modal */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Schedule Custom Reminder"
        subtitle="Creates a follow-up reminder for an existing customer"
      >
        <form onSubmit={handleCreateCustomReminder} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-secondary">
              Customer <span className="text-error">*</span>
            </label>
            {pickedCustomer ? (
              <div className="flex items-center justify-between rounded-lg border border-border bg-bg px-3 py-2 text-xs">
                <div>
                  <p className="font-semibold text-text-primary">
                    {pickedCustomer.full_name} ({pickedCustomer.customer_code})
                  </p>
                  <p className="text-text-secondary">{pickedCustomer.phone_number}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setPickedCustomer(null)}
                  className="text-accent hover:underline"
                >
                  Change
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-text-muted" />
                  <input
                    type="text"
                    value={custQuery}
                    onChange={(e) => setCustQuery(e.target.value)}
                    placeholder="Search customer by name or phone..."
                    className="w-full rounded-lg border pl-9 pr-3 py-2 text-sm"
                  />
                </div>
                {custResults.length > 0 && (
                  <div className="max-h-36 overflow-y-auto rounded-lg border border-border divide-y divide-border">
                    {custResults.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => {
                          setPickedCustomer(c);
                          setCustResults([]);
                        }}
                        className="flex w-full justify-between px-3 py-2 text-left text-xs hover:bg-bg"
                      >
                        <span className="font-medium">{c.full_name}</span>
                        <span className="font-mono text-text-muted">{c.phone_number}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-secondary">
              Due Date <span className="text-error">*</span>
            </label>
            <input
              type="date"
              required
              value={newDueDate}
              onChange={(e) => setNewDueDate(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-secondary">Notes</label>
            <textarea
              rows={2}
              value={newNotes}
              onChange={(e) => setNewNotes(e.target.value)}
              placeholder="Customer requested callback after 6 months..."
              className="w-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setCreateOpen(false)}
              className="rounded-lg border border-border px-3.5 py-2 text-xs font-medium"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!pickedCustomer || creating}
              className="zb-btn-primary rounded-lg px-4 py-2 text-xs font-medium disabled:opacity-50"
            >
              {creating ? 'Saving...' : 'Create Reminder'}
            </button>
          </div>
        </form>
      </Modal>

      <ServiceFormModal
        open={Boolean(serviceFromReminder)}
        onClose={() => setServiceFromReminder(null)}
        fixedCustomer={serviceFromReminder?.customer ?? null}
        onSaved={async () => {
          if (serviceFromReminder) {
            await updateReminderStatus(serviceFromReminder.reminder.id, {
              status: 'completed',
            });
          }
          setServiceFromReminder(null);
        }}
      />
    </div>
  );
}
