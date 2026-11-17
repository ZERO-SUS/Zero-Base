import { Hono } from 'hono';
import { z } from 'zod';
import { extractYearMonthFromDate } from '../lib/timezone';
import type { AppBindings } from '../types';

export const serviceRoutes = new Hono<AppBindings>();

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

const createServiceSchema = z
  .object({
    customer_id: z.string().regex(uuidRegex, 'Valid customer_id is required'),
    service_date: z.string().regex(dateRegex, 'service_date must be YYYY-MM-DD'),
    service_type: z.string().trim().min(1, 'Service type is required').max(120),
    tank_details: z.string().trim().max(150).optional().nullable(),
    description: z.string().trim().max(1000).optional().nullable(),
    price: z.number().nonnegative('Price cannot be negative').max(10_000_000),
    discount: z.number().nonnegative('Discount cannot be negative').max(10_000_000).default(0),
    next_due_date: z
      .string()
      .regex(dateRegex, 'next_due_date must be YYYY-MM-DD')
      .optional()
      .nullable(),
    notes: z.string().trim().max(3000).optional().nullable(),
    idempotency_key: z.string().trim().max(120).optional().nullable(),
    initial_payment: z
      .object({
        amount: z.number().positive(),
        payment_method: z.enum(['Cash', 'UPI', 'Other']),
        reference_number: z.string().trim().max(150).optional().nullable(),
        payment_date: z.string().regex(dateRegex),
        notes: z.string().trim().max(1000).optional().nullable(),
      })
      .optional()
      .nullable(),
  })
  .refine((d) => d.discount <= d.price, {
    message: 'Discount cannot exceed price',
    path: ['discount'],
  });

const unifiedCreateSchema = z
  .object({
    customer_id: z.string().regex(uuidRegex).optional().nullable(),
    new_customer: z
      .object({
        full_name: z.string().trim().min(1, 'Customer full name is required').max(150),
        phone_number: z.string().trim().min(5, 'Primary phone is required').max(30),
        alternate_phone: z.string().trim().max(30).optional().nullable(),
        address: z.string().trim().min(1, 'Address is required').max(400),
        area: z.string().trim().max(150).optional().nullable(),
        notes: z.string().trim().max(2000).optional().nullable(),
        allow_duplicate: z.boolean().optional().default(false),
      })
      .optional()
      .nullable(),
    service_date: z.string().regex(dateRegex, 'service_date must be YYYY-MM-DD'),
    service_type: z.string().trim().min(1, 'Service type is required').max(120),
    tank_details: z.string().trim().max(150).optional().nullable(),
    description: z.string().trim().max(1000).optional().nullable(),
    price: z.number().nonnegative().max(10_000_000),
    discount: z.number().nonnegative().max(10_000_000).default(0),
    notes: z.string().trim().max(3000).optional().nullable(),
    idempotency_key: z.string().trim().max(120).optional().nullable(),
    initial_payment: z
      .object({
        amount: z.number().positive(),
        payment_method: z.enum(['Cash', 'UPI', 'Other']),
        reference_number: z.string().trim().max(150).optional().nullable(),
        payment_date: z.string().regex(dateRegex).optional(),
      })
      .optional()
      .nullable(),
    reminder: z
      .object({
        enabled: z.boolean(),
        due_date: z.string().regex(dateRegex).optional().nullable(),
        reminder_type: z.enum(['service_due', 'custom', 'follow_up']).default('service_due'),
        notes: z.string().trim().max(1500).optional().nullable(),
      })
      .optional()
      .nullable(),
  })
  .refine((d) => Boolean(d.customer_id) || Boolean(d.new_customer), {
    message: 'Either an existing customer_id or new_customer details must be provided',
  })
  .refine((d) => d.discount <= d.price, {
    message: 'Discount cannot exceed price',
    path: ['discount'],
  })
  .refine((d) => !d.reminder?.enabled || Boolean(d.reminder?.due_date), {
    message: 'Reminder date is required when reminder is enabled',
    path: ['reminder', 'due_date'],
  });

const updateServiceSchema = z.object({
  service_date: z.string().regex(dateRegex, 'service_date must be YYYY-MM-DD').optional(),
  service_type: z.string().trim().min(1).max(120).optional(),
  tank_details: z.string().trim().max(150).optional().nullable(),
  description: z.string().trim().max(1000).optional().nullable(),
  price: z.number().nonnegative().max(10_000_000).optional(),
  discount: z.number().nonnegative().max(10_000_000).optional(),
  next_due_date: z.string().regex(dateRegex).optional().nullable(),
  notes: z.string().trim().max(3000).optional().nullable(),
});

