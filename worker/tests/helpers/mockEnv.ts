import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env, ServiceOverrides } from '../../src/types';

export const OWNER_IDS = [
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  '33333333-3333-3333-3333-333333333333',
] as const;

export const NON_OWNER_ID = '44444444-4444-4444-4444-444444444444';

export interface InMemoryDb {
  owner_allowlist: Array<Record<string, unknown>>;
  profiles: Array<Record<string, unknown>>;
  customers: Array<Record<string, unknown>>;
  services: Array<Record<string, unknown>>;
  payments: Array<Record<string, unknown>>;
  service_files: Array<Record<string, unknown>>;
  reminders: Array<Record<string, unknown>>;
  audit_logs: Array<Record<string, unknown>>;
  business_settings: Array<Record<string, unknown>>;
  failNextFileInsert: boolean;
  customerSeq: number;
}

export function createInitialDb(): InMemoryDb {
  return {
    owner_allowlist: [
      { user_id: OWNER_IDS[0], label: 'Owner Login 1', is_active: true },
      { user_id: OWNER_IDS[1], label: 'Owner Login 2', is_active: true },
      { user_id: OWNER_IDS[2], label: 'Owner Login 3', is_active: true },
    ],
    profiles: [
      {
        id: OWNER_IDS[0],
        email: 'owner1@zerobase.local',
        full_name: 'Owner Login 1',
        role: 'admin',
        theme_mode: 'dark',
        accent_color: '#2563EB',
      },
      {
        id: OWNER_IDS[1],
        email: 'owner2@zerobase.local',
        full_name: 'Owner Login 2',
        role: 'admin',
        theme_mode: 'light',
        accent_color: '#2563EB',
      },
      {
        id: OWNER_IDS[2],
        email: 'owner3@zerobase.local',
        full_name: 'Owner Login 3',
        role: 'admin',
        theme_mode: 'system',
        accent_color: '#2563EB',
      },
    ],
    customers: [],
    services: [],
    payments: [],
    service_files: [],
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
    failNextFileInsert: false,
    customerSeq: 1,
  };
}

function normalizePhone(val: unknown): string {
  return String(val ?? '').replace(/\D/g, '');
}

