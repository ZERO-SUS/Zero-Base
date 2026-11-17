import { describe, expect, it } from 'vitest';
import {
  clearLocalDraft,
  loadLocalDraft,
  saveLocalDraft,
  type LocalServiceDraftData,
} from '../lib/draftStorage';
import { inferFriendlyMimeType, validateAndPrepareUploadFile } from '../lib/imageUtils';

describe('Image Upload Validation & Local Draft Persistence', () => {
  it('handles mobile camera mime variants and empty file.type via filename extension fallback', async () => {
    const camFile = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], 'IMG_20261117.JPG', {
      type: '',
    });
    expect(inferFriendlyMimeType(camFile)).toBe('image/jpeg');
    const prep = await validateAndPrepareUploadFile(camFile);
    expect(prep.ok).toBe(true);

    const jpgAlias = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'photo.jpg', {
      type: 'image/jpg',
    });
    expect(inferFriendlyMimeType(jpgAlias)).toBe('image/jpeg');
  });

  it('rejects unsupported file types and >15MB files with plain-English messages', async () => {
    const badFile = new File(['hello'], 'notes.exe', { type: 'application/x-msdownload' });
    const badRes = await validateAndPrepareUploadFile(badFile);
    expect(badRes.ok).toBe(false);
    if (!badRes.ok) {
      expect(badRes.error).toContain('JPG, PNG, WEBP');
    }

    const hugePdfBytes = new Uint8Array(15 * 1024 * 1024 + 50);
    const hugePdf = new File([hugePdfBytes], 'huge_invoice.pdf', { type: 'application/pdf' });
    const bigRes = await validateAndPrepareUploadFile(hugePdf);
    expect(bigRes.ok).toBe(false);
    if (!bigRes.ok) {
      expect(bigRes.error).toContain('15 MB');
    }
  });

  it('saves, restores, and clears local drafts per authenticated owner cleanly', () => {
    const ownerA = '11111111-1111-1111-1111-111111111111';
    const ownerB = '22222222-2222-2222-2222-222222222222';

    const sample: LocalServiceDraftData = {
      draftId: 'draft-abc',
      idempotencyKey: 'idem-1',
      updatedAt: '2026-11-17T17:00:00Z',
      customerMode: 'existing',
      selectedCustomer: {
        id: 'cust-1',
        customer_code: 'ZB-00001',
        full_name: 'Ramesh Nair',
        phone_number: '9876543210',
        alternate_phone: null,
        address: '10 MG Road',
        area: 'Central',
        notes: null,
        created_at: '',
        updated_at: '',
        archived_at: null,
      },
      newCustomer: {
        full_name: '',
        phone_number: '',
        alternate_phone: '',
        address: '',
        area: '',
        notes: '',
        allow_duplicate: false,
      },
      serviceDate: '2026-11-17',
      description: '',
      notes: 'Clean both terrace tanks',
      cartGroups: [
        {
          category_name: 'Overhead Tank Cleaning',
          kind: 'tank',
          pricing_mode: 'itemized',
          category_subtotal: '',
          items: [
            {
              uid: 'u1',
              item_name: 'Tank 1',
              capacity_litres: '1000',
              quantity: 1,
              unit_price: '600',
              description: '',
            },
          ],
        },
      ],
      discountType: 'fixed',
      discountValue: '0',
      paymentChoice: 'partial',
      paidAmount: '300',
      paymentMethod: 'UPI',
      txRef: 'UTR123',
      reminderEnabled: false,
      reminderDate: '2027-05-17',
      reminderType: 'service_due',
      reminderNotes: '',
    };

    saveLocalDraft(ownerA, sample);
    expect(loadLocalDraft(ownerA)?.selectedCustomer?.full_name).toBe('Ramesh Nair');
    expect(loadLocalDraft(ownerB)).toBeNull();

    clearLocalDraft(ownerA);
    expect(loadLocalDraft(ownerA)).toBeNull();
  });
});
