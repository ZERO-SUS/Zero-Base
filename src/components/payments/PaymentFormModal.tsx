import React, { useEffect, useState } from 'react';
import { apiFetch, ApiError, newIdempotencyKey } from '../../lib/api';
import { formatCurrency, getTodayIstInputDate } from '../../lib/format';
import type { PaymentMethod, PaymentType } from '../../types/domain';
import { Modal } from '../ui/Modal';

interface PaymentFormModalProps {
  open: boolean;
  onClose: () => void;
  serviceId: string;
  outstandingAmount: number;
  amountPaid: number;
  currencySymbol?: string;
  onSaved: () => void;
}

export function PaymentFormModal({
  open,
  onClose,
  serviceId,
  outstandingAmount,
  amountPaid,
  currencySymbol = '₹',
  onSaved,
}: PaymentFormModalProps) {
  const [paymentType, setPaymentType] = useState<PaymentType>('payment');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('UPI');
  const [paymentDate, setPaymentDate] = useState(getTodayIstInputDate());
  const [txRef, setTxRef] = useState('');
  const [notes, setNotes] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPaymentType('payment');
    setAmount(outstandingAmount > 0 ? String(outstandingAmount) : '');
    setMethod('UPI');
    setPaymentDate(getTodayIstInputDate());
    setTxRef('');
    setNotes('');
    setIdempotencyKey(newIdempotencyKey());
    setError(null);
  }, [open, outstandingAmount]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const numAmount = Number(amount);
    if (Number.isNaN(numAmount) || numAmount <= 0) {
      setError('Amount must be greater than zero.');
      return;
    }
    if (paymentType === 'refund' && numAmount > amountPaid) {
      setError(`Refund cannot exceed total amount paid (${formatCurrency(amountPaid, currencySymbol)}).`);
      return;
    }

    setSubmitting(true);
    try {
      await apiFetch('/api/payments', {
        method: 'POST',
        body: JSON.stringify({
          service_id: serviceId,
          amount: numAmount,
          payment_type: paymentType,
          payment_method: method,
          reference_number: txRef.trim() || null,
          payment_date: paymentDate,
          notes: notes.trim() || null,
          idempotency_key: idempotencyKey,
        }),
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to record payment.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record Payment / Refund"
      subtitle={`Outstanding balance: ${formatCurrency(outstandingAmount, currencySymbol)}`}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="rounded-lg border border-error/30 bg-error-soft px-3.5 py-2.5 text-xs text-error">
            {error}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          {(['payment', 'refund'] as PaymentType[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setPaymentType(t)}
              className={`rounded-lg border px-3 py-2 text-xs font-medium capitalize transition ${
                paymentType === t
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-border bg-surface text-text-secondary hover:bg-bg'
              }`}
            >
              {t === 'payment' ? 'Payment Received' : 'Refund Issued'}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-secondary">
              Amount ({currencySymbol}) <span className="text-error">*</span>
            </label>
            <input
              type="number"
              min="0.01"
              step="0.01"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-secondary">
              Payment Method <span className="text-error">*</span>
            </label>
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value as PaymentMethod)}
              className="w-full rounded-lg border px-3 py-2 text-sm"
            >
              <option value="Cash">Cash</option>
              <option value="UPI">UPI</option>
              <option value="Other">Other</option>
            </select>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-secondary">
              Payment Date <span className="text-error">*</span>
            </label>
            <input
              type="date"
              required
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-secondary">
              Reference Number
            </label>
            <input
              type="text"
              value={txRef}
              onChange={(e) => setTxRef(e.target.value)}
              placeholder="UPI UTR / Receipt #"
              className="w-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-medium text-text-secondary">Notes</label>
          <textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional payment note..."
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
            {submitting ? 'Recording...' : paymentType === 'refund' ? 'Record Refund' : 'Record Payment'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