function recalcServiceFinancials(db: InMemoryDb, serviceId: string) {
  const srv = db.services.find((s) => s.id === serviceId);
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
  srv.balance_amount = Math.max(0, Number((totalAmount - netPaid).toFixed(2)));

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

export function createMockSupabaseStorage() {
  const store = new Map<string, { data: Uint8Array; contentType: string; updatedAt: string }>();

  return {
    store,
    from(bucket: string) {
      if (bucket !== 'zero-base-files') {
        throw new Error(`Unexpected bucket: ${bucket}`);
      }
      return {
        async upload(path: string, body: Uint8Array, opts?: { contentType?: string }) {
          store.set(path, {
            data: new Uint8Array(body),
            contentType: opts?.contentType ?? 'application/octet-stream',
            updatedAt: new Date().toISOString(),
          });
          return { data: { path }, error: null };
        },
        async remove(paths: string[]) {
          for (const p of paths) store.delete(p);
          return { data: paths, error: null };
        },
        async createSignedUrl(path: string, expiresIn: number, opts?: { download?: string }) {
          if (!store.has(path)) {
            return { data: null, error: { message: 'Object not found' } };
          }
          const dl = opts?.download ? `&download=${encodeURIComponent(opts.download)}` : '';
          return {
            data: {
              signedUrl: `https://fskcdtpdkjgjaksqwjaf.supabase.co/storage/v1/object/sign/zero-base-files/${path}?token=signed-ttl-${expiresIn}${dl}`,
            },
            error: null,
          };
        },
        async list(prefix = '') {
          const cleanPrefix = prefix ? `${prefix.replace(/\/$/, '')}/` : '';
          const items: Array<{ id: string | null; name: string; metadata?: { size: number }; updated_at: string }> = [];
          const seenFolders = new Set<string>();

          for (const [fullPath, meta] of store.entries()) {
            if (!fullPath.startsWith(cleanPrefix)) continue;
            const remainder = fullPath.slice(cleanPrefix.length);
            const slashIdx = remainder.indexOf('/');
            if (slashIdx === -1) {
              items.push({
                id: crypto.randomUUID(),
                name: remainder,
                metadata: { size: meta.data.byteLength },
                updated_at: meta.updatedAt,
              });
            } else {
              const folder = remainder.slice(0, slashIdx);
              if (!seenFolders.has(folder)) {
                seenFolders.add(folder);
                items.push({ id: null, name: folder, updated_at: meta.updatedAt });
              }
            }
          }
          return { data: items, error: null };
        },
      };
    },
  };
}

class MockQueryBuilder {
  private filters: Array<(row: Record<string, unknown>) => boolean> = [];
  private orders: Array<{ col: string; asc: boolean }> = [];
  private limitNum: number | null = null;
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
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

  delete() {
    this.op = 'delete';
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
      const cust = this.db.customers.find((c) => c.id === row.customer_id);
      if (cust) copy.customers = { ...cust };
    }
    if (this.table === 'payments') {
      const srv = this.db.services.find((s) => s.id === row.service_id);
      if (srv) {
        const cust = this.db.customers.find((c) => c.id === srv.customer_id);
        copy.services = { ...srv, customers: cust ? { ...cust } : undefined };
      }
    }
    if (this.table === 'reminders') {
      const cust = this.db.customers.find((c) => c.id === row.customer_id);
      const srv = row.service_id ? this.db.services.find((s) => s.id === row.service_id) : null;
      if (cust) copy.customers = { ...cust };
      if (srv) copy.services = { ...srv };
    }
    return copy;
  }

  private execute(): { data: unknown; error: null | { message: string } } {
    const rows = this.db[this.table] as Array<Record<string, unknown>>;

    if (this.op === 'insert' && this.payload) {
      if (this.table === 'service_files' && this.db.failNextFileInsert) {
        this.db.failNextFileInsert = false;
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
        if (this.table === 'customers') {
          if (!rec.id) rec.id = crypto.randomUUID();
          if (!rec.customer_code) {
            rec.customer_code = `ZB-${String(this.db.customerSeq++).padStart(5, '0')}`;
          }
        }
        if (this.table === 'services') {
          if (!rec.id) rec.id = crypto.randomUUID();
          rec.discount = rec.discount ?? 0;
        }
        if (this.table === 'payments' && !rec.id) rec.id = crypto.randomUUID();
        if (this.table === 'service_files' && !rec.id) rec.id = crypto.randomUUID();
        if (this.table === 'reminders' && !rec.id) rec.id = crypto.randomUUID();
        if (this.table === 'audit_logs' && !rec.audit_id) rec.audit_id = crypto.randomUUID();

        rows.push(rec);

        if (this.table === 'services') {
          recalcServiceFinancials(this.db, String(rec.id));
          if (rec.next_due_date) {
            this.db.reminders.push({
              id: crypto.randomUUID(),
              service_id: rec.id,
              customer_id: rec.customer_id,
              due_date: rec.next_due_date,
              reminder_type: 'service_due',
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
        if (this.table === 'services') recalcServiceFinancials(this.db, String(r.id));
        if (this.table === 'payments') recalcServiceFinancials(this.db, String(r.service_id));
      }
      return { data: matched.map((r) => this.enrichRow(r)), error: null };
    }

    if (this.op === 'delete') {
      const remaining: Array<Record<string, unknown>> = [];
      const deleted: Array<Record<string, unknown>> = [];
      for (const r of rows) {
        if (this.filters.every((f) => f(r))) deleted.push(r);
        else remaining.push(r);
      }
      (this.db[this.table] as Array<Record<string, unknown>>) = remaining;
      return { data: deleted, error: null };
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
  const storage = createMockSupabaseStorage();

  const env: Env = {
    SUPABASE_URL: 'https://fskcdtpdkjgjaksqwjaf.supabase.co',
    SUPABASE_ANON_KEY: 'test-publishable-key',
    OWNER_USER_IDS: OWNER_IDS.join(','),
    STORAGE_BUCKET: 'zero-base-files',
    ALLOWED_ORIGINS: 'https://zero-base.pages.dev,http://localhost:5173',
    ENVIRONMENT: 'test',
    BUSINESS_TIMEZONE: 'Asia/Kolkata',
    MAX_UPLOAD_BYTES: '15728640',
  };

  const mockSupabase = {
    storage,
    from(table: keyof InMemoryDb) {
      return new MockQueryBuilder(db, table);
    },
    async rpc(name: string, params?: Record<string, unknown>) {
      if (name === 'find_duplicate_customers') {
        const phone = String(params?.p_phone ?? '');
        const norm = normalizePhone(phone);
        const matches = db.customers.filter((c) => {
          const p1 = normalizePhone(c.phone_number);
          const p2 = normalizePhone(c.alternate_phone);
          return (
            c.phone_number === phone ||
            c.alternate_phone === phone ||
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
            today_ist: '2026-11-17',
            total_customers: activeCustomers.length,
            total_services: activeServices.length,
            services_this_month: activeServices.length,
            services_this_year: activeServices.length,
            todays_services: 0,
            upcoming_reminders: db.reminders.filter((r) => !r.archived_at && r.status === 'active').length,
            due_today: 0,
            overdue_services: 0,
            pending_payments_amount: activeServices.reduce(
              (acc, s) => acc + Number(s.balance_amount ?? 0),
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
            outstanding_balance: srvs.reduce((a, s) => a + Number(s.balance_amount), 0),
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
      if (token === 'owner-1-token') return { sub: OWNER_IDS[0], email: 'owner1@zerobase.local' };
      if (token === 'owner-2-token') return { sub: OWNER_IDS[1], email: 'owner2@zerobase.local' };
      if (token === 'owner-3-token') return { sub: OWNER_IDS[2], email: 'owner3@zerobase.local' };
      if (token === 'non-owner-token') return { sub: NON_OWNER_ID, email: 'stranger@example.com' };
      throw new Error('Invalid token');
    },
    createSupabase() {
      return mockSupabase;
    },
  };

  return { db, env, overrides, storageStore: storage.store };
}
