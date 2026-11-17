import { Hono } from 'hono';
import { z } from 'zod';
import { requireAdmin } from '../lib/auth';
import { inferCategoryKind } from '../lib/cartPricing';
import type { AppBindings } from '../types';

export const settingsRoutes = new Hono<AppBindings>();

const serviceCategorySchema = z.object({
  name: z.string().trim().min(1).max(100),
  active: z.boolean().default(true),
  kind: z.enum(['tank', 'sump', 'solar', 'plumbing', 'other']).optional(),
});

const updateSettingsSchema = z.object({
  app_name: z.string().trim().min(1).max(60).optional(),
  service_types: z.array(z.string().trim().min(1).max(100)).min(1).max(40).optional(),
  service_categories: z.array(serviceCategorySchema).min(1).max(40).optional(),
  default_reminder_months: z.number().int().min(1).max(60).optional(),
});

function normalizeSettingsRow(data: Record<string, unknown>) {
  const types = Array.isArray(data.service_types) ? (data.service_types as string[]) : [];
  const cats = Array.isArray(data.service_categories)
    ? data.service_categories
    : types.map((name) => ({
        name,
        active: true,
        kind: inferCategoryKind(name),
      }));
  return {
    ...data,
    service_categories: cats,
  };
}

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

  return c.json({ settings: normalizeSettingsRow(data as Record<string, unknown>) });
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

  const updates: Record<string, unknown> = {
    updated_by: user.id,
  };

  if (parsed.data.app_name !== undefined) {
    updates.app_name = parsed.data.app_name;
  }
  if (parsed.data.default_reminder_months !== undefined) {
    updates.default_reminder_months = parsed.data.default_reminder_months;
  }

  if (parsed.data.service_categories !== undefined) {
    const normalizedCats = parsed.data.service_categories.map((cat) => ({
      name: cat.name.trim(),
      active: cat.active,
      kind: cat.kind ?? inferCategoryKind(cat.name),
    }));
    const activeNames = normalizedCats.filter((c) => c.active).map((c) => c.name);
    if (activeNames.length === 0) {
      return c.json(
        { error: 'At least one active service category must remain enabled.' },
        400
      );
    }
    updates.service_categories = normalizedCats;
    updates.service_types = activeNames;
  } else if (parsed.data.service_types !== undefined) {
    updates.service_types = parsed.data.service_types;
    updates.service_categories = parsed.data.service_types.map((name) => ({
      name,
      active: true,
      kind: inferCategoryKind(name),
    }));
  }

  const { data, error } = await supabase
    .from('business_settings')
    .update(updates)
    .eq('singleton_key', true)
    .select('*')
    .single();

  if (error || !data) {
    return c.json({ error: 'Failed to update business settings' }, 500);
  }

  return c.json({ settings: normalizeSettingsRow(data as Record<string, unknown>) });
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

  const [customers, services, categoryGroups, serviceItems, payments, serviceFiles, reminders, businessSettings] =
    await Promise.all([
      supabase.from('customers').select('*'),
      supabase.from('services').select('*'),
      supabase.from('service_category_groups').select('*'),
      supabase.from('service_items').select('*'),
      supabase.from('payments').select('*'),
      supabase.from('service_files').select('*'),
      supabase.from('reminders').select('*'),
      supabase.from('business_settings').select('*'),
    ]);

  const errors = [
    customers.error,
    services.error,
    payments.error,
    serviceFiles.error,
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
        service_category_groups: categoryGroups.data?.length ?? 0,
        service_items: serviceItems.data?.length ?? 0,
        payments: payments.data?.length ?? 0,
        service_files: serviceFiles.data?.length ?? 0,
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
      service_category_groups: categoryGroups.data ?? [],
      service_items: serviceItems.data ?? [],
      payments: payments.data ?? [],
      service_files: serviceFiles.data ?? [],
      reminders: reminders.data ?? [],
    },
  });
});
