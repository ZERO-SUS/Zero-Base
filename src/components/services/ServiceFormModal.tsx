import React, { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { apiFetch, ApiError, newIdempotencyKey } from '../../lib/api';
import { addMonthsToIsoDate, formatCurrency, getTodayIstInputDate } from '../../lib/format';
import type { Customer, PaymentMethod, ServiceRecord } from '../../types/domain';
import { Modal } from '../ui/Modal';

interface ServiceFormModalProps {
  open: boolean;
  onClose: () => void;
  fixedCustomer?: Customer | null;
  existingService?: ServiceRecord | null;
  onSaved: (service: ServiceRecord) => void;
}

export function ServiceFormModal({
  open,
  onClose,
  fixedCustomer,
  existingService,
  onSaved,
}: ServiceFormModalProps) {
  const { settings } = useAuth();
  const isEdit = Boolean(existingService);

  const [customerSearch, setCustomerSearch] = useState('');
  const [customerResults, setCustomerResults] = useState<Customer[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);

  const [serviceDate, setServiceDate] = useState(getTodayIstInputDate());
  const [serviceType, setServiceType] = useState(settings.service_types[0] ?? 'Overhead Tank Cleaning');
  const [tankDetails, setTankDetails] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('1200');
  const [discount, setDiscount] = useState('0');
  const [nextDueDate, setNextDueDate] = useState('');
  const [notes, setNotes] = useState('');

  const [recordInitialPayment, setRecordInitialPayment] = useState(false);
  const [initialAmount, setInitialAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('Cash');
  const [txRef, setTxRef] = useState('');

  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setIdempotencyKey(newIdempotencyKey());

    if (existingService) {
      setServiceDate(existingService.service_date);
      setServiceType(existingService.service_type);
      setTankDetails(existingService.tank_details ?? '');
      setDescription(existingService.description ?? '');
      setPrice(String(existingService.price));
      setDiscount(String(existingService.discount));
      setNextDueDate(existingService.next_due_date ?? '');
      setNotes(existingService.notes ?? '');
      setRecordInitialPayment(false);
    } else {
      const today = getTodayIstInputDate();
      setSelectedCustomer(fixedCustomer ?? null);
      setCustomerSearch('');
      setCustomerResults([]);
      setServiceDate(today);
      setServiceType(settings.service_types[0] ?? 'Overhead Tank Cleaning');
      setTankDetails('');
      setDescription('');
      setPrice('1200');
      setDiscount('0');
      setNextDueDate(addMonthsToIsoDate(today, settings.default_reminder_months || 6));
      setNotes('');
      setRecordInitialPayment(false);
      setInitialAmount('');
      setPaymentMethod('Cash');
      setTxRef('');
    }
  }, [open, fixedCustomer, existingService, settings]);

  useEffect(() => {
    if (!open || isEdit || fixedCustomer) return;
    const q = customerSearch.trim();
    if (q.length < 2) {
      setCustomerResults([]);
      return;
    }

    const timer = window.setTimeout(async () => {
      try {
        const res = await apiFetch<{ customers: Customer[] }>(
          `/api/customers?q=${encodeURIComponent(q)}&limit=10`
        );
        setCustomerResults(res.customers);
      } catch {
        // Ignore transient search errors
      }
    }, 250);

    return () => window.clearTimeout(timer);
  }, [customerSearch, open, isEdit, fixedCustomer]);

  const computedTotal = useMemo(() => {
    const p = Math.max(0, Number(price) || 0);
    const d = Math.max(0, Number(discount) || 0);
    return Math.max(0, p - d);
  }, [price, discount]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const pNum = Number(price);
    const dNum = Number(discount || 0);
    if (Number.isNaN(pNum) || pNum < 0) {
      setError('Enter a valid non-negative price.');
      return;
    }
    if (Number.isNaN(dNum) || dNum < 0 || dNum > pNum) {
      setError('Discount must be between 0 and the service price.');
      return;
    }

    if (!isEdit && !selectedCustomer) {
      setError('Please select a customer first.');
      return;
    }

    setSubmitting(true);
    try {
      if (isEdit && existingService) {
        const res = await apiFetch<{ service: ServiceRecord }>(
          `/api/services/${existingService.id}`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              service_date: serviceDate,
              service_type: serviceType,
              tank_details: tankDetails.trim() || null,
              description: description.trim() || null,
              price: pNum,
              discount: dNum,
              next_due_date: nextDueDate || null,
              notes: notes.trim() || null,
            }),
          }
        );
        onSaved(res.service);
        onClose();
      } else if (selectedCustomer) {
        const initialPayAmount = Number(initialAmount || computedTotal);
        if (recordInitialPayment && (Number.isNaN(initialPayAmount) || initialPayAmount <= 0)) {
          setError('Initial payment amount must be greater than zero.');
          setSubmitting(false);
          return;
        }

        const res = await apiFetch<{ service: ServiceRecord }>('/api/services', {
          method: 'POST',
          body: JSON.stringify({
            customer_id: selectedCustomer.id,
            service_date: serviceDate,
            service_type: serviceType,
            tank_details: tankDetails.trim() || null,
            description: description.trim() || null,
            price: pNum,
            discount: dNum,
            next_due_date: nextDueDate || null,
            notes: notes.trim() || null,
            idempotency_key: idempotencyKey,
            initial_payment: recordInitialPayment
              ? {
                  amount: initialPayAmount,
                  payment_method: paymentMethod,
                  reference_number: txRef.trim() || null,
                  payment_date: serviceDate,
                }
              : null,
          }),
        });
        onSaved(res.service);
        onClose();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save service record.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit Service Record' : 'Record New Cleaning Service'}
      subtitle="Service history is organized strictly by actual service date"
      maxWidthClass="max-w-xl"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="rounded-lg border border-error/30 bg-error-soft px-3.5 py-2.5 text-xs text-error">
            {error}
          </div>
        )}

        {!isEdit && (
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-secondary">
              Customer <span className="text-error">*</span>
            </label>
            {selectedCustomer ? (
              <div className="flex items-center justify-between rounded-lg border border-border bg-bg px-3 py-2.5">
                <div>
                  <p className="text-sm font-medium text-text-primary">
                    {selectedCustomer.full_name} ({selectedCustomer.customer_code})
                  </p>
                  <p className="text-xs text-text-secondary">
                    {selectedCustomer.phone_number} • {selectedCustomer.address}
                  </p>
                </div>
                {!fixedCustomer && (
                  <button
                    type="button"
                    onClick={() => setSelectedCustomer(null)}
                    className="text-xs font-medium text-accent hover:underline"
                  >
                    Change
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-text-muted" />
                  <input
                    type="text"
                    value={customerSearch}
                    onChange={(e) => setCustomerSearch(e.target.value)}
                    placeholder="Search existing customer by name, phone, code, or area..."
                    className="w-full rounded-lg border pl-9 pr-3 py-2 text-sm"
                  />
                </div>
                {customerResults.length > 0 && (
                  <div className="max-h-40 overflow-y-auto rounded-lg border border-border bg-surface divide-y divide-border">
                    {customerResults.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => {
                          setSelectedCustomer(c);
                          setCustomerResults([]);
                        }}
                        className="flex w-full items-center justify-between px-3 py-2 text-left text-xs hover:bg-bg"
                      >
                        <div>
                          <p className="font-medium text-text-primary">
                            {c.full_name} <span className="text-text-muted">({c.customer_code})</span>
                          </p>
                          <p className="text-text-secondary">{c.address}</p>
                        </div>
                        <span className="font-mono text-text-muted">{c.phone_number}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-secondary">
              Actual Service Date <span className="text-error">*</span>
            </label>
            <input
              type="date"
              required
              value={serviceDate}
              onChange={(e) => setServiceDate(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-secondary">
              Service Type <span className="text-error">*</span>
            </label>
            <select
              value={serviceType}
              onChange={(e) => setServiceType(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm"
            >
              {!settings.service_types.includes(serviceType) && (
                <option value={serviceType}>{serviceType}</option>
              )}
              {settings.service_types.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-secondary">
              Tank Details
            </label>
            <input
              type="text"
              value={tankDetails}
              onChange={(e) => setTankDetails(e.target.value)}
              placeholder="e.g. 1000L Overhead + 2000L Sump"
              className="w-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-secondary">
              Next Due Date (Reminder)
            </label>
            <input
              type="date"
              value={nextDueDate}
              onChange={(e) => setNextDueDate(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-secondary">
              Price ({settings.currency_symbol}) <span className="text-error">*</span>
            </label>
            <input
              type="number"
              min="0"
              step="0.01"
              required
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-secondary">
              Discount ({settings.currency_symbol})
            </label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={discount}
              onChange={(e) => setDiscount(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="flex items-center justify-between rounded-lg border border-border bg-bg px-3.5 py-2.5 text-sm">
          <span className="text-text-secondary">Net Billed Total</span>
          <span className="font-semibold text-text-primary">
            {formatCurrency(computedTotal, settings.currency_symbol)}
          </span>
        </div>

        {!isEdit && (
          <div className="rounded-xl border border-border bg-bg/60 p-3.5 space-y-3">
            <label className="flex items-center gap-2 text-xs font-medium text-text-primary cursor-pointer">
              <input
                type="checkbox"
                checked={recordInitialPayment}
                onChange={(e) => {
                  setRecordInitialPayment(e.target.checked);
                  if (e.target.checked && !initialAmount) {
                    setInitialAmount(String(computedTotal));
                  }
                }}
                className="h-4 w-4 rounded border-border"
              />
              <span>Record initial payment now (full or partial)</span>
            </label>

            {recordInitialPayment && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-text-secondary">
                    Amount
                  </label>
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={initialAmount}
                    onChange={(e) => setInitialAmount(e.target.value)}
                    className="w-full rounded-lg border px-2.5 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-text-secondary">
                    Method
                  </label>
                  <select
                    value={paymentMethod}
                    onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
                    className="w-full rounded-lg border px-2.5 py-1.5 text-sm"
                  >
                    <option value="Cash">Cash</option>
                    <option value="UPI">UPI</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-text-secondary">
                    Reference
                  </label>
                  <input
                    type="text"
                    value={txRef}
                    onChange={(e) => setTxRef(e.target.value)}
                    placeholder="UPI Ref / Note"
                    className="w-full rounded-lg border px-2.5 py-1.5 text-sm"
                  />
                </div>
              </div>
            )}
          </div>
        )}

        <div>
          <label className="mb-1.5 block text-xs font-medium text-text-secondary">
            Description
          </label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Brief work summary"
            className="w-full rounded-lg border px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-medium text-text-secondary">Notes</label>
          <textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Tank condition, chlorination details, observations..."
            className="w-full rounded-lg border px-3 py-2 text-sm"
          />
        </div>

        <div className="flex items-center justify-end gap-2.5 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border bg-surface px-4 py-2 text-sm font-medium text-text-primary hover:bg-bg"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="zb-btn-primary rounded-lg px-4 py-2 text-sm font-medium transition disabled:opacity-50"
          >
            {submitting ? 'Saving...' : isEdit ? 'Update Service' : 'Save Service'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
