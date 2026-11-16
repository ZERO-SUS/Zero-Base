import { Hono } from 'hono';
import { z } from 'zod';
import type { AppBindings } from '../types';

export const paymentRoutes = new Hono<AppBindings>();

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

const createPaymentSchema = z.object({
  service_id: z.string().regex(uuidRegex, 'Valid service_id is required'),
  amount: z.number().positive('Amount must be greater than zero').max(10_000_000),
  payment_type: z.enum(['payment', 'refund']).default('payment'),
  payment_method: z.enum(['Cash', 'UPI', 'Other']),
  reference_number: z.string().trim().max(150).optional().nullable(),
  payment_date: z.string().regex(dateRegex, 'payment_date must be YYYY-MM-DD'),
  notes: z.string().trim().max(1000).optional().nullable(),
  idempotency_key: z.string().trim().max(120).optional().nullable(),
});

const correctPaymentSchema = z.object({
  reason: z.string().trim().min(3, 'Correction reason is required').max(500),
  replacement: z
    .object({
      amount: z.number().positive().max(10_000_000),
      payment_type: z.enum(['payment', 'refund']).default('payment'),
      payment_method: z.enum(['Cash', 'UPI', 'Other']),
      reference_number: z.string().trim().max(150).optional().nullable(),
      payment_date: z.string().regex(dateRegex),
      notes: z.string().trim().max(1000).optional().nullable(),
    })
    .optional()
    .nullable(),
});

paymentRoutes.get('/payments', async (c) => {
  const supabase = c.get('supabase');
  const method = c.req.query('payment_method');
  const paymentType = c.req.query('payment_type');
  const serviceId = c.req.query('service_id');
  const customerId = c.req.query('customer_id');
  const startDate = c.req.query('start_date');
  const endDate = c.req.query('end_date');
  const q = (c.req.query('q') ?? '').trim().toLowerCase();
  const includeArchived = c.req.query('include_archived') === 'true';

  let query = supabase
    .from('payments')
    .select(
      `
      *,
      services!inner (
        id,
        service_date,
        service_type,
        total_amount,
        amount_paid,
        balance_amount,
        payment_status,
        customers!inner (
          id,
          customer_code,
          full_name,
          phone_number
        )
      )
    `
    )
    .order('payment_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(300);

  if (!includeArchived) {
    query = query.is('archived_at', null);
  }
  if (method && ['Cash', 'UPI', 'Other'].includes(method)) {
    query = query.eq('payment_method', method);
  }
  if (paymentType && ['payment', 'refund'].includes(paymentType)) {
    query = query.eq('payment_type', paymentType);
  }
  if (serviceId && uuidRegex.test(serviceId)) {
    query = query.eq('service_id', serviceId);
  }
  if (customerId && uuidRegex.test(customerId)) {
    query = query.eq('customer_id', customerId);
  }
  if (startDate && dateRegex.test(startDate)) {
    query = query.gte('payment_date', startDate);
  }
  if (endDate && dateRegex.test(endDate)) {
    query = query.lte('payment_date', endDate);
  }

  const { data, error } = await query;
  if (error) {
    return c.json({ error: 'Failed to load payments' }, 500);
  }

  let payments = (data ?? []) as Array<
    Record<string, unknown> & {
      reference_number?: string | null;
      notes?: string | null;
      services?: {
        service_type?: string;
        customers?: { full_name?: string; phone_number?: string; customer_code?: string };
      };
    }
  >;

  if (q.length > 0) {
    payments = payments.filter((p) => {
      const cust = p.services?.customers;
      return (
        (cust?.full_name ?? '').toLowerCase().includes(q) ||
        (cust?.phone_number ?? '').toLowerCase().includes(q) ||
        (cust?.customer_code ?? '').toLowerCase().includes(q) ||
        (p.reference_number ?? '').toLowerCase().includes(q) ||
        (p.notes ?? '').toLowerCase().includes(q)
      );
    });
  }

  const { data: outstandingServices } = await supabase
    .from('services')
    .select(
      `
      id,
      service_date,
      service_type,
      total_amount,
      amount_paid,
      balance_amount,
      payment_status,
      customers!inner (
        id,
        customer_code,
        full_name,
        phone_number
      )
    `
    )
    .is('archived_at', null)
    .in('payment_status', ['Unpaid', 'Partially Paid'])
    .order('service_date', { ascending: false })
    .limit(100);

  return c.json({
    payments,
    outstanding_services: outstandingServices ?? [],
  });
});

paymentRoutes.post('/payments', async (c) => {
  const supabase = c.get('supabase');
  const user = c.get('authUser');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON request body' }, 400);
  }

  const parsed = createPaymentSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const payload = parsed.data;

  const { data: service, error: srvErr } = await supabase
    .from('services')
    .select('id, customer_id, total_amount, amount_paid, archived_at')
    .eq('id', payload.service_id)
    .single();

  if (srvErr || !service) {
    return c.json({ error: 'Service record not found' }, 404);
  }
  if (service.archived_at) {
    return c.json({ error: 'Cannot record payment for an archived service' }, 400);
  }

  if (payload.payment_type === 'refund' && payload.amount > Number(service.amount_paid)) {
    return c.json(
      {
        error: `Refund amount (₹${payload.amount}) cannot exceed amount paid (₹${service.amount_paid})`,
      },
      400
    );
  }

  if (payload.idempotency_key) {
    const { data: existing } = await supabase
      .from('payments')
      .select('*')
      .eq('idempotency_key', payload.idempotency_key)
      .maybeSingle();
    if (existing) {
      return c.json({ payment: existing, deduplicated: true }, 200);
    }
  }

  const { data: payment, error: insertErr } = await supabase
    .from('payments')
    .insert({
      service_id: payload.service_id,
      customer_id: service.customer_id,
      amount: payload.amount,
      payment_type: payload.payment_type,
      payment_method: payload.payment_method,
      reference_number: payload.reference_number || null,
      payment_date: payload.payment_date,
      notes: payload.notes || null,
      idempotency_key: payload.idempotency_key || null,
      created_by: user.id,
    })
    .select('*')
    .single();

  if (insertErr || !payment) {
    return c.json({ error: 'Failed to record payment' }, 500);
  }

  const { data: updatedService } = await supabase
    .from('services')
    .select('*')
    .eq('id', payload.service_id)
    .single();

  return c.json({ payment, service: updatedService }, 201);
});

