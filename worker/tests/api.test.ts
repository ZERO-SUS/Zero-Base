import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { escapeCsvCell, computeReminderCategory } from '../src/lib/timezone';
import { createTestHarness } from './helpers/mockEnv';

// Minimal valid 1x1 PNG bytes (with PNG magic signature 89 50 4E 47 0D 0A 1A 0A)
const VALID_PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
]);

describe('ZERO BASE Worker API Integration & Security Suite', () => {
  it('enforces authentication and rejects unauthorized or deactivated users', async () => {
    const { env, overrides } = createTestHarness();
    const app = createApp(overrides);

    // Public health endpoint works
    const health = await app.request('/api/health', {}, env);
    expect(health.status).toBe(200);

    // Unauthenticated API access is rejected
    const unauth = await app.request('/api/customers', {}, env);
    expect(unauth.status).toBe(401);

    // Invalid JWT is rejected
    const badToken = await app.request(
      '/api/customers',
      { headers: { Authorization: 'Bearer forged-jwt' } },
      env
    );
    expect(badToken.status).toBe(401);

    // Deactivated profile is forbidden
    const disabled = await app.request(
      '/api/customers',
      { headers: { Authorization: 'Bearer disabled-token' } },
      env
    );
    expect(disabled.status).toBe(403);

    // Non-admin staff cannot update business settings or scan orphans
    const staffPatch = await app.request(
      '/api/settings',
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer staff-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ app_name: 'HACKED' }),
      },
      env
    );
    expect(staffPatch.status).toBe(403);
  });

  it('creates customers preserving phone format, searches, and warns on duplicate phones', async () => {
    const { env, overrides } = createTestHarness();
    const app = createApp(overrides);

    const createRes = await app.request(
      '/api/customers',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          full_name: 'Ramesh Iyer',
          primary_phone: '+91 09876543210',
          address: '42 MG Road',
          locality: 'Indiranagar',
        }),
      },
      env
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { customer: { customer_id: string; primary_phone: string } };
    expect(created.customer.primary_phone).toBe('+91 09876543210');

    // Duplicate phone warning returns 409 with existing record
    const dupRes = await app.request(
      '/api/customers',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          full_name: 'Ramesh Duplicate',
          primary_phone: '9876543210',
          address: '99 Residency Rd',
        }),
      },
      env
    );
    expect(dupRes.status).toBe(409);
    const dupBody = (await dupRes.json()) as { code: string; duplicates: Array<{ customer_id: string }> };
    expect(dupBody.code).toBe('DUPLICATE_CUSTOMER_PHONE');
    expect(dupBody.duplicates[0].customer_id).toBe(created.customer.customer_id);

    // Search by partial phone & locality
    const searchRes = await app.request(
      '/api/customers?q=Indiranagar',
      { headers: { Authorization: 'Bearer admin-token' } },
      env
    );
    expect(searchRes.status).toBe(200);
    const searchBody = (await searchRes.json()) as { customers: Array<{ full_name: string }> };
    expect(searchBody.customers.length).toBe(1);
    expect(searchBody.customers[0].full_name).toBe('Ramesh Iyer');
  });

  it('groups year-wise service history strictly by actual service_date (never created_at)', async () => {
    const { db, env, overrides } = createTestHarness();
    const app = createApp(overrides);

    const custRes = await app.request(
      '/api/customers',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          full_name: 'Customer A',
          primary_phone: '9876500001',
          address: '10 Park Street',
        }),
      },
      env
    );
    const { customer } = (await custRes.json()) as { customer: { customer_id: string } };

    // Service actually performed 20 December 2025, even though record is created in 2026
    await app.request(
      '/api/services',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          customer_id: customer.customer_id,
          service_date: '2025-12-20',
          service_type: 'Overhead Tank Cleaning',
          price: 1500,
          discount: 0,
        }),
      },
      env
    );
    // Simulate record created on 2026-01-05
    db.services[0].created_at = '2026-01-05T10:00:00Z';

    // Another service in Nov 2026
    await app.request(
      '/api/services',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          customer_id: customer.customer_id,
          service_date: '2026-11-16',
          service_type: 'Underground Sump Cleaning',
          price: 2000,
          discount: 200,
        }),
      },
      env
    );

    const historyRes = await app.request(
      '/api/services/history',
      { headers: { Authorization: 'Bearer admin-token' } },
      env
    );
    expect(historyRes.status).toBe(200);
    const history = (await historyRes.json()) as {
      grouped: Array<{
        year: number;
        months: Array<{ month: number; records: Array<{ service_date: string }> }>;
      }>;
    };

    expect(history.grouped.map((g) => g.year)).toEqual([2026, 2025]);
    expect(history.grouped[0].months[0].month).toBe(11);
    expect(history.grouped[1].months[0].month).toBe(12);
    expect(history.grouped[1].months[0].records[0].service_date).toBe('2025-12-20');
  });

  it('computes partial payments, full payments, and audit-preserving payment corrections', async () => {
    const { env, overrides } = createTestHarness();
    const app = createApp(overrides);

    const custRes = await app.request(
      '/api/customers',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          full_name: 'Sita Verma',
          primary_phone: '9988776655',
          address: '22 Lake View',
        }),
      },
      env
    );
    const { customer } = (await custRes.json()) as { customer: { customer_id: string } };

    const srvRes = await app.request(
      '/api/services',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          customer_id: customer.customer_id,
          service_date: '2026-11-16',
          service_type: 'Overhead Tank Cleaning',
          price: 1500,
          discount: 300,
          idempotency_key: 'idem-srv-1',
        }),
      },
      env
    );
    const { service } = (await srvRes.json()) as {
      service: { service_id: string; total_amount: number; payment_status: string };
    };
    expect(service.total_amount).toBe(1200);
    expect(service.payment_status).toBe('Unpaid');

    // Duplicate submission with same idempotency_key returns existing service instead of creating a duplicate
    const dupSrvRes = await app.request(
      '/api/services',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          customer_id: customer.customer_id,
          service_date: '2026-11-16',
          service_type: 'Overhead Tank Cleaning',
          price: 1500,
          discount: 300,
          idempotency_key: 'idem-srv-1',
        }),
      },
      env
    );
    const dupSrvBody = (await dupSrvRes.json()) as { deduplicated?: boolean };
    expect(dupSrvBody.deduplicated).toBe(true);

    // Partial payment ₹500
    const p1Res = await app.request(
      '/api/payments',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          service_id: service.service_id,
          amount: 500,
          payment_method: 'Cash',
          payment_date: '2026-11-16',
        }),
      },
      env
    );
    const p1Body = (await p1Res.json()) as {
      payment: { payment_id: string };
      service: { amount_paid: number; payment_status: string };
    };
    expect(p1Body.service.amount_paid).toBe(500);
    expect(p1Body.service.payment_status).toBe('Partially Paid');

    // Second payment ₹700 -> Paid
    const p2Res = await app.request(
      '/api/payments',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          service_id: service.service_id,
          amount: 700,
          payment_method: 'UPI',
          transaction_reference: 'UTR123456',
          payment_date: '2026-11-16',
        }),
      },
      env
    );
    const p2Body = (await p2Res.json()) as {
      service: { amount_paid: number; payment_status: string };
    };
    expect(p2Body.service.amount_paid).toBe(1200);
    expect(p2Body.service.payment_status).toBe('Paid');

    // Correct first payment from ₹500 to ₹400 (preserves original record as archived/superseded)
    const corrRes = await app.request(
      `/api/payments/${p1Body.payment.payment_id}/correct`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          reason: 'Cash counted ₹400 instead of ₹500',
          replacement: {
            amount: 400,
            payment_method: 'Cash',
            payment_date: '2026-11-16',
          },
        }),
      },
      env
    );
    expect(corrRes.status).toBe(200);
    const corrBody = (await corrRes.json()) as {
      archived_payment: { archived_at: string; archive_reason: string };
      service: { amount_paid: number; payment_status: string };
    };
    expect(corrBody.archived_payment.archived_at).toBeTruthy();
    expect(corrBody.service.amount_paid).toBe(1100);
    expect(corrBody.service.payment_status).toBe('Partially Paid');
  });

  it('handles R2 private uploads, magic-byte validation, signed links, rollback & orphan cleanup', async () => {
    const { db, env, overrides, r2Store } = createTestHarness();
    const app = createApp(overrides);

    const custRes = await app.request(
      '/api/customers',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          full_name: 'R2 Test Customer',
          primary_phone: '9111222333',
          address: '15 Cloud Way',
        }),
      },
      env
    );
    const { customer } = (await custRes.json()) as { customer: { customer_id: string } };

    const srvRes = await app.request(
      '/api/services',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          customer_id: customer.customer_id,
          service_date: '2026-11-16',
          service_type: 'Overhead Tank Cleaning',
          price: 1000,
          discount: 0,
        }),
      },
      env
    );
    const { service } = (await srvRes.json()) as { service: { service_id: string } };

    // Reject spoofed non-image/non-PDF file
    const badForm = new FormData();
    badForm.append('file', new File(['<script>alert(1)</script>'], 'evil.png', { type: 'image/png' }));
    badForm.append('category', 'Before-cleaning photos');
    const badUpload = await app.request(
      `/api/services/${service.service_id}/attachments`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token' },
        body: badForm,
      },
      env
    );
    expect(badUpload.status).toBe(400);

    // Valid PNG upload
    const goodForm = new FormData();
    goodForm.append('file', new File([VALID_PNG_BYTES], 'tank-before.png', { type: 'image/png' }));
    goodForm.append('category', 'Before-cleaning photos');
    const uploadRes = await app.request(
      `/api/services/${service.service_id}/attachments`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token' },
        body: goodForm,
      },
      env
    );
    expect(uploadRes.status).toBe(201);
    const { attachment } = (await uploadRes.json()) as {
      attachment: { attachment_id: string; storage_key: string };
    };
    expect(r2Store.has(attachment.storage_key)).toBe(true);

    // Unauthenticated access to private R2 file without token fails
    const noTokenFile = await app.request(
      `/api/attachments/${attachment.attachment_id}/file`,
      {},
      env
    );
    expect(noTokenFile.status).toBe(401);

    // Signed temporary access link works
    const linkRes = await app.request(
      `/api/attachments/${attachment.attachment_id}/access-link`,
      { headers: { Authorization: 'Bearer admin-token' } },
      env
    );
    expect(linkRes.status).toBe(200);
    const { url } = (await linkRes.json()) as { url: string };
    const signedPath = new URL(url).pathname + new URL(url).search;
    const fileRes = await app.request(signedPath, {}, env);
    expect(fileRes.status).toBe(200);
    expect(fileRes.headers.get('X-Content-Type-Options')).toBe('nosniff');

    // Tampered token fails
    const tampered = await app.request(`${signedPath}tampered`, {}, env);
    expect(tampered.status).toBe(403);

    // Compensating rollback deletes R2 object if DB insert fails
    db.failNextAttachmentInsert = true;
    const failForm = new FormData();
    failForm.append('file', new File([VALID_PNG_BYTES], 'rollback.png', { type: 'image/png' }));
    failForm.append('category', 'Bill photos');
    const failUpload = await app.request(
      `/api/services/${service.service_id}/attachments`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token' },
        body: failForm,
      },
      env
    );
    expect(failUpload.status).toBe(500);
    expect(r2Store.size).toBe(1); // Only the valid uploaded file remains

    // Orphan detection finds unreferenced R2 objects and cleans them safely
    await env.FILES_BUCKET.put('customers/orphan/test.png', VALID_PNG_BYTES);
    const orphanRes = await app.request(
      '/api/attachments/orphans',
      { headers: { Authorization: 'Bearer admin-token' } },
      env
    );
    const orphanBody = (await orphanRes.json()) as {
      r2_only_orphans: Array<{ key: string }>;
    };
    expect(orphanBody.r2_only_orphans.map((o) => o.key)).toEqual(['customers/orphan/test.png']);
  });

  it('escapes CSV formula injection and categorizes reminders accurately in IST', () => {
    expect(escapeCsvCell('=CMD("calc")')).toBe('"\'=CMD(""calc"")"');
    expect(escapeCsvCell('+SUM(A1)')).toBe("'+SUM(A1)");
    expect(escapeCsvCell('Normal, Text')).toBe('"Normal, Text"');

    expect(computeReminderCategory({ status: 'active', due_date: '2026-11-15' }, '2026-11-16')).toBe('Overdue');
    expect(computeReminderCategory({ status: 'active', due_date: '2026-11-16' }, '2026-11-16')).toBe('Due Today');
    expect(computeReminderCategory({ status: 'active', due_date: '2026-11-20' }, '2026-11-16')).toBe('Upcoming');
    expect(computeReminderCategory({ status: 'snoozed', due_date: '2026-11-25' }, '2026-11-16')).toBe('Snoozed');
  });
});
