import { Hono } from 'hono';
import { z } from 'zod';
import { extractYearMonthFromDate } from '../lib/timezone';
import type { AppBindings } from '../types';

export const customerRoutes = new Hono<AppBindings>();

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createCustomerSchema = z.object({
  full_name: z.string().trim().min(1, 'Full name is required').max(150),
  customer_code: z.string().trim().min(2).max(40).optional(),
  phone_number: z.string().trim().min(5, 'Phone number is required').max(30),
  alternate_phone: z.string().trim().max(30).optional().nullable(),
  address: z.string().trim().min(1, 'Address is required').max(400),
  area: z.string().trim().max(150).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
  allow_duplicate: z.boolean().optional().default(false),
});

const updateCustomerSchema = z.object({
  full_name: z.string().trim().min(1).max(150).optional(),
  customer_code: z.string().trim().min(2).max(40).optional(),
  phone_number: z.string().trim().min(5).max(30).optional(),
  alternate_phone: z.string().trim().max(30).optional().nullable(),
  address: z.string().trim().min(1).max(400).optional(),
  area: z.string().trim().max(150).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
});

customerRoutes.get('/customers', async (c) => {
  const supabase = c.get('supabase');
  const q = (c.req.query('q') ?? '').trim();
  const includeArchived = c.req.query('include_archived') === 'true';
  const page = Math.max(1, Number(c.req.query('page') ?? 1));
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50)));
  const offset = (page - 1) * limit;

  let query = supabase
    .from('customers')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (!includeArchived) {
    query = query.is('archived_at', null);
  }

  if (q.length > 0) {
    const escaped = q.replace(/[%_,()]/g, '');
    const digits = q.replace(/\D/g, '');
    if (uuidRegex.test(q)) {
      query = query.eq('id', q);
    } else if (escaped.length > 0) {
      const clauses = [
        `full_name.ilike.%${escaped}%`,
        `phone_number.ilike.%${escaped}%`,
        `alternate_phone.ilike.%${escaped}%`,
        `customer_code.ilike.%${escaped}%`,
        `address.ilike.%${escaped}%`,
        `area.ilike.%${escaped}%`,
      ];
      if (digits.length >= 4 && digits !== escaped) {
        clauses.push(`phone_number.ilike.%${digits}%`);
        clauses.push(`alternate_phone.ilike.%${digits}%`);
      }
      query = query.or(clauses.join(','));
    }
  }

  const { data, count, error } = await query;
  if (error) {
    return c.json({ error: 'Failed to search customers' }, 500);
  }

  return c.json({
    customers: data ?? [],
    total: count ?? (data?.length ?? 0),
    page,
    page_size: limit,
  });
});

