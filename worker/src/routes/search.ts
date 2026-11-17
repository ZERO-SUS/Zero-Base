import { Hono } from 'hono';
import type { AppBindings } from '../types';

export const searchRoutes = new Hono<AppBindings>();

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

searchRoutes.get('/search', async (c) => {
  const supabase = c.get('supabase');

  const rawQ = (c.req.query('q') ?? '').replace(/\s+/g, ' ').trim();
  const qLower = rawQ.toLowerCase();
  const qDigits = rawQ.replace(/\D/g, '');

  const year = c.req.query('year')?.trim() || '';
  const month = c.req.query('month')?.trim() || '';
  const startDate = c.req.query('start_date')?.trim() || '';
  const endDate = c.req.query('end_date')?.trim() || '';
  const area = (c.req.query('area') ?? '').trim().toLowerCase();
  const paymentStatus = c.req.query('payment_status')?.trim() || '';
  const paymentMethod = c.req.query('payment_method')?.trim() || '';
  const customerId = c.req.query('customer_id')?.trim() || '';
  const reminderStatus = c.req.query('reminder_status')?.trim() || '';
  const serviceType = c.req.query('service_type')?.trim() || '';
  const sort = c.req.query('sort')?.trim() || 'newest';
  const page = Math.max(1, Number(c.req.query('page') ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(c.req.query('page_size') ?? 25)));

  let query = supabase
    .from('services')
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
      payments (
        id,
        payment_method,
        archived_at
      ),
      reminders (
        id,
        due_date,
        status,
        archived_at
      )
    `
    )
    .is('archived_at', null);

  if (customerId && uuidRegex.test(customerId)) {
    query = query.eq('customer_id', customerId);
  }
  if (paymentStatus) {
    query = query.eq('payment_status', paymentStatus);
  }
  if (serviceType) {
    query = query.eq('service_type', serviceType);
  }
  if (year && /^\d{4}$/.test(year)) {
    const y = Number(year);
    if (month && /^(0?[1-9]|1[0-2])$/.test(month)) {
      const m = Number(month);
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      query = query
        .gte('service_date', `${y}-${String(m).padStart(2, '0')}-01`)
        .lte('service_date', `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`);
    } else {
      query = query.gte('service_date', `${y}-01-01`).lte('service_date', `${y}-12-31`);
    }
  }
  if (startDate && dateRegex.test(startDate)) {
    query = query.gte('service_date', startDate);
  }
  if (endDate && dateRegex.test(endDate)) {
    query = query.lte('service_date', endDate);
  }

  const { data, error } = await query;
  if (error) {
    return c.json({ error: 'Search query failed' }, 500);
  }

  type SearchRow = Record<string, unknown> & {
    id: string;
    customer_id: string;
    service_date: string;
    service_type: string;
    tank_details?: string | null;
    description?: string | null;
    notes?: string | null;
    total_amount: number;
    customers: {
      id: string;
      customer_code: string;
      full_name: string;
      phone_number: string;
      alternate_phone?: string | null;
      address: string;
      area?: string | null;
    };
    payments?: Array<{ payment_method: string; archived_at?: string | null }>;
    reminders?: Array<{ status: string; archived_at?: string | null }>;
  };

  let rows = (data ?? []) as SearchRow[];

  // Collect facets before secondary filters
  const areasSet = new Set<string>();
  const yearsSet = new Set<number>();
  for (const r of rows) {
    if (r.customers.area) areasSet.add(r.customers.area);
    yearsSet.add(Number(r.service_date.slice(0, 4)));
  }

  if (area) {
    rows = rows.filter((r) => (r.customers.area ?? '').toLowerCase().includes(area));
  }
  if (paymentMethod) {
    rows = rows.filter((r) =>
      (r.payments ?? []).some((p) => !p.archived_at && p.payment_method === paymentMethod)
    );
  }
  if (reminderStatus) {
    rows = rows.filter((r) =>
      (r.reminders ?? []).some((rem) => !rem.archived_at && rem.status === reminderStatus)
    );
  }

  if (qLower.length > 0) {
    rows = rows.filter((r) => {
      const cust = r.customers;
      const phone1Digits = cust.phone_number.replace(/\D/g, '');
      const phone2Digits = (cust.alternate_phone ?? '').replace(/\D/g, '');
      return (
        cust.full_name.toLowerCase().includes(qLower) ||
        cust.customer_code.toLowerCase().includes(qLower) ||
        cust.id.toLowerCase() === qLower ||
        r.id.toLowerCase() === qLower ||
        cust.phone_number.toLowerCase().includes(qLower) ||
        (cust.alternate_phone ?? '').toLowerCase().includes(qLower) ||
        (qDigits.length >= 4 &&
          (phone1Digits.includes(qDigits) || phone2Digits.includes(qDigits))) ||
        cust.address.toLowerCase().includes(qLower) ||
        (cust.area ?? '').toLowerCase().includes(qLower) ||
        r.service_type.toLowerCase().includes(qLower) ||
        (r.description ?? '').toLowerCase().includes(qLower) ||
        (r.notes ?? '').toLowerCase().includes(qLower) ||
        r.service_date.includes(qLower)
      );
    });
  }

  rows.sort((a, b) => {
    switch (sort) {
      case 'oldest':
        return a.service_date.localeCompare(b.service_date);
      case 'customer_name':
        return a.customers.full_name.localeCompare(b.customers.full_name);
      case 'amount_desc':
        return Number(b.total_amount) - Number(a.total_amount);
      case 'amount_asc':
        return Number(a.total_amount) - Number(b.total_amount);
      case 'newest':
      default:
        return b.service_date.localeCompare(a.service_date);
    }
  });

  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const startIdx = (page - 1) * pageSize;
  const items = rows.slice(startIdx, startIdx + pageSize);

  return c.json({
    total,
    page,
    page_size: pageSize,
    total_pages: totalPages,
    items,
    facets: {
      areas: Array.from(areasSet).sort(),
      years: Array.from(yearsSet).sort((a, b) => b - a),
    },
  });
});
