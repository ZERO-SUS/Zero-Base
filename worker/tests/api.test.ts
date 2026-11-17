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

  it('supports itemized multi-category cart, itemized vs combined pricing, fixed & percentage discounts, edit reconciliation, and category deactivation history preservation', async () => {
    const { db, env, overrides } = createTestHarness();
    const app = createApp(overrides);

    // 1. Admin configures service categories (adds Pressure Washing and rejects zero active categories)
    const zeroActiveRes = await app.request(
      '/api/settings',
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer owner-1-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          service_categories: [{ name: 'Disabled Cat', active: false, kind: 'other' }],
        }),
      },
      env,
    );
    expect(zeroActiveRes.status).toBe(400);

    const addCatRes = await app.request(
      '/api/settings',
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer owner-1-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          service_categories: [
            { name: 'Overhead Tank Cleaning', active: true, kind: 'tank' },
            { name: 'Underground Sump Cleaning', active: true, kind: 'sump' },
            { name: 'Solar Panel Cleaning', active: true, kind: 'solar' },
            { name: 'Plumbing Services', active: true, kind: 'plumbing' },
            { name: 'Pressure Washing', active: true, kind: 'other' },
          ],
        }),
      },
      env,
    );
    expect(addCatRes.status).toBe(200);

    // 2. Rejects discount > subtotal cleanly
    const badDiscountRes = await app.request(
      '/api/services/unified',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-1-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          new_customer: {
            full_name: 'Cart Validation Customer',
            phone_number: '9988776655',
            address: '1 Test Street',
          },
          service_date: '2026-11-17',
          cart_groups: [
            {
              category_name: 'Overhead Tank Cleaning',
              pricing_mode: 'itemized',
              category_subtotal: 1000,
              items: [{ item_name: 'Tank 1', capacity_litres: 1000, quantity: 1, unit_price: 1000 }],
            },
          ],
          discount_type: 'fixed',
          discount_value: 1500,
        }),
      },
      env,
    );
    expect(badDiscountRes.status).toBe(400);

    // 3. Multi-category visit: Tank Cleaning (itemized: 2x1000L @600 + 1x5000L @1500 = 2700),
    //    Sump Cleaning (combined category total = 1800, item unit_price ignored so no double counting),
    //    Solar Panel Cleaning (20 panels @ 50 = 1000),
    //    Pressure Washing (itemized 500) -> Subtotal = 6000, 10% discount = 600, Grand Total = 5400, Partial Paid 2000
    const cartCreateRes = await app.request(
      '/api/services/unified',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-1-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          new_customer: {
            full_name: 'Multi Service Villa',
            phone_number: '+91 9000011111',
            address: '42 Palm Meadows',
            area: 'Whitefield',
          },
          service_date: '2026-11-10',
          cart_groups: [
            {
              category_name: 'Overhead Tank Cleaning',
              pricing_mode: 'itemized',
              category_subtotal: 0, // backend recomputes authoritatively
              items: [
                {
                  item_name: 'Block A Tanks',
                  capacity_litres: 1000,
                  quantity: 2,
                  unit_price: 600,
                },
                {
                  item_name: 'Main Tank',
                  capacity_litres: 5000,
                  quantity: 1,
                  unit_price: 1500,
                  description: 'Heavy scale',
                },
              ],
            },
            {
              category_name: 'Underground Sump Cleaning',
              pricing_mode: 'category_total',
              category_subtotal: 1800,
              items: [
                { item_name: 'Sump 1', capacity_litres: 10000, quantity: 1, unit_price: 999 },
                { item_name: 'Sump 2', capacity_litres: 5000, quantity: 1, unit_price: 999 },
              ],
            },
            {
              category_name: 'Solar Panel Cleaning',
              pricing_mode: 'itemized',
              category_subtotal: 0,
              items: [{ item_name: 'Rooftop Panels', quantity: 20, unit_price: 50 }],
            },
            {
              category_name: 'Pressure Washing',
              pricing_mode: 'itemized',
              category_subtotal: 0,
              items: [{ item_name: 'Terrace Floor', quantity: 1, unit_price: 500 }],
            },
          ],
          discount_type: 'percentage',
          discount_value: 10,
          initial_payment: {
            amount: 2000,
            payment_method: 'UPI',
            reference_number: 'UPI-CART-1',
          },
          reminder: { enabled: false },
        }),
      },
      env,
    );
    expect(cartCreateRes.status).toBe(201);
    const created = (await cartCreateRes.json()) as {
      service: {
        id: string;
        subtotal_amount: number;
        discount_type: string;
        discount_value: number;
        discount: number;
        total_amount: number;
        amount_paid: number;
        balance_amount: number;
        payment_status: string;
        service_categories_snapshot: string[];
      };
    };
    expect(created.service.subtotal_amount).toBe(6000);
    expect(created.service.discount_type).toBe('percentage');
    expect(created.service.discount_value).toBe(10);
    expect(created.service.discount).toBe(600);
    expect(created.service.total_amount).toBe(5400);
    expect(created.service.amount_paid).toBe(2000);
    expect(created.service.balance_amount).toBe(3400);
    expect(created.service.payment_status).toBe('Partially Paid');
    expect(created.service.service_categories_snapshot).toEqual([
      'Overhead Tank Cleaning',
      'Underground Sump Cleaning',
      'Solar Panel Cleaning',
      'Pressure Washing',
    ]);

    // 4. GET /api/services/:id loads full itemized category groups + items
    const detailRes = await app.request(`/api/services/${created.service.id}`, {
      headers: { Authorization: 'Bearer owner-2-token' },
    }, env);
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      category_groups: Array<{
        category_name: string;
        pricing_mode: string;
        category_subtotal: number;
        items: Array<{ item_name: string; unit_price: number; line_total: number }>;
      }>;
    };
    expect(detail.category_groups.length).toBe(4);
    expect(detail.category_groups[0].category_subtotal).toBe(2700);
    expect(detail.category_groups[1].pricing_mode).toBe('category_total');
    expect(detail.category_groups[1].category_subtotal).toBe(1800);
    // Item unit_price inside combined mode zeroed so no double counting
    expect(detail.category_groups[1].items[0].line_total).toBe(0);

    // 5. Search & Archive filter find multi-category visit by ANY category in snapshot
    const searchSolar = await app.request(
      `/api/search?service_type=${encodeURIComponent('Solar Panel Cleaning')}`,
      { headers: { Authorization: 'Bearer owner-1-token' } },
      env,
    );
    expect(((await searchSolar.json()) as { total: number }).total).toBe(1);

    const archiveSolar = await app.request(
      `/api/archive/summary?year=2026&month=11&service_type=${encodeURIComponent('Solar Panel Cleaning')}`,
      { headers: { Authorization: 'Bearer owner-1-token' } },
      env,
    );
    expect(((await archiveSolar.json()) as { month_services: unknown[] }).month_services.length).toBe(1);

    // 6. Deactivate "Pressure Washing" in Settings -> historical bill remains intact AND can still be edited,
    //    while NEW services cannot select the deactivated category
    const deactivateRes = await app.request(
      '/api/settings',
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer owner-1-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          service_categories: [
            { name: 'Overhead Tank Cleaning', active: true, kind: 'tank' },
            { name: 'Underground Sump Cleaning', active: true, kind: 'sump' },
            { name: 'Solar Panel Cleaning', active: true, kind: 'solar' },
            { name: 'Plumbing Services', active: true, kind: 'plumbing' },
            { name: 'Pressure Washing', active: false, kind: 'other' },
          ],
        }),
      },
      env,
    );
    expect(deactivateRes.status).toBe(200);

    // New visit using deactivated category is rejected
    const newInactiveRes = await app.request(
      '/api/services/unified',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-1-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          customer_id: db.customers[0].id,
          service_date: '2026-11-17',
          cart_groups: [
            {
              category_name: 'Pressure Washing',
              pricing_mode: 'itemized',
              category_subtotal: 400,
              items: [{ item_name: 'Patio', quantity: 1, unit_price: 400 }],
            },
          ],
          discount_type: 'fixed',
          discount_value: 0,
        }),
      },
      env,
    );
    expect(newInactiveRes.status).toBe(400);

    // 7. Edit existing historical cart: keeps historical "Pressure Washing", adjusts discount to fixed ₹500,
    //    and preserves existing payment (₹2000) without duplicating payment records
    const paymentCountBeforeEdit = db.payments.length;
    const editRes = await app.request(
      `/api/services/${created.service.id}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer owner-3-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          service_date: '2026-11-10',
          cart_groups: [
            {
              category_name: 'Overhead Tank Cleaning',
              pricing_mode: 'itemized',
              category_subtotal: 0,
              items: [{ item_name: 'Tank 1', capacity_litres: 2000, quantity: 1, unit_price: 1500 }],
            },
            {
              category_name: 'Pressure Washing',
              pricing_mode: 'itemized',
              category_subtotal: 0,
              items: [{ item_name: 'Terrace Floor', quantity: 1, unit_price: 1000 }],
            },
          ],
          discount_type: 'fixed',
          discount_value: 500,
        }),
      },
      env,
    );
    expect(editRes.status).toBe(200);
    const edited = (await editRes.json()) as {
      service: {
        subtotal_amount: number;
        discount: number;
        total_amount: number;
        amount_paid: number;
        balance_amount: number;
        payment_status: string;
        service_date: string;
      };
    };
    expect(db.payments.length).toBe(paymentCountBeforeEdit); // No duplicate payments created!
    expect(edited.service.service_date).toBe('2026-11-10');
    expect(edited.service.subtotal_amount).toBe(2500);
    expect(edited.service.discount).toBe(500);
    expect(edited.service.total_amount).toBe(2000);
    expect(edited.service.amount_paid).toBe(2000);
    expect(edited.service.balance_amount).toBe(0);
    expect(edited.service.payment_status).toBe('Paid');
  });

  it('supports automatic drafts, immediate draft image uploads with failure/retry/rollback, idempotent checkout, and private file access', async () => {
    const { db, env, overrides, storageStore } = createTestHarness();
    const app = createApp(overrides);

    const VALID_JPEG_BYTES = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9,
    ]);
    const VALID_WEBP_BYTES = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50,
    ]);

    // 1. Owner 1 saves an active draft automatically
    const saveDraft1 = await app.request(
      '/api/drafts/active',
      {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer owner-1-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          idempotency_key: 'draft-key-1',
          draft_payload: {
            customerMode: 'new',
            newCustomer: {
              full_name: 'Suresh Verma',
              phone_number: '9880011223',
              address: '12 HSR Layout',
            },
            cartGroups: [
              {
                category_name: 'Overhead Tank Cleaning',
                kind: 'tank',
                pricing_mode: 'itemized',
                items: [{ item_name: 'Tank 1', capacity_litres: '1000', quantity: 1, unit_price: '600' }],
              },
            ],
          },
        }),
      },
      env
    );
    expect(saveDraft1.status).toBe(201);
    const { draft } = (await saveDraft1.json()) as { draft: { id: string } };

    // Owner 2 cannot see or overwrite Owner 1's draft (per-owner isolation)
    const owner2Get = await app.request(
      '/api/drafts/active',
      { headers: { Authorization: 'Bearer owner-2-token' } },
      env
    );
    const owner2Json = (await owner2Get.json()) as { draft: unknown };
    expect(owner2Json.draft).toBeNull();

    // 2. Upload Before Service mobile JPEG photo + After Service PNG photo into draft
    const formBefore = new FormData();
    formBefore.append(
      'file',
      new File([VALID_JPEG_BYTES], 'mobile_camera_before.jpg', { type: 'image/jpeg' })
    );
    formBefore.append('category', 'Before-Service Area Photos');

    const upBefore = await app.request(
      `/api/drafts/${draft.id}/files`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer owner-1-token' },
        body: formBefore,
      },
      env
    );
    expect(upBefore.status).toBe(201);
    const upBeforeJson = (await upBefore.json()) as {
      file: { id: string; signed_url: string; category: string };
    };
    expect(upBeforeJson.file.signed_url).toContain('signed-ttl-');

    // 3. Reject oversized (>15MB) upload with friendly plain-English message
    const oversizedBytes = new Uint8Array(15 * 1024 * 1024 + 10);
    oversizedBytes[0] = 0xff;
    oversizedBytes[1] = 0xd8;
    oversizedBytes[2] = 0xff;
    const formBig = new FormData();
    formBig.append('file', new File([oversizedBytes], 'huge_camera.jpg', { type: 'image/jpeg' }));
    formBig.append('category', 'After-Service Area Photos');
    const upBig = await app.request(
      `/api/drafts/${draft.id}/files`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer owner-1-token' },
        body: formBig,
      },
      env
    );
    expect(upBig.status).toBe(400);
    const upBigJson = (await upBig.json()) as { error: string };
    expect(upBigJson.error).toContain('15 MB');

    // 4. Simulate failed Storage upload -> retry succeeds
    db.failNextStorageUpload = true;
    const formAfter = new FormData();
    formAfter.append('file', new File([VALID_WEBP_BYTES], 'after_tank.webp', { type: 'image/webp' }));
    formAfter.append('category', 'After-Service Area Photos');
    const upFail = await app.request(
      `/api/drafts/${draft.id}/files`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer owner-1-token' },
        body: formAfter,
      },
      env
    );
    expect(upFail.status).toBe(502);
    const upFailJson = (await upFail.json()) as { retryable: boolean; error: string };
    expect(upFailJson.retryable).toBe(true);
    expect(upFailJson.error).toBe("Photo couldn't be uploaded. Please try again.");

    // Retry same file -> succeeds!
    const upRetry = await app.request(
      `/api/drafts/${draft.id}/files`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer owner-1-token' },
        body: formAfter,
      },
      env
    );
    expect(upRetry.status).toBe(201);

    // 5. Simulate DB failure after storage upload -> compensating cleanup prevents orphan storage object
    db.failNextFileInsert = true;
    const formDbFail = new FormData();
    formDbFail.append('file', new File([VALID_PNG_BYTES], 'receipt.png', { type: 'image/png' }));
    formDbFail.append('category', 'Other Attachments');
    const upDbFail = await app.request(
      `/api/drafts/${draft.id}/files`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer owner-1-token' },
        body: formDbFail,
      },
      env
    );
    expect(upDbFail.status).toBe(500);
    expect(storageStore.size).toBe(2); // Rolled back cleanly; only the 2 successful photos exist!

    // 6. Simulate returning after navigation / refresh: GET /api/drafts/active restores draft + signed previews
    const restoredRes = await app.request(
      '/api/drafts/active',
      { headers: { Authorization: 'Bearer owner-1-token' } },
      env
    );
    expect(restoredRes.status).toBe(200);
    const restored = (await restoredRes.json()) as {
      draft: { id: string; draft_payload: { newCustomer: { full_name: string } } };
      files: Array<{ id: string; signed_url: string }>;
    };
    expect(restored.draft.draft_payload.newCustomer.full_name).toBe('Suresh Verma');
    expect(restored.files).toHaveLength(2);
    expect(restored.files[0].signed_url).toContain('signed-ttl-');

    // 7. Complete checkout using draft_id -> links draft attachments to service_files + completes draft
    const checkoutPayload = {
      new_customer: {
        full_name: 'Suresh Verma',
        phone_number: '9880011223',
        address: '12 HSR Layout',
      },
      service_date: '2026-11-17',
      cart_groups: [
        {
          category_name: 'Overhead Tank Cleaning',
          pricing_mode: 'itemized',
          category_subtotal: 600,
          items: [{ item_name: 'Tank 1', capacity_litres: 1000, quantity: 1, unit_price: 600 }],
        },
      ],
      discount_type: 'fixed',
      discount_value: 0,
      idempotency_key: 'draft-key-1',
      draft_id: draft.id,
      initial_payment: { amount: 600, payment_method: 'UPI', reference_number: 'UPI-DRAFT-1' },
      reminder: { enabled: false },
    };

    const checkout1 = await app.request(
      '/api/services/unified',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-1-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(checkoutPayload),
      },
      env
    );
    expect(checkout1.status).toBe(201);
    const c1Json = (await checkout1.json()) as {
      service: { id: string };
      linked_files_count: number;
    };
    expect(c1Json.linked_files_count).toBe(2);

    // Completed draft is no longer returned on GET /api/drafts/active
    const afterCompleteDraft = await app.request(
      '/api/drafts/active',
      { headers: { Authorization: 'Bearer owner-1-token' } },
      env
    );
    expect(((await afterCompleteDraft.json()) as { draft: unknown }).draft).toBeNull();

    // Repeated checkout click with same draft_id / idempotency_key does NOT create duplicate service
    const checkoutDup = await app.request(
      '/api/services/unified',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-1-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(checkoutPayload),
      },
      env
    );
    expect(checkoutDup.status).toBe(200);
    expect(((await checkoutDup.json()) as { deduplicated: boolean }).deduplicated).toBe(true);
    expect(db.services.filter((s) => s.id === c1Json.service.id)).toHaveLength(1);

    // Linked files appear on GET /api/services/:id and private access works via signed URL
    const srvDetailRes = await app.request(
      `/api/services/${c1Json.service.id}`,
      { headers: { Authorization: 'Bearer owner-1-token' } },
      env
    );
    const srvDetail = (await srvDetailRes.json()) as {
      files: Array<{ id: string }>;
    };
    expect(srvDetail.files).toHaveLength(2);

    const privUnauth = await app.request(`/api/files/${srvDetail.files[0].id}`, {}, env);
    expect(privUnauth.status).toBe(401);

    const privAuth = await app.request(
      `/api/files/${srvDetail.files[0].id}`,
      { headers: { Authorization: 'Bearer owner-1-token' } },
      env
    );
    expect(privAuth.status).toBe(200);

    // 8. Discard Draft cleans unlinked storage files cleanly
    const d2Res = await app.request(
      '/api/drafts/active',
      {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer owner-1-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ draft_payload: { notes: 'Discard me' } }),
      },
      env
    );
    const d2 = (await d2Res.json()) as { draft: { id: string } };
    const discardUpload = new FormData();
    discardUpload.append('file', new File([VALID_PNG_BYTES], 'temp.png', { type: 'image/png' }));
    discardUpload.append('category', 'Before-Service Area Photos');
    await app.request(
      `/api/drafts/${d2.draft.id}/files`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer owner-1-token' },
        body: discardUpload,
      },
      env
    );
    expect(storageStore.size).toBe(3);

    const discardRes = await app.request(
      `/api/drafts/${d2.draft.id}`,
      {
        method: 'DELETE',
        headers: { Authorization: 'Bearer owner-1-token' },
      },
      env
    );
    expect(discardRes.status).toBe(200);
    expect(storageStore.size).toBe(2); // Temp draft file cleaned up; saved service photos preserved!
  });
});
