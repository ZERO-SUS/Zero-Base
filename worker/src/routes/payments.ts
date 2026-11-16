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
  transaction_reference: z.string().trim().max(150).optional().nullable(),
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
      transaction_reference: z.string().trim().max(150).optional().nullable(),
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
  const startDate = c.req.query('start_date');
  const endDate = c.req.query('end_date');
  const includeArchived = c.req.query('include_archived') === 'true';

  let query = supabase
    .from('payments')
    .select(
      `
      *,
      services!inner (
        service_id,
        service_date,
        service_type,
        total_amount,
        amount_paid,
        payment_status,
        customers!inner (
          customer_id,
          full_name,
          primary_phone
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

  // Also fetch services with outstanding balances for quick settlement
  const { data: outstandingServices } = await supabase
    .from('services')
    .select(
      `
      service_id,
      service_date,
      service_type,
      total_amount,
      amount_paid,
      payment_status,
      customers!inner (
        customer_id,
        full_name,
        primary_phone
      )
    `
    )
    .is('archived_at', null)
    .in('payment_status', ['Unpaid', 'Partially Paid'])
    .order('service_date', { ascending: false })
    .limit(100);

  return c.json({
    payments: data ?? [],
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

  // Verify service exists & is active
  const { data: service, error: srvErr } = await supabase
    .from('services')
    .select('service_id, total_amount, amount_paid, archived_at')
    .eq('service_id', payload.service_id)
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
      amount: payload.amount,
      payment_type: payload.payment_type,
      payment_method: payload.payment_method,
      transaction_reference: payload.transaction_reference || null,
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
    .eq('service_id', payload.service_id)
    .single();

  return c.json({ payment, service: updatedService }, 201);
});

// Preserve audit history when correcting a payment; never silently delete
paymentRoutes.post('/payments/:id/correct', async (c) => {
  const supabase = c.get('supabase');
  const user = c.get('authUser');
  const paymentId = c.req.param('id');

  if (!uuidRegex.test(paymentId)) {
    return c.json({ error: 'Invalid payment ID format' }, 400);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON request body' }, 400);
  }

  const parsed = correctPaymentSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const { data: original, error: findErr } = await supabase
    .from('payments')
    .select('*')
    .eq('payment_id', paymentId)
    .single();

  if (findErr || !original) {
    return c.json({ error: 'Payment record not found' }, 404);
  }

  if (original.archived_at) {
    return c.json({ error: 'Payment record is already archived/superseded' }, 400);
  }

  let replacementPayment = null;
  if (parsed.data.replacement) {
    const rep = parsed.data.replacement;
    const { data: inserted, error: repErr } = await supabase
      .from('payments')
      .insert({
        service_id: original.service_id,
        amount: rep.amount,
        payment_type: rep.payment_type,
        payment_method: rep.payment_method,
        transaction_reference: rep.transaction_reference || null,
        payment_date: rep.payment_date,
        notes: rep.notes || `Correction of payment ${paymentId}: ${parsed.data.reason}`,
        created_by: user.id,
      })
      .select('*')
      .single();

    if (repErr || !inserted) {
      return c.json({ error: 'Failed to create replacement payment record' }, 500);
    }
    replacementPayment = inserted;
  }

  const { data: archivedOriginal, error: archErr } = await supabase
    .from('payments')
    .update({
      archived_at: new Date().toISOString(),
      archived_by: user.id,
      archive_reason: parsed.data.reason,
      superseded_by: replacementPayment ? replacementPayment.payment_id : null,
    })
    .eq('payment_id', paymentId)
    .select('*')
    .single();

  if (archErr || !archivedOriginal) {
    return c.json({ error: 'Failed to archive superseded payment' }, 500);
  }

  const { data: updatedService } = await supabase
    .from('services')
    .select('*')
    .eq('service_id', original.service_id)
    .single();

  return c.json({
    archived_payment: archivedOriginal,
    replacement_payment: replacementPayment,
    service: updatedService,
  });
});

paymentRoutes.post('/payments/:id/restore', async (c) => {
  const supabase = c.get('supabase');
  const paymentId = c.req.param('id');

  if (!uuidRegex.test(paymentId)) {
    return c.json({ error: 'Invalid payment ID format' }, 400);
  }

  const { data, error } = await supabase
    .from('payments')
    .update({
      archived_at: null,
      archived_by: null,
      archive_reason: null,
    })
    .eq('payment_id', paymentId)
    .select('*')
    .single();

  if (error || !data) {
    return c.json({ error: 'Failed to restore payment' }, 500);
  }

  return c.json({ payment: data });
});
