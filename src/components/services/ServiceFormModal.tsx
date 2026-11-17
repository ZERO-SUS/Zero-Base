import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  Bell,
  Camera,
  Check,
  CheckCircle2,
  Cloud,
  CloudOff,
  FileText,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  UserCheck,
  UserPlus,
  XCircle,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { apiFetch, apiFlushKeepalive, ApiError, newIdempotencyKey } from '../../lib/api';
import {
  computeCartTotals,
  getGroupSubtotal,
  groupsFromExisting,
  inferCategoryKind,
  newCartItem,
  resolveServiceCategories,
  toCartPayloadGroups,
  type DraftCartGroup,
  type DraftCartItem,
} from '../../lib/cartPricing';
import {
  clearLocalDraft,
  clearLocalPendingFilesForUser,
  deleteLocalPendingFile,
  loadLocalDraft,
  loadLocalPendingFiles,
  saveLocalDraft,
  saveLocalPendingFile,
  type LocalServiceDraftData,
} from '../../lib/draftStorage';
import {
  addMonthsToIsoDate,
  formatBytes,
  formatCurrency,
  getTodayIstInputDate,
} from '../../lib/format';
import { validateAndPrepareUploadFile } from '../../lib/imageUtils';
import {
  type CategoryKind,
  type Customer,
  type DiscountType,
  type FileCategory,
  type PaymentMethod,
  type ServiceCategoryGroup,
  type ServiceRecord,
} from '../../types/domain';
import { Modal } from '../ui/Modal';

interface AttachmentItem {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  category: FileCategory;
  previewUrl: string | null;
  status: 'uploading' | 'uploaded' | 'failed';
  errorMessage?: string;
  fileObj?: Blob;
  serverFileId?: string;
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

interface ServerDraftFileRow {
  id: string;
  file_name: string;
  mime_type: string;
  file_size: number;
  category: FileCategory;
  upload_status: 'uploading' | 'uploaded' | 'failed';
  error_message?: string | null;
  signed_url?: string | null;
}

interface ServerDraftResponse {
  draft: {
    id: string;
    draft_payload: Partial<LocalServiceDraftData>;
    idempotency_key: string;
    updated_at: string;
  } | null;
  files: ServerDraftFileRow[];
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

const PHOTO_SECTIONS: Array<{
  title: string;
  category: FileCategory;
  buttonLabel: string;
  accept: string;
  allowCamera: boolean;
}> = [
  {
    title: 'BEFORE SERVICE',
    category: 'Before-Service Area Photos',
    buttonLabel: 'Add Photo',
    accept: 'image/jpeg,image/png,image/webp,image/gif,image/*',
    allowCamera: true,
  },
  {
    title: 'AFTER SERVICE',
    category: 'After-Service Area Photos',
    buttonLabel: 'Add Photo',
    accept: 'image/jpeg,image/png,image/webp,image/gif,image/*',
    allowCamera: true,
  },
  {
    title: 'OTHER DOCUMENTS',
    category: 'Other Attachments',
    buttonLabel: 'Add File',
    accept: 'image/jpeg,image/png,image/webp,image/gif,application/pdf,.pdf,image/*',
    allowCamera: false,
  },
];

function unitNoun(kind: CategoryKind, count: number): string {
  if (kind === 'tank') return count === 1 ? 'tank' : 'tanks';
  if (kind === 'sump') return count === 1 ? 'sump' : 'sumps';
  if (kind === 'solar') return count === 1 ? 'panel' : 'panels';
  return count === 1 ? 'item' : 'items';
}

function addItemButtonText(kind: CategoryKind): string {
  if (kind === 'tank') return 'Add Another Tank';
  if (kind === 'sump') return 'Add Another Sump';
  return 'Add Another Item';
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
  const { user, settings } = useAuth();
  const userId = user?.id || 'owner-local';
  const isEdit = Boolean(existingService);
  const sym = settings.currency_symbol || '₹';

  const allCategories = useMemo(() => resolveServiceCategories(settings), [settings]);
  const activeCategories = useMemo(
    () => allCategories.filter((c) => c.active),
    [allCategories],
  );

  // Draft tracking state
  const [draftId, setDraftId] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey());
  const [draftRestoredBanner, setDraftRestoredBanner] = useState(false);
  const [draftSaveStatus, setDraftSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [differentCustomerNotice, setDifferentCustomerNotice] = useState<string | null>(null);
  const draftHydratedRef = useRef(false);
  const ensuringDraftRef = useRef<Promise<string | null> | null>(null);
  const activeDraftIdRef = useRef<string | null>(null);
  activeDraftIdRef.current = draftId;

  // Customer state (both existing & new states preserved across switching)
  const [customerMode, setCustomerMode] = useState<'existing' | 'new'>('existing');
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerResults, setCustomerResults] = useState<Customer[]>([]);
  const [searchingCustomers, setSearchingCustomers] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);

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
  const [description, setDescription] = useState('');
  const [notes, setNotes] = useState('');
  const [editNextDueDate, setEditNextDueDate] = useState('');

  // Dynamic Cart state
  const [cartGroups, setCartGroups] = useState<DraftCartGroup[]>([]);
  const [loadingCartDetails, setLoadingCartDetails] = useState(false);

  // Discount & Payment state
  const [showDiscountBox, setShowDiscountBox] = useState(false);
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

  // Attachments (immediate draft-backed upload)
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  const galleryInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const cameraInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // Submission state
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetToBlankCreate = useCallback(() => {
    const today = getTodayIstInputDate();
    activeDraftIdRef.current = null;
    setDraftId(null);
    setIdempotencyKey(newIdempotencyKey());
    setDraftRestoredBanner(false);
    setDraftSaveStatus('idle');
    setDifferentCustomerNotice(null);

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
    setCartGroups([]);

    setShowDiscountBox(false);
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
    setAttachments([]);
  }, [fixedCustomer, settings.default_reminder_months]);

  const applyDraftSnapshot = useCallback(
    (snap: Partial<LocalServiceDraftData>, srvDraftId: string | null, srvIdempKey?: string) => {
      const today = getTodayIstInputDate();
      setDraftId(srvDraftId ?? snap.draftId ?? null);
      setIdempotencyKey(srvIdempKey || snap.idempotencyKey || newIdempotencyKey());

      setCustomerMode(snap.customerMode === 'new' ? 'new' : 'existing');
      setSelectedCustomer(snap.selectedCustomer ?? fixedCustomer ?? null);
      setNewFullName(snap.newCustomer?.full_name ?? '');
      setNewPhone(snap.newCustomer?.phone_number ?? '');
      setNewAltPhone(snap.newCustomer?.alternate_phone ?? '');
      setNewAddress(snap.newCustomer?.address ?? '');
      setNewArea(snap.newCustomer?.area ?? '');
      setNewCustomerNotes(snap.newCustomer?.notes ?? '');
      setAllowDuplicate(Boolean(snap.newCustomer?.allow_duplicate));

      setServiceDate(snap.serviceDate || today);
      setDescription(snap.description ?? '');
      setNotes(snap.notes ?? '');
      setCartGroups(Array.isArray(snap.cartGroups) ? snap.cartGroups : []);

      const discVal = snap.discountValue ?? '0';
      setDiscountType(snap.discountType === 'percentage' ? 'percentage' : 'fixed');
      setDiscountValue(discVal);
      setShowDiscountBox(Number(discVal || 0) > 0);

      setPaymentChoice(
        snap.paymentChoice === 'paid' || snap.paymentChoice === 'partial'
          ? snap.paymentChoice
          : 'unpaid'
      );
      setPaidAmount(snap.paidAmount ?? '');
      setPaymentMethod(snap.paymentMethod ?? 'Cash');
      setTxRef(snap.txRef ?? '');

      setReminderEnabled(Boolean(snap.reminderEnabled));
      setReminderDate(
        snap.reminderDate || addMonthsToIsoDate(today, settings.default_reminder_months || 6)
      );
      setReminderType(snap.reminderType ?? 'service_due');
      setReminderNotes(snap.reminderNotes ?? '');
    },
    [fixedCustomer, settings.default_reminder_months]
  );