customerRoutes.get('/customers/check-duplicate', async (c) => {
  const supabase = c.get('supabase');
  const phone = (c.req.query('phone') ?? '').trim();
  const altPhone = (c.req.query('alt_phone') ?? '').trim();
  const name = (c.req.query('name') ?? '').trim();
  const address = (c.req.query('address') ?? '').trim();

  if (phone.length < 5 && altPhone.length < 5 && name.length < 4) {
    return c.json({ duplicates: [] });
  }

  const similarRes = await supabase.rpc('find_similar_customers', {
    p_phone: phone,
    p_alt_phone: altPhone,
    p_name: name,
    p_address: address,
  });

  if (!similarRes.error) {
    return c.json({ duplicates: similarRes.data ?? [] });
  }

  // Fallback for pre-0006 DBs
  if (phone.length >= 5) {
    const { data, error } = await supabase.rpc('find_duplicate_customers', { p_phone: phone });
    if (error) return c.json({ error: 'Duplicate check failed' }, 500);
    return c.json({ duplicates: data ?? [] });
  }

  return c.json({ duplicates: [] });
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

  const dupRes = await supabase.rpc('find_similar_customers', {
    p_phone: payload.phone_number,
    p_alt_phone: payload.alternate_phone ?? '',
    p_name: payload.full_name,
    p_address: payload.address,
  });

  let duplicates = (dupRes.data ?? []) as Array<Record<string, unknown>>;
  if (dupRes.error) {
    const fallback = await supabase.rpc('find_duplicate_customers', {
      p_phone: payload.phone_number,
    });
    duplicates = (fallback.data ?? []) as Array<Record<string, unknown>>;
  }

  if (duplicates.length > 0 && !payload.allow_duplicate) {
    return c.json(
      {
        error: 'A customer with similar details already exists.',
        code: 'DUPLICATE_CUSTOMER_PHONE',
        duplicates,
      },
      409
    );
  }

  const insertData: Record<string, unknown> = {
    full_name: payload.full_name,
    phone_number: payload.phone_number,
    alternate_phone: payload.alternate_phone || null,
    address: payload.address,
    area: payload.area || null,
    notes: payload.notes || null,
    created_by: user.id,
    updated_by: user.id,
  };
  if (payload.customer_code) {
    insertData.customer_code = payload.customer_code;
  }

  const { data, error } = await supabase
    .from('customers')
    .insert(insertData)
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

  const [customerRes, servicesRes, paymentsRes, remindersRes, filesRes] = await Promise.all([
    supabase.from('customers').select('*').eq('id', customerId).single(),
    supabase
      .from('services')
      .select('*')
      .eq('customer_id', customerId)
      .is('archived_at', null)
      .order('service_date', { ascending: false })
      .order('created_at', { ascending: false }),
    supabase
      .from('payments')
      .select('*')
      .eq('customer_id', customerId)
      .is('archived_at', null)
      .order('payment_date', { ascending: false })
      .order('created_at', { ascending: false }),
    supabase
      .from('reminders')
      .select('*')
      .eq('customer_id', customerId)
      .is('archived_at', null)
      .in('status', ['active', 'contacted', 'confirmed', 'snoozed'])
      .order('due_date', { ascending: true }),
    supabase
      .from('service_files')
      .select('*')
      .eq('customer_id', customerId)
      .is('archived_at', null)
      .order('uploaded_at', { ascending: false }),
  ]);

  if (customerRes.error || !customerRes.data) {
    return c.json({ error: 'Customer not found' }, 404);
  }

  const services = (servicesRes.data ?? []) as Array<
    Record<string, unknown> & {
      service_date: string;
      total_amount?: number;
      amount_paid?: number;
      next_due_date?: string | null;
    }
  >;
  const totalServices = services.length;
  const lastServiceDate = totalServices > 0 ? services[0].service_date : null;
  const firstServiceDate = totalServices > 0 ? services[totalServices - 1].service_date : null;
  const totalBilled = services.reduce((acc, s) => acc + Number(s.total_amount ?? 0), 0);
  const totalPaid = services.reduce((acc, s) => acc + Number(s.amount_paid ?? 0), 0);
  const outstandingAmount = Math.max(0, totalBilled - totalPaid);
  const nextScheduledService =
    remindersRes.data && remindersRes.data.length > 0
      ? remindersRes.data[0].due_date
      : services.find((s) => s.next_due_date)?.next_due_date ?? null;

  // Group service history by year -> month strictly by service_date (newest first)
  const yearsMap = new Map<number, Map<number, typeof services>>();
  for (const srv of services) {
    const { year, month } = extractYearMonthFromDate(srv.service_date);
    if (!yearsMap.has(year)) yearsMap.set(year, new Map());
    const monthsMap = yearsMap.get(year)!;
    if (!monthsMap.has(month)) monthsMap.set(month, []);
    monthsMap.get(month)!.push(srv);
  }

  const servicesGrouped = Array.from(yearsMap.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([year, monthsMap]) => ({
      year,
      months: Array.from(monthsMap.entries())
        .sort((a, b) => b[0] - a[0])
        .map(([month, records]) => ({ month, records })),
    }));

  return c.json({
    customer: customerRes.data,
    summary: {
      total_services: totalServices,
      first_service_date: firstServiceDate,
      last_service_date: lastServiceDate,
      total_billed: Number(totalBilled.toFixed(2)),
      total_paid: Number(totalPaid.toFixed(2)),
      outstanding_amount: Number(outstandingAmount.toFixed(2)),
      next_scheduled_service: nextScheduledService,
    },
    services,
    services_grouped: servicesGrouped,
    payments: paymentsRes.data ?? [],
    reminders: remindersRes.data ?? [],
    files: filesRes.data ?? [],
  });
});

customerRoutes.get('/customers/:id/services', async (c) => {
  const supabase = c.get('supabase');
  const customerId = c.req.param('id');

  if (!uuidRegex.test(customerId)) {
    return c.json({ error: 'Invalid customer ID format' }, 400);
  }

  const { data, error } = await supabase
    .from('services')
    .select('*')
    .eq('customer_id', customerId)
    .is('archived_at', null)
    .order('service_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) {
    return c.json({ error: 'Failed to load customer services' }, 500);
  }

  return c.json({ services: data ?? [] });
});

