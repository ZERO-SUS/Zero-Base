import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  Bell,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  FileText,
  Layers,
  Minus,
  Paperclip,
  Plus,
  Receipt,
  Search,
  ShoppingCart,
  Trash2,
  Upload,
  UserCheck,
  UserPlus,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { apiFetch, ApiError, newIdempotencyKey } from '../../lib/api';
import {
  computeCartTotals,
  getGroupSubtotal,
  getItemLineTotal,
  groupsFromExisting,
  inferCategoryKind,
  newCartItem,
  resolveServiceCategories,
  toCartPayloadGroups,
  type DraftCartGroup,
  type DraftCartItem,
} from '../../lib/cartPricing';
import {
  addMonthsToIsoDate,
  formatBytes,
  formatCurrency,
  getTodayIstInputDate,
} from '../../lib/format';
import {
  FILE_CATEGORIES,
  type CategoryKind,
  type Customer,
  type DiscountType,
  type FileCategory,
  type PaymentMethod,
  type PricingMode,
  type ServiceCategoryGroup,
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
  existingGroups?: ServiceCategoryGroup[] | null;
  onSaved: (service: ServiceRecord, customer?: Customer) => void;
}

const CAPACITY_PRESETS = [500, 1000, 2000, 5000, 10000];

function addButtonLabel(kind: CategoryKind): string {
  switch (kind) {
    case 'tank':
      return 'Add Another Tank';
    case 'sump':
      return 'Add Another Sump';
    case 'solar':
      return 'Add Another Solar Entry';
    case 'plumbing':
      return 'Add Another Plumbing Work';
    default:
      return 'Add Another Item';
  }
}