  // Load either Existing Service (Edit mode) OR Restore Saved Draft (Create mode)
  useEffect(() => {
    if (!open) {
      draftHydratedRef.current = false;
      return;
    }

    let cancelled = false;
    setError(null);
    setSubmitting(false);

    if (existingService) {
      draftHydratedRef.current = true;
      setDraftRestoredBanner(false);
      setDifferentCustomerNotice(null);
      setServiceDate(existingService.service_date);
      setDescription(existingService.description ?? '');
      setEditNextDueDate(existingService.next_due_date ?? '');
      setNotes(existingService.notes ?? '');
      setDiscountType(existingService.discount_type ?? 'fixed');
      const dv = String(existingService.discount_value ?? existingService.discount ?? 0);
      setDiscountValue(dv);
      setShowDiscountBox(Number(dv || 0) > 0);
      setPaymentChoice('unpaid');
      setReminderEnabled(false);
      setAttachments([]);

      if (existingGroups && existingGroups.length > 0) {
        setCartGroups(groupsFromExisting(existingGroups, allCategories));
      } else {
        setLoadingCartDetails(true);
        void apiFetch<{ category_groups?: ServiceCategoryGroup[] }>(
          `/api/services/${existingService.id}`
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
              setError("Couldn't load the saved details for this service.");
            }
          })
          .finally(() => {
            if (!cancelled) setLoadingCartDetails(false);
          });
      }

      return () => {
        cancelled = true;
      };
    }

    // Create Mode: Restore automatic draft from local cache + server + IndexedDB
    draftHydratedRef.current = false;
    resetToBlankCreate();

    const restore = async () => {
      const localDraft = loadLocalDraft(userId);
      const localPending = await loadLocalPendingFiles(userId);

      let serverRes: ServerDraftResponse | null = null;
      try {
        serverRes = await apiFetch<ServerDraftResponse>('/api/drafts/active');
      } catch {
        // Offline or transient API error: fall back smoothly to localDraft
      }

      if (cancelled) return;

      const serverDraft = serverRes?.draft ?? null;
      const serverFiles = serverRes?.files ?? [];

      const hasMeaningfulLocal =
        localDraft &&
        (Boolean(localDraft.selectedCustomer) ||
          Boolean(localDraft.newCustomer?.full_name) ||
          Boolean(localDraft.newCustomer?.phone_number) ||
          (localDraft.cartGroups && localDraft.cartGroups.length > 0) ||
          Boolean(localDraft.notes) ||
          localPending.length > 0);

      const serverPayload = serverDraft?.draft_payload as Partial<LocalServiceDraftData> | undefined;
      const hasMeaningfulServer =
        Boolean(serverDraft) &&
        (Boolean(serverPayload?.selectedCustomer) ||
          Boolean(serverPayload?.newCustomer?.full_name) ||
          Boolean(serverPayload?.newCustomer?.phone_number) ||
          (serverPayload?.cartGroups && serverPayload.cartGroups.length > 0) ||
          Boolean(serverPayload?.notes) ||
          serverFiles.length > 0);

      if (hasMeaningfulServer || hasMeaningfulLocal) {
        let chosenSnap: Partial<LocalServiceDraftData> | null = null;
        if (hasMeaningfulLocal && hasMeaningfulServer && localDraft && serverDraft) {
          chosenSnap =
            (localDraft.updatedAt || '') > (serverDraft.updated_at || '')
              ? localDraft
              : serverPayload!;
        } else if (hasMeaningfulLocal && localDraft) {
          chosenSnap = localDraft;
        } else if (hasMeaningfulServer && serverPayload) {
          chosenSnap = serverPayload;
        }

        if (chosenSnap) {
          // If opened directly on a specific customer's profile and draft belongs to another customer,
          // let user choose without silently wiping their saved draft
          if (
            fixedCustomer &&
            chosenSnap.selectedCustomer &&
            chosenSnap.selectedCustomer.id !== fixedCustomer.id
          ) {
            setDifferentCustomerNotice(
              `You have an unfinished service saved for ${chosenSnap.selectedCustomer.full_name}.`
            );
          }
          applyDraftSnapshot(
            chosenSnap,
            serverDraft?.id ?? localDraft?.draftId ?? null,
            serverDraft?.idempotency_key ?? localDraft?.idempotencyKey
          );
          setDraftRestoredBanner(true);
          setDraftSaveStatus('saved');
        }

        // Rebuild attachment list from server uploaded files + any local failed/interrupted IndexedDB files
        const mergedAttachments: AttachmentItem[] = [];
        for (const sf of serverFiles) {
          mergedAttachments.push({
            id: sf.id,
            serverFileId: sf.id,
            fileName: sf.file_name,
            fileSize: sf.file_size,
            mimeType: sf.mime_type,
            category: sf.category,
            previewUrl: sf.signed_url ?? null,
            status: 'uploaded',
          });
        }
        for (const lf of localPending) {
          const isImg = lf.mimeType.startsWith('image/');
          mergedAttachments.push({
            id: lf.id,
            fileName: lf.fileName,
            fileSize: lf.fileSize,
            mimeType: lf.mimeType,
            category: lf.category,
            previewUrl: isImg ? URL.createObjectURL(lf.blob) : null,
            status: 'failed',
            errorMessage:
              lf.errorMessage || "Upload didn't finish. Tap Retry to upload this file.",
            fileObj: lf.blob,
          });
        }
        if (mergedAttachments.length > 0) {
          setAttachments(mergedAttachments);
          setDraftRestoredBanner(true);
        }
      }

      draftHydratedRef.current = true;
    };

    void restore();

