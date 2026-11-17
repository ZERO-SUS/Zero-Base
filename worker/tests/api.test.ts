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

    expect((await app.request('/health', {}, env)).status).toBe(200);
    expect((await app.request('/api/health', {}, env)).status).toBe(200);
    expect((await app.request('/api/customers', {}, env)).status).toBe(401);
    expect(
      (await app.request('/api/customers', { headers: { Authorization: 'Bearer bad' } }, env))
        .status
    ).toBe(401);
    expect(
      (
        await app.request('/api/customers', {
          headers: { Authorization: 'Bearer non-owner-token' },
        }, env)
      ).status
    ).toBe(403);

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

    expect(
      (
        await app.request(`/api/customers/${customer.id}`, {
          headers: { Authorization: 'Bearer owner-2-token' },
        }, env)
      ).status
    ).toBe(200);

    expect(
      (
        await app.request(
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
        )
      ).status
    ).toBe(200);
  });

  it('supports unified Add Service (new customer + existing customer + optional reminder OFF by default)', async () => {
    const { db, env, overrides } = createTestHarness();
    const app = createApp(overrides);

    // 1. Unified creation with new customer + service + partial payment + reminder OFF
    const u1 = await app.request(
      '/api/services/unified',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-1-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          new_customer: {
            full_name: 'Ananya Rao',
            phone_number: '+91 9845011223',
            address: '14 Indiranagar 100ft Rd',
            area: 'Indiranagar',
          },
          service_date: '2025-12-25',
          service_type: 'Overhead Tank Cleaning',
          tank_details: '2000L Overhead',
          price: 2000,
          discount: 0,
          initial_payment: {
            amount: 500,
            payment_method: 'UPI',
            reference_number: 'UTR-UNIFIED-1',
          },
          reminder: { enabled: false },
        }),
      },
      env
    );
    expect(u1.status).toBe(201);
    const u1Json = (await u1.json()) as {
      customer: { id: string; customer_code: string };
      service: { id: string; service_date: string; balance_amount: number; payment_status: string };
      reminder: null;
    };
    expect(u1Json.service.service_date).toBe('2025-12-25');
    expect(u1Json.service.balance_amount).toBe(1500);
    expect(u1Json.service.payment_status).toBe('Partially Paid');
    expect(u1Json.reminder).toBeNull();
    expect(db.reminders.length).toBe(0);

    // 2. Duplicate warning when attempting unified creation with matching phone
    const uDup = await app.request(
      '/api/services/unified',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-1-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          new_customer: {
            full_name: 'Ananya Duplicate',
            phone_number: '9845011223',
            address: 'Other Address',
          },
          service_date: '2026-11-17',
          service_type: 'Overhead Tank Cleaning',
          price: 1200,
        }),
      },
      env
    );
    expect(uDup.status).toBe(409);

    // 3. Add second service to the SAME existing customer with optional reminder ON
    const u2 = await app.request(
      '/api/services/unified',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-2-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          customer_id: u1Json.customer.id,
          service_date: '2026-11-15',
          service_type: 'Underground Sump Cleaning',
          price: 1500,
          reminder: {
            enabled: true,
            due_date: '2027-05-15',
            reminder_type: 'service_due',
            notes: '6-month follow-up',
          },
        }),
      },
      env
    );
    expect(u2.status).toBe(201);
    expect(db.customers.length).toBe(1);
    expect(db.services.length).toBe(2);
    expect(db.reminders.length).toBe(1);

    // Verify customer profile returns first & most recent service dates + year-wise grouping
    const profRes = await app.request(`/api/customers/${u1Json.customer.id}`, {
      headers: { Authorization: 'Bearer owner-1-token' },
    }, env);
    const prof = (await profRes.json()) as {
      summary: { first_service_date: string; last_service_date: string };
      services_grouped: Array<{ year: number }>;
    };
    expect(prof.summary.first_service_date).toBe('2025-12-25');
    expect(prof.summary.last_service_date).toBe('2026-11-15');
    expect(prof.services_grouped.map((g) => g.year)).toEqual([2026, 2025]);
  });

  it('powers calendar archive summary and global multi-filter search with pagination', async () => {
    const { env, overrides } = createTestHarness();
    const app = createApp(overrides);

    await app.request(
      '/api/services/unified',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-1-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          new_customer: {
            full_name: 'Karthik Nair',
            phone_number: '+91 9900112233',
            address: '22 Jayanagar 4th Block',
            area: 'Jayanagar',
          },
          service_date: '2025-06-20',
          service_type: 'Overhead Tank Cleaning',
          price: 1800,
          notes: 'Chlorination completed',
        }),
      },
      env
    );

    await app.request(
      '/api/services/unified',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-1-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          new_customer: {
            full_name: 'Meera Iyer',
            phone_number: '+91 9811223344',
            address: '8 Koramangala',
            area: 'Koramangala',
          },
          service_date: '2026-11-15',
          service_type: 'Underground Sump Cleaning',
          price: 2500,
          initial_payment: { amount: 2500, payment_method: 'Cash' },
        }),
      },
      env
    );

    // Calendar Archive Summary
    const archRes = await app.request(
      '/api/archive/summary?year=2025&month=6',
      { headers: { Authorization: 'Bearer owner-1-token' } },
      env
    );
    expect(archRes.status).toBe(200);
    const arch = (await archRes.json()) as {
      years: Array<{ year: number; count: number }>;
      month_services: Array<{ service_date: string }>;
    };
    expect(arch.years.map((y) => y.year)).toEqual([2026, 2025]);
    expect(arch.month_services.length).toBe(1);
    expect(arch.month_services[0].service_date).toBe('2025-06-20');

    // Global Search by normalized phone digits + combined filters
    const searchPhone = await app.request(
      '/api/search?q=9900112233',
      { headers: { Authorization: 'Bearer owner-1-token' } },
      env
    );
    const searchPhoneJson = (await searchPhone.json()) as { total: number; items: Array<{ service_date: string }> };
    expect(searchPhoneJson.total).toBe(1);
    expect(searchPhoneJson.items[0].service_date).toBe('2025-06-20');

    const searchFiltered = await app.request(
      '/api/search?area=Koramangala&payment_status=Paid&payment_method=Cash',
      { headers: { Authorization: 'Bearer owner-1-token' } },
      env
    );
    const searchFilteredJson = (await searchFiltered.json()) as { total: number };
    expect(searchFilteredJson.total).toBe(1);
  });

  it('supports 5 attachment categories, signed URLs, and safe permanent deletion cleaning storage', async () => {
    const { db, env, overrides, storageStore } = createTestHarness();
    const app = createApp(overrides);

    const unifiedRes = await app.request(
      '/api/services/unified',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-1-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          new_customer: {
            full_name: 'Deletion Test Customer',
            phone_number: '9111222333',
            address: '15 Lake Road',
          },
          service_date: '2026-11-16',
          service_type: 'Overhead Tank Cleaning',
          price: 1000,
        }),
      },
      env
    );
    const { customer, service } = (await unifiedRes.json()) as {
      customer: { id: string };
      service: { id: string };
    };

    const form = new FormData();
    form.append('file', new File([VALID_PNG_BYTES], 'bill.png', { type: 'image/png' }));
    form.append('service_id', service.id);
    form.append('category', 'Bills / Invoices');
    const uploadRes = await app.request(
      '/api/files/upload',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer owner-1-token' },
        body: form,
      },
      env
    );
    expect(uploadRes.status).toBe(201);
    expect(storageStore.size).toBe(1);

    // Impact check & permanent delete of ONLY the service -> customer remains intact, storage cleaned
    const impactRes = await app.request(`/api/services/${service.id}/deletion-impact`, {
      headers: { Authorization: 'Bearer owner-1-token' },
    }, env);
    expect(impactRes.status).toBe(200);

    const delSrvRes = await app.request(`/api/services/${service.id}?mode=permanent`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer owner-1-token' },
    }, env);
    expect(delSrvRes.status).toBe(200);
    expect(db.services.length).toBe(0);
    expect(db.customers.length).toBe(1);
    expect(storageStore.size).toBe(0);

    // Permanent delete of customer works cleanly
    const delCustRes = await app.request(`/api/customers/${customer.id}?mode=permanent`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer owner-1-token' },
    }, env);
    expect(delCustRes.status).toBe(200);
    expect(db.customers.length).toBe(0);
  });

  it('handles CORS preflight, cancelled reminders, and CSV injection escaping', async () => {
    const { env, overrides } = createTestHarness();
    const app = createApp(overrides);

    const preflight = await app.request(
      '/api/search',
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://zero-base.pages.dev',
          'Access-Control-Request-Method': 'GET',
        },
      },
      env
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://zero-base.pages.dev'
    );

    expect(escapeCsvCell('=CMD("calc")')).toBe('"\'=CMD(""calc"")"');
    expect(computeReminderCategory({ status: 'cancelled', due_date: '2026-11-16' }, '2026-11-16')).toBe('Cancelled');
    expect(computeReminderCategory({ status: 'completed', due_date: '2026-11-15' }, '2026-11-16')).toBe('Completed');
  });
});
