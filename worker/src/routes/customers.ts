import { Hono } from 'hono';
import { z } from 'zod';
import type { AppBindings } from '../types';

export const customerRoutes = new Hono<AppBindings>();

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createCustomerSchema = z.object({
  full_name: z.string().trim().min(1, 'Full name is required').max(150),
  // Keep phone strings verbatim (preserve leading zeros and + country codes)
  primary_phone: z.string().trim().min(5, 'Primary phone is required').max(30),
  secondary_phone: z.string().trim().max(30).optional().nullable(),
  address: z.string().trim().min(1, 'Address is required').max(400),
  locality: z.string().trim().max(150).optional().nullable(),
  landmark: z.string().trim().max(200).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
  allow_duplicate: z.boolean().optional().default(false),
});

const updateCustomerSchema = z.object({
  full_name: z.string().trim().min(1).max(150).optional(),
  primary_phone: z.string().trim().min(5).max(30).optional(),
  secondary_phone: z.string().trim().max(30).optional().nullable(),
  address: z.string().trim().min(1).max(400).optional(),
  locality: z.string().trim().max(150).optional().nullable(),
  landmark: z.string().trim().max(200).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
});

customerRoutes.get('/customers', async (c) => {
  const supabase = c.get('supabase');
  const q = (c.req.query('q') ?? '').trim();
  const includeArchived = c.req.query('include_archived') === 'true';
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 100)));

  let query = supabase
    .from('customers')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (!includeArchived) {
    query = query.is('archived_at', null);
  }

  if (q.length > 0) {
    const escaped = q.replace(/[%_,()]/g, '');
    if (uuidRegex.test(q)) {
      query = query.eq('customer_id', q);
    } else if (escaped.length > 0) {
      query = query.or(
        `full_name.ilike.%${escaped}%,primary_phone.ilike.%${escaped}%,secondary_phone.ilike.%${escaped}%,address.ilike.%${escaped}%,locality.ilike.%${escaped}%`
      );
    }
  }

  const { data, error } = await query;
  if (error) {
    return c.json({ error: 'Failed to search customers' }, 500);
  }

  return c.json({ customers: data ?? [] });
});

customerRoutes.get('/customers/check-duplicate', async (c) => {
  const supabase = c.get('supabase');
  const phone = (c.req.query('phone') ?? '').trim();

  if (phone.length < 5) {
    return c.json({ duplicates: [] });
  }

  const { data, error } = await supabase.rpc('find_duplicate_customers', {
    p_phone: phone,
  });

  if (error) {
    return c.json({ error: 'Duplicate check failed' }, 500);
  }

  return c.json({ duplicates: data ?? [] });
});

customerRoutes.post('/customers', async (c) => {
  const supabase = c.get('supabase');
  const user = c.get('authUser');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON request body' }, 400);
  }

  const parsed = createCustomerSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const payload = parsed.data;

  // Check duplicates on primary_phone (and secondary_phone if supplied)
  const dupChecks = [
    supabase.rpc('find_duplicate_customers', { p_phone: payload.primary_phone }),
  ];
  if (payload.secondary_phone && payload.secondary_phone.trim().length >= 5) {
    dupChecks.push(
      supabase.rpc('find_duplicate_customers', { p_phone: payload.secondary_phone })
    );
  }

  const dupResults = await Promise.all(dupChecks);
  const duplicatesMap = new Map<string, Record<string, unknown>>();
  for (const res of dupResults) {
    if (res.data) {
      for (const row of res.data as Array<Record<string, unknown>>) {
        duplicatesMap.set(String(row.customer_id), row);
      }
    }
  }

  if (duplicatesMap.size > 0 && !payload.allow_duplicate) {
    return c.json(
      {
        error: 'A customer with this phone number already exists.',
        code: 'DUPLICATE_CUSTOMER_PHONE',
        duplicates: Array.from(duplicatesMap.values()),
      },
      409
    );
  }

  const { data, error } = await supabase
    .from('customers')
    .insert({
      full_name: payload.full_name,
      primary_phone: payload.primary_phone,
      secondary_phone: payload.secondary_phone || null,
      address: payload.address,
      locality: payload.locality || null,
      landmark: payload.landmark || null,
      notes: payload.notes || null,
      created_by: user.id,
      updated_by: user.id,
    })
    .select('*')
    .single();

  if (error || !data) {
    return c.json({ error: 'Failed to create customer' }, 500);
  }

  return c.json({ customer: data }, 201);
});

