import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env, ServiceOverrides } from '../../src/types';

export interface InMemoryDb {
  profiles: Array<Record<string, unknown>>;
  customers: Array<Record<string, unknown>>;
  services: Array<Record<string, unknown>>;
  payments: Array<Record<string, unknown>>;
  attachments: Array<Record<string, unknown>>;
  reminders: Array<Record<string, unknown>>;
  audit_logs: Array<Record<string, unknown>>;
  business_settings: Array<Record<string, unknown>>;
  failNextAttachmentInsert: boolean;
}

export function createInitialDb(): InMemoryDb {
  return {
    profiles: [
      {
        id: '11111111-1111-1111-1111-111111111111',
        email: 'admin@zerobase.local',
        full_name: 'Primary Admin',
        role: 'admin',
        is_active: true,
        theme_mode: 'dark',
        accent_color: '#2563EB',
      },
      {
        id: '22222222-2222-2222-2222-222222222222',
        email: 'staff@zerobase.local',
        full_name: 'Field Staff',
        role: 'staff',
        is_active: true,
        theme_mode: 'light',
        accent_color: '#059669',
      },
      {
        id: '33333333-3333-3333-3333-333333333333',
        email: 'disabled@zerobase.local',
        full_name: 'Disabled User',
        role: 'staff',
        is_active: false,
        theme_mode: 'light',
        accent_color: '#2563EB',
      },
    ],
    customers: [],
    services: [],
    payments: [],
    attachments: [],
    reminders: [],
    audit_logs: [],
    business_settings: [
      {
        id: '99999999-9999-9999-9999-999999999999',
        singleton_key: true,
        app_name: 'ZERO BASE',
        timezone: 'Asia/Kolkata',
        currency_code: 'INR',
        currency_symbol: '₹',
        service_types: ['Overhead Tank Cleaning', 'Underground Sump Cleaning'],
        default_reminder_months: 6,
      },
    ],
    failNextAttachmentInsert: false,
  };
}

function normalizePhone(val: unknown): string {
  return String(val ?? '').replace(/\D/g, '');
}

function recalcServiceFinancials(db: InMemoryDb, serviceId: string) {
  const srv = db.services.find((s) => s.service_id === serviceId);
  if (!srv) return;

  const totalAmount = Number((Number(srv.price) - Number(srv.discount ?? 0)).toFixed(2));
  srv.total_amount = totalAmount;

  const activePayments = db.payments.filter(
    (p) => p.service_id === serviceId && !p.archived_at
  );
  const grossPaid = activePayments
    .filter((p) => p.payment_type === 'payment')
    .reduce((acc, p) => acc + Number(p.amount), 0);
  const refunded = activePayments
    .filter((p) => p.payment_type === 'refund')
    .reduce((acc, p) => acc + Number(p.amount), 0);
  const netPaid = Math.max(0, Number((grossPaid - refunded).toFixed(2)));
  srv.amount_paid = netPaid;

  if (refunded > 0 && netPaid <= 0) {
    srv.payment_status = 'Refunded';
  } else if (totalAmount === 0) {
    srv.payment_status = 'Paid';
  } else if (netPaid <= 0) {
    srv.payment_status = 'Unpaid';
  } else if (netPaid < totalAmount) {
    srv.payment_status = 'Partially Paid';
  } else {
    srv.payment_status = 'Paid';
  }
}

