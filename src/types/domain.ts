export type PaymentStatus = 'Unpaid' | 'Partially Paid' | 'Paid' | 'Refunded';
export type PaymentMethod = 'Cash' | 'UPI' | 'Other';
export type PaymentType = 'payment' | 'refund';

export type AttachmentCategory =
  | 'Bill photos'
  | 'UPI transaction screenshots'
  | 'Before-cleaning photos'
  | 'After-cleaning photos'
  | 'Tank photos'
  | 'Hose photos'
  | 'Work-area photos'
  | 'Other attachments';

export const ATTACHMENT_CATEGORIES: AttachmentCategory[] = [
  'Bill photos',
  'UPI transaction screenshots',
  'Before-cleaning photos',
  'After-cleaning photos',
  'Tank photos',
  'Hose photos',
  'Work-area photos',
  'Other attachments',
];

export type ReminderCategory =
  | 'Overdue'
  | 'Due Today'
  | 'Upcoming'
  | 'Contacted'
  | 'Confirmed'
  | 'Snoozed'
  | 'Dismissed'
  | 'Completed';

export interface UserProfile {
  id: string;
  email: string;
  full_name: string;
  role: 'admin' | 'staff';
  is_active: boolean;
  theme_mode: 'light' | 'dark' | 'system';
  accent_color: string;
}

export interface BusinessSettings {
  app_name: string;
  timezone: string;
  currency_code: string;
  currency_symbol: string;
  service_types: string[];
  default_reminder_months: number;
}

export interface Customer {
  customer_id: string;
  full_name: string;
  primary_phone: string;
  secondary_phone: string | null;
  address: string;
  locality: string | null;
  landmark: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface ServiceRecord {
  service_id: string;
  customer_id: string;
  service_date: string;
  service_type: string;
  tank_capacity: string | null;
  price: number;
  discount: number;
  total_amount: number;
  amount_paid: number;
  payment_status: PaymentStatus;
  next_due_date: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  customers?: {
    customer_id: string;
    full_name: string;
    primary_phone: string;
    secondary_phone?: string | null;
    address?: string;
    locality?: string | null;
    landmark?: string | null;
  };
}

export interface PaymentRecord {
  payment_id: string;
  service_id: string;
  amount: number;
  payment_type: PaymentType;
  payment_method: PaymentMethod;
  transaction_reference: string | null;
  payment_date: string;
  notes: string | null;
  created_at: string;
  archived_at: string | null;
  archive_reason: string | null;
  superseded_by: string | null;
  services?: {
    service_id: string;
    service_date: string;
    service_type: string;
    total_amount: number;
    amount_paid: number;
    payment_status: PaymentStatus;
    customers?: {
      customer_id: string;
      full_name: string;
      primary_phone: string;
    };
  };
}

export interface AttachmentRecord {
  attachment_id: string;
  service_id: string;
  storage_key: string;
  original_filename: string;
  mime_type: string;
  file_size: number;
  category: AttachmentCategory;
  uploaded_at: string;
  archived_at: string | null;
}

export interface ReminderRecord {
  reminder_id: string;
  service_id: string;
  customer_id: string;
  due_date: string;
  status: 'active' | 'contacted' | 'confirmed' | 'snoozed' | 'dismissed' | 'completed';
  snoozed_until: string | null;
  contacted_at: string | null;
  confirmed_at: string | null;
  notes: string | null;
  category: ReminderCategory;
  customers?: {
    customer_id: string;
    full_name: string;
    primary_phone: string;
    secondary_phone?: string | null;
    address?: string;
    locality?: string | null;
  };
  services?: {
    service_id: string;
    service_date: string;
    service_type: string;
    tank_capacity?: string | null;
    total_amount?: number;
  };
}

export interface DashboardMetrics {
  today_ist: string;
  total_customers: number;
  total_services: number;
  services_this_month: number;
  services_this_year: number;
  todays_services: number;
  upcoming_reminders: number;
  due_today: number;
  overdue_services: number;
  pending_payments_amount: number;
  pending_payments_count: number;
  revenue_this_month: number;
  revenue_this_year: number;
}

export interface YearMonthGroup {
  year: number;
  months: Array<{
    month: number;
    records: ServiceRecord[];
  }>;
}

export interface ReportSummary {
  start_date: string;
  end_date: string;
  total_services: number;
  total_billed: number;
  outstanding_balance: number;
  total_collected: number;
  cash_payments: number;
  upi_payments: number;
  other_payments: number;
  service_type_breakdown: Array<{
    service_type: string;
    service_count: number;
    total_billed: number;
    total_paid: number;
    outstanding: number;
  }>;
}

export interface AuditLogEntry {
  audit_id: string;
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}
