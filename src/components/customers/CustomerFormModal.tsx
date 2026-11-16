import React, { useEffect, useState } from 'react';
import { AlertTriangle, ArrowUpRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { apiFetch, ApiError } from '../../lib/api';
import type { Customer } from '../../types/domain';
import { Modal } from '../ui/Modal';

interface CustomerFormModalProps {
  open: boolean;
  onClose: () => void;
  existingCustomer?: Customer | null;
  onSaved: (customer: Customer) => void;
}

interface DuplicateCandidate {
  id: string;
  customer_code: string;
  full_name: string;
  phone_number: string;
  alternate_phone: string | null;
  address: string;
  area: string | null;
  archived_at: string | null;
}

export function CustomerFormModal({
  open,
  onClose,
  existingCustomer,
  onSaved,
}: CustomerFormModalProps) {
  const navigate = useNavigate();
  const isEdit = Boolean(existingCustomer);

  const [fullName, setFullName] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [alternatePhone, setAlternatePhone] = useState('');
  const [address, setAddress] = useState('');
  const [area, setArea] = useState('');
  const [notes, setNotes] = useState('');
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[]>([]);
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (existingCustomer) {
      setFullName(existingCustomer.full_name);
      setPhoneNumber(existingCustomer.phone_number);
      setAlternatePhone(existingCustomer.alternate_phone ?? '');
      setAddress(existingCustomer.address);
      setArea(existingCustomer.area ?? '');
      setNotes(existingCustomer.notes ?? '');
    } else {
      setFullName('');
      setPhoneNumber('');
      setAlternatePhone('');
      setAddress('');
      setArea('');
      setNotes('');
    }
    setDuplicates([]);
    setAllowDuplicate(false);
    setError(null);
  }, [open, existingCustomer]);

  useEffect(() => {
    if (!open || isEdit) return;
    const trimmed = phoneNumber.trim();
    if (trimmed.length < 6) {
      setDuplicates([]);
      return;
    }

    const timer = window.setTimeout(async () => {
      try {
        const res = await apiFetch<{ duplicates: DuplicateCandidate[] }>(
          `/api/customers/check-duplicate?phone=${encodeURIComponent(trimmed)}`
        );
        setDuplicates(res.duplicates ?? []);
      } catch {
        // Non-blocking background check; server validates on submit
      }
    }, 300);

    return () => window.clearTimeout(timer);
  }, [phoneNumber, open, isEdit]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      if (isEdit && existingCustomer) {
        const res = await apiFetch<{ customer: Customer }>(
          `/api/customers/${existingCustomer.id}`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              full_name: fullName.trim(),
              phone_number: phoneNumber.trim(),
              alternate_phone: alternatePhone.trim() || null,
              address: address.trim(),
              area: area.trim() || null,
              notes: notes.trim() || null,
            }),
          }
        );
        onSaved(res.customer);
        onClose();
      } else {
        const res = await apiFetch<{ customer: Customer }>('/api/customers', {
          method: 'POST',
          body: JSON.stringify({
            full_name: fullName.trim(),
            phone_number: phoneNumber.trim(),
            alternate_phone: alternatePhone.trim() || null,
            address: address.trim(),
            area: area.trim() || null,
            notes: notes.trim() || null,
            allow_duplicate: allowDuplicate,
          }),
        });
        onSaved(res.customer);
        onClose();
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'DUPLICATE_CUSTOMER_PHONE') {
        const details = err.details as { duplicates?: DuplicateCandidate[] } | undefined;
        setDuplicates(details?.duplicates ?? []);
        setError('Matching customer phone number found. Open the existing record or confirm creating a separate record.');
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Unable to save customer.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit Customer' : 'Add New Customer'}
      subtitle={
        isEdit
          ? `Customer Code: ${existingCustomer?.customer_code}`
          : 'Phone numbers are stored as entered (preserving leading zeros & country codes)'
      }
      maxWidthClass="max-w-xl"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="rounded-lg border border-error/30 bg-error-soft px-3.5 py-2.5 text-xs text-error">
            {error}
          </div>
        )}

        {duplicates.length > 0 && !isEdit && (
          <div className="rounded-xl border border-warning/40 bg-warning-soft p-3.5 text-xs">
            <div className="flex items-start gap-2 font-semibold text-warning">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Possible existing customer found with matching phone number:</span>
            </div>
            <div className="mt-2.5 space-y-2">
              {duplicates.map((dup) => (
                <div
                  key={dup.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface p-2.5"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-text-primary">
                      {dup.full_name} ({dup.customer_code}) {dup.archived_at ? '(Archived)' : ''}
                    </p>
                    <p className="text-text-secondary">
                      {dup.phone_number} • {dup.address}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      navigate(`/customers/${dup.id}`);
                    }}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-accent-fg hover:bg-accent-hover"
                  >
                    Open Record
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
            <label className="mt-3 flex items-center gap-2 text-text-primary cursor-pointer">
              <input
                type="checkbox"
                checked={allowDuplicate}
                onChange={(e) => setAllowDuplicate(e.target.checked)}
                className="h-4 w-4 rounded border-border"
              />
              <span>Create as a separate new customer anyway</span>
            </label>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="mb-1.5 block text-xs font-medium text-text-secondary">
              Full Name <span className="text-error">*</span>
            </label>
            <input
              type="text"
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="e.g. Rajesh Kumar Sharma"
              className="w-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-secondary">
              Phone Number <span className="text-error">*</span>
            </label>
            <input
              type="text"
              required
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              placeholder="+91 9876543210"
              className="w-full rounded-lg border px-3 py-2 text-sm font-mono"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-secondary">
              Alternate Phone
            </label>
            <input
              type="text"
              value={alternatePhone}
              onChange={(e) => setAlternatePhone(e.target.value)}
              placeholder="Optional alternate phone"
              className="w-full rounded-lg border px-3 py-2 text-sm font-mono"
            />
          </div>

          <div className="sm:col-span-2">
            <label className="mb-1.5 block text-xs font-medium text-text-secondary">
              Address <span className="text-error">*</span>
            </label>
            <textarea
              required
              rows={2}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="House/Flat No., Building, Street"
              className="w-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>

          <div className="sm:col-span-2">
            <label className="mb-1.5 block text-xs font-medium text-text-secondary">
              Area / Locality
            </label>
            <input
              type="text"
              value={area}
              onChange={(e) => setArea(e.target.value)}
              placeholder="e.g. Indiranagar"
              className="w-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>

          <div className="sm:col-span-2">
            <label className="mb-1.5 block text-xs font-medium text-text-secondary">
              Notes
            </label>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Tank access instructions, landmarks, special requirements..."
              className="w-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>
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
            disabled={submitting || (duplicates.length > 0 && !isEdit && !allowDuplicate)}
            className="zb-btn-primary rounded-lg px-4 py-2 text-sm font-medium transition disabled:opacity-50"
          >
            {submitting ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Customer'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
