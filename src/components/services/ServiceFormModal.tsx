import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  Bell,
  ChevronDown,
  ChevronUp,
  FileText,
  Paperclip,
  Search,
  Trash2,
  Upload,
  UserCheck,
  UserPlus,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { apiFetch, ApiError, newIdempotencyKey } from '../../lib/api';
import { addMonthsToIsoDate, formatBytes, formatCurrency, getTodayIstInputDate } from '../../lib/format';
import {
  FILE_CATEGORIES,
  type Customer,
  type FileCategory,
  type PaymentMethod,
  type ServiceRecord,
} from '../../types/domain';
import { Modal } from '../ui/Modal';

interface QueuedAttachment {
  id: string;
  file: File;
  category: FileCategory;
  previewUrl: string | null;
  status: 'queued' | 'uploading' | 'uploaded' | 'error';
  error?: string;
}

interface DuplicateCandidate {
  id: string;
  customer_code: string;
  full_name: string;
  phone_number: string;
  alternate_phone: string | null;
  address: string;
  area: string | null;
  match_reason?: string;
}

interface ServiceFormModalProps {
  open: boolean;
  onClose: () => void;
  fixedCustomer?: Customer | null;
  existingService?: ServiceRecord | null;
  onSaved: (service: ServiceRecord, customer?: Customer) => void;
}