customerRoutes.get('/customers/:id/deletion-impact', async (c) => {
  const supabase = c.get('supabase');
  const customerId = c.req.param('id');
  if (!uuidRegex.test(customerId)) return c.json({ error: 'Invalid customer ID format' }, 400);

  const [custRes, srvRes, payRes, remRes, fileRes] = await Promise.all([
    supabase.from('customers').select('id, full_name, customer_code').eq('id', customerId).single(),
    supabase.from('services').select('id', { count: 'exact', head: true }).eq('customer_id', customerId),
    supabase.from('payments').select('id', { count: 'exact', head: true }).eq('customer_id', customerId),
    supabase.from('reminders').select('id', { count: 'exact', head: true }).eq('customer_id', customerId),
    supabase.from('service_files').select('id', { count: 'exact', head: true }).eq('customer_id', customerId),
  ]);

  if (custRes.error || !custRes.data) {
    return c.json({ error: 'Customer not found' }, 404);
  }

  return c.json({
    customer: custRes.data,
    impact: {
      services_count: srvRes.count ?? 0,
      payments_count: payRes.count ?? 0,
      reminders_count: remRes.count ?? 0,
      files_count: fileRes.count ?? 0,
    },
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

  const { data, error } = await supabase
    .from('customers')
    .update({
      ...parsed.data,
      updated_by: user.id,
    })
    .eq('id', customerId)
    .select('*')
    .single();

  if (error || !data) {
    return c.json({ error: 'Failed to update customer' }, 500);
  }

  return c.json({ customer: data });
});

async function archiveCustomer(
  supabase: AppBindings['Variables']['supabase'],
  userId: string,
  customerId: string
) {
  return supabase
    .from('customers')
    .update({ archived_at: new Date().toISOString(), updated_by: userId })
    .eq('id', customerId)
    .select('*')
    .single();
}

customerRoutes.post('/customers/:id/archive', async (c) => {
  const supabase = c.get('supabase');
  const user = c.get('authUser');
  const customerId = c.req.param('id');
  if (!uuidRegex.test(customerId)) return c.json({ error: 'Invalid customer ID format' }, 400);

  const { data, error } = await archiveCustomer(supabase, user.id, customerId);
  if (error || !data) return c.json({ error: 'Failed to archive customer' }, 500);
  return c.json({ customer: data });
});

// Safe deletion: supports ?mode=archive (recoverable default) or ?mode=permanent (transactional + storage cleanup)
customerRoutes.delete('/customers/:id', async (c) => {
  const supabase = c.get('supabase');
  const user = c.get('authUser');
  const customerId = c.req.param('id');
  const mode = c.req.query('mode') === 'permanent' ? 'permanent' : 'archive';
  if (!uuidRegex.test(customerId)) return c.json({ error: 'Invalid customer ID format' }, 400);

  if (mode === 'permanent') {
    const { data, error } = await supabase.rpc('permanently_delete_customer', {
      p_customer_id: customerId,
    });
    if (error || !data) {
      return c.json({ error: 'Failed to permanently delete customer' }, 500);
    }
    const result = data as { storage_paths?: string[] };
    const paths = Array.isArray(result.storage_paths) ? result.storage_paths.filter(Boolean) : [];
    if (paths.length > 0) {
      const bucket = c.env.STORAGE_BUCKET || 'zero-base-files';
      await supabase.storage.from(bucket).remove(paths);
    }
    return c.json({ deleted: true, mode: 'permanent', details: data });
  }

  const { data, error } = await archiveCustomer(supabase, user.id, customerId);
  if (error || !data) return c.json({ error: 'Failed to archive customer' }, 500);
  return c.json({ customer: data, archived: true, mode: 'archive' });
});

customerRoutes.post('/customers/:id/restore', async (c) => {
  const supabase = c.get('supabase');
  const user = c.get('authUser');
  const customerId = c.req.param('id');
  if (!uuidRegex.test(customerId)) return c.json({ error: 'Invalid customer ID format' }, 400);

  const { data, error } = await supabase
    .from('customers')
    .update({ archived_at: null, updated_by: user.id })
    .eq('id', customerId)
    .select('*')
    .single();

  if (error || !data) return c.json({ error: 'Failed to restore customer' }, 500);
  return c.json({ customer: data });
});
