import { Hono } from 'hono';
import { z } from 'zod';
import { computeReminderCategory, getIstToday } from '../lib/timezone';
import type { AppBindings } from '../types';

export const reminderRoutes = new Hono<AppBindings>();

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

const updateReminderSchema = z.object({
  due_date: z.string().regex(dateRegex).optional(),
  status: z
    .enum(['active', 'contacted', 'confirmed', 'snoozed', 'dismissed', 'completed'])
    .optional(),
  snoozed_until: z.string().regex(dateRegex).optional().nullable(),
  notes: z.string().trim().max(1500).optional().nullable(),
});

reminderRoutes.get('/reminders', async (c) => {
  const supabase = c.get('supabase');
  const categoryFilter = c.req.query('category');
  const todayIst = getIstToday();

  const { data, error } = await supabase
    .from('reminders')
    .select(
      `
      *,
      customers!inner (
        customer_id,
        full_name,
        primary_phone,
        secondary_phone,
        address,
        locality
      ),
      services!inner (
        service_id,
        service_date,
        service_type,
        tank_capacity,
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
    : enriched.filter((r) => r.status !== 'completed');

  const counts = {
    Overdue: enriched.filter((r) => r.category === 'Overdue').length,
    'Due Today': enriched.filter((r) => r.category === 'Due Today').length,
    Upcoming: enriched.filter((r) => r.category === 'Upcoming').length,
    Contacted: enriched.filter((r) => r.category === 'Contacted').length,
    Confirmed: enriched.filter((r) => r.category === 'Confirmed').length,
    Snoozed: enriched.filter((r) => r.category === 'Snoozed').length,
    Dismissed: enriched.filter((r) => r.category === 'Dismissed').length,
  };

  return c.json({
    today_ist: todayIst,
    counts,
    reminders: filtered,
  });
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

  if (parsed.data.due_date !== undefined) {
    updates.due_date = parsed.data.due_date;
  }
  if (parsed.data.notes !== undefined) {
    updates.notes = parsed.data.notes;
  }
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
    .eq('reminder_id', reminderId)
    .select('*')
    .single();

  if (error || !data) {
    return c.json({ error: 'Failed to update reminder' }, 500);
  }

  // Keep linked service's next_due_date in sync if due_date changed
  if (parsed.data.due_date) {
    await supabase
      .from('services')
      .update({ next_due_date: parsed.data.due_date, updated_by: user.id })
      .eq('service_id', data.service_id);
  }

  return c.json({
    reminder: {
      ...data,
      category: computeReminderCategory(data),
    },
  });
});