export function ServiceFormModal({
  open,
  onClose,
  fixedCustomer,
  existingService,
  onSaved,
}: ServiceFormModalProps) {
  const navigate = useNavigate();
  const { settings } = useAuth();
  const isEdit = Boolean(existingService);
  const sym = settings.currency_symbol || '₹';

  // Customer mode: existing vs new
  const [customerMode, setCustomerMode] = useState<'existing' | 'new'>('existing');
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerResults, setCustomerResults] = useState<Customer[]>([]);
  const [searchingCustomers, setSearchingCustomers] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);

  // New customer fields
  const [newFullName, setNewFullName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newAltPhone, setNewAltPhone] = useState('');
  const [newAddress, setNewAddress] = useState('');
  const [newArea, setNewArea] = useState('');
  const [newCustomerNotes, setNewCustomerNotes] = useState('');
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[]>([]);
  const [allowDuplicate, setAllowDuplicate] = useState(false);

  // Service fields
  const [serviceDate, setServiceDate] = useState(getTodayIstInputDate());
  const [serviceType, setServiceType] = useState(
    settings.service_types[0] ?? 'Overhead Tank Cleaning'
  );
  const [tankDetails, setTankDetails] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('1200');
  const [discount, setDiscount] = useState('0');
  const [notes, setNotes] = useState('');

  // Payment fields
  const [paymentChoice, setPaymentChoice] = useState<'unpaid' | 'partial' | 'paid'>('unpaid');
  const [paidAmount, setPaidAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('Cash');
  const [txRef, setTxRef] = useState('');

  // Optional Next-Service Reminder (OFF by default per Section 8)
  const [reminderEnabled, setReminderEnabled] = useState(false);
  const [reminderDate, setReminderDate] = useState('');
  const [reminderType, setReminderType] = useState<'service_due' | 'custom' | 'follow_up'>('service_due');
  const [reminderNotes, setReminderNotes] = useState('');

  // Edit-only next_due_date
  const [editNextDueDate, setEditNextDueDate] = useState('');

  // Attachments (5 categories)
  const [attachmentsOpen, setAttachmentsOpen] = useState(true);
  const [queuedFiles, setQueuedFiles] = useState<QueuedAttachment[]>([]);
  const [dragCategory, setDragCategory] = useState<FileCategory | null>(null);
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // Submission state
  const [savedServiceForRetry, setSavedServiceForRetry] = useState<ServiceRecord | null>(null);
  const [savedCustomerForRetry, setSavedCustomerForRetry] = useState<Customer | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey());
  const [submitting, setSubmitting] = useState(false);
  const [uploadProgressText, setUploadProgressText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset form when opened
  useEffect(() => {
    if (!open) return;
    setError(null);
    setUploadProgressText(null);
    setSavedServiceForRetry(null);
    setSavedCustomerForRetry(null);
    setIdempotencyKey(newIdempotencyKey());

    if (existingService) {
      setServiceDate(existingService.service_date);
      setServiceType(existingService.service_type);
      setTankDetails(existingService.tank_details ?? '');
      setDescription(existingService.description ?? '');
      setPrice(String(existingService.price));
      setDiscount(String(existingService.discount));
      setEditNextDueDate(existingService.next_due_date ?? '');
      setNotes(existingService.notes ?? '');
      setPaymentChoice('unpaid');
      setReminderEnabled(false);
      setQueuedFiles([]);
    } else {
      const today = getTodayIstInputDate();
      setCustomerMode('existing');
      setSelectedCustomer(fixedCustomer ?? null);
      setCustomerSearch('');
      setCustomerResults([]);
      setNewFullName('');
      setNewPhone('');
      setNewAltPhone('');
      setNewAddress('');
      setNewArea('');
      setNewCustomerNotes('');
      setDuplicates([]);
      setAllowDuplicate(false);

      setServiceDate(today);
      setServiceType(settings.service_types[0] ?? 'Overhead Tank Cleaning');
      setTankDetails('');
      setDescription('');
      setPrice('1200');
      setDiscount('0');
      setNotes('');

      setPaymentChoice('unpaid');
      setPaidAmount('');
      setPaymentMethod('Cash');
      setTxRef('');

      // Default OFF
      setReminderEnabled(false);
      setReminderDate(addMonthsToIsoDate(today, settings.default_reminder_months || 6));
      setReminderType('service_due');
      setReminderNotes('');
      setQueuedFiles([]);
      setAttachmentsOpen(true);
    }
  }, [open, fixedCustomer, existingService, settings]);

  // Revoke object URLs on unmount/clear
  useEffect(() => {
    return () => {
      for (const item of queuedFiles) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      }
    };
  }, [queuedFiles]);

  // Existing customer search
  useEffect(() => {
    if (!open || isEdit || fixedCustomer || customerMode !== 'existing') return;
    const q = customerSearch.trim();
    if (q.length < 2) {
      setCustomerResults([]);
      return;
    }

    const timer = window.setTimeout(async () => {
      setSearchingCustomers(true);
      try {
        const res = await apiFetch<{ customers: Customer[] }>(
          `/api/customers?q=${encodeURIComponent(q)}&limit=10`
        );
        setCustomerResults(res.customers);
      } catch {
        // Ignore transient search errors
      } finally {
        setSearchingCustomers(false);
      }
    }, 250);

    return () => window.clearTimeout(timer);
  }, [customerSearch, open, isEdit, fixedCustomer, customerMode]);

  // Live duplicate detection for new customer
  useEffect(() => {
    if (!open || isEdit || customerMode !== 'new') return;
    const phone = newPhone.trim();
    const alt = newAltPhone.trim();
    const name = newFullName.trim();
    if (phone.length < 6 && alt.length < 6 && name.length < 4) {
      setDuplicates([]);
      return;
    }

    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams();
        if (phone) params.set('phone', phone);
        if (alt) params.set('alt_phone', alt);
        if (name) params.set('name', name);
        if (newAddress.trim()) params.set('address', newAddress.trim());

        const res = await apiFetch<{ duplicates: DuplicateCandidate[] }>(
          `/api/customers/check-duplicate?${params.toString()}`
        );
        setDuplicates(res.duplicates ?? []);
      } catch {
        // Non-blocking background check
      }
    }, 300);

    return () => window.clearTimeout(timer);
  }, [newPhone, newAltPhone, newFullName, newAddress, customerMode, open, isEdit]);

  const computedTotal = useMemo(() => {
    const p = Math.max(0, Number(price) || 0);
    const d = Math.max(0, Number(discount) || 0);
    return Math.max(0, p - d);
  }, [price, discount]);

  const computedBalance = useMemo(() => {
    if (paymentChoice === 'paid') return 0;
    if (paymentChoice === 'unpaid') return computedTotal;
    const paid = Math.max(0, Number(paidAmount) || 0);
    return Math.max(0, computedTotal - paid);
  }, [paymentChoice, paidAmount, computedTotal]);

  const addFilesToQueue = (files: File[], category: FileCategory) => {
    const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
    const maxBytes = 15 * 1024 * 1024;
    const next: QueuedAttachment[] = [];

    for (const file of files) {
      if (!allowed.has(file.type)) {
        setError(`Unsupported file "${file.name}". Allowed: JPG, JPEG, PNG, WEBP, PDF.`);
        continue;
      }
      if (file.size > maxBytes) {
        setError(`File "${file.name}" exceeds the 15 MB limit.`);
        continue;
      }
      next.push({
        id: crypto.randomUUID(),
        file,
        category,
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
        status: 'queued',
      });
    }

    if (next.length > 0) {
      setQueuedFiles((prev) => [...prev, ...next]);
    }
  };

  const removeQueuedFile = (id: string) => {
    setQueuedFiles((prev) => {
      const target = prev.find((f) => f.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((f) => f.id !== id);
    });
  };

  const uploadQueuedFilesForService = async (service: ServiceRecord): Promise<boolean> => {
    const pending = queuedFiles.filter((f) => f.status !== 'uploaded');
    if (pending.length === 0) return true;

    let allOk = true;
    for (let i = 0; i < pending.length; i += 1) {
      const item = pending[i];
      setUploadProgressText(`Uploading attachment ${i + 1} of ${pending.length}: ${item.file.name}`);
      setQueuedFiles((prev) =>
        prev.map((q) => (q.id === item.id ? { ...q, status: 'uploading', error: undefined } : q))
      );

      const form = new FormData();
      form.append('file', item.file);
      form.append('service_id', service.id);
      form.append('category', item.category);

      try {
        await apiFetch('/api/files/upload', {
          method: 'POST',
          body: form,
        });
        setQueuedFiles((prev) =>
          prev.map((q) => (q.id === item.id ? { ...q, status: 'uploaded' } : q))
        );
      } catch (err) {
        allOk = false;
        const msg = err instanceof ApiError ? err.message : 'Upload failed';
        setQueuedFiles((prev) =>
          prev.map((q) => (q.id === item.id ? { ...q, status: 'error', error: msg } : q))
        );
      }
    }
    setUploadProgressText(null);
    return allOk;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // If service already saved and only retrying failed attachment uploads
    if (savedServiceForRetry) {
      setSubmitting(true);
      const ok = await uploadQueuedFilesForService(savedServiceForRetry);
      setSubmitting(false);
      if (ok) {
        onSaved(savedServiceForRetry, savedCustomerForRetry ?? undefined);
        onClose();
      } else {
        setError('Some attachments failed to upload. Remove or retry failed files.');
      }
      return;
    }

    const pNum = Number(price);
    const dNum = Number(discount || 0);
    if (Number.isNaN(pNum) || pNum < 0) {
      setError('Enter a valid non-negative service amount.');
      return;
    }
    if (Number.isNaN(dNum) || dNum < 0 || dNum > pNum) {
      setError('Discount must be between 0 and the service amount.');
      return;
    }

    if (isEdit && existingService) {
      setSubmitting(true);
      try {
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
              next_due_date: editNextDueDate || null,
              notes: notes.trim() || null,
            }),
          }
        );
        onSaved(res.service);
        onClose();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to update service record.');
      } finally {
        setSubmitting(false);
      }
      return;
    }

    // Validate unified creation mode
    if (customerMode === 'existing' && !selectedCustomer) {
      setError('Search and select an existing customer, or switch to "New Customer".');
      return;
    }
    if (customerMode === 'new') {
      if (!newFullName.trim() || !newPhone.trim() || !newAddress.trim()) {
        setError('Customer full name, primary phone, and address are required.');
        return;
      }
      if (duplicates.length > 0 && !allowDuplicate) {
        setError('Matching customer found. Select the existing customer or confirm creating a new record.');
        return;
      }
    }

    let initialPayPayload: null | {
      amount: number;
      payment_method: PaymentMethod;
      reference_number: string | null;
      payment_date: string;
    } = null;

    if (paymentChoice === 'paid' && computedTotal > 0) {
      initialPayPayload = {
        amount: computedTotal,
        payment_method: paymentMethod,
        reference_number: txRef.trim() || null,
        payment_date: serviceDate,
      };
    } else if (paymentChoice === 'partial') {
      const amt = Number(paidAmount);
      if (Number.isNaN(amt) || amt <= 0) {
        setError('Enter a valid amount paid greater than zero for partial payment.');
        return;
      }
      initialPayPayload = {
        amount: amt,
        payment_method: paymentMethod,
        reference_number: txRef.trim() || null,
        payment_date: serviceDate,
      };
    }

    if (reminderEnabled && !reminderDate) {
      setError('Select a reminder date or disable the Next Service Reminder toggle.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await apiFetch<{
        customer: Customer;
        service: ServiceRecord;
      }>('/api/services/unified', {
        method: 'POST',
        body: JSON.stringify({
          customer_id: customerMode === 'existing' ? selectedCustomer?.id : null,
          new_customer:
            customerMode === 'new'
              ? {
                  full_name: newFullName.trim(),
                  phone_number: newPhone.trim(),
                  alternate_phone: newAltPhone.trim() || null,
                  address: newAddress.trim(),
                  area: newArea.trim() || null,
                  notes: newCustomerNotes.trim() || null,
                  allow_duplicate: allowDuplicate,
                }
              : null,
          service_date: serviceDate,
          service_type: serviceType,
          tank_details: tankDetails.trim() || null,
          description: description.trim() || null,
          price: pNum,
          discount: dNum,
          notes: notes.trim() || null,
          idempotency_key: idempotencyKey,
          initial_payment: initialPayPayload,
          reminder: {
            enabled: reminderEnabled,
            due_date: reminderEnabled ? reminderDate : null,
            reminder_type: reminderType,
            notes: reminderEnabled ? reminderNotes.trim() || null : null,
          },
        }),
      });

      if (queuedFiles.length > 0) {
        const uploadsOk = await uploadQueuedFilesForService(res.service);
        if (!uploadsOk) {
          setSavedServiceForRetry(res.service);
          setSavedCustomerForRetry(res.customer);
          setError(
            'Service record saved, but one or more attachments failed to upload. Retry failed files or close to view the service.'
          );
          onSaved(res.service, res.customer);
          setSubmitting(false);
          return;
        }
      }

      onSaved(res.service, res.customer);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'DUPLICATE_CUSTOMER_PHONE') {
        const details = err.details as { duplicates?: DuplicateCandidate[] } | undefined;
        setDuplicates(details?.duplicates ?? []);
        setError('A customer with similar details already exists.');
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Failed to save service record.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit Service Record' : 'Add Service'}
      subtitle={
        isEdit
          ? 'Update service details (record upload timestamp remains preserved)'
          : 'Unified customer & water-tank cleaning record creation'
      }
      maxWidthClass="max-w-3xl"
    >
      <form onSubmit={handleSubmit} className="space-y-6">
        {error && (
          <div className="rounded-lg border border-error/30 bg-error-soft px-3.5 py-2.5 text-xs text-error">
            {error}
          </div>
        )}

        {/* SECTION 1: CUSTOMER SELECTION OR CREATION */}
        {!isEdit && !savedServiceForRetry && (
          <div className="space-y-3 rounded-xl border border-border bg-bg/50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                1. Customer
              </h3>
              {!fixedCustomer && (
                <div className="inline-flex rounded-lg border border-border bg-surface p-0.5 text-xs">
                  <button
                    type="button"
                    onClick={() => setCustomerMode('existing')}
                    className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 font-medium transition ${
                      customerMode === 'existing'
                        ? 'bg-accent text-accent-fg'
                        : 'text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    <UserCheck className="h-3.5 w-3.5" />
                    Existing Customer
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCustomerMode('new');
                      setSelectedCustomer(null);
                    }}
                    className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 font-medium transition ${
                      customerMode === 'new'
                        ? 'bg-accent text-accent-fg'
                        : 'text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    <UserPlus className="h-3.5 w-3.5" />
                    New Customer
                  </button>
                </div>
              )}
            </div>

            {customerMode === 'existing' ? (
              selectedCustomer ? (
                <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3.5 sm:flex-row sm:items-start sm:justify-between">
                  <div className="space-y-1 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-text-primary">
                        {selectedCustomer.full_name}
                      </span>
                      <span className="rounded bg-accent-soft px-2 py-0.5 font-mono text-[11px] font-medium text-accent">
                        {selectedCustomer.customer_code}
                      </span>
                    </div>
                    <p className="font-mono text-text-secondary">
                      {selectedCustomer.phone_number}
                      {selectedCustomer.alternate_phone
                        ? ` / ${selectedCustomer.alternate_phone}`
                        : ''}
                    </p>
                    <p className="text-text-secondary">
                      {selectedCustomer.address}
                      {selectedCustomer.area ? ` • ${selectedCustomer.area}` : ''}
                    </p>
                  </div>
                  {!fixedCustomer && (
                    <button
                      type="button"
                      onClick={() => setSelectedCustomer(null)}
                      className="text-xs font-medium text-accent hover:underline self-start"
                    >
                      Change Customer
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
                      placeholder="Search by customer name, phone, code (ZB-00001), address, or area..."
                      className="w-full rounded-lg border pl-9 pr-3 py-2 text-sm"
                    />
                  </div>
                  {searchingCustomers && (
                    <p className="text-[11px] text-text-muted">Searching customers...</p>
                  )}
                  {customerSearch.trim().length >= 2 &&
                    !searchingCustomers &&
                    customerResults.length === 0 && (
                      <div className="flex items-center justify-between rounded-lg border border-dashed border-border bg-surface px-3 py-2.5 text-xs">
                        <span className="text-text-secondary">
                          No existing customer matched &ldquo;{customerSearch}&rdquo;.
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setCustomerMode('new');
                            if (/^\+?\d[\d\s-]{4,}$/.test(customerSearch.trim())) {
                              setNewPhone(customerSearch.trim());
                            } else {
                              setNewFullName(customerSearch.trim());
                            }
                          }}
                          className="font-medium text-accent hover:underline"
                        >
                          + Create New Customer
                        </button>
                      </div>
                    )}
                  {customerResults.length > 0 && (
                    <div className="max-h-44 overflow-y-auto rounded-lg border border-border bg-surface divide-y divide-border">
                      {customerResults.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => {
                            setSelectedCustomer(c);
                            setCustomerResults([]);
                          }}
                          className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-xs hover:bg-bg"
                        >
                          <div className="min-w-0">
                            <p className="font-medium text-text-primary">
                              {c.full_name}{' '}
                              <span className="font-mono text-text-muted">({c.customer_code})</span>
                            </p>
                            <p className="truncate text-text-secondary">
                              {c.address} {c.area ? `• ${c.area}` : ''}
                            </p>
                          </div>
                          <span className="shrink-0 font-mono text-text-secondary">
                            {c.phone_number}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )
            ) : (
              <div className="space-y-3">
                {duplicates.length > 0 && (
                  <div className="rounded-xl border border-warning/40 bg-warning-soft p-3.5 text-xs space-y-2.5">
                    <div className="flex items-start gap-2 font-semibold text-warning">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>A customer with similar details already exists.</span>
                    </div>
                    <div className="space-y-2">
                      {duplicates.map((dup) => (
                        <div
                          key={dup.id}
                          className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-2.5 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <div className="min-w-0">
                            <p className="font-medium text-text-primary">
                              {dup.full_name} ({dup.customer_code})
                            </p>
                            <p className="text-text-secondary">
                              {dup.phone_number} • {dup.address}
                              {dup.match_reason ? ` • ${dup.match_reason}` : ''}
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              onClick={() => {
                                onClose();
                                navigate(`/customers/${dup.id}`);
                              }}
                              className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 font-medium text-text-primary hover:bg-bg"
                            >
                              Open
                              <ArrowUpRight className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setCustomerMode('existing');
                                setSelectedCustomer({
                                  id: dup.id,
                                  customer_code: dup.customer_code,
                                  full_name: dup.full_name,
                                  phone_number: dup.phone_number,
                                  alternate_phone: dup.alternate_phone,
                                  address: dup.address,
                                  area: dup.area,
                                  notes: null,
                                  created_at: '',
                                  updated_at: '',
                                  archived_at: null,
                                });
                              }}
                              className="zb-btn-primary rounded-md px-2.5 py-1 font-medium"
                            >
                              Select &amp; Add Service
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                    <label className="flex items-center gap-2 text-text-primary cursor-pointer">
                      <input
                        type="checkbox"
                        checked={allowDuplicate}
                        onChange={(e) => setAllowDuplicate(e.target.checked)}
                        className="h-4 w-4 rounded border-border"
                      />
                      <span>Continue creating a new customer (genuinely different person)</span>
                    </label>
                  </div>
                )}

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <label className="mb-1 block text-xs font-medium text-text-secondary">
                      Customer Full Name <span className="text-error">*</span>
                    </label>
                    <input
                      type="text"
                      required
                      value={newFullName}
                      onChange={(e) => setNewFullName(e.target.value)}
                      placeholder="e.g. Rajesh Kumar Sharma"
                      className="w-full rounded-lg border px-3 py-1.5 text-sm"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-text-secondary">
                      Primary Phone <span className="text-error">*</span>
                    </label>
                    <input
                      type="text"
                      required
                      value={newPhone}
                      onChange={(e) => setNewPhone(e.target.value)}
                      placeholder="+91 9876543210"
                      className="w-full rounded-lg border px-3 py-1.5 text-sm font-mono"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-text-secondary">
                      Alternate Phone
                    </label>
                    <input
                      type="text"
                      value={newAltPhone}
                      onChange={(e) => setNewAltPhone(e.target.value)}
                      placeholder="Optional alternate phone"
                      className="w-full rounded-lg border px-3 py-1.5 text-sm font-mono"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="mb-1 block text-xs font-medium text-text-secondary">
                      Customer Address <span className="text-error">*</span>
                    </label>
                    <textarea
                      required
                      rows={2}
                      value={newAddress}
                      onChange={(e) => setNewAddress(e.target.value)}
                      placeholder="House/Flat No., Building, Street"
                      className="w-full rounded-lg border px-3 py-1.5 text-sm"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-text-secondary">
                      Area / Locality
                    </label>
                    <input
                      type="text"
                      value={newArea}
                      onChange={(e) => setNewArea(e.target.value)}
                      placeholder="e.g. Indiranagar"
                      className="w-full rounded-lg border px-3 py-1.5 text-sm"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-text-secondary">
                      Customer Notes (Optional)
                    </label>
                    <input
                      type="text"
                      value={newCustomerNotes}
                      onChange={(e) => setNewCustomerNotes(e.target.value)}
                      placeholder="Access info, landmark..."
                      className="w-full rounded-lg border px-3 py-1.5 text-sm"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* SECTION 2: SERVICE INFORMATION */}
        {!savedServiceForRetry && (
          <div className="space-y-3 rounded-xl border border-border p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
              {isEdit ? 'Service Details' : '2. Service Information'}
            </h3>

            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-text-secondary">
                  Actual Service Date <span className="text-error">*</span>
                </label>
                <input
                  type="date"
                  required
                  value={serviceDate}
                  onChange={(e) => setServiceDate(e.target.value)}
                  className="w-full rounded-lg border px-3 py-1.5 text-sm"
                />
                <p className="mt-0.5 text-[10px] text-text-muted">
                  Past dates allowed. Record upload timestamp is saved automatically.
                </p>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-text-secondary">
                  Service Type <span className="text-error">*</span>
                </label>
                <select
                  value={serviceType}
                  onChange={(e) => setServiceType(e.target.value)}
                  className="w-full rounded-lg border px-3 py-1.5 text-sm"
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
                <label className="mb-1 block text-xs font-medium text-text-secondary">
                  Tank Details
                </label>
                <input
                  type="text"
                  value={tankDetails}
                  onChange={(e) => setTankDetails(e.target.value)}
                  placeholder="e.g. 1000L Overhead + 2000L Sump"
                  className="w-full rounded-lg border px-3 py-1.5 text-sm"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-text-secondary">
                  Service Description
                </label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="High-pressure wash & chlorination"
                  className="w-full rounded-lg border px-3 py-1.5 text-sm"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-text-secondary">
                  Service Amount ({sym}) <span className="text-error">*</span>
                </label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  required
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  className="w-full rounded-lg border px-3 py-1.5 text-sm"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-text-secondary">
                  Discount ({sym})
                </label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={discount}
                  onChange={(e) => setDiscount(e.target.value)}
                  className="w-full rounded-lg border px-3 py-1.5 text-sm"
                />
              </div>

              {isEdit && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-text-secondary">
                    Next Due Date
                  </label>
                  <input
                    type="date"
                    value={editNextDueDate}
                    onChange={(e) => setEditNextDueDate(e.target.value)}
                    className="w-full rounded-lg border px-3 py-1.5 text-sm"
                  />
                </div>
              )}

              <div className="sm:col-span-2">
                <label className="mb-1 block text-xs font-medium text-text-secondary">
                  Service Notes
                </label>
                <textarea
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Sludge condition, observations, valve checks..."
                  className="w-full rounded-lg border px-3 py-1.5 text-sm"
                />
              </div>
            </div>

            <div className="flex items-center justify-between rounded-lg bg-bg px-3.5 py-2 text-sm">
              <span className="text-text-secondary">Net Service Total</span>
              <span className="font-semibold text-text-primary">
                {formatCurrency(computedTotal, sym)}
              </span>
            </div>
          </div>
        )}

        {/* SECTION 3: PAYMENT (on creation) */}
        {!isEdit && !savedServiceForRetry && (
          <div className="space-y-3 rounded-xl border border-border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                3. Payment
              </h3>
              <span className="text-xs text-text-secondary">
                Outstanding Balance:{' '}
                <strong className={computedBalance > 0 ? 'text-error' : 'text-success'}>
                  {formatCurrency(computedBalance, sym)}
                </strong>
              </span>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {[
                { id: 'unpaid' as const, label: 'Unpaid' },
                { id: 'partial' as const, label: 'Partially Paid' },
                { id: 'paid' as const, label: 'Paid in Full' },
              ].map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => {
                    setPaymentChoice(opt.id);
                    if (opt.id === 'partial' && !paidAmount) {
                      setPaidAmount(String(Math.round(computedTotal / 2)));
                    }
                  }}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                    paymentChoice === opt.id
                      ? 'border-accent bg-accent-soft text-accent'
                      : 'border-border bg-surface text-text-secondary hover:bg-bg'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {paymentChoice !== 'unpaid' && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 pt-1">
                {paymentChoice === 'partial' && (
                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-text-secondary">
                      Amount Paid ({sym})
                    </label>
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      required
                      value={paidAmount}
                      onChange={(e) => setPaidAmount(e.target.value)}
                      className="w-full rounded-lg border px-2.5 py-1.5 text-sm"
                    />
                  </div>
                )}
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-text-secondary">
                    Payment Method
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
                <div className={paymentChoice === 'paid' ? 'sm:col-span-2' : ''}>
                  <label className="mb-1 block text-[11px] font-medium text-text-secondary">
                    Reference / UTR (Optional)
                  </label>
                  <input
                    type="text"
                    value={txRef}
                    onChange={(e) => setTxRef(e.target.value)}
                    placeholder="UPI UTR or Receipt #"
                    className="w-full rounded-lg border px-2.5 py-1.5 text-sm"
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {/* SECTION 4: ATTACHMENTS BY CATEGORY (on creation) */}
        {!isEdit && (
          <div className="rounded-xl border border-border overflow-hidden">
            <button
              type="button"
              onClick={() => setAttachmentsOpen((v) => !v)}
              className="flex w-full items-center justify-between bg-bg/50 px-4 py-3 text-left"
            >
              <div className="flex items-center gap-2">
                <Paperclip className="h-4 w-4 text-accent" />
                <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                  4. Attachments &amp; Photos ({queuedFiles.length})
                </span>
              </div>
              {attachmentsOpen ? (
                <ChevronUp className="h-4 w-4 text-text-muted" />
              ) : (
                <ChevronDown className="h-4 w-4 text-text-muted" />
              )}
            </button>

            {attachmentsOpen && (
              <div className="space-y-3 p-4 border-t border-border">
                <p className="text-[11px] text-text-secondary">
                  Supports JPG, JPEG, PNG, WEBP, PDF up to 15 MB each. Stored privately in{' '}
                  <code>zero-base-files</code>.
                </p>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {FILE_CATEGORIES.map((cat) => {
                    const catFiles = queuedFiles.filter((f) => f.category === cat);
                    const isDragging = dragCategory === cat;
                    return (
                      <div
                        key={cat}
                        onDragOver={(e) => {
                          e.preventDefault();
                          setDragCategory(cat);
                        }}
                        onDragLeave={() => setDragCategory(null)}
                        onDrop={(e) => {
                          e.preventDefault();
                          setDragCategory(null);
                          addFilesToQueue(Array.from(e.dataTransfer.files), cat);
                        }}
                        className={`rounded-lg border p-3 transition ${
                          isDragging
                            ? 'border-accent bg-accent-soft'
                            : 'border-dashed border-border bg-bg/30'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-medium text-text-primary">{cat}</span>
                          <input
                            ref={(el) => {
                              fileInputRefs.current[cat] = el;
                            }}
                            type="file"
                            multiple
                            accept="image/jpeg,image/png,image/webp,application/pdf"
                            onChange={(e) => {
                              addFilesToQueue(Array.from(e.target.files ?? []), cat);
                              e.target.value = '';
                            }}
                            className="hidden"
                          />
                          <button
                            type="button"
                            onClick={() => fileInputRefs.current[cat]?.click()}
                            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-medium hover:bg-bg"
                          >
                            <Upload className="h-3 w-3" />
                            Upload
                          </button>
                        </div>

                        {catFiles.length === 0 ? (
                          <p className="mt-2 text-[11px] text-text-muted">
                            Drag &amp; drop files here or click Upload
                          </p>
                        ) : (
                          <div className="mt-2.5 space-y-2">
                            {catFiles.map((item) => (
                              <div
                                key={item.id}
                                className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface p-2 text-xs"
                              >
                                <div className="flex items-center gap-2 min-w-0">
                                  {item.previewUrl ? (
                                    <img
                                      src={item.previewUrl}
                                      alt={item.file.name}
                                      className="h-9 w-9 shrink-0 rounded object-cover border border-border"
                                    />
                                  ) : (
                                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded border border-border bg-bg">
                                      <FileText className="h-4 w-4 text-text-muted" />
                                    </div>
                                  )}
                                  <div className="min-w-0">
                                    <p className="truncate font-medium text-text-primary">
                                      {item.file.name}
                                    </p>
                                    <p className="text-[10px] text-text-muted">
                                      {formatBytes(item.file.size)}
                                      {item.status === 'uploading' && ' • Uploading...'}
                                      {item.status === 'uploaded' && ' • Uploaded'}
                                      {item.status === 'error' && ` • ${item.error}`}
                                    </p>
                                  </div>
                                </div>
                                {item.status !== 'uploaded' && (
                                  <button
                                    type="button"
                                    onClick={() => removeQueuedFile(item.id)}
                                    aria-label={`Remove ${item.file.name}`}
                                    className="rounded p-1 text-text-muted hover:bg-error-soft hover:text-error"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* SECTION 5: OPTIONAL NEXT-SERVICE REMINDER (Default OFF) */}
        {!isEdit && !savedServiceForRetry && (
          <div className="rounded-xl border border-border p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Bell className="h-4 w-4 text-accent" />
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                    5. Schedule Next Service Reminder (Optional)
                  </h3>
                  <p className="text-[11px] text-text-secondary">
                    Off by default — enable only if the customer requests a follow-up date
                  </p>
                </div>
              </div>
              <label className="relative inline-flex cursor-pointer items-center">
                <input
                  type="checkbox"
                  checked={reminderEnabled}
                  onChange={(e) => setReminderEnabled(e.target.checked)}
                  className="peer sr-only"
                />
                <div className="h-5 w-9 rounded-full border border-border bg-bg transition peer-checked:bg-accent after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow after:transition-all peer-checked:after:translate-x-4" />
              </label>
            </div>

            {reminderEnabled && (
              <div className="space-y-3 border-t border-border pt-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-text-muted mr-1">Quick set:</span>
                  {[
                    { label: '+3 Months', months: 3 },
                    { label: '+6 Months', months: 6 },
                    { label: '+1 Year', months: 12 },
                  ].map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() =>
                        setReminderDate(addMonthsToIsoDate(serviceDate, preset.months))
                      }
                      className="rounded-md border border-border bg-bg px-2.5 py-1 text-[11px] font-medium text-text-secondary hover:text-text-primary"
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-text-secondary">
                      Reminder Date <span className="text-error">*</span>
                    </label>
                    <input
                      type="date"
                      required={reminderEnabled}
                      value={reminderDate}
                      onChange={(e) => setReminderDate(e.target.value)}
                      className="w-full rounded-lg border px-3 py-1.5 text-sm"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-text-secondary">
                      Reminder Type
                    </label>
                    <select
                      value={reminderType}
                      onChange={(e) =>
                        setReminderType(e.target.value as 'service_due' | 'custom' | 'follow_up')
                      }
                      className="w-full rounded-lg border px-3 py-1.5 text-sm"
                    >
                      <option value="service_due">Service Due</option>
                      <option value="follow_up">Follow-Up Call</option>
                      <option value="custom">Custom Reminder</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-text-secondary">
                      Reminder Note
                    </label>
                    <input
                      type="text"
                      value={reminderNotes}
                      onChange={(e) => setReminderNotes(e.target.value)}
                      placeholder="Call before visiting..."
                      className="w-full rounded-lg border px-3 py-1.5 text-sm"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {uploadProgressText && (
          <div className="rounded-lg border border-accent/30 bg-accent-soft px-3.5 py-2 text-xs font-medium text-accent">
            {uploadProgressText}
          </div>
        )}

        <div className="flex items-center justify-end gap-2.5 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border bg-surface px-4 py-2 text-sm font-medium text-text-primary hover:bg-bg"
          >
            {savedServiceForRetry ? 'Close' : 'Cancel'}
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="zb-btn-primary rounded-lg px-5 py-2 text-sm font-medium transition disabled:opacity-50"
          >
            {submitting
              ? uploadProgressText
                ? 'Uploading...'
                : 'Saving...'
              : savedServiceForRetry
                ? 'Retry Failed Uploads'
                : isEdit
                  ? 'Update Service'
                  : 'Save Service'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
