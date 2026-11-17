import { Hono } from 'hono';
import { z } from 'zod';
import { inferCategoryKind } from '../lib/cartPricing';
import type { AppBindings } from '../types';

export const authRoutes = new Hono<AppBindings>();

const updatePreferencesSchema = z.object({
  theme_mode: z.enum(['light', 'dark', 'system']).optional(),
  accent_color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Accent color must be a valid #RRGGBB HEX code')
    .optional(),
  full_name: z.string().trim().min(1).max(120).optional(),
});

authRoutes.get('/me', async (c) => {
  const user = c.get('authUser');
  const supabase = c.get('supabase');

  const { data: settings } = await supabase
    .from('business_settings')
    .select('*')
    .eq('singleton_key', true)
    .single();

  const defaultTypes = [
    'Overhead Tank Cleaning',
    'Underground Sump Cleaning',
    'Sump and Overhead Tank Cleaning',
    'Solar Cleaning',
    'Plumbing',
  ];

  const rawSettings = (settings ?? {}) as Record<string, unknown>;
  const rawTypes = Array.isArray(rawSettings.service_types)
    ? (rawSettings.service_types as string[])
    : defaultTypes;
  const rawCats = Array.isArray(rawSettings.service_categories)
    ? rawSettings.service_categories
    : rawTypes.map((name) => ({
        name,
        active: true,
        kind: inferCategoryKind(name),
      }));

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      full_name: user.fullName,
      role: user.role,
      theme_mode: user.themeMode,
      accent_color: user.accentColor,
    },
    settings: {
      app_name: (rawSettings.app_name as string) ?? 'ZERO BASE',
      timezone: (rawSettings.timezone as string) ?? 'Asia/Kolkata',
      currency_code: (rawSettings.currency_code as string) ?? 'INR',
      currency_symbol: (rawSettings.currency_symbol as string) ?? '₹',
      service_types: rawTypes,
      service_categories: rawCats,
      default_reminder_months: (rawSettings.default_reminder_months as number) ?? 6,
    },
  });
});

authRoutes.patch('/me/preferences', async (c) => {
  const user = c.get('authUser');
  const supabase = c.get('supabase');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON request body' }, 400);
  }

  const parsed = updatePreferencesSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const updates: Record<string, unknown> = {};
  if (parsed.data.theme_mode !== undefined) updates.theme_mode = parsed.data.theme_mode;
  if (parsed.data.accent_color !== undefined) {
    updates.accent_color = parsed.data.accent_color.toUpperCase();
  }
  if (parsed.data.full_name !== undefined) updates.full_name = parsed.data.full_name;

  if (Object.keys(updates).length === 0) {
    return c.json({ error: 'No preference fields provided' }, 400);
  }

  const { data, error } = await supabase
    .from('profiles')
    .update(updates)
    .eq('id', user.id)
    .select('id, email, full_name, role, theme_mode, accent_color')
    .single();

  if (error || !data) {
    return c.json({ error: 'Unable to update preferences' }, 500);
  }

  return c.json({ user: data });
});
