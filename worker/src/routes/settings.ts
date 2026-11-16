import { Hono } from 'hono';
import { z } from 'zod';
import { requireAdmin } from '../lib/auth';
import type { AppBindings } from '../types';

export const settingsRoutes = new Hono<AppBindings>();

const updateSettingsSchema = z.object({
  app_name: z.string().trim().min(1).max(60).optional(),
  service_types: z.array(z.string().trim().min(1).max(100)).min(1).max(30).optional(),
  default_reminder_months: z.number().int().min(1).max(60).optional(),
});

settingsRoutes.get('/settings', async (c) => {
  const supabase = c.get('supabase');
  const { data, error } = await supabase
    .from('business_settings')
    .select('*')
    .eq('singleton_key', true)
    .single();

  if (error || !data) {
    return c.json({ error: 'Failed to load business settings' }, 500);
  }

  return c.json({ settings: data });
});

settingsRoutes.patch('/settings', requireAdmin, async (c) => {
  const supabase = c.get('supabase');
  const user = c.get('authUser');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON request body' }, 400);
  }

  const parsed = updateSettingsSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const { data, error } = await supabase
    .from('business_settings')
    .update({
      ...parsed.data,
      updated_by: user.id,
    })
    .eq('singleton_key', true)
    .select('*')
    .single();

  if (error || !data) {
    return c.json({ error: 'Failed to update business settings' }, 500);
  }

  return c.json({ settings: data });
});

settingsRoutes.get('/audit-logs', requireAdmin, async (c) => {
  const supabase = c.get('supabase');
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50)));
  const entityType = c.req.query('entity_type');

  let query = supabase
    .from('audit_logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (entityType) {
    query = query.eq('entity_type', entityType);
  }

  const { data, error } = await query;
  if (error) {
    return c.json({ error: 'Failed to fetch audit logs' }, 500);
  }

  return c.json({ audit_logs: data ?? [] });
});

settingsRoutes.get('/backup/export', requireAdmin, async (c) => {
  const supabase = c.get('supabase');
  const user = c.get('authUser');

  const [customers, services, payments, attachments, reminders, businessSettings] =
    await Promise.all([
      supabase.from('customers').select('*'),
      supabase.from('services').select('*'),
      supabase.from('payments').select('*'),
      supabase.from('attachments').select('*'),
      supabase.from('reminders').select('*'),
      supabase.from('business_settings').select('*'),
    ]);

  const errors = [
    customers.error,
    services.error,
    payments.error,
    attachments.error,
    reminders.error,
    businessSettings.error,
  ].filter(Boolean);

  if (errors.length > 0) {
    return c.json({ error: 'Failed to export consistent database snapshot' }, 500);
  }

  await supabase.from('audit_logs').insert({
    actor_id: user.id,
    actor_email: user.email,
    action: 'BACKUP',
    entity_type: 'full_snapshot',
    metadata: {
      counts: {
        customers: customers.data?.length ?? 0,
        services: services.data?.length ?? 0,
        payments: payments.data?.length ?? 0,
        attachments: attachments.data?.length ?? 0,
        reminders: reminders.data?.length ?? 0,
      },
    },
  });

  return c.json({
    exported_at: new Date().toISOString(),
    timezone: 'Asia/Kolkata',
    tables: {
      business_settings: businessSettings.data ?? [],
      customers: customers.data ?? [],
      services: services.data ?? [],
      payments: payments.data ?? [],
      attachments: attachments.data ?? [],
      reminders: reminders.data ?? [],
    },
  });
});