// Unified Add Service endpoint (Existing OR New Customer + Service + Optional Payment + Optional Reminder)
serviceRoutes.post('/services/unified', async (c) => {
  const supabase = c.get('supabase');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON request body' }, 400);
  }

  const parsed = unifiedCreateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const p = parsed.data;

  // Duplicate check before creating a new customer (unless explicitly confirmed)
  if (!p.customer_id && p.new_customer && !p.new_customer.allow_duplicate) {
    const dupRes = await supabase.rpc('find_similar_customers', {
      p_phone: p.new_customer.phone_number,
      p_alt_phone: p.new_customer.alternate_phone ?? '',
      p_name: p.new_customer.full_name,
      p_address: p.new_customer.address,
    });
    const duplicates = (dupRes.data ?? []) as Array<Record<string, unknown>>;
    if (duplicates.length > 0) {
      return c.json(
        {
          error: 'A customer with similar details already exists.',
          code: 'DUPLICATE_CUSTOMER_PHONE',
          duplicates,
        },
        409
      );
    }
  }

  const { data, error } = await supabase.rpc('create_unified_service', {
    p_customer_id: p.customer_id ?? null,
    p_customer_full_name: p.new_customer?.full_name ?? null,
    p_customer_phone: p.new_customer?.phone_number ?? null,
    p_customer_alt_phone: p.new_customer?.alternate_phone ?? null,
    p_customer_address: p.new_customer?.address ?? null,
    p_customer_area: p.new_customer?.area ?? null,
    p_customer_notes: p.new_customer?.notes ?? null,
    p_service_date: p.service_date,
    p_service_type: p.service_type,
    p_tank_details: p.tank_details ?? null,
    p_description: p.description ?? null,
    p_price: p.price,
    p_discount: p.discount,
    p_notes: p.notes ?? null,
    p_idempotency_key: p.idempotency_key ?? null,
    p_payment_amount: p.initial_payment?.amount ?? null,
    p_payment_method: p.initial_payment?.payment_method ?? null,
    p_payment_ref: p.initial_payment?.reference_number ?? null,
    p_payment_date: p.initial_payment?.payment_date ?? p.service_date,
    p_reminder_enabled: Boolean(p.reminder?.enabled),
    p_reminder_date: p.reminder?.enabled ? (p.reminder.due_date ?? null) : null,
    p_reminder_type: p.reminder?.reminder_type ?? 'service_due',
    p_reminder_notes: p.reminder?.notes ?? null,
  });

  if (error || !data) {
    return c.json({ error: error?.message || 'Failed to save unified service record' }, 500);
  }

  const res = data as {
    customer: Record<string, unknown>;
    service: Record<string, unknown>;
    reminder?: Record<string, unknown> | null;
    deduplicated?: boolean;
  };

  return c.json(res, res.deduplicated ? 200 : 201);
});

