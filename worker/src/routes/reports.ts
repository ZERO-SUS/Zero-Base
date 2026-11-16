import { Hono } from 'hono';
import { escapeCsvCell, getIstToday } from '../lib/timezone';
import type { AppBindings } from '../types';

export const reportRoutes = new Hono<AppBindings>();

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

function resolveReportRange(query: {
  period?: string;
  date?: string;
  month?: string;
  year?: string;
  start_date?: string;
  end_date?: string;
}): { startDate: string; endDate: string } | { error: string } {
  const todayIst = getIstToday();
  const period = query.period ?? 'monthly';

  if (period === 'daily') {
    const d = query.date && dateRegex.test(query.date) ? query.date : todayIst;
    return { startDate: d, endDate: d };
  }

  if (period === 'monthly') {
    const ym = query.month && /^\d{4}-\d{2}$/.test(query.month) ? query.month : todayIst.slice(0, 7);
    const [y, m] = ym.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return {
      startDate: `${ym}-01`,
      endDate: `${ym}-${String(lastDay).padStart(2, '0')}`,
    };
  }

  if (period === 'yearly') {
    const y = query.year && /^\d{4}$/.test(query.year) ? query.year : todayIst.slice(0, 4);
    return { startDate: `${y}-01-01`, endDate: `${y}-12-31` };
  }

  if (period === 'custom') {
    if (
      !query.start_date ||
      !query.end_date ||
      !dateRegex.test(query.start_date) ||
      !dateRegex.test(query.end_date)
    ) {
      return { error: 'Valid start_date and end_date (YYYY-MM-DD) are required for custom range' };
    }
    if (query.start_date > query.end_date) {
      return { error: 'start_date cannot be after end_date' };
    }
    return { startDate: query.start_date, endDate: query.end_date };
  }

  return { error: 'Unsupported report period' };
}

reportRoutes.get('/reports', async (c) => {
  const supabase = c.get('supabase');
  const range = resolveReportRange({
    period: c.req.query('period'),
    date: c.req.query('date'),
    month: c.req.query('month'),
    year: c.req.query('year'),
    start_date: c.req.query('start_date'),
    end_date: c.req.query('end_date'),
  });

  if ('error' in range) {
    return c.json({ error: range.error }, 400);
  }

  const [summaryRes, servicesRes] = await Promise.all([
    supabase.rpc('get_reports_summary', {
      p_start_date: range.startDate,
      p_end_date: range.endDate,
    }),
    supabase
      .from('services')
      .select(
        `
        service_id,
        service_date,
        service_type,
        tank_capacity,
        price,
        discount,
        total_amount,
        amount_paid,
        payment_status,
        customers!inner (
          customer_id,
          full_name,
          primary_phone,
          locality
        )
      `
      )
      .is('archived_at', null)
      .gte('service_date', range.startDate)
      .lte('service_date', range.endDate)
      .order('service_date', { ascending: false }),
  ]);

  if (summaryRes.error) {
    return c.json({ error: 'Failed to generate report summary' }, 500);
  }
  if (servicesRes.error) {
    return c.json({ error: 'Failed to fetch report records' }, 500);
  }

  return c.json({
    summary: summaryRes.data,
    services: servicesRes.data ?? [],
  });
});

reportRoutes.get('/reports/export.csv', async (c) => {
  const supabase = c.get('supabase');
  const range = resolveReportRange({
    period: c.req.query('period'),
    date: c.req.query('date'),
    month: c.req.query('month'),
    year: c.req.query('year'),
    start_date: c.req.query('start_date'),
    end_date: c.req.query('end_date'),
  });

  if ('error' in range) {
    return c.json({ error: range.error }, 400);
  }

  const { data, error } = await supabase
    .from('services')
    .select(
      `
      service_id,
      service_date,
      service_type,
      tank_capacity,
      price,
      discount,
      total_amount,
      amount_paid,
      payment_status,
      next_due_date,
      customers!inner (
        full_name,
        primary_phone,
        locality,
        address
      )
    `
    )
    .is('archived_at', null)
    .gte('service_date', range.startDate)
    .lte('service_date', range.endDate)
    .order('service_date', { ascending: false });

  if (error) {
    return c.json({ error: 'Failed to export report CSV' }, 500);
  }

  const headers = [
    'Service ID',
    'Service Date',
    'Customer Name',
    'Primary Phone',
    'Locality',
    'Service Type',
    'Tank Capacity',
    'Price',
    'Discount',
    'Total Amount',
    'Amount Paid',
    'Outstanding Balance',
    'Payment Status',
    'Next Due Date',
  ];

  const rows = (data ?? []).map((row) => {
    const cust = row.customers as unknown as {
      full_name: string;
      primary_phone: string;
      locality: string | null;
    };
    const outstanding = Math.max(0, Number(row.total_amount) - Number(row.amount_paid));
    return [
      row.service_id,
      row.service_date,
      cust.full_name,
      cust.primary_phone,
      cust.locality ?? '',
      row.service_type,
      row.tank_capacity ?? '',
      row.price,
      row.discount,
      row.total_amount,
      row.amount_paid,
      outstanding.toFixed(2),
      row.payment_status,
      row.next_due_date ?? '',
    ]
      .map(escapeCsvCell)
      .join(',');
  });

  const csv = [headers.map(escapeCsvCell).join(','), ...rows].join('\r\n');

  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="zero-base-report-${range.startDate}-to-${range.endDate}.csv"`,
      'Cache-Control': 'private, no-store',
    },
  });
});
