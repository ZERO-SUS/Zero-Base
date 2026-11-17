import type { DraftCartGroup } from './cartPricing';
import type { Customer, DiscountType, FileCategory, PaymentMethod } from '../types/domain';

export interface LocalServiceDraftData {
  draftId: string | null;
  idempotencyKey: string;
  updatedAt: string;
  fixedCustomerId?: string | null;
  customerMode: 'existing' | 'new';
  selectedCustomer: Customer | null;
  newCustomer: {
    full_name: string;
    phone_number: string;
    alternate_phone: string;
    address: string;
    area: string;
    notes: string;
    allow_duplicate: boolean;
  };
  serviceDate: string;
  description: string;
  notes: string;
  cartGroups: DraftCartGroup[];
  discountType: DiscountType;
  discountValue: string;
  paymentChoice: 'unpaid' | 'partial' | 'paid';
  paidAmount: string;
  paymentMethod: PaymentMethod;
  txRef: string;
  reminderEnabled: boolean;
  reminderDate: string;
  reminderType: 'service_due' | 'custom' | 'follow_up';
  reminderNotes: string;
}

export interface LocalPendingFileRecord {
  id: string;
  userId: string;
  category: FileCategory;
  fileName: string;
  mimeType: string;
  fileSize: number;
  status: 'uploading' | 'failed';
  errorMessage?: string;
  blob: Blob;
  createdAt: string;
}

function draftStorageKey(userId: string): string {
  return `zero_base_service_draft_v2:${userId}`;
}

export function saveLocalDraft(userId: string, draft: LocalServiceDraftData): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(draftStorageKey(userId), JSON.stringify(draft));
  } catch {
    // Ignore quota or storage unavailability
  }
}

export function loadLocalDraft(userId: string): LocalServiceDraftData | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const raw = window.localStorage.getItem(draftStorageKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LocalServiceDraftData;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearLocalDraft(userId: string): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.removeItem(draftStorageKey(userId));
  } catch {
    // Ignore
  }
}

const DB_NAME = 'zero-base-draft-files';
const DB_VERSION = 1;
const STORE_NAME = 'pending_files';

function openDraftFilesDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('by_user', 'userId', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function saveLocalPendingFile(record: LocalPendingFileRecord): Promise<void> {
  const db = await openDraftFilesDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function loadLocalPendingFiles(userId: string): Promise<LocalPendingFileRecord[]> {
  const db = await openDraftFilesDb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const idx = tx.objectStore(STORE_NAME).index('by_user');
      const req = idx.getAll(IDBKeyRange.only(userId));
      req.onsuccess = () => {
        const rows = (req.result || []) as LocalPendingFileRecord[];
        rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        resolve(rows);
      };
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

export async function deleteLocalPendingFile(id: string): Promise<void> {
  const db = await openDraftFilesDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function clearLocalPendingFilesForUser(userId: string): Promise<void> {
  const existing = await loadLocalPendingFiles(userId);
  await Promise.all(existing.map((f) => deleteLocalPendingFile(f.id)));
}
