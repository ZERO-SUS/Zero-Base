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
    // CRITICAL DATE RULE: always sort and group by actual service_date, never created_at
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

  // Group strictly by service_date year & month (newest first)
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

  if (!uuidRegex.test(serviceId)) return c.json({ error: 'Invalid service ID format' }, 400);

  const { data, error } = await supabase
    .from('services')
    .update({ archived_at: new Date().toISOString(), updated_by: user.id })
    .eq('id', serviceId)
    .select('*')
    .single();

  if (error || !data) return c.json({ error: 'Failed to archive service' }, 500);
  return c.json({ service: data, archived: true });
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