customerRoutes.get('/customers/:id', async (c) => {
  const supabase = c.get('supabase');
  const customerId = c.req.param('id');

  if (!uuidRegex.test(customerId)) {
    return c.json({ error: 'Invalid customer ID format' }, 400);
  }

  const [customerRes, servicesRes, remindersRes] = await Promise.all([
    supabase.from('customers').select('*').eq('customer_id', customerId).single(),
    supabase
      .from('services')
      .select('*')
      .eq('customer_id', customerId)
      .is('archived_at', null)
      .order('service_date', { ascending: false })
      .order('created_at', { ascending: false }),
    supabase
      .from('reminders')
      .select('*')
      .eq('customer_id', customerId)
      .is('archived_at', null)
      .in('status', ['active', 'contacted', 'confirmed', 'snoozed'])
      .order('due_date', { ascending: true }),
  ]);

  if (customerRes.error || !customerRes.data) {
    return c.json({ error: 'Customer not found' }, 404);
  }

  const services = servicesRes.data ?? [];
  const totalServices = services.length;
  const lastServiceDate = totalServices > 0 ? services[0].service_date : null;
  const totalBilled = services.reduce((acc, s) => acc + Number(s.total_amount ?? 0), 0);
  const totalPaid = services.reduce((acc, s) => acc + Number(s.amount_paid ?? 0), 0);
  const outstandingAmount = Math.max(0, totalBilled - totalPaid);
  const nextScheduledService =
    remindersRes.data && remindersRes.data.length > 0
      ? remindersRes.data[0].due_date
      : services.find((s) => s.next_due_date)?.next_due_date ?? null;

  return c.json({
    customer: customerRes.data,
    summary: {
      total_services: totalServices,
      last_service_date: lastServiceDate,
      total_billed: Number(totalBilled.toFixed(2)),
      total_paid: Number(totalPaid.toFixed(2)),
      outstanding_amount: Number(outstandingAmount.toFixed(2)),
      next_scheduled_service: nextScheduledService,
    },
    services,
    reminders: remindersRes.data ?? [],
  });
});

customerRoutes.patch('/customers/:id', async (c) => {
  const supabase = c.get('supabase');
  const user = c.get('authUser');
  const customerId = c.req.param('id');

  if (!uuidRegex.test(customerId)) {
    return c.json({ error: 'Invalid customer ID format' }, 400);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON request body' }, 400);
  }

  const parsed = updateCustomerSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const updates: Record<string, unknown> = {
    ...parsed.data,
    updated_by: user.id,
  };

  const { data, error } = await supabase
    .from('customers')
    .update(updates)
    .eq('customer_id', customerId)
    .select('*')
    .single();

  if (error || !data) {
    return c.json({ error: 'Failed to update customer' }, 500);
  }

  return c.json({ customer: data });
});

customerRoutes.post('/customers/:id/archive', async (c) => {
  const supabase = c.get('supabase');
  const user = c.get('authUser');
  const customerId = c.req.param('id');

  if (!uuidRegex.test(customerId)) {
    return c.json({ error: 'Invalid customer ID format' }, 400);
  }

  const { data, error } = await supabase
    .from('customers')
    .update({ archived_at: new Date().toISOString(), updated_by: user.id })
    .eq('customer_id', customerId)
    .select('*')
    .single();

  if (error || !data) {
    return c.json({ error: 'Failed to archive customer' }, 500);
  }

  return c.json({ customer: data });
});

customerRoutes.post('/customers/:id/restore', async (c) => {
  const supabase = c.get('supabase');
  const user = c.get('authUser');
  const customerId = c.req.param('id');

  if (!uuidRegex.test(customerId)) {
    return c.json({ error: 'Invalid customer ID format' }, 400);
  }

  const { data, error } = await supabase
    .from('customers')
    .update({ archived_at: null, updated_by: user.id })
    .eq('customer_id', customerId)
    .select('*')
    .single();

  if (error || !data) {
    return c.json({ error: 'Failed to restore customer' }, 500);
  }

  return c.json({ customer: data });
});
