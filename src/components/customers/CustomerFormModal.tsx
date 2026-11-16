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
  customer_id: string;
  full_name: string;
  primary_phone: string;
  secondary_phone: string | null;
  address: string;
  locality: string | null;
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
  const [primaryPhone, setPrimaryPhone] = useState('');
  const [secondaryPhone, setSecondaryPhone] = useState('');
  const [address, setAddress] = useState('');
  const [locality, setLocality] = useState('');
  const [landmark, setLandmark] = useState('');
  const [notes, setNotes] = useState('');
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[]>([]);
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (existingCustomer) {
      setFullName(existingCustomer.full_name);
      setPrimaryPhone(existingCustomer.primary_phone);
      setSecondaryPhone(existingCustomer.secondary_phone ?? '');
      setAddress(existingCustomer.address);
      setLocality(existingCustomer.locality ?? '');
      setLandmark(existingCustomer.landmark ?? '');
      setNotes(existingCustomer.notes ?? '');
    } else {
      setFullName('');
      setPrimaryPhone('');
      setSecondaryPhone('');
      setAddress('');
      setLocality('');
      setLandmark('');
      setNotes('');
    }
    setDuplicates([]);
    setAllowDuplicate(false);
    setError(null);
  }, [open, existingCustomer]);

  // Live duplicate phone detection when creating a new customer
  useEffect(() => {
    if (!open || isEdit) return;
    const trimmed = primaryPhone.trim();
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
        // Non-blocking background check; server also validates on submit
      }
    }, 300);

    return () => window.clearTimeout(timer);
  }, [primaryPhone, open, isEdit]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      if (isEdit && existingCustomer) {
        const res = await apiFetch<{ customer: Customer }>(
          `/api/customers/${existingCustomer.customer_id}`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              full_name: fullName.trim(),
              primary_phone: primaryPhone.trim(),
              secondary_phone: secondaryPhone.trim() || null,
              address: address.trim(),
              locality: locality.trim() || null,
              landmark: landmark.trim() || null,
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
            primary_phone: primaryPhone.trim(),
            secondary_phone: secondaryPhone.trim() || null,
            address: address.trim(),
            locality: locality.trim() || null,
            landmark: landmark.trim() || null,
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
          ? 'Update customer contact and location details'
          : 'Phone numbers are stored verbatim (including leading zeros and country codes)'
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
                  key={dup.customer_id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface p-2.5"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-text-primary">
                      {dup.full_name} {dup.archived_at ? '(Archived)' : ''}
                    </p>
                    <p className="text-text-secondary">
                      {dup.primary_phone} • {dup.address}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      navigate(`/customers/${dup.customer_id}`);
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
              Primary Phone <span className="text-error">*</span>
            </label>
            <input
              type="text"
              required
              value={primaryPhone}
              onChange={(e) => setPrimaryPhone(e.target.value)}
              placeholder="+91 9876543210"
              className="w-full rounded-lg border px-3 py-2 text-sm font-mono"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-secondary">
              Secondary Phone
            </label>
            <input
              type="text"
              value={secondaryPhone}
              onChange={(e) => setSecondaryPhone(e.target.value)}
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

          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-secondary">
              Locality / Area
            </label>
            <input
              type="text"
              value={locality}
              onChange={(e) => setLocality(e.target.value)}
              placeholder="e.g. Indiranagar"
              className="w-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-secondary">
              Landmark
            </label>
            <input
              type="text"
              value={landmark}
              onChange={(e) => setLandmark(e.target.value)}
              placeholder="Near Metro / Temple"
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
              placeholder="Tank location, access instructions, special requirements..."
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