async function applyPaymentCorrection(
  supabase: AppBindings['Variables']['supabase'],
  userId: string,
  paymentId: string,
  body: unknown
) {
  const parsed = correctPaymentSchema.safeParse(body);
  if (!parsed.success) {
    return { status: 400 as const, body: { error: 'Validation failed', details: parsed.error.flatten() } };
  }

  const { data: original, error: findErr } = await supabase
    .from('payments')
    .select('*')
    .eq('id', paymentId)
    .single();

  if (findErr || !original) {
    return { status: 404 as const, body: { error: 'Payment record not found' } };
  }
  if (original.archived_at) {
    return { status: 400 as const, body: { error: 'Payment record is already archived/superseded' } };
  }

  let replacementPayment = null;
  if (parsed.data.replacement) {
    const rep = parsed.data.replacement;
    const { data: inserted, error: repErr } = await supabase
      .from('payments')
      .insert({
        service_id: original.service_id,
        customer_id: original.customer_id,
        amount: rep.amount,
        payment_type: rep.payment_type,
        payment_method: rep.payment_method,
        reference_number: rep.reference_number || null,
        payment_date: rep.payment_date,
        notes: rep.notes || `Correction of payment ${paymentId}: ${parsed.data.reason}`,
        created_by: userId,
      })
      .select('*')
      .single();

    if (repErr || !inserted) {
      return { status: 500 as const, body: { error: 'Failed to create replacement payment record' } };
    }
    replacementPayment = inserted;
  }

  const { data: archivedOriginal, error: archErr } = await supabase
    .from('payments')
    .update({
      archived_at: new Date().toISOString(),
      archived_by: userId,
      archive_reason: parsed.data.reason,
      superseded_by: replacementPayment ? replacementPayment.id : null,
    })
    .eq('id', paymentId)
    .select('*')
    .single();

  if (archErr || !archivedOriginal) {
    return { status: 500 as const, body: { error: 'Failed to archive superseded payment' } };
  }

  const { data: updatedService } = await supabase
    .from('services')
    .select('*')
    .eq('id', original.service_id)
    .single();

  return {
    status: 200 as const,
    body: {
      archived_payment: archivedOriginal,
      replacement_payment: replacementPayment,
      service: updatedService,
    },
  };
}

paymentRoutes.post('/payments/:id/correct', async (c) => {
  const paymentId = c.req.param('id');
  if (!uuidRegex.test(paymentId)) return c.json({ error: 'Invalid payment ID format' }, 400);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON request body' }, 400);
  }

  const res = await applyPaymentCorrection(c.get('supabase'), c.get('authUser').id, paymentId, body);
  return c.json(res.body, res.status);
});

paymentRoutes.patch('/payments/:id', async (c) => {
  const paymentId = c.req.param('id');
  if (!uuidRegex.test(paymentId)) return c.json({ error: 'Invalid payment ID format' }, 400);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON request body' }, 400);
  }

  const res = await applyPaymentCorrection(c.get('supabase'), c.get('authUser').id, paymentId, body);
  return c.json(res.body, res.status);
});

paymentRoutes.post('/payments/:id/restore', async (c) => {
  const supabase = c.get('supabase');
  const paymentId = c.req.param('id');
  if (!uuidRegex.test(paymentId)) return c.json({ error: 'Invalid payment ID format' }, 400);

  const { data, error } = await supabase
    .from('payments')
    .update({
      archived_at: null,
      archived_by: null,
      archive_reason: null,
    })
    .eq('id', paymentId)
    .select('*')
    .single();

  if (error || !data) return c.json({ error: 'Failed to restore payment' }, 500);
  return c.json({ payment: data });
});
