import { Hono } from 'hono';
import { computeReminderCategory, getIstToday } from '../lib/timezone';
import type { AppBindings } from '../types';

export const dashboardRoutes = new Hono<AppBindings>();

dashboardRoutes.get('/dashboard', async (c) => {
  const supabase = c.get('supabase');
  const todayIst = getIstToday();

  const [metricsRes, recentServicesRes, remindersRes] = await Promise.all([
    supabase.rpc('get_dashboard_metrics'),
    supabase
      .from('services')
      .select(
        `
        service_id,
        customer_id,
        service_date,
        service_type,
        tank_capacity,
        total_amount,
        amount_paid,
        payment_status,
        next_due_date,
        customers (
          customer_id,
          full_name,
          primary_phone,
          locality
        )
      `
      )
      .is('archived_at', null)
      .order('service_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(8),
    supabase
      .from('reminders')
      .select(
        `
        reminder_id,
        service_id,
        customer_id,
        due_date,
        status,
        snoozed_until,
        notes,
        customers (
          customer_id,
          full_name,
          primary_phone,
          locality,
          address
        ),
        services (
          service_id,
          service_type,
          service_date
        )
      `
      )
      .is('archived_at', null)
      .in('status', ['active', 'contacted', 'confirmed', 'snoozed'])
      .order('due_date', { ascending: true })
      .limit(12),
  ]);

  if (metricsRes.error) {
    return c.json({ error: 'Failed to load dashboard metrics' }, 500);
  }
  if (recentServicesRes.error) {
    return c.json({ error: 'Failed to load recent services' }, 500);
  }
  if (remindersRes.error) {
    return c.json({ error: 'Failed to load upcoming reminders' }, 500);
  }

  const upcomingReminders = (remindersRes.data ?? []).map((r) => ({
    ...r,
    category: computeReminderCategory(r, todayIst),
  }));

  return c.json({
    metrics: metricsRes.data,
    recent_services: recentServicesRes.data ?? [],
    upcoming_reminders: upcomingReminders,
  });
});
