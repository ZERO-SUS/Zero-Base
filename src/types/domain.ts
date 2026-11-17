export type PaymentStatus = 'Unpaid' | 'Partially Paid' | 'Paid' | 'Refunded';
export type PaymentMethod = 'Cash' | 'UPI' | 'Other';
export type PaymentType = 'payment' | 'refund';

export type FileCategory =
  | 'Bills / Invoices'
  | 'UPI Transaction Screenshots'
  | 'Before-Service Area Photos'
  | 'After-Service Area Photos'
  | 'Other Attachments';

export const FILE_CATEGORIES: FileCategory[] = [
  'Bills / Invoices',
  'UPI Transaction Screenshots',
  'Before-Service Area Photos',
  'After-Service Area Photos',
  'Other Attachments',
];

export type ReminderCategory =
  | 'Overdue'
  | 'Due Today'
  | 'Upcoming'
  | 'Contacted'
  | 'Confirmed'
  | 'Snoozed'
  | 'Cancelled'
  | 'Dismissed'
  | 'Completed';

export interface UserProfile {
  id: string;
  email: string;
  full_name: string;
  role: 'admin';
  theme_mode: 'light' | 'dark' | 'system';
  accent_color: string;
}

export type CategoryKind = 'tank' | 'sump' | 'solar' | 'plumbing' | 'other';
export type PricingMode = 'itemized' | 'category_total';
export type DiscountType = 'fixed' | 'percentage';

export interface ServiceCategoryConfig {
  name: string;
  active: boolean;
  kind?: CategoryKind;
}

export interface BusinessSettings {
  app_name: string;
  timezone: string;
  currency_code: string;
  currency_symbol: string;
  service_types: string[];
  service_categories?: ServiceCategoryConfig[];
  default_reminder_months: number;
}

export interface Customer {
  id: string;
  customer_code: string;
  full_name: string;
  phone_number: string;
  alternate_phone: string | null;
  address: string;
  area: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface ServiceItem {
  id: string;
  service_id: string;
  category_group_id: string;
  category_name: string;
  item_name: string | null;
  capacity_litres: number | null;
  quantity: number;
  unit_price: number;
  line_total: number;
  description: string | null;
  display_order: number;
}

export interface ServiceCategoryGroup {
  id: string;
  service_id: string;
  category_name: string;
  pricing_mode: PricingMode;
  category_subtotal: number;
  display_order: number;
  items: ServiceItem[];
}

export interface ServiceRecord {
  id: string;
  customer_id: string;
  service_date: string;
  service_type: string;
  tank_details: string | null;
  description: string | null;
  price: number;
  subtotal_amount?: number;
  discount_type?: DiscountType;
  discount_value?: number;
  discount: number;
  total_amount: number;
  amount_paid: number;
  balance_amount: number;
  payment_status: PaymentStatus;
  service_categories_snapshot?: string[];
  next_due_date: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  customers?: {
    id: string;
    customer_code: string;
    full_name: string;
    phone_number: string;
    alternate_phone?: string | null;
    address?: string;
    area?: string | null;
  };
}

export interface PaymentRecord {
  id: string;
  service_id: string;
  customer_id: string;
  amount: number;
  payment_type: PaymentType;
  payment_method: PaymentMethod;
  payment_date: string;
  reference_number: string | null;
  notes: string | null;
  created_at: string;
  archived_at: string | null;
  archive_reason: string | null;
  superseded_by: string | null;
  services?: {
    id: string;
    service_date: string;
    service_type: string;
    total_amount: number;
    amount_paid: number;
    balance_amount: number;
    payment_status: PaymentStatus;
    customers?: {
      id: string;
      customer_code: string;
      full_name: string;
      phone_number: string;
    };
  };
}

export interface ServiceFileRecord {
  id: string;
  customer_id: string;
  service_id: string;
  payment_id: string | null;
  file_name: string;
  storage_path: string;
  mime_type: string;
  file_size: number;
  category: string;
  uploaded_at: string;
  uploaded_by?: string | null;
  archived_at: string | null;
}

export interface ReminderRecord {
  id: string;
  customer_id: string;
  service_id: string | null;
  due_date: string;
  reminder_type: 'service_due' | 'custom' | 'follow_up';
  status: 'active' | 'contacted' | 'confirmed' | 'snoozed' | 'dismissed' | 'cancelled' | 'completed';
  snoozed_until: string | null;
  contacted_at: string | null;
  confirmed_at: string | null;
  notes: string | null;
  category: ReminderCategory;
  customers?: {
    id: string;
    customer_code: string;
    full_name: string;
    phone_number: string;
    alternate_phone?: string | null;
    address?: string;
    area?: string | null;
  };
  services?: {
    id: string;
    service_date: string;
    service_type: string;
    tank_details?: string | null;
    total_amount?: number;
  } | null;
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
  total_recorded_revenue?: number;
  total_collected_payments?: number;
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