export function ServiceFormModal({
  open,
  onClose,
  fixedCustomer,
  existingService,
  existingGroups,
  onSaved,
}: ServiceFormModalProps) {
  const navigate = useNavigate();
  const { settings } = useAuth();
  const isEdit = Boolean(existingService);
  const sym = settings.currency_symbol || '₹';

  const allCategories = useMemo(() => resolveServiceCategories(settings), [settings]);
  const activeCategories = useMemo(
    () => allCategories.filter((c) => c.active),
    [allCategories],
  );

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

  // Service metadata
  const [serviceDate, setServiceDate] = useState(getTodayIstInputDate());
  const [description, setDescription] = useState('');
  const [notes, setNotes] = useState('');
  const [editNextDueDate, setEditNextDueDate] = useState('');

  // Dynamic Cart Builder state
  const [cartGroups, setCartGroups] = useState<DraftCartGroup[]>([]);
  const [collapsedCategories, setCollapsedCategories] = useState<Record<string, boolean>>({});
  const [loadingCartDetails, setLoadingCartDetails] = useState(false);

  // Discount & Checkout payment fields
  const [discountType, setDiscountType] = useState<DiscountType>('fixed');
  const [discountValue, setDiscountValue] = useState('0');
  const [paymentChoice, setPaymentChoice] = useState<'unpaid' | 'partial' | 'paid'>('unpaid');
  const [paidAmount, setPaidAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('Cash');
  const [txRef, setTxRef] = useState('');

  // Optional Next-Service Reminder (OFF by default)
  const [reminderEnabled, setReminderEnabled] = useState(false);
  const [reminderDate, setReminderDate] = useState('');
  const [reminderType, setReminderType] = useState<'service_due' | 'custom' | 'follow_up'>('service_due');
  const [reminderNotes, setReminderNotes] = useState('');

  // Attachments (5 categories)
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
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

  // Initialize modal state
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setUploadProgressText(null);
    setSavedServiceForRetry(null);
    setSavedCustomerForRetry(null);
    setIdempotencyKey(newIdempotencyKey());
    setCollapsedCategories({});

    if (existingService) {
      setServiceDate(existingService.service_date);
      setDescription(existingService.description ?? '');
      setEditNextDueDate(existingService.next_due_date ?? '');
      setNotes(existingService.notes ?? '');
      setDiscountType(existingService.discount_type ?? 'fixed');
      setDiscountValue(
        String(existingService.discount_value ?? existingService.discount ?? 0),
      );
      setPaymentChoice('unpaid');
      setReminderEnabled(false);
      setQueuedFiles([]);

      if (existingGroups && existingGroups.length > 0) {
        setCartGroups(groupsFromExisting(existingGroups, allCategories));
      } else {
        setLoadingCartDetails(true);
        void apiFetch<{ category_groups?: ServiceCategoryGroup[] }>(
          `/api/services/${existingService.id}`,
        )
          .then((res) => {
            if (cancelled) return;
            if (res.category_groups && res.category_groups.length > 0) {
              setCartGroups(groupsFromExisting(res.category_groups, allCategories));
            } else {
              const fallbackKind = inferCategoryKind(existingService.service_type);
              setCartGroups([
                {
                  category_name: existingService.service_type,
                  kind: fallbackKind,
                  pricing_mode: 'itemized',
                  category_subtotal: String(existingService.price || 0),
                  items: [
                    {
                      uid: `legacy-${existingService.id}`,
                      item_name: existingService.tank_details || existingService.service_type,
                      capacity_litres: '',
                      quantity: 1,
                      unit_price: String(existingService.price || 0),
                      description: existingService.description || '',
                    },
                  ],
                },
              ]);
            }
          })
          .catch(() => {
            if (!cancelled) {
              setError('Could not load original cart items for editing.');
            }
          })
          .finally(() => {
            if (!cancelled) setLoadingCartDetails(false);
          });
      }
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
      setDescription('');
      setNotes('');

      const firstActive = activeCategories[0];
      if (firstActive) {
        const kind = firstActive.kind || inferCategoryKind(firstActive.name);
        setCartGroups([
          {
            category_name: firstActive.name,
            kind,
            pricing_mode: 'itemized',
            category_subtotal: '',
            items: [newCartItem(kind, 0)],
          },
        ]);
      } else {
        setCartGroups([]);
      }

      setDiscountType('fixed');
      setDiscountValue('0');
      setPaymentChoice('unpaid');
      setPaidAmount('');
      setPaymentMethod('Cash');
      setTxRef('');

      setReminderEnabled(false);
      setReminderDate(addMonthsToIsoDate(today, settings.default_reminder_months || 6));
      setReminderType('service_due');
      setReminderNotes('');
      setQueuedFiles([]);
      setAttachmentsOpen(false);
    }

    return () => {
      cancelled = true;
    };
  }, [open, fixedCustomer, existingService, existingGroups, allCategories, activeCategories, settings.default_reminder_months]);

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
          `/api/customers?q=${encodeURIComponent(q)}&limit=10`,
        );
        setCustomerResults(res.customers);
      } catch {
        // Non-blocking search
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
          `/api/customers/check-duplicate?${params.toString()}`,
        );
        setDuplicates(res.duplicates ?? []);
      } catch {
        // Non-blocking
      }
    }, 300);

    return () => window.clearTimeout(timer);
  }, [newPhone, newAltPhone, newFullName, newAddress, customerMode, open, isEdit]);

  // Live cart computation
  const computation = useMemo(
    () => computeCartTotals(cartGroups, discountType, discountValue),
    [cartGroups, discountType, discountValue],
  );

  const computedBalance = useMemo(() => {
    if (isEdit && existingService) {
      return Math.max(0, computation.grandTotal - Number(existingService.amount_paid || 0));
    }
    if (paymentChoice === 'paid') return 0;
    if (paymentChoice === 'unpaid') return computation.grandTotal;
    const paid = Math.max(0, Number(paidAmount) || 0);
    return Math.max(0, computation.grandTotal - paid);
  }, [isEdit, existingService, paymentChoice, paidAmount, computation.grandTotal]);

  const totalItemCount = useMemo(
    () => cartGroups.reduce((acc, g) => acc + g.items.reduce((a, i) => a + i.quantity, 0), 0),
    [cartGroups],
  );

  // Cart manipulation handlers
  const handleToggleCategoryInCart = (categoryName: string, kindHint?: CategoryKind) => {
    const existingIdx = cartGroups.findIndex(
      (g) => g.category_name.toLowerCase() === categoryName.toLowerCase(),
    );
    if (existingIdx >= 0) {
      // Expand it if collapsed rather than accidentally losing user entries
      setCollapsedCategories((prev) => ({ ...prev, [categoryName]: false }));
      return;
    }
    const kind = kindHint || inferCategoryKind(categoryName);
    setCartGroups((prev) => [
      ...prev,
      {
        category_name: categoryName,
        kind,
        pricing_mode: 'itemized',
        category_subtotal: '',
        items: [newCartItem(kind, 0)],
      },
    ]);
    setCollapsedCategories((prev) => ({ ...prev, [categoryName]: false }));
  };

  const handleRemoveCategory = (categoryName: string) => {
    setCartGroups((prev) => prev.filter((g) => g.category_name !== categoryName));
  };

  const handlePricingModeChange = (categoryName: string, nextMode: PricingMode) => {
    setCartGroups((prev) =>
      prev.map((g) => {
        if (g.category_name !== categoryName) return g;
        if (nextMode === 'category_total' && !g.category_subtotal) {
          const currentSum = getGroupSubtotal(g);
          return {
            ...g,
            pricing_mode: nextMode,
            category_subtotal: currentSum > 0 ? String(currentSum) : '',
          };
        }
        return { ...g, pricing_mode: nextMode };
      }),
    );
  };

  const handleGroupSubtotalChange = (categoryName: string, val: string) => {
    setCartGroups((prev) =>
      prev.map((g) => (g.category_name === categoryName ? { ...g, category_subtotal: val } : g)),
    );
  };

  const handleAddItem = (categoryName: string) => {
    setCartGroups((prev) =>
      prev.map((g) => {
        if (g.category_name !== categoryName) return g;
        return {
          ...g,
          items: [...g.items, newCartItem(g.kind, g.items.length)],
        };
      }),
    );
  };

  const handleDuplicateItem = (categoryName: string, itemUid: string) => {
    setCartGroups((prev) =>
      prev.map((g) => {
        if (g.category_name !== categoryName) return g;
        const targetIdx = g.items.findIndex((i) => i.uid === itemUid);
        if (targetIdx < 0) return g;
        const src = g.items[targetIdx];
        const copy: DraftCartItem = {
          ...src,
          uid: `dup-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          item_name: src.item_name ? `${src.item_name} (Copy)` : '',
        };
        const nextItems = [...g.items];
        nextItems.splice(targetIdx + 1, 0, copy);
        return { ...g, items: nextItems };
      }),
    );
  };

  const handleRemoveItem = (categoryName: string, itemUid: string) => {
    setCartGroups((prev) =>
      prev
        .map((g) => {
          if (g.category_name !== categoryName) return g;
          return { ...g, items: g.items.filter((i) => i.uid !== itemUid) };
        })
        .filter((g) => g.items.length > 0),
    );
  };

  const handleUpdateItem = (
    categoryName: string,
    itemUid: string,
    patch: Partial<DraftCartItem>,
  ) => {
    setCartGroups((prev) =>
      prev.map((g) => {
        if (g.category_name !== categoryName) return g;
        return {
          ...g,
          items: g.items.map((i) => (i.uid === itemUid ? { ...i, ...patch } : i)),
        };
      }),
    );
  };

  // Attachments
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
      setUploadProgressText(
        `Uploading attachment ${i + 1} of ${pending.length}: ${item.file.name}`,
      );
      setQueuedFiles((prev) =>
        prev.map((q) => (q.id === item.id ? { ...q, status: 'uploading', error: undefined } : q)),
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
          prev.map((q) => (q.id === item.id ? { ...q, status: 'uploaded' } : q)),
        );
      } catch (err) {
        allOk = false;
        const msg = err instanceof ApiError ? err.message : 'Upload failed';
        setQueuedFiles((prev) =>
          prev.map((q) => (q.id === item.id ? { ...q, status: 'error', error: msg } : q)),
        );
      }
    }
    setUploadProgressText(null);
    return allOk;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

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

    if (cartGroups.length === 0) {
      setError('Add at least one service category and item to the cart.');
      return;
    }

    if (computation.error) {
      setError(computation.error);
      return;
    }

    const payloadGroups = toCartPayloadGroups(cartGroups);
    const parsedDiscount = Math.max(0, Number(discountValue || 0));

    if (isEdit && existingService) {
      setSubmitting(true);
      try {
        const res = await apiFetch<{ service: ServiceRecord }>(
          `/api/services/${existingService.id}`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              service_date: serviceDate,
              cart_groups: payloadGroups,
              discount_type: discountType,
              discount_value: parsedDiscount,
              description: description.trim() || null,
              notes: notes.trim() || null,
              next_due_date: editNextDueDate || null,
            }),
          },
        );
        if (queuedFiles.length > 0) {
          const uploadsOk = await uploadQueuedFilesForService(res.service);
          if (!uploadsOk) {
            setSavedServiceForRetry(res.service);
            setError(
              'Service cart updated, but one or more attachments failed to upload. Retry or close.',
            );
            onSaved(res.service);
            setSubmitting(false);
            return;
          }
        }
        onSaved(res.service);
        onClose();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to update service cart.');
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
        setError(
          'Matching customer found. Select the existing customer or confirm creating a new record.',
        );
        return;
      }
    }

    let initialPayPayload: null | {
      amount: number;
      payment_method: PaymentMethod;
      reference_number: string | null;
      payment_date: string;
    } = null;

    if (paymentChoice === 'paid' && computation.grandTotal > 0) {
      initialPayPayload = {
        amount: computation.grandTotal,
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
      if (amt > computation.grandTotal) {
        setError('Partial payment cannot exceed the checkout Grand Total.');
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
          cart_groups: payloadGroups,
          discount_type: discountType,
          discount_value: parsedDiscount,
          description: description.trim() || null,
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
            'Service bill saved, but one or more attachments failed to upload. Retry failed files or close to view the service.',
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
        setError('Failed to save service checkout.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Categories available in the quick-add menu (active + any historical category already inside cartGroups)
  const menuCategories = useMemo(() => {
    const map = new Map<string, { name: string; kind: CategoryKind; inactive?: boolean }>();
    for (const c of activeCategories) {
      map.set(c.name.toLowerCase(), {
        name: c.name,
        kind: c.kind || inferCategoryKind(c.name),
      });
    }
    for (const g of cartGroups) {
      if (!map.has(g.category_name.toLowerCase())) {
        map.set(g.category_name.toLowerCase(), {
          name: g.category_name,
          kind: g.kind,
          inactive: true,
        });
      }
    }
    return Array.from(map.values());
  }, [activeCategories, cartGroups]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit Service Cart & Bill' : 'Service Cart & Checkout'}
      subtitle={
        isEdit
          ? 'Modify itemized services, capacities, or discounts. Existing payments are automatically reconciled.'
          : 'Build an itemized service visit across one or more categories, then complete checkout.'
      }
      maxWidthClass="max-w-6xl"
    >
      <form onSubmit={handleSubmit} className="space-y-5 overflow-x-hidden">
        {error && (
          <div className="rounded-lg border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
            {error}
          </div>
        )}

        {uploadProgressText && (
          <div className="rounded-lg border border-accent/30 bg-accent-soft px-4 py-2.5 text-xs font-medium text-accent">
            {uploadProgressText}
          </div>
        )}

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-12 items-start">
          {/* LEFT / MAIN BUILDER WORKSPACE */}
          <div className="lg:col-span-7 xl:col-span-8 space-y-5 min-w-0">
            {/* STEP 1: CUSTOMER SELECTION (create mode only) */}
            {!isEdit && (
              <section className="rounded-xl border border-border bg-bg p-4 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-text-primary">1. Customer</h3>
                    <p className="text-xs text-text-secondary">
                      Select an existing customer or create a new one inline.
                    </p>
                  </div>
                  {!fixedCustomer && (
                    <div className="inline-flex rounded-lg border border-border bg-surface p-0.5 text-xs font-medium">
                      <button
                        type="button"
                        onClick={() => setCustomerMode('existing')}
                        className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 transition-colors ${
                          customerMode === 'existing'
                            ? 'bg-accent text-white'
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
                        className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 transition-colors ${
                          customerMode === 'new'
                            ? 'bg-accent text-white'
                            : 'text-text-secondary hover:text-text-primary'
                        }`}
                      >
                        <UserPlus className="h-3.5 w-3.5" />
                        New Customer
                      </button>
                    </div>
                  )}
                </div>

                {fixedCustomer ? (
                  <div className="flex items-center justify-between rounded-lg border border-border bg-surface px-3.5 py-2.5">
                    <div>
                      <p className="text-sm font-semibold text-text-primary">
                        {fixedCustomer.full_name}
                      </p>
                      <p className="text-xs text-text-secondary">
                        {fixedCustomer.customer_code} · {fixedCustomer.phone_number}
                      </p>
                    </div>
                    <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent">
                      Selected
                    </span>
                  </div>
                ) : customerMode === 'existing' ? (
                  <div className="space-y-3">
                    {selectedCustomer ? (
                      <div className="flex items-center justify-between rounded-lg border border-accent/40 bg-surface px-3.5 py-2.5">
                        <div>
                          <p className="text-sm font-semibold text-text-primary">
                            {selectedCustomer.full_name}{' '}
                            <span className="text-xs font-mono text-text-muted">
                              ({selectedCustomer.customer_code})
                            </span>
                          </p>
                          <p className="text-xs text-text-secondary">
                            {selectedCustomer.phone_number} · {selectedCustomer.address}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setSelectedCustomer(null)}
                          className="text-xs font-medium text-accent hover:underline"
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
                            value={customerSearch}
                            onChange={(e) => setCustomerSearch(e.target.value)}
                            placeholder="Search by customer name, phone, code, or address..."
                            className="w-full rounded-lg border py-2 pl-9 pr-3 text-sm"
                          />
                        </div>
                        {searchingCustomers && (
                          <p className="text-xs text-text-muted">Searching customers...</p>
                        )}
                        {customerResults.length > 0 && (
                          <div className="max-h-44 overflow-y-auto divide-y divide-border rounded-lg border border-border bg-surface">
                            {customerResults.map((cust) => (
                              <button
                                key={cust.id}
                                type="button"
                                onClick={() => {
                                  setSelectedCustomer(cust);
                                  setCustomerResults([]);
                                }}
                                className="flex w-full items-start justify-between gap-3 px-3.5 py-2.5 text-left hover:bg-bg"
                              >
                                <div>
                                  <p className="text-sm font-medium text-text-primary">
                                    {cust.full_name}
                                  </p>
                                  <p className="text-xs text-text-secondary">
                                    {cust.phone_number} · {cust.address}
                                  </p>
                                </div>
                                <span className="font-mono text-xs text-text-muted">
                                  {cust.customer_code}
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-xs font-medium text-text-secondary">
                          Full Name *
                        </label>
                        <input
                          type="text"
                          value={newFullName}
                          onChange={(e) => setNewFullName(e.target.value)}
                          placeholder="e.g. Rajesh Kumar"
                          className="w-full rounded-lg border px-3 py-2 text-sm"
                          required
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-medium text-text-secondary">
                          Primary Phone Number *
                        </label>
                        <input
                          type="tel"
                          value={newPhone}
                          onChange={(e) => setNewPhone(e.target.value)}
                          placeholder="+91 98765 43210"
                          className="w-full rounded-lg border px-3 py-2 text-sm"
                          required
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-medium text-text-secondary">
                          Alternate Phone (Optional)
                        </label>
                        <input
                          type="tel"
                          value={newAltPhone}
                          onChange={(e) => setNewAltPhone(e.target.value)}
                          placeholder="Optional"
                          className="w-full rounded-lg border px-3 py-2 text-sm"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-medium text-text-secondary">
                          Area / Locality (Optional)
                        </label>
                        <input
                          type="text"
                          value={newArea}
                          onChange={(e) => setNewArea(e.target.value)}
                          placeholder="e.g. Indiranagar"
                          className="w-full rounded-lg border px-3 py-2 text-sm"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-text-secondary">
                        Full Address *
                      </label>
                      <textarea
                        rows={2}
                        value={newAddress}
                        onChange={(e) => setNewAddress(e.target.value)}
                        placeholder="House/Flat no., Street, Landmark"
                        className="w-full rounded-lg border px-3 py-2 text-sm"
                        required
                      />
                    </div>

                    {duplicates.length > 0 && (
                      <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 space-y-2">
                        <div className="flex items-start gap-2 text-xs text-warning">
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                          <div>
                            <p className="font-semibold">Possible duplicate customer found</p>
                            <p className="text-text-secondary">
                              Select the matching customer to reuse their profile instead of creating
                              a duplicate.
                            </p>
                          </div>
                        </div>
                        <div className="space-y-1.5">
                          {duplicates.map((dup) => (
                            <div
                              key={dup.id}
                              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2 text-xs"
                            >
                              <div>
                                <span className="font-semibold text-text-primary">
                                  {dup.full_name}
                                </span>{' '}
                                <span className="font-mono text-text-muted">
                                  ({dup.customer_code})
                                </span>{' '}
                                · {dup.phone_number}
                                {dup.match_reason && (
                                  <span className="ml-2 text-warning">[{dup.match_reason}]</span>
                                )}
                              </div>
                              <div className="flex items-center gap-2">
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
                                    setDuplicates([]);
                                  }}
                                  className="rounded bg-accent px-2.5 py-1 text-white font-medium"
                                >
                                  Use This Customer
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    onClose();
                                    navigate(`/customers/${dup.id}`);
                                  }}
                                  className="inline-flex items-center gap-1 text-accent hover:underline"
                                >
                                  Profile <ArrowUpRight className="h-3 w-3" />
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                        <label className="flex items-center gap-2 pt-1 text-xs text-text-primary">
                          <input
                            type="checkbox"
                            checked={allowDuplicate}
                            onChange={(e) => setAllowDuplicate(e.target.checked)}
                          />
                          Create a separate new customer anyway
                        </label>
                      </div>
                    )}
                  </div>
                )}
              </section>
            )}

            {/* STEP 2: VISIT DATE & DYNAMIC CATEGORY MENU */}
            <section className="rounded-xl border border-border bg-bg p-4 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Layers className="h-4 w-4 text-accent" />
                  <h3 className="text-sm font-semibold text-text-primary">
                    {isEdit ? '1. Service Menu & Cart Items' : '2. Choose Service Categories'}
                  </h3>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-xs font-medium text-text-secondary">Service Date</label>
                  <input
                    type="date"
                    value={serviceDate}
                    onChange={(e) => setServiceDate(e.target.value)}
                    className="rounded-lg border px-2.5 py-1.5 text-xs"
                    required
                  />
                </div>
              </div>

              {/* Burger-King style category selector bar */}
              <div>
                <p className="mb-2 text-xs text-text-secondary">
                  Tap categories below to add them to this visit&apos;s cart (supports multiple
                  categories &amp; items in one bill):
                </p>
                <div className="flex flex-wrap gap-2">
                  {menuCategories.map((cat) => {
                    const inCart = cartGroups.some(
                      (g) => g.category_name.toLowerCase() === cat.name.toLowerCase(),
                    );
                    return (
                      <button
                        key={cat.name}
                        type="button"
                        onClick={() => handleToggleCategoryInCart(cat.name, cat.kind)}
                        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                          inCart
                            ? 'border-accent bg-accent text-white'
                            : 'border-border bg-surface text-text-primary hover:border-accent/60 hover:bg-elevated'
                        }`}
                      >
                        {inCart ? (
                          <CheckCircle2 className="h-3.5 w-3.5" />
                        ) : (
                          <Plus className="h-3.5 w-3.5" />
                        )}
                        <span>{cat.name}</span>
                        {cat.inactive && (
                          <span className="rounded bg-black/20 px-1.5 py-0.5 text-[10px]">
                            Inactive
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Active Cart Category Sections */}
              {loadingCartDetails ? (
                <div className="rounded-lg border border-border bg-surface p-6 text-center text-xs text-text-muted">
                  Loading original cart breakdown...
                </div>
              ) : cartGroups.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border bg-surface p-6 text-center text-xs text-text-muted">
                  Your service cart is empty. Select one or more categories above to start adding
                  items.
                </div>
              ) : (
                <div className="space-y-3">
                  {cartGroups.map((group) => {
                    const isCollapsed = Boolean(collapsedCategories[group.category_name]);
                    const catSubtotal = getGroupSubtotal(group);
                    const totalQty = group.items.reduce((a, i) => a + i.quantity, 0);

                    return (
                      <div
                        key={group.category_name}
                        className="rounded-xl border border-border bg-surface overflow-hidden"
                      >
                        {/* Category Card Header */}
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-elevated/60 px-3.5 py-2.5">
                          <button
                            type="button"
                            onClick={() =>
                              setCollapsedCategories((prev) => ({
                                ...prev,
                                [group.category_name]: !isCollapsed,
                              }))
                            }
                            className="flex items-center gap-2 text-left min-w-0"
                          >
                            {isCollapsed ? (
                              <ChevronDown className="h-4 w-4 shrink-0 text-text-muted" />
                            ) : (
                              <ChevronUp className="h-4 w-4 shrink-0 text-text-muted" />
                            )}
                            <span className="text-sm font-semibold text-text-primary truncate">
                              {group.category_name}
                            </span>
                            <span className="rounded-full bg-bg px-2 py-0.5 text-[11px] font-medium text-text-secondary">
                              {group.items.length} {group.items.length === 1 ? 'entry' : 'entries'} ·{' '}
                              {totalQty} qty
                            </span>
                          </button>

                          <div className="flex items-center gap-2.5">
                            <span className="text-sm font-semibold text-text-primary tabular-nums">
                              {formatCurrency(catSubtotal, sym)}
                            </span>
                            <button
                              type="button"
                              onClick={() => handleRemoveCategory(group.category_name)}
                              className="rounded p-1 text-text-muted hover:bg-bg hover:text-error"
                              title={`Remove ${group.category_name}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>

                        {!isCollapsed && (
                          <div className="p-3.5 space-y-3">
                            {/* Pricing mode toggle */}
                            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-bg px-3 py-2">
                              <div className="text-xs text-text-secondary">
                                Pricing Mode:
                                <span className="ml-1 font-medium text-text-primary">
                                  {group.pricing_mode === 'itemized'
                                    ? 'Individual Price Per Item'
                                    : 'Combined Price For Entire Category'}
                                </span>
                              </div>
                              <div className="inline-flex rounded-md border border-border bg-surface p-0.5 text-[11px] font-medium">
                                <button
                                  type="button"
                                  onClick={() =>
                                    handlePricingModeChange(group.category_name, 'itemized')
                                  }
                                  className={`rounded px-2.5 py-1 transition-colors ${
                                    group.pricing_mode === 'itemized'
                                      ? 'bg-accent text-white'
                                      : 'text-text-secondary hover:text-text-primary'
                                  }`}
                                >
                                  Per Item
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    handlePricingModeChange(group.category_name, 'category_total')
                                  }
                                  className={`rounded px-2.5 py-1 transition-colors ${
                                    group.pricing_mode === 'category_total'
                                      ? 'bg-accent text-white'
                                      : 'text-text-secondary hover:text-text-primary'
                                  }`}
                                >
                                  Combined Total
                                </button>
                              </div>
                            </div>

                            {group.pricing_mode === 'category_total' && (
                              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-accent/30 bg-accent-soft/40 px-3 py-2.5">
                                <div>
                                  <p className="text-xs font-semibold text-text-primary">
                                    Combined {group.category_name} Price ({sym})
                                  </p>
                                  <p className="text-[11px] text-text-secondary">
                                    All items listed below are included under this single category
                                    price (no double counting).
                                  </p>
                                </div>
                                <input
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  value={group.category_subtotal}
                                  onChange={(e) =>
                                    handleGroupSubtotalChange(group.category_name, e.target.value)
                                  }
                                  placeholder="0"
                                  className="w-32 rounded-lg border bg-surface px-3 py-1.5 text-sm font-semibold text-right tabular-nums"
                                />
                              </div>
                            )}

                            {/* Line items inside this category */}
                            <div className="space-y-2.5">
                              {group.items.map((item, idx) => {
                                const isTankOrSump =
                                  group.kind === 'tank' || group.kind === 'sump';
                                const isSolar = group.kind === 'solar';
                                const lineTotal = getItemLineTotal(item, group.pricing_mode);

                                return (
                                  <div
                                    key={item.uid}
                                    className="rounded-lg border border-border bg-bg p-3 space-y-2.5"
                                  >
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                      <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                                        Entry #{idx + 1}
                                      </span>
                                      <div className="flex items-center gap-1.5">
                                        <button
                                          type="button"
                                          onClick={() =>
                                            handleDuplicateItem(group.category_name, item.uid)
                                          }
                                          className="inline-flex items-center gap-1 rounded border border-border bg-surface px-2 py-0.5 text-[11px] text-text-secondary hover:text-text-primary"
                                          title="Duplicate item"
                                        >
                                          <Copy className="h-3 w-3" />
                                          Duplicate
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() =>
                                            handleRemoveItem(group.category_name, item.uid)
                                          }
                                          className="inline-flex items-center gap-1 rounded border border-border bg-surface px-2 py-0.5 text-[11px] text-text-muted hover:text-error"
                                          title="Remove item"
                                        >
                                          <Trash2 className="h-3 w-3" />
                                          Remove
                                        </button>
                                      </div>
                                    </div>

                                    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-12">
                                      {/* Item label / title */}
                                      <div className={isTankOrSump ? 'sm:col-span-5' : 'sm:col-span-6'}>
                                        <label className="mb-1 block text-[11px] font-medium text-text-secondary">
                                          {isTankOrSump
                                            ? 'Tank / Sump Label'
                                            : isSolar
                                            ? 'Solar Panel Label / Size'
                                            : 'Work Item Description'}
                                        </label>
                                        <input
                                          type="text"
                                          value={item.item_name}
                                          onChange={(e) =>
                                            handleUpdateItem(group.category_name, item.uid, {
                                              item_name: e.target.value,
                                            })
                                          }
                                          placeholder={
                                            isTankOrSump
                                              ? 'e.g. Terrace Tank A'
                                              : isSolar
                                              ? 'e.g. Rooftop Mono Panels'
                                              : 'e.g. Valve & Float Replacement'
                                          }
                                          className="w-full rounded-lg border bg-surface px-2.5 py-1.5 text-xs"
                                        />
                                      </div>

                                      {/* Capacity (Litres) for Tank / Sump */}
                                      {isTankOrSump && (
                                        <div className="sm:col-span-3">
                                          <label className="mb-1 block text-[11px] font-medium text-text-secondary">
                                            Litres Capacity
                                          </label>
                                          <input
                                            type="number"
                                            min="0"
                                            step="1"
                                            value={item.capacity_litres}
                                            onChange={(e) =>
                                              handleUpdateItem(group.category_name, item.uid, {
                                                capacity_litres: e.target.value,
                                              })
                                            }
                                            placeholder="1000"
                                            className="w-full rounded-lg border bg-surface px-2.5 py-1.5 text-xs tabular-nums"
                                          />
                                        </div>
                                      )}

                                      {/* Quantity Stepper */}
                                      <div className={isTankOrSump ? 'sm:col-span-2' : 'sm:col-span-3'}>
                                        <label className="mb-1 block text-[11px] font-medium text-text-secondary">
                                          {isSolar ? 'Panels Qty' : 'Qty'}
                                        </label>
                                        <div className="flex items-center rounded-lg border border-border bg-surface overflow-hidden">
                                          <button
                                            type="button"
                                            onClick={() =>
                                              handleUpdateItem(group.category_name, item.uid, {
                                                quantity: Math.max(1, item.quantity - 1),
                                              })
                                            }
                                            className="px-2 py-1.5 text-text-secondary hover:bg-bg"
                                            aria-label="Decrease quantity"
                                          >
                                            <Minus className="h-3 w-3" />
                                          </button>
                                          <input
                                            type="number"
                                            min={1}
                                            value={item.quantity}
                                            onChange={(e) =>
                                              handleUpdateItem(group.category_name, item.uid, {
                                                quantity: Math.max(1, Number(e.target.value) || 1),
                                              })
                                            }
                                            className="w-full border-0 bg-transparent py-1 text-center text-xs font-medium tabular-nums focus:outline-none"
                                          />
                                          <button
                                            type="button"
                                            onClick={() =>
                                              handleUpdateItem(group.category_name, item.uid, {
                                                quantity: item.quantity + 1,
                                              })
                                            }
                                            className="px-2 py-1.5 text-text-secondary hover:bg-bg"
                                            aria-label="Increase quantity"
                                          >
                                            <Plus className="h-3 w-3" />
                                          </button>
                                        </div>
                                      </div>

                                      {/* Unit Price (only editable in itemized mode) */}
                                      <div className={isTankOrSump ? 'sm:col-span-2' : 'sm:col-span-3'}>
                                        <label className="mb-1 block text-[11px] font-medium text-text-secondary">
                                          {group.pricing_mode === 'itemized'
                                            ? `Unit (${sym})`
                                            : 'Pricing'}
                                        </label>
                                        {group.pricing_mode === 'itemized' ? (
                                          <input
                                            type="number"
                                            min="0"
                                            step="0.01"
                                            value={item.unit_price}
                                            onChange={(e) =>
                                              handleUpdateItem(group.category_name, item.uid, {
                                                unit_price: e.target.value,
                                              })
                                            }
                                            placeholder="0"
                                            className="w-full rounded-lg border bg-surface px-2.5 py-1.5 text-xs text-right tabular-nums"
                                          />
                                        ) : (
                                          <div className="rounded-lg border border-dashed border-border bg-surface/60 px-2 py-1.5 text-center text-[11px] text-text-muted">
                                            Combined
                                          </div>
                                        )}
                                      </div>
                                    </div>

                                    {/* Quick capacity chips for Tank/Sump */}
                                    {isTankOrSump && (
                                      <div className="flex flex-wrap items-center gap-1.5">
                                        <span className="text-[10px] text-text-muted">Quick L:</span>
                                        {CAPACITY_PRESETS.map((cap) => (
                                          <button
                                            key={cap}
                                            type="button"
                                            onClick={() =>
                                              handleUpdateItem(group.category_name, item.uid, {
                                                capacity_litres: String(cap),
                                              })
                                            }
                                            className={`rounded px-1.5 py-0.5 text-[10px] border transition-colors ${
                                              item.capacity_litres === String(cap)
                                                ? 'border-accent bg-accent-soft text-accent font-medium'
                                                : 'border-border bg-surface text-text-secondary hover:text-text-primary'
                                            }`}
                                          >
                                            {cap}L
                                          </button>
                                        ))}
                                      </div>
                                    )}

                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                      <input
                                        type="text"
                                        value={item.description}
                                        onChange={(e) =>
                                          handleUpdateItem(group.category_name, item.uid, {
                                            description: e.target.value,
                                          })
                                        }
                                        placeholder="Optional item note (e.g. heavy silt, UV treatment)..."
                                        className="flex-1 min-w-[180px] rounded border bg-surface px-2.5 py-1 text-[11px]"
                                      />
                                      {group.pricing_mode === 'itemized' && (
                                        <span className="text-xs font-medium text-text-primary tabular-nums">
                                          Line Total: {formatCurrency(lineTotal, sym)}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>

                            <button
                              type="button"
                              onClick={() => handleAddItem(group.category_name)}
                              className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-accent/50 bg-accent-soft/30 px-3 py-2 text-xs font-medium text-accent hover:bg-accent-soft/60"
                            >
                              <Plus className="h-3.5 w-3.5" />
                              {addButtonLabel(group.kind)}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Visit-level description / notes */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 pt-1">
                <div>
                  <label className="mb-1 block text-xs font-medium text-text-secondary">
                    Visit Work Summary (Optional)
                  </label>
                  <input
                    type="text"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Overall visit summary..."
                    className="w-full rounded-lg border px-3 py-1.5 text-xs"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-text-secondary">
                    Internal Visit Notes (Optional)
                  </label>
                  <input
                    type="text"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Any remarks for the team..."
                    className="w-full rounded-lg border px-3 py-1.5 text-xs"
                  />
                </div>
              </div>
            </section>

            {/* STEP 3: OPTIONAL REMINDER */}
            {!isEdit ? (
              <section className="rounded-xl border border-border bg-bg p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Bell className="h-4 w-4 text-accent" />
                    <div>
                      <h3 className="text-sm font-semibold text-text-primary">
                        Next-Service Reminder (Optional)
                      </h3>
                      <p className="text-xs text-text-secondary">
                        Off by default. Enable only to schedule a follow-up reminder.
                      </p>
                    </div>
                  </div>
                  <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium">
                    <input
                      type="checkbox"
                      checked={reminderEnabled}
                      onChange={(e) => setReminderEnabled(e.target.checked)}
                    />
                    Schedule Reminder
                  </label>
                </div>

                {reminderEnabled && (
                  <div className="grid grid-cols-1 gap-3 pt-1 sm:grid-cols-3">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-text-secondary">
                        Next Due Date *
                      </label>
                      <input
                        type="date"
                        value={reminderDate}
                        onChange={(e) => setReminderDate(e.target.value)}
                        className="w-full rounded-lg border px-3 py-1.5 text-xs"
                        required
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
                        className="w-full rounded-lg border px-3 py-1.5 text-xs"
                      >
                        <option value="service_due">Service Due</option>
                        <option value="follow_up">Follow-Up</option>
                        <option value="custom">Custom</option>
                      </select>
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-text-secondary">
                        Reminder Notes
                      </label>
                      <input
                        type="text"
                        value={reminderNotes}
                        onChange={(e) => setReminderNotes(e.target.value)}
                        placeholder="Optional reminder note"
                        className="w-full rounded-lg border px-3 py-1.5 text-xs"
                      />
                    </div>
                  </div>
                )}
              </section>
            ) : (
              <section className="rounded-xl border border-border bg-bg p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Bell className="h-4 w-4 text-accent" />
                    <span className="text-xs font-medium text-text-primary">
                      Next Due Date (Optional)
                    </span>
                  </div>
                  <input
                    type="date"
                    value={editNextDueDate}
                    onChange={(e) => setEditNextDueDate(e.target.value)}
                    className="rounded-lg border px-3 py-1.5 text-xs"
                  />
                </div>
              </section>
            )}

            {/* STEP 4: ATTACHMENTS (5 categories) */}
            <section className="rounded-xl border border-border bg-bg p-4 space-y-3">
              <button
                type="button"
                onClick={() => setAttachmentsOpen((v) => !v)}
                className="flex w-full items-center justify-between text-left"
              >
                <div className="flex items-center gap-2">
                  <Paperclip className="h-4 w-4 text-accent" />
                  <div>
                    <h3 className="text-sm font-semibold text-text-primary">
                      Attachments ({queuedFiles.length} queued)
                    </h3>
                    <p className="text-xs text-text-secondary">
                      Invoices, UPI screenshots, Before/After photos (JPG, PNG, WEBP, PDF)
                    </p>
                  </div>
                </div>
                {attachmentsOpen ? (
                  <ChevronUp className="h-4 w-4 text-text-muted" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-text-muted" />
                )}
              </button>

              {attachmentsOpen && (
                <div className="space-y-3 pt-1">
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    {FILE_CATEGORIES.map((category) => {
                      const filesInCat = queuedFiles.filter((f) => f.category === category);
                      const isDragging = dragCategory === category;

                      return (
                        <div
                          key={category}
                          onDragOver={(e) => {
                            e.preventDefault();
                            setDragCategory(category);
                          }}
                          onDragLeave={() => setDragCategory(null)}
                          onDrop={(e) => {
                            e.preventDefault();
                            setDragCategory(null);
                            addFilesToQueue(Array.from(e.dataTransfer.files), category);
                          }}
                          className={`rounded-lg border border-dashed p-3 transition-colors ${
                            isDragging
                              ? 'border-accent bg-accent-soft'
                              : 'border-border bg-surface'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-medium text-text-primary">
                              {category}
                            </span>
                            <button
                              type="button"
                              onClick={() => fileInputRefs.current[category]?.click()}
                              className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] font-medium hover:bg-bg"
                            >
                              <Upload className="h-3 w-3" />
                              Add
                            </button>
                            <input
                              ref={(el) => {
                                fileInputRefs.current[category] = el;
                              }}
                              type="file"
                              multiple
                              accept="image/jpeg,image/png,image/webp,application/pdf"
                              className="hidden"
                              onChange={(e) => {
                                const list = e.target.files ? Array.from(e.target.files) : [];
                                addFilesToQueue(list, category);
                                e.target.value = '';
                              }}
                            />
                          </div>

                          {filesInCat.length > 0 && (
                            <div className="mt-2 space-y-1.5">
                              {filesInCat.map((item) => (
                                <div
                                  key={item.id}
                                  className="flex items-center justify-between gap-2 rounded border border-border bg-bg px-2 py-1.5"
                                >
                                  <div className="flex items-center gap-2 min-w-0">
                                    {item.previewUrl ? (
                                      <img
                                        src={item.previewUrl}
                                        alt={item.file.name}
                                        className="h-8 w-8 rounded object-cover shrink-0"
                                      />
                                    ) : (
                                      <FileText className="h-6 w-6 text-text-muted shrink-0" />
                                    )}
                                    <div className="min-w-0">
                                      <p className="truncate text-[11px] font-medium text-text-primary">
                                        {item.file.name}
                                      </p>
                                      <p className="text-[10px] text-text-muted">
                                        {formatBytes(item.file.size)}
                                      </p>
                                    </div>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => removeQueuedFile(item.id)}
                                    className="text-text-muted hover:text-error"
                                    aria-label="Remove file"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
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
            </section>
          </div>

          {/* RIGHT COLUMN: STICKY CHECKOUT SUMMARY */}
          <aside className="lg:col-span-5 xl:col-span-4 lg:sticky lg:top-4 space-y-4">
            <div className="rounded-xl border border-border bg-bg p-4 space-y-4 shadow-sm">
              <div className="flex items-center justify-between border-b border-border pb-3">
                <div className="flex items-center gap-2">
                  <ShoppingCart className="h-4 w-4 text-accent" />
                  <h3 className="text-sm font-semibold text-text-primary">Checkout Summary</h3>
                </div>
                <span className="rounded-full bg-surface px-2.5 py-0.5 text-xs font-medium text-text-secondary">
                  {cartGroups.length} {cartGroups.length === 1 ? 'category' : 'categories'} ·{' '}
                  {totalItemCount} {totalItemCount === 1 ? 'unit' : 'units'}
                </span>
              </div>

              {/* Per-category mini bill */}
              {cartGroups.length === 0 ? (
                <p className="text-xs text-text-muted">No items added to cart yet.</p>
              ) : (
                <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
                  {cartGroups.map((g) => (
                    <div key={g.category_name} className="space-y-0.5 text-xs">
                      <div className="flex items-center justify-between font-semibold text-text-primary">
                        <span className="truncate pr-2">{g.category_name}</span>
                        <span className="tabular-nums shrink-0">
                          {formatCurrency(computation.groupTotals[g.category_name] || 0, sym)}
                        </span>
                      </div>
                      <p className="text-[11px] text-text-muted truncate">
                        {g.items
                          .map(
                            (i) =>
                              `${i.item_name || g.category_name}${
                                i.capacity_litres ? ` ${i.capacity_litres}L` : ''
                              } ×${i.quantity}`,
                          )
                          .join(' · ')}
                      </p>
                    </div>
                  ))}
                </div>
              )}

              {/* Totals & Discount */}
              <div className="border-t border-border pt-3 space-y-2.5">
                <div className="flex items-center justify-between text-xs text-text-secondary">
                  <span>Cart Subtotal</span>
                  <span className="font-semibold text-text-primary tabular-nums">
                    {formatCurrency(computation.subtotal, sym)}
                  </span>
                </div>

                {/* Discount controls */}
                <div className="space-y-1.5 rounded-lg border border-border bg-surface p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-text-secondary">Discount</span>
                    <div className="inline-flex rounded border border-border bg-bg p-0.5 text-[11px]">
                      <button
                        type="button"
                        onClick={() => setDiscountType('fixed')}
                        className={`rounded px-2 py-0.5 font-medium ${
                          discountType === 'fixed'
                            ? 'bg-accent text-white'
                            : 'text-text-secondary'
                        }`}
                      >
                        {sym} Fixed
                      </button>
                      <button
                        type="button"
                        onClick={() => setDiscountType('percentage')}
                        className={`rounded px-2 py-0.5 font-medium ${
                          discountType === 'percentage'
                            ? 'bg-accent text-white'
                            : 'text-text-secondary'
                        }`}
                      >
                        % Percent
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min="0"
                      max={discountType === 'percentage' ? '100' : undefined}
                      step="0.01"
                      value={discountValue}
                      onChange={(e) => setDiscountValue(e.target.value)}
                      className="w-full rounded border bg-bg px-2.5 py-1 text-xs text-right tabular-nums"
                      aria-label="Discount value"
                    />
                    <span className="text-xs text-text-muted shrink-0">
                      = -{formatCurrency(computation.discountAmount, sym)}
                    </span>
                  </div>
                  {computation.error && (
                    <p className="text-[11px] text-error">{computation.error}</p>
                  )}
                </div>

                <div className="flex items-center justify-between border-t border-border pt-2.5">
                  <span className="text-sm font-semibold text-text-primary">Grand Total</span>
                  <span className="text-lg font-bold text-text-primary tabular-nums">
                    {formatCurrency(computation.grandTotal, sym)}
                  </span>
                </div>
              </div>

              {/* Payment Status Integration */}
              {!isEdit ? (
                <div className="border-t border-border pt-3 space-y-3">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-text-primary">
                    <Receipt className="h-3.5 w-3.5 text-accent" />
                    <span>Payment at Checkout</span>
                  </div>

                  <div className="grid grid-cols-3 gap-1.5">
                    {(
                      [
                        ['paid', 'Paid in Full'],
                        ['partial', 'Partial'],
                        ['unpaid', 'Unpaid'],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setPaymentChoice(value)}
                        className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                          paymentChoice === value
                            ? 'border-accent bg-accent-soft text-accent'
                            : 'border-border bg-surface text-text-secondary hover:text-text-primary'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {paymentChoice !== 'unpaid' && (
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {paymentChoice === 'partial' && (
                        <div className="sm:col-span-2">
                          <label className="mb-1 block text-[11px] font-medium text-text-secondary">
                            Amount Paid ({sym}) *
                          </label>
                          <input
                            type="number"
                            min="1"
                            step="0.01"
                            value={paidAmount}
                            onChange={(e) => setPaidAmount(e.target.value)}
                            placeholder="Enter received amount"
                            className="w-full rounded-lg border bg-surface px-3 py-1.5 text-xs tabular-nums"
                            required
                          />
                        </div>
                      )}
                      <div>
                        <label className="mb-1 block text-[11px] font-medium text-text-secondary">
                          Method
                        </label>
                        <select
                          value={paymentMethod}
                          onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
                          className="w-full rounded-lg border bg-surface px-2.5 py-1.5 text-xs"
                        >
                          <option value="Cash">Cash</option>
                          <option value="UPI">UPI</option>
                          <option value="Other">Other</option>
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-[11px] font-medium text-text-secondary">
                          Reference #
                        </label>
                        <input
                          type="text"
                          value={txRef}
                          onChange={(e) => setTxRef(e.target.value)}
                          placeholder="UPI / Tx ID"
                          className="w-full rounded-lg border bg-surface px-2.5 py-1.5 text-xs"
                        />
                      </div>
                    </div>
                  )}

                  <div className="flex items-center justify-between rounded-lg bg-surface px-3 py-2 text-xs">
                    <span className="text-text-secondary">Balance Due</span>
                    <span className="font-semibold text-text-primary tabular-nums">
                      {formatCurrency(computedBalance, sym)}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="border-t border-border pt-3 space-y-2 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-text-secondary">Already Recorded Paid</span>
                    <span className="font-semibold text-success tabular-nums">
                      {formatCurrency(existingService?.amount_paid ?? 0, sym)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-text-secondary">Reconciled New Balance</span>
                    <span className="font-semibold text-text-primary tabular-nums">
                      {formatCurrency(computedBalance, sym)}
                    </span>
                  </div>
                  <p className="text-[11px] text-text-muted">
                    Existing payment entries are preserved without duplication. Use the Service
                    Detail page to record additional payments or refunds.
                  </p>
                </div>
              )}

              {/* Actions */}
              <div className="space-y-2 pt-2">
                <button
                  type="submit"
                  disabled={submitting || loadingCartDetails}
                  className="zb-btn-primary w-full rounded-lg px-4 py-2.5 text-xs font-semibold disabled:opacity-50"
                >
                  {submitting
                    ? 'Processing...'
                    : savedServiceForRetry
                    ? 'Retry Failed Attachment Uploads'
                    : isEdit
                    ? `Update Service Cart (${formatCurrency(computation.grandTotal, sym)})`
                    : `Complete Checkout (${formatCurrency(computation.grandTotal, sym)})`}
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="w-full rounded-lg border border-border bg-surface px-4 py-2 text-xs font-medium hover:bg-elevated"
                >
                  Cancel
                </button>
              </div>
            </div>
          </aside>
        </div>
      </form>
    </Modal>
  );
}
