import { Hono } from 'hono';
import { z } from 'zod';
import { computeReminderCategory, getIstToday } from '../lib/timezone';
import type { AppBindings } from '../types';

export const reminderRoutes = new Hono<AppBindings>();

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

const createReminderSchema = z.object({
  customer_id: z.string().regex(uuidRegex, 'Valid customer_id is required'),
  service_id: z.string().regex(uuidRegex).optional().nullable(),
  due_date: z.string().regex(dateRegex, 'due_date must be YYYY-MM-DD'),
  reminder_type: z.enum(['service_due', 'custom', 'follow_up']).default('custom'),
  notes: z.string().trim().max(1500).optional().nullable(),
});

const updateReminderSchema = z.object({
  due_date: z.string().regex(dateRegex).optional(),
  reminder_type: z.enum(['service_due', 'custom', 'follow_up']).optional(),
  status: z
    .enum(['active', 'contacted', 'confirmed', 'snoozed', 'dismissed', 'completed'])
    .optional(),
  snoozed_until: z.string().regex(dateRegex).optional().nullable(),
  notes: z.string().trim().max(1500).optional().nullable(),
});

reminderRoutes.get('/reminders', async (c) => {
  const supabase = c.get('supabase');
  const categoryFilter = c.req.query('category');
  const includeCompleted = c.req.query('include_completed') === 'true';
  const todayIst = getIstToday();

  const { data, error } = await supabase
    .from('reminders')
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
      ),
      services (
        id,
        service_date,
        service_type,
        tank_details,
        total_amount
      )
    `
    )
    .is('archived_at', null)
    .order('due_date', { ascending: true });

  if (error) {
    return c.json({ error: 'Failed to load reminders' }, 500);
  }

  const enriched = (data ?? []).map((r) => ({
    ...r,
    category: computeReminderCategory(r, todayIst),
  }));

  const filtered = categoryFilter
    ? enriched.filter((r) => r.category.toLowerCase() === categoryFilter.toLowerCase())
    : includeCompleted
      ? enriched
      : enriched.filter((r) => r.status !== 'completed');

  const counts = {
    Overdue: enriched.filter((r) => r.category === 'Overdue').length,
    'Due Today': enriched.filter((r) => r.category === 'Due Today').length,
    Upcoming: enriched.filter((r) => r.category === 'Upcoming').length,
    Contacted: enriched.filter((r) => r.category === 'Contacted').length,
    Confirmed: enriched.filter((r) => r.category === 'Confirmed').length,
    Snoozed: enriched.filter((r) => r.category === 'Snoozed').length,
    Completed: enriched.filter((r) => r.category === 'Completed').length,
    Dismissed: enriched.filter((r) => r.category === 'Dismissed').length,
  };

  return c.json({
    today_ist: todayIst,
    counts,
    reminders: filtered,
  });
});

reminderRoutes.post('/reminders', async (c) => {
  const supabase = c.get('supabase');
  const user = c.get('authUser');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON request body' }, 400);
  }

  const parsed = createReminderSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const payload = parsed.data;

  // Prevent duplicate active reminders for the same service + due date
  if (payload.service_id) {
    const { data: dup } = await supabase
      .from('reminders')
      .select('id')
      .eq('service_id', payload.service_id)
      .is('archived_at', null)
      .in('status', ['active', 'contacted', 'confirmed', 'snoozed'])
      .maybeSingle();

    if (dup) {
      return c.json(
        { error: 'An active reminder already exists for this service record.' },
        409
      );
    }
  }

  const { data, error } = await supabase
    .from('reminders')
    .insert({
      customer_id: payload.customer_id,
      service_id: payload.service_id ?? null,
      due_date: payload.due_date,
      reminder_type: payload.reminder_type,
      status: 'active',
      notes: payload.notes || null,
      created_by: user.id,
      updated_by: user.id,
    })
    .select('*')
    .single();

  if (error || !data) {
    return c.json({ error: 'Failed to create reminder' }, 500);
  }

  return c.json(
    {
      reminder: {
        ...data,
        category: computeReminderCategory(data),
      },
    },
    201
  );
});

reminderRoutes.patch('/reminders/:id', async (c) => {
  const supabase = c.get('supabase');
  const user = c.get('authUser');
  const reminderId = c.req.param('id');

  if (!uuidRegex.test(reminderId)) {
    return c.json({ error: 'Invalid reminder ID format' }, 400);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON request body' }, 400);
  }

  const parsed = updateReminderSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const updates: Record<string, unknown> = {
    updated_by: user.id,
  };

  if (parsed.data.due_date !== undefined) updates.due_date = parsed.data.due_date;
  if (parsed.data.reminder_type !== undefined) updates.reminder_type = parsed.data.reminder_type;
  if (parsed.data.notes !== undefined) updates.notes = parsed.data.notes;

  if (parsed.data.status !== undefined) {
    updates.status = parsed.data.status;
    if (parsed.data.status === 'contacted') {
      updates.contacted_at = new Date().toISOString();
    } else if (parsed.data.status === 'confirmed') {
      updates.confirmed_at = new Date().toISOString();
    } else if (parsed.data.status === 'snoozed') {
      if (!parsed.data.snoozed_until && !parsed.data.due_date) {
        return c.json({ error: 'snoozed_until or new due_date is required when snoozing' }, 400);
      }
      updates.snoozed_until = parsed.data.snoozed_until ?? parsed.data.due_date;
      if (parsed.data.snoozed_until && !parsed.data.due_date) {
        updates.due_date = parsed.data.snoozed_until;
      }
    }
  }

  const { data, error } = await supabase
    .from('reminders')
    .update(updates)
    .eq('id', reminderId)
    .select('*')
    .single();

  if (error || !data) {
    return c.json({ error: 'Failed to update reminder' }, 500);
  }

  if (parsed.data.due_date && data.service_id) {
    await supabase
      .from('services')
      .update({ next_due_date: parsed.data.due_date, updated_by: user.id })
      .eq('id', data.service_id);
  }

  return c.json({
    reminder: {
      ...data,
      category: computeReminderCategory(data),
    },
  });
});
