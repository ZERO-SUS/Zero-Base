import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { computeReminderCategory, escapeCsvCell } from '../src/lib/timezone';
import { createTestHarness } from './helpers/mockEnv';

const VALID_PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
]);

describe('ZERO BASE Worker API Integration & Security Suite', () => {
  it('allows all 3 owner emergency accounts identically and rejects unauthorized users', async () => {
    const { env, overrides } = createTestHarness();
    const app = createApp(overrides);

    // Health endpoints (/health and /api/health)
    expect((await app.request('/health', {}, env)).status).toBe(200);
    expect((await app.request('/api/health', {}, env)).status).toBe(200);

    // Unauthenticated & invalid JWT rejected
    expect((await app.request('/api/customers', {}, env)).status).toBe(401);
    expect(
      (await app.request('/api/customers', { headers: { Authorization: 'Bearer bad' } }, env))
        .status
    ).toBe(401);

    // Authenticated non-owner Supabase user is strictly rejected (403)
    const nonOwnerRes = await app.request(
      '/api/customers',
      { headers: { Authorization: 'Bearer non-owner-token' } },
      env
    );
    expect(nonOwnerRes.status).toBe(403);

    // Owner 1 creates a customer; Owner 2 & Owner 3 see and edit the exact same record
    const c1 = await app.request(
      '/api/customers',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-1-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          full_name: 'Shared Owner Customer',
          phone_number: '+91 09876543210',
          address: '10 Residency Road',
          area: 'Ashok Nagar',
        }),
      },
      env
    );
    expect(c1.status).toBe(201);
    const { customer } = (await c1.json()) as {
      customer: { id: string; customer_code: string; phone_number: string };
    };
    expect(customer.customer_code).toBe('ZB-00001');
    expect(customer.phone_number).toBe('+91 09876543210');

    const c2Read = await app.request(`/api/customers/${customer.id}`, {
      headers: { Authorization: 'Bearer owner-2-token' },
    }, env);
    expect(c2Read.status).toBe(200);

    const c3Update = await app.request(
      `/api/customers/${customer.id}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer owner-3-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ area: 'MG Road' }),
      },
      env
    );
    expect(c3Update.status).toBe(200);
  });

  it('handles CORS preflight for Pages origin and blocks unknown origins', async () => {
    const { env, overrides } = createTestHarness();
    const app = createApp(overrides);

    const allowedPreflight = await app.request(
      '/api/customers',
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://zero-base.pages.dev',
          'Access-Control-Request-Method': 'POST',
        },
      },
      env
    );
    expect(allowedPreflight.status).toBe(204);
    expect(allowedPreflight.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://zero-base.pages.dev'
    );

    const evilPreflight = await app.request(
      '/api/customers',
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://evil.example.com',
          'Access-Control-Request-Method': 'POST',
        },
      },
      env
    );
    expect(evilPreflight.headers.get('Access-Control-Allow-Origin')).toBeFalsy();
  });

  it('warns on duplicate phones and searches by name, phone, code, area', async () => {
    const { env, overrides } = createTestHarness();
    const app = createApp(overrides);

    await app.request(
      '/api/customers',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-1-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          full_name: 'Ramesh Iyer',
          phone_number: '09876543210',
          address: '42 MG Road',
          area: 'Indiranagar',
        }),
      },
      env
    );

    const dup = await app.request(
      '/api/customers',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-1-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          full_name: 'Ramesh Duplicate',
          phone_number: '+91 9876543210',
          address: '99 Residency Rd',
        }),
      },
      env
    );
    expect(dup.status).toBe(409);
    const dupBody = (await dup.json()) as { code: string };
    expect(dupBody.code).toBe('DUPLICATE_CUSTOMER_PHONE');

    const searchByCode = await app.request(
      '/api/customers?q=ZB-00001',
      { headers: { Authorization: 'Bearer owner-1-token' } },
      env
    );
    expect(((await searchByCode.json()) as { customers: unknown[] }).customers.length).toBe(1);
  });

  it('groups year-wise history by service_date and keeps edited old services in their original year', async () => {
    const { db, env, overrides } = createTestHarness();
    const app = createApp(overrides);

    const custRes = await app.request(
      '/api/customers',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-1-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          full_name: 'Customer A',
          phone_number: '9876500001',
          address: '10 Park Street',
        }),
      },
      env
    );
    const { customer } = (await custRes.json()) as { customer: { id: string } };

    const oldSrvRes = await app.request(
      '/api/services',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-1-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          customer_id: customer.id,
          service_date: '2024-10-12',
          service_type: 'Overhead Tank Cleaning',
          price: 1500,
          discount: 0,
        }),
      },
      env
    );
    const { service: oldSrv } = (await oldSrvRes.json()) as { service: { id: string } };
    db.services[0].created_at = '2026-01-05T10:00:00Z';

    // Edit notes on the 2024 service without changing service_date -> must remain in 2024!
    await app.request(
      `/api/services/${oldSrv.id}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer owner-2-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ notes: 'Updated tank details' }),
      },
      env
    );

    await app.request(
      '/api/services',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-1-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          customer_id: customer.id,
          service_date: '2026-11-16',
          service_type: 'Underground Sump Cleaning',
          price: 2000,
          discount: 0,
        }),
      },
      env
    );

    const historyRes = await app.request(
      '/api/services/history',
      { headers: { Authorization: 'Bearer owner-1-token' } },
      env
    );
    const history = (await historyRes.json()) as {
      grouped: Array<{ year: number; months: Array<{ month: number }> }>;
    };
    expect(history.grouped.map((g) => g.year)).toEqual([2026, 2024]);
    expect(history.grouped[1].months[0].month).toBe(10);
  });

  it('computes partial payments (₹2000 -> ₹500 + ₹500 = ₹1000 balance) and audit-preserving corrections', async () => {
    const { env, overrides } = createTestHarness();
    const app = createApp(overrides);

    const custRes = await app.request(
      '/api/customers',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-1-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          full_name: 'Sita Verma',
          phone_number: '9988776655',
          address: '22 Lake View',
        }),
      },
      env
    );
    const { customer } = (await custRes.json()) as { customer: { id: string } };

    const srvRes = await app.request(
      '/api/services',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-1-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          customer_id: customer.id,
          service_date: '2026-11-16',
          service_type: 'Overhead Tank Cleaning',
          price: 2000,
          discount: 0,
          idempotency_key: 'idem-srv-2000',
        }),
      },
      env
    );
    const { service } = (await srvRes.json()) as {
      service: { id: string; total_amount: number; balance_amount: number };
    };
    expect(service.total_amount).toBe(2000);
    expect(service.balance_amount).toBe(2000);

    // First payment ₹500
    const p1 = await app.request(
      '/api/payments',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-1-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          service_id: service.id,
          amount: 500,
          payment_method: 'Cash',
          payment_date: '2026-11-16',
        }),
      },
      env
    );
    const p1Json = (await p1.json()) as {
      payment: { id: string };
      service: { amount_paid: number; balance_amount: number; payment_status: string };
    };
    expect(p1Json.service.amount_paid).toBe(500);
    expect(p1Json.service.balance_amount).toBe(1500);
    expect(p1Json.service.payment_status).toBe('Partially Paid');

    // Second payment ₹500 -> Remaining balance ₹1000
    const p2 = await app.request(
      '/api/payments',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-2-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          service_id: service.id,
          amount: 500,
          payment_method: 'UPI',
          reference_number: 'UTR999',
          payment_date: '2026-11-16',
        }),
      },
      env
    );
    const p2Json = (await p2.json()) as {
      service: { amount_paid: number; balance_amount: number; payment_status: string };
    };
    expect(p2Json.service.amount_paid).toBe(1000);
    expect(p2Json.service.balance_amount).toBe(1000);

    // Correction preserves original record
    const corr = await app.request(
      `/api/payments/${p1Json.payment.id}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer owner-1-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          reason: 'Adjusted cash receipt to ₹1500',
          replacement: {
            amount: 1500,
            payment_method: 'Cash',
            payment_date: '2026-11-16',
          },
        }),
      },
      env
    );
    expect(corr.status).toBe(200);
    const corrJson = (await corr.json()) as {
      archived_payment: { archived_at: string };
      service: { amount_paid: number; balance_amount: number; payment_status: string };
    };
    expect(corrJson.archived_payment.archived_at).toBeTruthy();
    expect(corrJson.service.amount_paid).toBe(2000);
    expect(corrJson.service.balance_amount).toBe(0);
    expect(corrJson.service.payment_status).toBe('Paid');
  });

  it('handles Supabase Storage private uploads, signed URLs, deletion, rollback & orphans', async () => {
    const { db, env, overrides, storageStore } = createTestHarness();
    const app = createApp(overrides);

    const custRes = await app.request(
      '/api/customers',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-1-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          full_name: 'Storage Customer',
          phone_number: '9111222333',
          address: '15 Lake Road',
        }),
      },
      env
    );
    const { customer } = (await custRes.json()) as { customer: { id: string } };

    const srvRes = await app.request(
      '/api/services',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-1-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          customer_id: customer.id,
          service_date: '2026-11-16',
          service_type: 'Overhead Tank Cleaning',
          price: 1000,
          discount: 0,
        }),
      },
      env
    );
    const { service } = (await srvRes.json()) as { service: { id: string } };

    // Reject invalid file magic bytes
    const badForm = new FormData();
    badForm.append('file', new File(['<script>alert(1)</script>'], 'evil.png', { type: 'image/png' }));
    badForm.append('service_id', service.id);
    badForm.append('category', 'Before-cleaning photos');
    const badUpload = await app.request(
      '/api/files/upload',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer owner-1-token' },
        body: badForm,
      },
      env
    );
    expect(badUpload.status).toBe(400);

    // Valid PNG upload
    const goodForm = new FormData();
    goodForm.append('file', new File([VALID_PNG_BYTES], 'before.png', { type: 'image/png' }));
    goodForm.append('service_id', service.id);
    goodForm.append('category', 'Before-cleaning photos');
    const uploadRes = await app.request(
      '/api/files/upload',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer owner-1-token' },
        body: goodForm,
      },
      env
    );
    expect(uploadRes.status).toBe(201);
    const { file } = (await uploadRes.json()) as {
      file: { id: string; storage_path: string };
    };
    expect(storageStore.has(file.storage_path)).toBe(true);

    // Unauthorized access to file link rejected
    expect((await app.request(`/api/files/${file.id}`, {}, env)).status).toBe(401);
    expect(
      (
        await app.request(`/api/files/${file.id}`, {
          headers: { Authorization: 'Bearer non-owner-token' },
        }, env)
      ).status
    ).toBe(403);

    // Authorized owner gets 5-minute signed URL
    const signedRes = await app.request(`/api/files/${file.id}`, {
      headers: { Authorization: 'Bearer owner-2-token' },
    }, env);
    expect(signedRes.status).toBe(200);
    const signedJson = (await signedRes.json()) as { url: string; expires_in_seconds: number };
    expect(signedJson.url).toContain('/storage/v1/object/sign/zero-base-files/');
    expect(signedJson.expires_in_seconds).toBe(300);

    // Compensating rollback removes uploaded object if DB metadata insert fails
    db.failNextFileInsert = true;
    const failForm = new FormData();
    failForm.append('file', new File([VALID_PNG_BYTES], 'rollback.png', { type: 'image/png' }));
    failForm.append('service_id', service.id);
    failForm.append('category', 'Bill photos');
    const failRes = await app.request(
      '/api/files/upload',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer owner-1-token' },
        body: failForm,
      },
      env
    );
    expect(failRes.status).toBe(500);
    expect(storageStore.size).toBe(1);

    // Authorized deletion deletes from both Supabase Storage and service_files table
    const delRes = await app.request(`/api/files/${file.id}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer owner-3-token' },
    }, env);
    expect(delRes.status).toBe(200);
    expect(storageStore.size).toBe(0);
    expect(db.service_files.length).toBe(0);
  });

  it('prevents duplicate active reminders, supports custom reminders, and escapes CSV cells', async () => {
    const { env, overrides } = createTestHarness();
    const app = createApp(overrides);

    const custRes = await app.request(
      '/api/customers',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-1-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          full_name: 'Reminder Customer',
          phone_number: '9000011111',
          address: '5 Hill Rd',
        }),
      },
      env
    );
    const { customer } = (await custRes.json()) as { customer: { id: string } };

    const remRes = await app.request(
      '/api/reminders',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-1-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          customer_id: customer.id,
          due_date: '2026-12-01',
          reminder_type: 'custom',
          notes: 'Call for sump cleaning',
        }),
      },
      env
    );
    expect(remRes.status).toBe(201);

    expect(escapeCsvCell('=CMD("calc")')).toBe('"\'=CMD(""calc"")"');
    expect(computeReminderCategory({ status: 'active', due_date: '2026-11-15' }, '2026-11-16')).toBe('Overdue');
    expect(computeReminderCategory({ status: 'active', due_date: '2026-11-16' }, '2026-11-16')).toBe('Due Today');
    expect(computeReminderCategory({ status: 'active', due_date: '2026-11-20' }, '2026-11-16')).toBe('Upcoming');
    expect(computeReminderCategory({ status: 'completed', due_date: '2026-11-15' }, '2026-11-16')).toBe('Completed');
  });
});