export function createMockR2Bucket() {
  const store = new Map<
    string,
    {
      data: Uint8Array;
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
      uploaded: Date;
    }
  >();

  const bucket = {
    async put(key: string, value: ArrayBuffer | Uint8Array | string, options?: R2PutOptions) {
      let bytes: Uint8Array;
      if (typeof value === 'string') {
        bytes = new TextEncoder().encode(value);
      } else if (value instanceof ArrayBuffer) {
        bytes = new Uint8Array(value);
      } else {
        bytes = new Uint8Array(value);
      }
      store.set(key, {
        data: bytes,
        httpMetadata: options?.httpMetadata as { contentType?: string } | undefined,
        customMetadata: options?.customMetadata,
        uploaded: new Date(),
      });
      return { key, size: bytes.byteLength } as unknown as R2Object;
    },
    async get(key: string) {
      const item = store.get(key);
      if (!item) return null;
      return {
        key,
        size: item.data.byteLength,
        httpMetadata: item.httpMetadata ?? {},
        customMetadata: item.customMetadata ?? {},
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(item.data);
            controller.close();
          },
        }),
        async arrayBuffer() {
          return item.data.buffer.slice(
            item.data.byteOffset,
            item.data.byteOffset + item.data.byteLength
          );
        },
      } as unknown as R2ObjectBody;
    },
    async delete(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) {
        store.delete(k);
      }
    },
    async list(options?: R2ListOptions) {
      const prefix = options?.prefix ?? '';
      const objects = Array.from(store.entries())
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, val]) => ({
          key,
          size: val.data.byteLength,
          uploaded: val.uploaded,
        }));
      return {
        objects,
        truncated: false,
      } as unknown as R2Objects;
    },
  };

  return { bucket: bucket as unknown as R2Bucket, store };
}

class MockQueryBuilder {
  private filters: Array<(row: Record<string, unknown>) => boolean> = [];
  private orders: Array<{ col: string; asc: boolean }> = [];
  private limitNum: number | null = null;
  private op: 'select' | 'insert' | 'update' = 'select';
  private payload: Record<string, unknown> | Array<Record<string, unknown>> | null = null;

  constructor(
    private db: InMemoryDb,
    private table: keyof InMemoryDb
  ) {}

  select(_cols?: string) {
    return this;
  }

  insert(data: Record<string, unknown> | Array<Record<string, unknown>>) {
    this.op = 'insert';
    this.payload = data;
    return this;
  }

  update(data: Record<string, unknown>) {
    this.op = 'update';
    this.payload = data;
    return this;
  }

  eq(col: string, val: unknown) {
    this.filters.push((r) => r[col] === val);
    return this;
  }

  is(col: string, val: unknown) {
    this.filters.push((r) => (r[col] ?? null) === val);
    return this;
  }

  in(col: string, vals: unknown[]) {
    this.filters.push((r) => vals.includes(r[col]));
    return this;
  }

  gte(col: string, val: string) {
    this.filters.push((r) => String(r[col] ?? '') >= val);
    return this;
  }

  lte(col: string, val: string) {
    this.filters.push((r) => String(r[col] ?? '') <= val);
    return this;
  }

  or(expr: string) {
    // Parse simple `col.ilike.%val%` clauses
    const parts = expr.split(',').map((p) => p.trim());
    this.filters.push((r) =>
      parts.some((p) => {
        const m = p.match(/^([^.]+)\.ilike\.%(.+)%$/);
        if (!m) return false;
        const [, col, term] = m;
        return String(r[col] ?? '')
          .toLowerCase()
          .includes(term.toLowerCase());
      })
    );
    return this;
  }

  order(col: string, opts?: { ascending?: boolean }) {
    this.orders.push({ col, asc: opts?.ascending ?? true });
    return this;
  }

  limit(n: number) {
    this.limitNum = n;
    return this;
  }

  private enrichRow(row: Record<string, unknown>): Record<string, unknown> {
    const copy = { ...row };
    if (this.table === 'services') {
      const cust = this.db.customers.find((c) => c.customer_id === row.customer_id);
      if (cust) copy.customers = { ...cust };
    }
    if (this.table === 'payments') {
      const srv = this.db.services.find((s) => s.service_id === row.service_id);
      if (srv) {
        const cust = this.db.customers.find((c) => c.customer_id === srv.customer_id);
        copy.services = { ...srv, customers: cust ? { ...cust } : undefined };
      }
    }
    if (this.table === 'reminders') {
      const cust = this.db.customers.find((c) => c.customer_id === row.customer_id);
      const srv = this.db.services.find((s) => s.service_id === row.service_id);
      if (cust) copy.customers = { ...cust };
      if (srv) copy.services = { ...srv };
    }
    return copy;
  }

