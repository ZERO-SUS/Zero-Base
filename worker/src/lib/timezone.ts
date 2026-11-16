const IST_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function getIstToday(now: Date = new Date()): string {
  return IST_FORMATTER.format(now); // YYYY-MM-DD
}

export function extractYearMonthFromDate(dateStr: string): { year: number; month: number } {
  const [y, m] = dateStr.split('-').map(Number);
  return { year: y, month: m };
}

export type ReminderDisplayCategory =
  | 'Overdue'
  | 'Due Today'
  | 'Upcoming'
  | 'Contacted'
  | 'Confirmed'
  | 'Snoozed'
  | 'Dismissed'
  | 'Completed';

export function computeReminderCategory(
  reminder: { status: string; due_date: string },
  todayIst: string = getIstToday()
): ReminderDisplayCategory {
  switch (reminder.status) {
    case 'contacted':
      return 'Contacted';
    case 'confirmed':
      return 'Confirmed';
    case 'snoozed':
      return 'Snoozed';
    case 'dismissed':
      return 'Dismissed';
    case 'completed':
      return 'Completed';
    case 'active':
    default:
      if (reminder.due_date < todayIst) return 'Overdue';
      if (reminder.due_date === todayIst) return 'Due Today';
      return 'Upcoming';
  }
}

export function escapeCsvCell(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value);
  // Neutralize CSV formula injection (=, +, -, @, tab, CR)
  const safe = /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
  if (/[",\n\r]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}