// Calendar-Style Service Archive endpoint (strictly by service_date)
serviceRoutes.get('/archive/summary', async (c) => {
  const supabase = c.get('supabase');
  const yearParam = c.req.query('year');
  const monthParam = c.req.query('month');
  const q = (c.req.query('q') ?? '').trim().toLowerCase();
  const paymentStatus = (c.req.query('payment_status') ?? '').trim();
  const serviceType = (c.req.query('service_type') ?? '').trim();

  let query = supabase
    .from('services')
    .select(
      `
      id,
      customer_id,
      service_date,
      service_type,
      tank_details,
      total_amount,
      amount_paid,
      balance_amount,
      payment_status,
      created_at,
      customers!inner (
        id,
        customer_code,
        full_name,
        phone_number,
        area
      )
    `
    )
    .is('archived_at', null)
    .order('service_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (paymentStatus) query = query.eq('payment_status', paymentStatus);
  if (serviceType) query = query.eq('service_type', serviceType);

  const { data, error } = await query;
  if (error) {
    return c.json({ error: 'Failed to load service archive' }, 500);
  }

  let services = (data ?? []) as unknown as Array<{
    id: string;
    customer_id: string;
    service_date: string;
    service_type: string;
    tank_details: string | null;
    total_amount: number;
    amount_paid: number;
    balance_amount: number;
    payment_status: string;
    created_at: string;
    customers: {
      id: string;
      customer_code: string;
      full_name: string;
      phone_number: string;
      area: string | null;
    };
  }>;

  if (q.length > 0) {
    services = services.filter((s) => {
      const cust = s.customers;
      return (
        cust.full_name.toLowerCase().includes(q) ||
        cust.phone_number.toLowerCase().includes(q) ||
        cust.customer_code.toLowerCase().includes(q) ||
        (cust.area ?? '').toLowerCase().includes(q) ||
        s.service_type.toLowerCase().includes(q)
      );
    });
  }

  const yearsMap = new Map<
    number,
    {
      year: number;
      count: number;
      revenue: number;
      months: Map<number, { month: number; count: number; revenue: number }>;
    }
  >();

  for (const s of services) {
    const { year, month } = extractYearMonthFromDate(s.service_date);
    if (!yearsMap.has(year)) {
      yearsMap.set(year, { year, count: 0, revenue: 0, months: new Map() });
    }
    const yEntry = yearsMap.get(year)!;
    yEntry.count += 1;
    yEntry.revenue += Number(s.total_amount ?? 0);

    if (!yEntry.months.has(month)) {
      yEntry.months.set(month, { month, count: 0, revenue: 0 });
    }
    const mEntry = yEntry.months.get(month)!;
    mEntry.count += 1;
    mEntry.revenue += Number(s.total_amount ?? 0);
  }

  const years = Array.from(yearsMap.values())
    .sort((a, b) => b.year - a.year)
    .map((y) => ({
      year: y.year,
      count: y.count,
      revenue: Number(y.revenue.toFixed(2)),
      months: Array.from(y.months.values()).sort((a, b) => b.month - a.month),
    }));

  let monthServices: typeof services = [];
  if (yearParam && /^\d{4}$/.test(yearParam) && monthParam && /^(0?[1-9]|1[0-2])$/.test(monthParam)) {
    const targetPrefix = `${yearParam}-${String(Number(monthParam)).padStart(2, '0')}-`;
    monthServices = services.filter((s) => s.service_date.startsWith(targetPrefix));
  }

  return c.json({
    years,
    month_services: monthServices,
  });
});

serviceRoutes.get('/services/history', async (c) => {
  const supabase = c.get('supabase');
  const yearParam = c.req.query('year');
  const monthParam = c.req.query('month');
  const q = (c.req.query('q') ?? '').trim().toLowerCase();
  const serviceType = (c.req.query('service_type') ?? '').trim();
  const paymentStatus = (c.req.query('payment_status') ?? '').trim();
  const includeArchived = c.req.query('include_archived') === 'true';

  let query = supabase
    .from('services')
    .select(
      `
      *,
      customers!inner (
        id,
        customer_code,
        full_name,
        phone_number,
        alternate_phone,
        address,
        area
      )
    `
    )
    .order('service_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (!includeArchived) {
    query = query.is('archived_at', null);
  }
  if (serviceType) {
    query = query.eq('service_type', serviceType);
  }
  if (paymentStatus) {
    query = query.eq('payment_status', paymentStatus);
  }

  if (yearParam && /^\d{4}$/.test(yearParam)) {
    const yearNum = Number(yearParam);
    if (monthParam && /^(0?[1-9]|1[0-2])$/.test(monthParam)) {
      const m = Number(monthParam);
      const start = `${yearNum}-${String(m).padStart(2, '0')}-01`;
      const lastDay = new Date(Date.UTC(yearNum, m, 0)).getUTCDate();
      const end = `${yearNum}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      query = query.gte('service_date', start).lte('service_date', end);
    } else {
      query = query.gte('service_date', `${yearNum}-01-01`).lte('service_date', `${yearNum}-12-31`);
    }
  }

  const { data, error } = await query;
  if (error) {
    return c.json({ error: 'Failed to load service history' }, 500);
  }

  let services = (data ?? []) as Array<
    Record<string, unknown> & {
      service_date: string;
      customers: {
        id: string;
        customer_code: string;
        full_name: string;
        phone_number: string;
        alternate_phone?: string | null;
        address: string;
        area?: string | null;
      };
    }
  >;

  if (q.length > 0) {
    services = services.filter((s) => {
      const cust = s.customers;
      return (
        cust.full_name.toLowerCase().includes(q) ||
        cust.phone_number.toLowerCase().includes(q) ||
        (cust.alternate_phone ?? '').toLowerCase().includes(q) ||
        cust.customer_code.toLowerCase().includes(q) ||
        cust.address.toLowerCase().includes(q) ||
        (cust.area ?? '').toLowerCase().includes(q) ||
        cust.id.toLowerCase() === q
      );
    });
  }

  const yearsMap = new Map<number, Map<number, typeof services>>();

  for (const srv of services) {
    const { year, month } = extractYearMonthFromDate(srv.service_date);
    if (!yearsMap.has(year)) {
      yearsMap.set(year, new Map());
    }
    const monthsMap = yearsMap.get(year)!;
    if (!monthsMap.has(month)) {
      monthsMap.set(month, []);
    }
    monthsMap.get(month)!.push(srv);
  }

  const grouped = Array.from(yearsMap.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([year, monthsMap]) => ({
      year,
      months: Array.from(monthsMap.entries())
        .sort((a, b) => b[0] - a[0])
        .map(([month, records]) => ({
          month,
          records,
        })),
    }));

  return c.json({
    total: services.length,
    grouped,
    services,
  });
});

serviceRoutes.get('/services/:id', async (c) => {
  const supabase = c.get('supabase');
  const serviceId = c.req.param('id');

  if (!uuidRegex.test(serviceId)) {
    return c.json({ error: 'Invalid service ID format' }, 400);
  }

  const [serviceRes, paymentsRes, filesRes, remindersRes] = await Promise.all([
    supabase
      .from('services')
      .select(
        `
        *,
        customers (
          id,
          customer_code,
          full_name,
          phone_number,
          alternate_phone,
          address,
          area
        )
      `
      )
      .eq('id', serviceId)
      .single(),
    supabase
      .from('payments')
      .select('*')
      .eq('service_id', serviceId)
      .order('payment_date', { ascending: false })
      .order('created_at', { ascending: false }),
    supabase
      .from('service_files')
      .select('*')
      .eq('service_id', serviceId)
      .is('archived_at', null)
      .order('uploaded_at', { ascending: false }),
    supabase
      .from('reminders')
      .select('*')
      .eq('service_id', serviceId)
      .is('archived_at', null)
      .order('created_at', { ascending: false }),
  ]);

  if (serviceRes.error || !serviceRes.data) {
    return c.json({ error: 'Service record not found' }, 404);
  }

  return c.json({
    service: serviceRes.data,
    payments: paymentsRes.data ?? [],
    files: filesRes.data ?? [],
    reminders: remindersRes.data ?? [],
  });
});

serviceRoutes.get('/services/:id/deletion-impact', async (c) => {
  const supabase = c.get('supabase');
  const serviceId = c.req.param('id');
  if (!uuidRegex.test(serviceId)) return c.json({ error: 'Invalid service ID format' }, 400);

  const [srvRes, payRes, remRes, fileRes] = await Promise.all([
    supabase.from('services').select('id, service_date, service_type').eq('id', serviceId).single(),
    supabase.from('payments').select('id', { count: 'exact', head: true }).eq('service_id', serviceId),
    supabase.from('reminders').select('id', { count: 'exact', head: true }).eq('service_id', serviceId),
    supabase.from('service_files').select('id', { count: 'exact', head: true }).eq('service_id', serviceId),
  ]);

  if (srvRes.error || !srvRes.data) {
    return c.json({ error: 'Service record not found' }, 404);
  }

  return c.json({
    service: srvRes.data,
    impact: {
      payments_count: payRes.count ?? 0,
      reminders_count: remRes.count ?? 0,
      files_count: fileRes.count ?? 0,
    },
  });
});

serviceRoutes.post('/services', async (c) => {
  const supabase = c.get('supabase');
  const user = c.get('authUser');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON request body' }, 400);
  }

  const parsed = createServiceSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const payload = parsed.data;

  const { data: customer, error: custErr } = await supabase
    .from('customers')
    .select('id, archived_at')
    .eq('id', payload.customer_id)
    .single();

  if (custErr || !customer) {
    return c.json({ error: 'Customer not found' }, 404);
  }
  if (customer.archived_at) {
    return c.json({ error: 'Cannot add a service to an archived customer. Restore the customer first.' }, 400);
  }

  if (payload.idempotency_key) {
    const { data: existing } = await supabase
      .from('services')
      .select('*')
      .eq('idempotency_key', payload.idempotency_key)
      .maybeSingle();
    if (existing) {
      return c.json({ service: existing, deduplicated: true }, 200);
    }
  }

  const { data: service, error: insertErr } = await supabase
    .from('services')
    .insert({
      customer_id: payload.customer_id,
      service_date: payload.service_date,
      service_type: payload.service_type,
      tank_details: payload.tank_details || null,
      description: payload.description || null,
      price: payload.price,
      discount: payload.discount,
      next_due_date: payload.next_due_date || null,
      notes: payload.notes || null,
      idempotency_key: payload.idempotency_key || null,
      created_by: user.id,
      updated_by: user.id,
    })
    .select('*')
    .single();

  if (insertErr || !service) {
    return c.json({ error: 'Failed to create service record' }, 500);
  }

  if (payload.initial_payment) {
    const { error: payErr } = await supabase.from('payments').insert({
      service_id: service.id,
      customer_id: payload.customer_id,
      amount: payload.initial_payment.amount,
      payment_type: 'payment',
      payment_method: payload.initial_payment.payment_method,
      reference_number: payload.initial_payment.reference_number || null,
      payment_date: payload.initial_payment.payment_date,
      notes: payload.initial_payment.notes || null,
      idempotency_key: payload.idempotency_key
        ? `${payload.idempotency_key}:initial-payment`
        : null,
      created_by: user.id,
    });

    if (payErr) {
      return c.json(
        {
          error: 'Service created, but initial payment failed to record. Please record payment manually.',
          service,
        },
        207
      );
    }

    const { data: refreshed } = await supabase
      .from('services')
      .select('*')
      .eq('id', service.id)
      .single();

    return c.json({ service: refreshed ?? service }, 201);
  }

  return c.json({ service }, 201);
});

serviceRoutes.patch('/services/:id', async (c) => {
  const supabase = c.get('supabase');
  const user = c.get('authUser');
  const serviceId = c.req.param('id');

  if (!uuidRegex.test(serviceId)) {
    return c.json({ error: 'Invalid service ID format' }, 400);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON request body' }, 400);
  }

  const parsed = updateServiceSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const { data: existing, error: findErr } = await supabase
    .from('services')
    .select('id, price, discount')
    .eq('id', serviceId)
    .single();

  if (findErr || !existing) {
    return c.json({ error: 'Service record not found' }, 404);
  }

  const nextPrice = parsed.data.price ?? Number(existing.price);
  const nextDiscount = parsed.data.discount ?? Number(existing.discount);
  if (nextDiscount > nextPrice) {
    return c.json({ error: 'Discount cannot exceed price' }, 400);
  }

  const { data, error } = await supabase
    .from('services')
    .update({
      ...parsed.data,
      updated_by: user.id,
    })
    .eq('id', serviceId)
    .select('*')
    .single();

  if (error || !data) {
    return c.json({ error: 'Failed to update service record' }, 500);
  }

  return c.json({ service: data });
});

serviceRoutes.post('/services/:id/archive', async (c) => {
  const supabase = c.get('supabase');
  const user = c.get('authUser');
  const serviceId = c.req.param('id');

  if (!uuidRegex.test(serviceId)) return c.json({ error: 'Invalid service ID format' }, 400);

  const { data, error } = await supabase
    .from('services')
    .update({ archived_at: new Date().toISOString(), updated_by: user.id })
    .eq('id', serviceId)
    .select('*')
    .single();

  if (error || !data) return c.json({ error: 'Failed to archive service' }, 500);
  return c.json({ service: data });
});

serviceRoutes.delete('/services/:id', async (c) => {
  const supabase = c.get('supabase');
  const user = c.get('authUser');
  const serviceId = c.req.param('id');
  const mode = c.req.query('mode') === 'permanent' ? 'permanent' : 'archive';

  if (!uuidRegex.test(serviceId)) return c.json({ error: 'Invalid service ID format' }, 400);

  if (mode === 'permanent') {
    const { data, error } = await supabase.rpc('permanently_delete_service', {
      p_service_id: serviceId,
    });
    if (error || !data) {
      return c.json({ error: 'Failed to permanently delete service record' }, 500);
    }
    const result = data as { storage_paths?: string[] };
    const paths = Array.isArray(result.storage_paths) ? result.storage_paths.filter(Boolean) : [];
    if (paths.length > 0) {
      const bucket = c.env.STORAGE_BUCKET || 'zero-base-files';
      await supabase.storage.from(bucket).remove(paths);
    }
    return c.json({ deleted: true, mode: 'permanent', details: data });
  }

  const { data, error } = await supabase
    .from('services')
    .update({ archived_at: new Date().toISOString(), updated_by: user.id })
    .eq('id', serviceId)
    .select('*')
    .single();

  if (error || !data) return c.json({ error: 'Failed to archive service' }, 500);
  return c.json({ service: data, archived: true, mode: 'archive' });
});

serviceRoutes.post('/services/:id/restore', async (c) => {
  const supabase = c.get('supabase');
  const user = c.get('authUser');
  const serviceId = c.req.param('id');

  if (!uuidRegex.test(serviceId)) return c.json({ error: 'Invalid service ID format' }, 400);

  const { data, error } = await supabase
    .from('services')
    .update({ archived_at: null, updated_by: user.id })
    .eq('id', serviceId)
    .select('*')
    .single();

  if (error || !data) return c.json({ error: 'Failed to restore service' }, 500);
  return c.json({ service: data });
});