  private execute(): { data: unknown; error: null | { message: string } } {
    const rows = this.db[this.table] as Array<Record<string, unknown>>;

    if (this.op === 'insert' && this.payload) {
      if (this.table === 'attachments' && this.db.failNextAttachmentInsert) {
        this.db.failNextAttachmentInsert = false;
        return { data: null, error: { message: 'Simulated DB insert failure' } };
      }
      const list = Array.isArray(this.payload) ? this.payload : [this.payload];
      const inserted: Array<Record<string, unknown>> = [];
      for (const item of list) {
        const rec: Record<string, unknown> = {
          ...item,
          created_at: item.created_at ?? new Date().toISOString(),
          updated_at: item.updated_at ?? new Date().toISOString(),
          archived_at: item.archived_at ?? null,
        };
        if (this.table === 'customers' && !rec.customer_id) rec.customer_id = crypto.randomUUID();
        if (this.table === 'services' && !rec.service_id) {
          rec.service_id = crypto.randomUUID();
          rec.discount = rec.discount ?? 0;
        }
        if (this.table === 'payments' && !rec.payment_id) rec.payment_id = crypto.randomUUID();
        if (this.table === 'attachments' && !rec.attachment_id) {
          rec.attachment_id = crypto.randomUUID();
        }
        if (this.table === 'reminders' && !rec.reminder_id) rec.reminder_id = crypto.randomUUID();
        if (this.table === 'audit_logs' && !rec.audit_id) rec.audit_id = crypto.randomUUID();

        rows.push(rec);

        if (this.table === 'services') {
          recalcServiceFinancials(this.db, String(rec.service_id));
          if (rec.next_due_date) {
            this.db.reminders.push({
              reminder_id: crypto.randomUUID(),
              service_id: rec.service_id,
              customer_id: rec.customer_id,
              due_date: rec.next_due_date,
              status: 'active',
              snoozed_until: null,
              notes: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              archived_at: null,
            });
          }
        }
        if (this.table === 'payments') {
          recalcServiceFinancials(this.db, String(rec.service_id));
        }

        inserted.push(this.enrichRow(rec));
      }
      return { data: inserted, error: null };
    }

    if (this.op === 'update' && this.payload) {
      const matched = rows.filter((r) => this.filters.every((f) => f(r)));
      for (const r of matched) {
        Object.assign(r, this.payload, { updated_at: new Date().toISOString() });
        if (this.table === 'services') {
          recalcServiceFinancials(this.db, String(r.service_id));
        }
        if (this.table === 'payments') {
          recalcServiceFinancials(this.db, String(r.service_id));
        }
      }
      return { data: matched.map((r) => this.enrichRow(r)), error: null };
    }

    let result = rows.filter((r) => this.filters.every((f) => f(r))).map((r) => this.enrichRow(r));
    for (let i = this.orders.length - 1; i >= 0; i -= 1) {
      const { col, asc } = this.orders[i];
      result.sort((a, b) => {
        const av = String(a[col] ?? '');
        const bv = String(b[col] ?? '');
        return asc ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    if (this.limitNum !== null) {
      result = result.slice(0, this.limitNum);
    }
    return { data: result, error: null };
  }

  async single() {
    const res = this.execute();
    if (res.error) return res;
    const arr = res.data as Array<Record<string, unknown>>;
    if (arr.length === 0) return { data: null, error: { message: 'Row not found' } };
    return { data: arr[0], error: null };
  }

  async maybeSingle() {
    const res = this.execute();
    if (res.error) return res;
    const arr = res.data as Array<Record<string, unknown>>;
    return { data: arr[0] ?? null, error: null };
  }

  then<TResult1 = { data: unknown; error: null | { message: string } }>(
    onfulfilled?: ((value: { data: unknown; error: null | { message: string } }) => TResult1) | null
  ) {
    return Promise.resolve(this.execute()).then(onfulfilled ?? undefined);
  }
}

export function createTestHarness() {
  const db = createInitialDb();
  const { bucket, store } = createMockR2Bucket();

  const env: Env = {
    FILES_BUCKET: bucket,
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_ANON_KEY: 'test-anon-key',
    FILE_SIGNING_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    ENVIRONMENT: 'test',
    BUSINESS_TIMEZONE: 'Asia/Kolkata',
    MAX_UPLOAD_BYTES: '15728640',
  };

  const mockSupabase = {
    from(table: keyof InMemoryDb) {
      return new MockQueryBuilder(db, table);
    },
    async rpc(name: string, params?: Record<string, unknown>) {
      if (name === 'find_duplicate_customers') {
        const phone = String(params?.p_phone ?? '');
        const norm = normalizePhone(phone);
        const matches = db.customers.filter((c) => {
          const p1 = normalizePhone(c.primary_phone);
          const p2 = normalizePhone(c.secondary_phone);
          return (
            c.primary_phone === phone ||
            c.secondary_phone === phone ||
            (norm.length >= 6 &&
              (p1 === norm ||
                p2 === norm ||
                p1.slice(-10) === norm.slice(-10) ||
                (p2.length > 0 && p2.slice(-10) === norm.slice(-10))))
          );
        });
        return { data: matches, error: null };
      }

      if (name === 'get_dashboard_metrics') {
        const activeCustomers = db.customers.filter((c) => !c.archived_at);
        const activeServices = db.services.filter((s) => !s.archived_at);
        return {
          data: {
            today_ist: '2026-11-16',
            total_customers: activeCustomers.length,
            total_services: activeServices.length,
            services_this_month: activeServices.length,
            services_this_year: activeServices.length,
            todays_services: 0,
            upcoming_reminders: db.reminders.filter((r) => !r.archived_at && r.status === 'active').length,
            due_today: 0,
            overdue_services: 0,
            pending_payments_amount: activeServices.reduce(
              (acc, s) => acc + Math.max(0, Number(s.total_amount) - Number(s.amount_paid)),
              0
            ),
            pending_payments_count: activeServices.filter(
              (s) => s.payment_status === 'Unpaid' || s.payment_status === 'Partially Paid'
            ).length,
            revenue_this_month: 0,
            revenue_this_year: 0,
          },
          error: null,
        };
      }

      if (name === 'get_reports_summary') {
        const start = String(params?.p_start_date ?? '2000-01-01');
        const end = String(params?.p_end_date ?? '2099-12-31');
        const srvs = db.services.filter(
          (s) => !s.archived_at && String(s.service_date) >= start && String(s.service_date) <= end
        );
        const pays = db.payments.filter(
          (p) => !p.archived_at && String(p.payment_date) >= start && String(p.payment_date) <= end
        );
        return {
          data: {
            start_date: start,
            end_date: end,
            total_services: srvs.length,
            total_billed: srvs.reduce((a, s) => a + Number(s.total_amount), 0),
            outstanding_balance: srvs.reduce(
              (a, s) => a + Math.max(0, Number(s.total_amount) - Number(s.amount_paid)),
              0
            ),
            total_collected: pays.reduce(
              (a, p) => a + (p.payment_type === 'payment' ? Number(p.amount) : -Number(p.amount)),
              0
            ),
            cash_payments: pays
              .filter((p) => p.payment_method === 'Cash')
              .reduce((a, p) => a + Number(p.amount), 0),
            upi_payments: pays
              .filter((p) => p.payment_method === 'UPI')
              .reduce((a, p) => a + Number(p.amount), 0),
            other_payments: pays
              .filter((p) => p.payment_method === 'Other')
              .reduce((a, p) => a + Number(p.amount), 0),
            service_type_breakdown: [],
          },
          error: null,
        };
      }

      return { data: null, error: { message: `Unknown RPC ${name}` } };
    },
  } as unknown as SupabaseClient;

  const overrides: ServiceOverrides = {
    async verifyJwt(token) {
      if (token === 'admin-token') {
        return { sub: '11111111-1111-1111-1111-111111111111', email: 'admin@zerobase.local' };
      }
      if (token === 'staff-token') {
        return { sub: '22222222-2222-2222-2222-222222222222', email: 'staff@zerobase.local' };
      }
      if (token === 'disabled-token') {
        return { sub: '33333333-3333-3333-3333-333333333333', email: 'disabled@zerobase.local' };
      }
      throw new Error('Invalid token');
    },
    createSupabase() {
      return mockSupabase;
    },
  };

  return { db, env, overrides, r2Store: store };
}