    return () => {
      cancelled = true;
    };
  }, [
    open,
    existingService,
    existingGroups,
    fixedCustomer,
    userId,
    allCategories,
    resetToBlankCreate,
    applyDraftSnapshot,
  ]);

  // Build current draft payload snapshot
  const currentDraftPayload = useMemo<LocalServiceDraftData>(
    () => ({
      draftId,
      idempotencyKey,
      updatedAt: new Date().toISOString(),
      fixedCustomerId: fixedCustomer?.id ?? null,
      customerMode,
      selectedCustomer,
      newCustomer: {
        full_name: newFullName,
        phone_number: newPhone,
        alternate_phone: newAltPhone,
        address: newAddress,
        area: newArea,
        notes: newCustomerNotes,
        allow_duplicate: allowDuplicate,
      },
      serviceDate,
      description,
      notes,
      cartGroups,
      discountType,
      discountValue,
      paymentChoice,
      paidAmount,
      paymentMethod,
      txRef,
      reminderEnabled,
      reminderDate,
      reminderType,
      reminderNotes,
    }),
    [
      draftId,
      idempotencyKey,
      fixedCustomer?.id,
      customerMode,
      selectedCustomer,
      newFullName,
      newPhone,
      newAltPhone,
      newAddress,
      newArea,
      newCustomerNotes,
      allowDuplicate,
      serviceDate,
      description,
      notes,
      cartGroups,
      discountType,
      discountValue,
      paymentChoice,
      paidAmount,
      paymentMethod,
      txRef,
      reminderEnabled,
      reminderDate,
      reminderType,
      reminderNotes,
    ]
  );

  const latestPayloadRef = useRef(currentDraftPayload);
  latestPayloadRef.current = currentDraftPayload;

  const hasDraftContent = useMemo(
    () =>
      Boolean(selectedCustomer) ||
      Boolean(newFullName.trim()) ||
      Boolean(newPhone.trim()) ||
      Boolean(newAddress.trim()) ||
      cartGroups.length > 0 ||
      Boolean(notes.trim()) ||
      attachments.length > 0,
    [selectedCustomer, newFullName, newPhone, newAddress, cartGroups.length, notes, attachments.length]
  );

  const syncDraftToServer = useCallback(
    async (payloadToSave: LocalServiceDraftData): Promise<string | null> => {
      setDraftSaveStatus('saving');
      try {
        const res = await apiFetch<{ draft: { id: string } }>('/api/drafts/active', {
          method: 'PUT',
          body: JSON.stringify({
            draft_payload: payloadToSave,
            idempotency_key: payloadToSave.idempotencyKey,
          }),
        });
        const newId = res.draft?.id ?? null;
        if (newId && newId !== payloadToSave.draftId) {
          activeDraftIdRef.current = newId;
          setDraftId(newId);
        }
        setDraftSaveStatus('saved');
        return newId;
      } catch {
        setDraftSaveStatus('error');
        return null;
      }
    },
    []
  );

  // Automatic local + debounced server draft persistence in Create mode
  useEffect(() => {
    if (!open || isEdit || !draftHydratedRef.current) return;
    if (!hasDraftContent && !draftId) return;

    saveLocalDraft(userId, currentDraftPayload);
    setDraftSaveStatus('saving');

    const timer = window.setTimeout(() => {
      void syncDraftToServer(currentDraftPayload);
    }, 600);

    return () => window.clearTimeout(timer);
  }, [open, isEdit, hasDraftContent, draftId, userId, currentDraftPayload, syncDraftToServer]);

  // Flush draft best-effort on page close / refresh / tab switch
  useEffect(() => {
    if (!open || isEdit) return;
    const handleFlush = () => {
      if (!draftHydratedRef.current) return;
      const snap = latestPayloadRef.current;
      saveLocalDraft(userId, snap);
      apiFlushKeepalive('/api/drafts/active', 'PUT', {
        draft_payload: snap,
        idempotency_key: snap.idempotencyKey,
      });
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') handleFlush();
    };

    window.addEventListener('pagehide', handleFlush);
    window.addEventListener('beforeunload', handleFlush);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      handleFlush();
      window.removeEventListener('pagehide', handleFlush);
      window.removeEventListener('beforeunload', handleFlush);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [open, isEdit, userId]);

  const ensureActiveDraftId = useCallback(async (): Promise<string | null> => {
    if (activeDraftIdRef.current) return activeDraftIdRef.current;
    if (ensuringDraftRef.current) return ensuringDraftRef.current;

    const promise = (async () => {
      const snap = latestPayloadRef.current;
      saveLocalDraft(userId, snap);
      const id = await syncDraftToServer(snap);
      if (id) activeDraftIdRef.current = id;
      ensuringDraftRef.current = null;
      return id;
    })();
    ensuringDraftRef.current = promise;
    return promise;
  }, [userId, syncDraftToServer]);

  // Cleanup object URLs on unmount
  useEffect(() => {
    return () => {
      for (const a of attachments) {
        if (a.previewUrl && a.previewUrl.startsWith('blob:')) {
          URL.revokeObjectURL(a.previewUrl);
        }
      }
    };
  }, [attachments]);

  // Existing customer live search
  useEffect(() => {
    if (!open || isEdit || customerMode !== 'existing') return;
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
        // Non-blocking
      } finally {
        setSearchingCustomers(false);
      }
    }, 250);

    return () => window.clearTimeout(timer);
  }, [customerSearch, open, isEdit, customerMode]);

  // Live duplicate customer check
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
        // Non-blocking
      }
    }, 300);

    return () => window.clearTimeout(timer);
  }, [newPhone, newAltPhone, newFullName, newAddress, customerMode, open, isEdit]);

  // Totals
  const computation = useMemo(
    () => computeCartTotals(cartGroups, discountType, discountValue),
    [cartGroups, discountType, discountValue]
  );

  const remainingAmount = useMemo(() => {
    if (isEdit && existingService) {
      return Math.max(0, computation.grandTotal - Number(existingService.amount_paid || 0));
    }
    if (paymentChoice === 'paid') return 0;
    if (paymentChoice === 'unpaid') return computation.grandTotal;
    const paid = Math.max(0, Number(paidAmount) || 0);
    return Math.max(0, computation.grandTotal - paid);
  }, [isEdit, existingService, paymentChoice, paidAmount, computation.grandTotal]);

  // Dynamic checkbox menu options (active settings + any inactive historical category in cart)
  const checkboxCategories = useMemo(() => {
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

  // Category & Cart operations
  const handleToggleCategoryCheckbox = (catName: string, kind: CategoryKind) => {
    const exists = cartGroups.some(
      (g) => g.category_name.toLowerCase() === catName.toLowerCase()
    );
    if (exists) {
      setCartGroups((prev) =>
        prev.filter((g) => g.category_name.toLowerCase() !== catName.toLowerCase())
      );
      return;
    }
    setCartGroups((prev) => [
      ...prev,
      {
        category_name: catName,
        kind,
        pricing_mode: 'itemized',
        category_subtotal: '',
        items: [newCartItem(kind, 0)],
      },
    ]);
  };

  // Tank/Sump count stepper ("How many tanks? [-] N [+]")
  const handleSetEntryCount = (categoryName: string, targetCount: number) => {
    const clamped = Math.max(1, Math.min(50, targetCount));
    setCartGroups((prev) =>
      prev.map((g) => {
        if (g.category_name !== categoryName) return g;
        if (clamped === g.items.length) return g;
        if (clamped < g.items.length) {
          return { ...g, items: g.items.slice(0, clamped) };
        }
        const nextItems = [...g.items];
        while (nextItems.length < clamped) {
          nextItems.push(newCartItem(g.kind, nextItems.length));
        }
        return { ...g, items: nextItems };
      })
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
      })
    );
  };

  const handleRemoveItem = (categoryName: string, itemUid: string) => {
    setCartGroups((prev) =>
      prev
        .map((g) => {
          if (g.category_name !== categoryName) return g;
          return { ...g, items: g.items.filter((i) => i.uid !== itemUid) };
        })
        .filter((g) => g.items.length > 0)
    );
  };

  const handleUpdateItem = (
    categoryName: string,
    itemUid: string,
    patch: Partial<DraftCartItem>
  ) => {
    setCartGroups((prev) =>
      prev.map((g) => {
        if (g.category_name !== categoryName) return g;
        return {
          ...g,
          items: g.items.map((i) => (i.uid === itemUid ? { ...i, ...patch } : i)),
        };
      })
    );
  };

  const handleToggleCombinedPrice = (categoryName: string, combined: boolean) => {
    setCartGroups((prev) =>
      prev.map((g) => {
        if (g.category_name !== categoryName) return g;
        if (combined) {
          const sum = getGroupSubtotal(g);
          return {
            ...g,
            pricing_mode: 'category_total',
            category_subtotal: g.category_subtotal || (sum > 0 ? String(sum) : ''),
          };
        }
        return { ...g, pricing_mode: 'itemized' };
      })
    );
  };

  const handleCombinedAmountChange = (categoryName: string, val: string) => {
    setCartGroups((prev) =>
      prev.map((g) => (g.category_name === categoryName ? { ...g, category_subtotal: val } : g))
    );
  };

  // Immediate draft-backed photo/document upload
  const uploadAttachmentItem = async (item: AttachmentItem) => {
    const blobToUpload = item.fileObj;
    if (!blobToUpload) return;

    setAttachments((prev) =>
      prev.map((a) =>
        a.id === item.id ? { ...a, status: 'uploading', errorMessage: undefined } : a
      )
    );

    if (!isEdit) {
      await saveLocalPendingFile({
        id: item.id,
        userId,
        category: item.category,
        fileName: item.fileName,
        mimeType: item.mimeType,
        fileSize: item.fileSize,
        status: 'uploading',
        blob: blobToUpload,
        createdAt: new Date().toISOString(),
      });
    }

    try {
      const fileForForm =
        blobToUpload instanceof File
          ? blobToUpload
          : new File([blobToUpload], item.fileName, { type: item.mimeType });

      if (isEdit && existingService) {
        const form = new FormData();
        form.append('file', fileForForm);
        form.append('service_id', existingService.id);
        form.append('category', item.category);
        const res = await apiFetch<{ file: { id: string; signed_url?: string | null } }>(
          '/api/files/upload',
          {
            method: 'POST',
            body: form,
          }
        );
        setAttachments((prev) =>
          prev.map((a) =>
            a.id === item.id
              ? {
                  ...a,
                  status: 'uploaded',
                  serverFileId: res.file.id,
                  previewUrl: res.file.signed_url ?? a.previewUrl,
                  errorMessage: undefined,
                }
              : a
          )
        );
      } else {
        const activeDraftId = await ensureActiveDraftId();
        if (!activeDraftId) {
          throw new Error("Photo couldn't be uploaded because saving didn't respond. Please tap Retry.");
        }
        const form = new FormData();
        form.append('file', fileForForm);
        form.append('category', item.category);

        const res = await apiFetch<{ file: { id: string; signed_url?: string | null } }>(
          `/api/drafts/${activeDraftId}/files`,
          {
            method: 'POST',
            body: form,
          }
        );

        await deleteLocalPendingFile(item.id);
        setAttachments((prev) =>
          prev.map((a) =>
            a.id === item.id
              ? {
                  ...a,
                  status: 'uploaded',
                  serverFileId: res.file.id,
                  previewUrl: res.file.signed_url ?? a.previewUrl,
                  errorMessage: undefined,
                }
              : a
          )
        );
      }
    } catch (err) {
      const msg =
        err instanceof ApiError || (err instanceof Error && err.message)
          ? err.message
          : "Photo couldn't be uploaded. Please check your connection and tap Retry.";
      if (!isEdit) {
        await saveLocalPendingFile({
          id: item.id,
          userId,
          category: item.category,
          fileName: item.fileName,
          mimeType: item.mimeType,
          fileSize: item.fileSize,
          status: 'failed',
          errorMessage: msg,
          blob: blobToUpload,
          createdAt: new Date().toISOString(),
        });
      }
      setAttachments((prev) =>
        prev.map((a) =>
          a.id === item.id ? { ...a, status: 'failed', errorMessage: msg } : a
        )
      );
    }
  };

  const handleSelectFiles = async (rawFiles: File[], category: FileCategory) => {
    if (rawFiles.length === 0) return;
    setError(null);

    const preparedList: AttachmentItem[] = [];
    for (const raw of rawFiles) {
      const prep = await validateAndPrepareUploadFile(raw);
      if (!prep.ok) {
        setError(prep.error);
        continue;
      }
      const isImg = prep.mime.startsWith('image/');
      preparedList.push({
        id: crypto.randomUUID(),
        fileName: prep.file.name,
        fileSize: prep.file.size,
        mimeType: prep.mime,
        category,
        previewUrl: isImg ? URL.createObjectURL(prep.file) : null,
        status: 'uploading',
        fileObj: prep.file,
      });
    }

    if (preparedList.length === 0) return;
    setAttachments((prev) => [...prev, ...preparedList]);

    // Upload each file independently so one failure never interrupts others
    for (const item of preparedList) {
      await uploadAttachmentItem(item);
    }
  };

  const handleRemoveAttachment = async (item: AttachmentItem) => {
    if (item.previewUrl && item.previewUrl.startsWith('blob:')) {
      URL.revokeObjectURL(item.previewUrl);
    }
    setAttachments((prev) => prev.filter((a) => a.id !== item.id));
    await deleteLocalPendingFile(item.id);

    if (item.serverFileId) {
      try {
        const effectiveDraftId = activeDraftIdRef.current || draftId;
        if (isEdit) {
          await apiFetch(`/api/files/${item.serverFileId}`, { method: 'DELETE' });
        } else if (effectiveDraftId) {
          await apiFetch(`/api/drafts/${effectiveDraftId}/files/${item.serverFileId}`, {
            method: 'DELETE',
          });
        }
      } catch {
        // Already removed from UI
      }
    }
  };

  const handleDiscardDraft = async () => {
    setError(null);
    const idToDelete = draftId;
    clearLocalDraft(userId);
    await clearLocalPendingFilesForUser(userId);
    resetToBlankCreate();
    if (idToDelete) {
      try {
        await apiFetch(`/api/drafts/${idToDelete}`, { method: 'DELETE' });
      } catch {
        // Local cleanup already succeeded
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);

    // Prevent saving while uploads are still in flight
    const uploadingNow = attachments.some((a) => a.status === 'uploading');
    if (uploadingNow) {
      setError('Please wait a few seconds while your photos finish uploading.');
      return;
    }

    const failedNow = attachments.some((a) => a.status === 'failed');
    if (failedNow) {
      setError(
        'One or more photos failed to upload. Tap Retry on the failed photo or remove it before saving.'
      );
      return;
    }

    if (cartGroups.length === 0) {
      setError('Please choose at least one type of work done.');
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
          }
        );
        onSaved(res.service);
        onClose();
      } catch (err) {
        setError(
          err instanceof ApiError
            ? err.message
            : "Your changes couldn't be saved. Please try again."
        );
      } finally {
        setSubmitting(false);
      }
      return;
    }

    // Validate customer details
    if (customerMode === 'existing' && !selectedCustomer) {
      setError('Please search and choose an existing customer, or switch to New Customer.');
      return;
    }
    if (customerMode === 'new') {
      if (!newFullName.trim() || !newPhone.trim() || !newAddress.trim()) {
        setError('Some customer information is missing. Please enter Name, Phone, and Address.');
        return;
      }
      if (duplicates.length > 0 && !allowDuplicate) {
        setError(
          'A customer with this phone already exists. Tap "Use This Customer" or confirm creating a separate record.'
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
        setError('Please enter how much money was received.');
        return;
      }
      if (amt > computation.grandTotal) {
        setError('Amount received cannot be more than the Total Amount.');
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
      setError('Please choose a reminder date or turn off Next Service Reminder.');
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
          draft_id: activeDraftIdRef.current || draftId,
          initial_payment: initialPayPayload,
          reminder: {
            enabled: reminderEnabled,
            due_date: reminderEnabled ? reminderDate : null,
            reminder_type: reminderType,
            notes: reminderEnabled ? reminderNotes.trim() || null : null,
          },
        }),
      });

      // Clear local draft & local file blobs cleanly once service is persisted
      clearLocalDraft(userId);
      await clearLocalPendingFilesForUser(userId);
      onSaved(res.service, res.customer);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'DUPLICATE_CUSTOMER_PHONE') {
        const details = err.details as { duplicates?: DuplicateCandidate[] } | undefined;
        setDuplicates(details?.duplicates ?? []);
        setError('A customer with this phone number already exists.');
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Your service couldn't be saved right now. Please try again — your draft is safe.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit Service' : 'Add Service'}
      subtitle={
        isEdit
          ? 'Update the work done or bill details. Past payments stay safe.'
          : 'Your progress saves automatically as you type.'
      }
      maxWidthClass="max-w-5xl"
    >
      <form onSubmit={handleSubmit} className="space-y-6 overflow-x-hidden pb-4">
        {/* Draft Status & Recovery Banner (Create Mode) */}
        {!isEdit && (draftRestoredBanner || draftSaveStatus !== 'idle') && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-bg px-4 py-2.5 text-xs">
            <div className="flex items-center gap-2 min-w-0">
              {draftSaveStatus === 'saving' && (
                <span className="inline-flex items-center gap-1.5 font-medium text-accent">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Saving...
                </span>
              )}
              {draftSaveStatus === 'saved' && (
                <span className="inline-flex items-center gap-1.5 font-medium text-success">
                  <Cloud className="h-3.5 w-3.5" />
                  Saved
                </span>
              )}
              {draftSaveStatus === 'error' && (
                <button
                  type="button"
                  onClick={() => void syncDraftToServer(currentDraftPayload)}
                  className="inline-flex items-center gap-1.5 font-medium text-warning hover:underline"
                >
                  <CloudOff className="h-3.5 w-3.5" />
                  Couldn&apos;t save — Retry
                </button>
              )}
              {draftRestoredBanner && (
                <span className="text-text-secondary">
                  • Unfinished entry restored automatically
                </span>
              )}
            </div>

            {(draftRestoredBanner || hasDraftContent) && (
              <button
                type="button"
                onClick={() => void handleDiscardDraft()}
                className="inline-flex items-center gap-1 rounded-lg border border-border bg-surface px-2.5 py-1 text-xs font-medium text-text-secondary hover:text-error"
              >
                <RotateCcw className="h-3 w-3" />
                Start Fresh
              </button>
            )}
          </div>
        )}

        {differentCustomerNotice && !isEdit && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-xs">
            <span className="font-medium text-text-primary">{differentCustomerNotice}</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setDifferentCustomerNotice(null)}
                className="rounded-lg border border-border bg-surface px-3 py-1.5 font-medium"
              >
                Continue Saved Draft
              </button>
              {fixedCustomer && (
                <button
                  type="button"
                  onClick={async () => {
                    await handleDiscardDraft();
                    setSelectedCustomer(fixedCustomer);
                    setCustomerMode('existing');
                  }}
                  className="rounded-lg bg-accent px-3 py-1.5 font-medium text-white"
                >
                  Start New for {fixedCustomer.full_name}
                </button>
              )}
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-error/40 bg-error/10 px-4 py-3 text-sm font-medium text-error">
            {error}
          </div>
        )}

        {/* 1. CHOOSE CUSTOMER */}
        {!isEdit && (
          <section className="rounded-xl border border-border bg-bg p-4 sm:p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-text-primary">1. Customer</h3>
                <p className="text-xs text-text-secondary">
                  Pick an existing customer or enter a new customer.
                </p>
              </div>
              <div className="inline-flex rounded-xl border border-border bg-surface p-1 text-xs font-semibold">
                <button
                  type="button"
                  onClick={() => setCustomerMode('existing')}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 transition-colors ${
                    customerMode === 'existing'
                      ? 'bg-accent text-white'
                      : 'text-text-secondary hover:text-text-primary'
                  }`}
                >
                  <UserCheck className="h-4 w-4" />
                  Existing Customer
                </button>
                <button
                  type="button"
                  onClick={() => setCustomerMode('new')}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 transition-colors ${
                    customerMode === 'new'
                      ? 'bg-accent text-white'
                      : 'text-text-secondary hover:text-text-primary'
                  }`}
                >
                  <UserPlus className="h-4 w-4" />
                  New Customer
                </button>
              </div>
            </div>

            {customerMode === 'existing' ? (
              <div className="space-y-3">
                {selectedCustomer ? (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border-2 border-accent/40 bg-surface px-4 py-3">
                    <div>
                      <p className="text-sm font-semibold text-text-primary">
                        {selectedCustomer.full_name}
                      </p>
                      <p className="text-xs text-text-secondary">
                        {selectedCustomer.phone_number}
                        {selectedCustomer.address ? ` • ${selectedCustomer.address}` : ''}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedCustomer(null)}
                      className="rounded-lg border border-border bg-bg px-3 py-1.5 text-xs font-semibold text-accent hover:bg-elevated"
                    >
                      Change Customer
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-3.5 top-3 h-4 w-4 text-text-muted" />
                      <input
                        type="text"
                        value={customerSearch}
                        onChange={(e) => setCustomerSearch(e.target.value)}
                        placeholder="Type customer name or phone number..."
                        className="w-full rounded-xl border bg-surface py-2.5 pl-10 pr-4 text-sm"
                      />
                    </div>
                    {searchingCustomers && (
                      <p className="text-xs text-text-muted">Looking up customers...</p>
                    )}
                    {customerResults.length > 0 && (
                      <div className="max-h-52 overflow-y-auto divide-y divide-border rounded-xl border border-border bg-surface">
                        {customerResults.map((cust) => (
                          <button
                            key={cust.id}
                            type="button"
                            onClick={() => {
                              setSelectedCustomer(cust);
                              setCustomerResults([]);
                            }}
                            className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-bg"
                          >
                            <div>
                              <p className="text-sm font-semibold text-text-primary">
                                {cust.full_name}
                              </p>
                              <p className="text-xs text-text-secondary">
                                {cust.phone_number} • {cust.address}
                              </p>
                            </div>
                            <span className="text-xs font-medium text-accent">Select</span>
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
                    <label className="mb-1 block text-xs font-semibold text-text-secondary">
                      Customer Name *
                    </label>
                    <input
                      type="text"
                      value={newFullName}
                      onChange={(e) => setNewFullName(e.target.value)}
                      placeholder="e.g. Rajesh Kumar"
                      className="w-full rounded-xl border bg-surface px-3.5 py-2.5 text-sm"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-text-secondary">
                      Phone Number *
                    </label>
                    <input
                      type="tel"
                      value={newPhone}
                      onChange={(e) => setNewPhone(e.target.value)}
                      placeholder="e.g. 9876543210"
                      className="w-full rounded-xl border bg-surface px-3.5 py-2.5 text-sm"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-text-secondary">
                      Second Phone (Optional)
                    </label>
                    <input
                      type="tel"
                      value={newAltPhone}
                      onChange={(e) => setNewAltPhone(e.target.value)}
                      placeholder="Optional"
                      className="w-full rounded-xl border bg-surface px-3.5 py-2.5 text-sm"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-text-secondary">
                      Area / Locality (Optional)
                    </label>
                    <input
                      type="text"
                      value={newArea}
                      onChange={(e) => setNewArea(e.target.value)}
                      placeholder="e.g. Indiranagar"
                      className="w-full rounded-xl border bg-surface px-3.5 py-2.5 text-sm"
                    />
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-text-secondary">
                    Address *
                  </label>
                  <textarea
                    rows={2}
                    value={newAddress}
                    onChange={(e) => setNewAddress(e.target.value)}
                    placeholder="House/Flat no., Street, Landmark"
                    className="w-full rounded-xl border bg-surface px-3.5 py-2.5 text-sm"
                  />
                </div>

                {duplicates.length > 0 && (
                  <div className="rounded-xl border border-warning/40 bg-warning/10 p-3.5 space-y-2">
                    <div className="flex items-start gap-2 text-xs text-warning">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <div>
                        <p className="font-semibold">Customer already exists</p>
                        <p className="text-text-secondary">
                          Tap &quot;Use This Customer&quot; to avoid creating a duplicate entry.
                        </p>
                      </div>
                    </div>
                    <div className="space-y-2">
                      {duplicates.map((dup) => (
                        <div
                          key={dup.id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs"
                        >
                          <div>
                            <span className="font-semibold text-text-primary">
                              {dup.full_name}
                            </span>{' '}
                            • {dup.phone_number}
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
                              className="rounded-lg bg-accent px-3 py-1.5 text-white font-semibold"
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
                              View <ArrowUpRight className="h-3 w-3" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                    <label className="flex items-center gap-2 pt-1 text-xs font-medium text-text-primary">
                      <input
                        type="checkbox"
                        checked={allowDuplicate}
                        onChange={(e) => setAllowDuplicate(e.target.checked)}
                      />
                      Save as a new customer anyway
                    </label>
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {/* 2. CHOOSE THE WORK DONE (Simple Checkboxes) */}
        <section className="rounded-xl border border-border bg-bg p-4 sm:p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-text-primary uppercase tracking-wide">
                {isEdit ? '1. Work Done' : '2. Choose the Work Done'}
              </h3>
              <p className="text-xs text-text-secondary">
                Tap to tick everything done during this visit.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs font-semibold text-text-secondary">Date:</label>
              <input
                type="date"
                value={serviceDate}
                onChange={(e) => setServiceDate(e.target.value)}
                className="rounded-lg border bg-surface px-3 py-2 text-xs font-medium"
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {checkboxCategories.map((cat) => {
              const checked = cartGroups.some(
                (g) => g.category_name.toLowerCase() === cat.name.toLowerCase()
              );
              return (
                <button
                  key={cat.name}
                  type="button"
                  onClick={() => handleToggleCategoryCheckbox(cat.name, cat.kind)}
                  className={`flex items-center gap-3 rounded-xl border-2 px-4 py-3.5 text-left transition-colors ${
                    checked
                      ? 'border-accent bg-accent-soft text-text-primary'
                      : 'border-border bg-surface text-text-primary hover:border-accent/50'
                  }`}
                >
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2 ${
                      checked
                        ? 'border-accent bg-accent text-white'
                        : 'border-text-muted/50 bg-bg'
                    }`}
                  >
                    {checked && <Check className="h-4 w-4 stroke-[3]" />}
                  </span>
                  <span className="text-sm font-semibold leading-snug">{cat.name}</span>
                </button>
              );
            })}
          </div>
        </section>

        {/* 3. ENTER WORK DETAILS */}
        {loadingCartDetails ? (
          <div className="rounded-xl border border-border bg-bg p-6 text-center text-sm text-text-muted">
            Loading service details...
          </div>
        ) : cartGroups.length > 0 ? (
          <section className="space-y-4">
            <h3 className="text-base font-semibold text-text-primary">
              {isEdit ? '2. Work Details & Prices' : '3. Enter Work Details'}
            </h3>

            {cartGroups.map((group) => {
              const isTankOrSump = group.kind === 'tank' || group.kind === 'sump';
              const isSolar = group.kind === 'solar';
              const isCombined = group.pricing_mode === 'category_total';
              const catTotal = getGroupSubtotal(group);

              return (
                <div
                  key={group.category_name}
                  ref={(el) => {
                    sectionRefs.current[group.category_name] = el;
                  }}
                  className="rounded-xl border border-border bg-bg p-4 sm:p-5 space-y-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
                    <h4 className="text-base font-bold text-text-primary">{group.category_name}</h4>
                    <span className="text-base font-bold text-accent tabular-nums">
                      Total: {formatCurrency(catTotal, sym)}
                    </span>
                  </div>

                  {/* Tank / Sump: "How many tanks? [ − ] 2 [ + ]" */}
                  {isTankOrSump && (
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3">
                      <span className="text-sm font-semibold text-text-primary">
                        {group.kind === 'sump' ? 'How many sumps?' : 'How many tanks?'}
                      </span>
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() =>
                            handleSetEntryCount(group.category_name, group.items.length - 1)
                          }
                          disabled={group.items.length <= 1}
                          className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-bg text-text-primary hover:bg-elevated disabled:opacity-40"
                          aria-label="Decrease count"
                        >
                          <Minus className="h-4 w-4" />
                        </button>
                        <span className="min-w-[2rem] text-center text-base font-bold tabular-nums">
                          {group.items.length}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            handleSetEntryCount(group.category_name, group.items.length + 1)
                          }
                          className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-bg text-text-primary hover:bg-elevated"
                          aria-label="Increase count"
                        >
                          <Plus className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Simple combined price option (plain English, no technical terms) */}
                  <label className="inline-flex cursor-pointer items-center gap-2.5 text-xs font-medium text-text-secondary">
                    <input
                      type="checkbox"
                      checked={isCombined}
                      onChange={(e) =>
                        handleToggleCombinedPrice(group.category_name, e.target.checked)
                      }
                    />
                    Enter one combined price for all {group.category_name} instead of separate prices
                  </label>

                  {isCombined && (
                    <div className="rounded-xl border border-accent/40 bg-accent-soft/40 p-3.5 flex flex-wrap items-center justify-between gap-3">
                      <label className="text-sm font-semibold text-text-primary">
                        Total Price for {group.category_name} ({sym})
                      </label>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={group.category_subtotal}
                        onChange={(e) =>
                          handleCombinedAmountChange(group.category_name, e.target.value)
                        }
                        placeholder="0"
                        className="w-36 rounded-xl border bg-surface px-3.5 py-2 text-base font-bold text-right tabular-nums"
                      />
                    </div>
                  )}

                  {/* Individual entries tailored cleanly to the category */}
                  <div className="space-y-3">
                    {group.items.map((item, idx) => (
                      <div
                        key={item.uid}
                        className="rounded-xl border border-border bg-surface p-3.5 sm:p-4 space-y-3"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-bold text-text-primary">
                            {isTankOrSump
                              ? `${group.kind === 'sump' ? 'Sump' : 'Tank'} ${idx + 1}`
                              : isSolar
                              ? `Solar Details${group.items.length > 1 ? ` #${idx + 1}` : ''}`
                              : `Work Details${group.items.length > 1 ? ` #${idx + 1}` : ''}`}
                          </span>
                          {group.items.length > 1 && (
                            <button
                              type="button"
                              onClick={() => handleRemoveItem(group.category_name, item.uid)}
                              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-text-muted hover:text-error"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              Remove
                            </button>
                          )}
                        </div>

                        {isTankOrSump ? (
                          <>
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
                              <div className="sm:col-span-5">
                                <label className="mb-1 block text-xs font-semibold text-text-secondary">
                                  Capacity (Litres)
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
                                  placeholder="e.g. 1000"
                                  className="w-full rounded-xl border bg-bg px-3 py-2.5 text-sm font-medium tabular-nums"
                                />
                              </div>

                              <div className="sm:col-span-3">
                                <label className="mb-1 block text-xs font-semibold text-text-secondary">
                                  Same size count
                                </label>
                                <div className="flex items-center rounded-xl border border-border bg-bg overflow-hidden">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleUpdateItem(group.category_name, item.uid, {
                                        quantity: Math.max(1, item.quantity - 1),
                                      })
                                    }
                                    className="px-3 py-2.5 hover:bg-elevated"
                                    aria-label="Decrease quantity"
                                  >
                                    <Minus className="h-3.5 w-3.5" />
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
                                    className="w-full bg-transparent text-center text-sm font-bold tabular-nums focus:outline-none"
                                  />
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleUpdateItem(group.category_name, item.uid, {
                                        quantity: item.quantity + 1,
                                      })
                                    }
                                    className="px-3 py-2.5 hover:bg-elevated"
                                    aria-label="Increase quantity"
                                  >
                                    <Plus className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              </div>

                              {!isCombined && (
                                <div className="sm:col-span-4">
                                  <label className="mb-1 block text-xs font-semibold text-text-secondary">
                                    {item.quantity > 1
                                      ? `Price per ${group.kind === 'sump' ? 'Sump' : 'Tank'} (${sym})`
                                      : `Price (${sym})`}
                                  </label>
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
                                    className="w-full rounded-xl border bg-bg px-3 py-2.5 text-sm font-bold text-right tabular-nums"
                                  />
                                </div>
                              )}
                            </div>

                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-[11px] font-medium text-text-muted">
                                Quick Litres:
                              </span>
                              {CAPACITY_PRESETS.map((cap) => (
                                <button
                                  key={cap}
                                  type="button"
                                  onClick={() =>
                                    handleUpdateItem(group.category_name, item.uid, {
                                      capacity_litres: String(cap),
                                    })
                                  }
                                  className={`rounded-lg border px-2.5 py-1 text-xs font-medium ${
                                    item.capacity_litres === String(cap)
                                      ? 'border-accent bg-accent-soft text-accent'
                                      : 'border-border bg-bg text-text-secondary hover:text-text-primary'
                                  }`}
                                >
                                  {cap.toLocaleString('en-IN')}L
                                </button>
                              ))}
                            </div>

                            <input
                              type="text"
                              value={item.description}
                              onChange={(e) =>
                                handleUpdateItem(group.category_name, item.uid, {
                                  description: e.target.value,
                                })
                              }
                              placeholder="Optional note (e.g. Terrace tank, heavy mud)..."
                              className="w-full rounded-xl border bg-bg px-3 py-2 text-xs"
                            />
                          </>
                        ) : isSolar ? (
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
                            <div className="sm:col-span-4">
                              <label className="mb-1 block text-xs font-semibold text-text-secondary">
                                Number of Panels
                              </label>
                              <div className="flex items-center rounded-xl border border-border bg-bg overflow-hidden">
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleUpdateItem(group.category_name, item.uid, {
                                      quantity: Math.max(1, item.quantity - 1),
                                    })
                                  }
                                  className="px-3 py-2.5 hover:bg-elevated"
                                >
                                  <Minus className="h-3.5 w-3.5" />
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
                                  className="w-full bg-transparent text-center text-sm font-bold tabular-nums focus:outline-none"
                                />
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleUpdateItem(group.category_name, item.uid, {
                                      quantity: item.quantity + 1,
                                    })
                                  }
                                  className="px-3 py-2.5 hover:bg-elevated"
                                >
                                  <Plus className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>

                            {!isCombined && (
                              <div className="sm:col-span-4">
                                <label className="mb-1 block text-xs font-semibold text-text-secondary">
                                  Price per Panel ({sym})
                                </label>
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
                                  className="w-full rounded-xl border bg-bg px-3 py-2.5 text-sm font-bold text-right tabular-nums"
                                />
                              </div>
                            )}

                            <div className={isCombined ? 'sm:col-span-8' : 'sm:col-span-4'}>
                              <label className="mb-1 block text-xs font-semibold text-text-secondary">
                                Optional Details
                              </label>
                              <input
                                type="text"
                                value={item.description}
                                onChange={(e) =>
                                  handleUpdateItem(group.category_name, item.uid, {
                                    description: e.target.value,
                                  })
                                }
                                placeholder="e.g. Rooftop array"
                                className="w-full rounded-xl border bg-bg px-3 py-2.5 text-sm"
                              />
                            </div>
                          </div>
                        ) : (
                          /* Plumbing / Other */
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
                            <div className="sm:col-span-6">
                              <label className="mb-1 block text-xs font-semibold text-text-secondary">
                                What work was done?
                              </label>
                              <input
                                type="text"
                                value={item.item_name}
                                onChange={(e) =>
                                  handleUpdateItem(group.category_name, item.uid, {
                                    item_name: e.target.value,
                                  })
                                }
                                placeholder="Enter a short description"
                                className="w-full rounded-xl border bg-bg px-3 py-2.5 text-sm"
                              />
                            </div>

                            <div className="sm:col-span-2">
                              <label className="mb-1 block text-xs font-semibold text-text-secondary">
                                Qty
                              </label>
                              <input
                                type="number"
                                min={1}
                                value={item.quantity}
                                onChange={(e) =>
                                  handleUpdateItem(group.category_name, item.uid, {
                                    quantity: Math.max(1, Number(e.target.value) || 1),
                                  })
                                }
                                className="w-full rounded-xl border bg-bg px-3 py-2.5 text-sm text-center font-bold tabular-nums"
                              />
                            </div>

                            {!isCombined && (
                              <div className="sm:col-span-4">
                                <label className="mb-1 block text-xs font-semibold text-text-secondary">
                                  Price ({sym})
                                </label>
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
                                  className="w-full rounded-xl border bg-bg px-3 py-2.5 text-sm font-bold text-right tabular-nums"
                                />
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={() => handleAddItem(group.category_name)}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-accent/60 bg-accent-soft/30 px-4 py-2.5 text-xs font-semibold text-accent hover:bg-accent-soft/60"
                  >
                    <Plus className="h-4 w-4" />
                    {addItemButtonText(group.kind)}
                  </button>
                </div>
              );
            })}
          </section>
        ) : null}

        {/* 4. ADD PHOTOS & DOCUMENTS (Simple 3 Sections with live thumbnails + Retry) */}
        <section className="rounded-xl border border-border bg-bg p-4 sm:p-5 space-y-4">
          <div>
            <h3 className="text-base font-semibold text-text-primary">
              {isEdit ? '3. Add More Photos or Documents' : '4. Add Photos & Documents'}
            </h3>
            <p className="text-xs text-text-secondary">
              Photos upload right away and stay safe even if you leave or refresh. (Max 15 MB each)
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3.5 md:grid-cols-3">
            {PHOTO_SECTIONS.map((sec) => {
              const itemsInSec = attachments.filter((a) => a.category === sec.category);

              return (
                <div
                  key={sec.category}
                  className="rounded-xl border border-border bg-surface p-3.5 space-y-3"
                >
                  <p className="text-xs font-bold uppercase tracking-wider text-text-primary">
                    {sec.title}
                  </p>

                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => galleryInputRefs.current[sec.category]?.click()}
                      className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-border bg-bg px-3 py-2.5 text-xs font-semibold text-text-primary hover:bg-elevated"
                    >
                      <Plus className="h-4 w-4 text-accent" />
                      {sec.buttonLabel}
                    </button>

                    {sec.allowCamera && (
                      <button
                        type="button"
                        onClick={() => cameraInputRefs.current[sec.category]?.click()}
                        className="inline-flex items-center justify-center gap-1 rounded-xl border border-border bg-bg px-3 py-2.5 text-xs font-medium text-text-secondary hover:text-text-primary sm:hidden"
                      >
                        <Camera className="h-4 w-4" />
                        Camera
                      </button>
                    )}
                  </div>

                  <input
                    ref={(el) => {
                      galleryInputRefs.current[sec.category] = el;
                    }}
                    type="file"
                    multiple
                    accept={sec.accept}
                    className="hidden"
                    onChange={(e) => {
                      const list = Array.from(e.target.files ?? []);
                      void handleSelectFiles(list, sec.category);
                      e.target.value = '';
                    }}
                  />

                  {sec.allowCamera && (
                    <input
                      ref={(el) => {
                        cameraInputRefs.current[sec.category] = el;
                      }}
                      type="file"
                      accept="image/*"
                      capture="environment"
                      className="hidden"
                      onChange={(e) => {
                        const list = Array.from(e.target.files ?? []);
                        void handleSelectFiles(list, sec.category);
                        e.target.value = '';
                      }}
                    />
                  )}

                  {itemsInSec.length > 0 && (
                    <div className="space-y-2">
                      {itemsInSec.map((item) => (
                        <div
                          key={item.id}
                          className="rounded-xl border border-border bg-bg p-2.5 space-y-2"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex items-center gap-2.5 min-w-0">
                              {item.previewUrl ? (
                                <img
                                  src={item.previewUrl}
                                  alt={item.fileName}
                                  className="h-12 w-12 rounded-lg object-cover shrink-0 border border-border"
                                />
                              ) : (
                                <div className="flex h-12 w-12 items-center justify-center rounded-lg border border-border bg-surface shrink-0">
                                  <FileText className="h-6 w-6 text-text-muted" />
                                </div>
                              )}
                              <div className="min-w-0">
                                <p className="truncate text-xs font-semibold text-text-primary">
                                  {item.fileName}
                                </p>
                                <p className="text-[11px] text-text-muted">
                                  {formatBytes(item.fileSize)}
                                </p>
                                <div className="mt-0.5">
                                  {item.status === 'uploading' && (
                                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-accent">
                                      <Loader2 className="h-3 w-3 animate-spin" />
                                      Uploading...
                                    </span>
                                  )}
                                  {item.status === 'uploaded' && (
                                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-success">
                                      <CheckCircle2 className="h-3 w-3" />
                                      Uploaded
                                    </span>
                                  )}
                                  {item.status === 'failed' && (
                                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-error">
                                      <XCircle className="h-3 w-3" />
                                      Failed
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>

                            <button
                              type="button"
                              onClick={() => void handleRemoveAttachment(item)}
                              className="p-1 text-text-muted hover:text-error"
                              aria-label={`Remove ${item.fileName}`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>

                          {item.status === 'failed' && (
                            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-error/10 px-2.5 py-1.5 text-[11px]">
                              <span className="text-error">
                                {item.errorMessage || "Photo couldn't be uploaded."}
                              </span>
                              <button
                                type="button"
                                onClick={() => void uploadAttachmentItem(item)}
                                className="inline-flex items-center gap-1 rounded-md bg-surface px-2.5 py-1 font-semibold text-text-primary border border-border hover:bg-elevated"
                              >
                                <RefreshCw className="h-3 w-3" />
                                Retry
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* 5. REVIEW WORK ADDED, TOTAL AMOUNT & RECORD PAYMENT */}
        <section className="rounded-xl border-2 border-border bg-bg p-4 sm:p-5 space-y-4">
          <h3 className="text-base font-semibold text-text-primary">
            {isEdit ? '4. Bill Summary & Save' : '5. Review Amount & Payment'}
          </h3>

          {/* Work Added Summary */}
          {cartGroups.length > 0 && (
            <div className="rounded-xl border border-border bg-surface p-4 space-y-2.5">
              <p className="text-xs font-bold uppercase tracking-wider text-text-muted">
                Work Added (Tap any line to edit)
              </p>
              <div className="divide-y divide-border">
                {cartGroups.map((g) => {
                  const totalUnits = g.items.reduce((a, i) => a + i.quantity, 0);
                  const grpAmt = computation.groupTotals[g.category_name] || 0;
                  return (
                    <button
                      key={g.category_name}
                      type="button"
                      onClick={() =>
                        sectionRefs.current[g.category_name]?.scrollIntoView({
                          behavior: 'smooth',
                          block: 'center',
                        })
                      }
                      className="flex w-full items-center justify-between gap-3 py-2 text-left hover:opacity-80"
                    >
                      <div>
                        <p className="text-sm font-semibold text-text-primary">
                          {g.category_name}
                        </p>
                        <p className="text-xs text-text-secondary">
                          {totalUnits} {unitNoun(g.kind, totalUnits)}
                        </p>
                      </div>
                      <span className="text-sm font-bold text-text-primary tabular-nums">
                        {formatCurrency(grpAmt, sym)}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Optional Discount */}
              <div className="pt-2 border-t border-border">
                {!showDiscountBox ? (
                  <button
                    type="button"
                    onClick={() => setShowDiscountBox(true)}
                    className="text-xs font-semibold text-accent hover:underline"
                  >
                    + Give a Discount (Optional)
                  </button>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-bg p-2.5">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-text-secondary">Discount:</span>
                      <div className="inline-flex rounded-lg border border-border bg-surface p-0.5 text-xs">
                        <button
                          type="button"
                          onClick={() => setDiscountType('fixed')}
                          className={`rounded-md px-2.5 py-1 font-semibold ${
                            discountType === 'fixed' ? 'bg-accent text-white' : 'text-text-secondary'
                          }`}
                        >
                          {sym}
                        </button>
                        <button
                          type="button"
                          onClick={() => setDiscountType('percentage')}
                          className={`rounded-md px-2.5 py-1 font-semibold ${
                            discountType === 'percentage'
                              ? 'bg-accent text-white'
                              : 'text-text-secondary'
                          }`}
                        >
                          %
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
                        className="w-28 rounded-lg border bg-surface px-2.5 py-1.5 text-sm text-right font-semibold tabular-nums"
                        aria-label="Discount amount"
                      />
                      <span className="text-xs text-text-secondary tabular-nums">
                        (-{formatCurrency(computation.discountAmount, sym)})
                      </span>
                    </div>
                    {computation.error && (
                      <p className="w-full text-xs text-error">{computation.error}</p>
                    )}
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between border-t border-border pt-3">
                <span className="text-base font-bold text-text-primary">Total Amount</span>
                <span className="text-xl font-bold text-text-primary tabular-nums">
                  {formatCurrency(computation.grandTotal, sym)}
                </span>
              </div>
            </div>
          )}

          {/* Payment controls */}
          {!isEdit ? (
            <div className="space-y-3">
              <p className="text-sm font-semibold text-text-primary">Payment Received</p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {(
                  [
                    ['paid', 'Paid in Full'],
                    ['partial', 'Partial Payment'],
                    ['unpaid', 'Not Paid Yet'],
                  ] as const
                ).map(([val, label]) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setPaymentChoice(val)}
                    className={`rounded-xl border-2 px-4 py-3 text-sm font-semibold transition-colors ${
                      paymentChoice === val
                        ? 'border-accent bg-accent-soft text-accent'
                        : 'border-border bg-surface text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {paymentChoice !== 'unpaid' && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 rounded-xl border border-border bg-surface p-3.5">
                  {paymentChoice === 'partial' && (
                    <div>
                      <label className="mb-1 block text-xs font-semibold text-text-secondary">
                        Amount Received ({sym}) *
                      </label>
                      <input
                        type="number"
                        min="1"
                        step="0.01"
                        value={paidAmount}
                        onChange={(e) => setPaidAmount(e.target.value)}
                        placeholder="0"
                        className="w-full rounded-xl border bg-bg px-3 py-2 text-sm font-bold tabular-nums"
                      />
                    </div>
                  )}
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-text-secondary">
                      Payment Mode
                    </label>
                    <select
                      value={paymentMethod}
                      onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
                      className="w-full rounded-xl border bg-bg px-3 py-2 text-sm"
                    >
                      <option value="Cash">Cash</option>
                      <option value="UPI">UPI</option>
                      <option value="Other">Other</option>
                    </select>
                  </div>
                  <div className={paymentChoice === 'paid' ? 'sm:col-span-2' : ''}>
                    <label className="mb-1 block text-xs font-semibold text-text-secondary">
                      UPI / Reference No. (Optional)
                    </label>
                    <input
                      type="text"
                      value={txRef}
                      onChange={(e) => setTxRef(e.target.value)}
                      placeholder="Optional"
                      className="w-full rounded-xl border bg-bg px-3 py-2 text-sm"
                    />
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3 rounded-xl bg-surface px-4 py-3 text-sm border border-border">
                <div>
                  <p className="text-xs text-text-secondary">Amount Received</p>
                  <p className="text-base font-bold text-success tabular-nums">
                    {formatCurrency(
                      paymentChoice === 'paid'
                        ? computation.grandTotal
                        : paymentChoice === 'partial'
                        ? Math.max(0, Number(paidAmount) || 0)
                        : 0,
                      sym
                    )}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-text-secondary">Remaining Amount</p>
                  <p className="text-base font-bold text-text-primary tabular-nums">
                    {formatCurrency(remainingAmount, sym)}
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 rounded-xl bg-surface px-4 py-3 text-sm border border-border">
              <div>
                <p className="text-xs text-text-secondary">Amount Received So Far</p>
                <p className="text-base font-bold text-success tabular-nums">
                  {formatCurrency(existingService?.amount_paid ?? 0, sym)}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs text-text-secondary">Remaining Amount</p>
                <p className="text-base font-bold text-text-primary tabular-nums">
                  {formatCurrency(remainingAmount, sym)}
                </p>
              </div>
            </div>
          )}

          {/* Notes & Optional Reminder */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-semibold text-text-secondary">
                Any Extra Notes (Optional)
              </label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Write any note to remember..."
                className="w-full rounded-xl border bg-surface px-3.5 py-2.5 text-sm"
              />
            </div>

            {!isEdit ? (
              <div className="rounded-xl border border-border bg-surface px-3.5 py-2.5 space-y-2">
                <label className="flex cursor-pointer items-center justify-between gap-2 text-xs font-semibold text-text-primary">
                  <span className="inline-flex items-center gap-1.5">
                    <Bell className="h-4 w-4 text-accent" />
                    Remind for next service later?
                  </span>
                  <input
                    type="checkbox"
                    checked={reminderEnabled}
                    onChange={(e) => setReminderEnabled(e.target.checked)}
                  />
                </label>
                {reminderEnabled && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    <input
                      type="date"
                      value={reminderDate}
                      onChange={(e) => setReminderDate(e.target.value)}
                      className="flex-1 rounded-lg border bg-bg px-2.5 py-1.5 text-xs"
                    />
                    <select
                      value={reminderType}
                      onChange={(e) =>
                        setReminderType(
                          e.target.value as 'service_due' | 'custom' | 'follow_up'
                        )
                      }
                      className="rounded-lg border bg-bg px-2.5 py-1.5 text-xs"
                    >
                      <option value="service_due">Service Due</option>
                      <option value="follow_up">Follow-Up</option>
                      <option value="custom">Custom</option>
                    </select>
                  </div>
                )}
              </div>
            ) : (
              <div>
                <label className="mb-1 block text-xs font-semibold text-text-secondary">
                  Next Service Due Date (Optional)
                </label>
                <input
                  type="date"
                  value={editNextDueDate}
                  onChange={(e) => setEditNextDueDate(e.target.value)}
                  className="w-full rounded-xl border bg-surface px-3.5 py-2.5 text-sm"
                />
              </div>
            )}
          </div>

          {/* Primary Save Button */}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-border bg-surface px-5 py-3 text-sm font-semibold hover:bg-elevated"
            >
              Close (Keep Draft)
            </button>
            <button
              type="submit"
              disabled={submitting || loadingCartDetails}
              className="zb-btn-primary rounded-xl px-7 py-3 text-sm font-bold disabled:opacity-50"
            >
              {submitting
                ? 'Saving...'
                : isEdit
                ? `Save Changes (${formatCurrency(computation.grandTotal, sym)})`
                : `Save Service (${formatCurrency(computation.grandTotal, sym)})`}
            </button>
          </div>
        </section>
      </form>
    </Modal>
  );
}
