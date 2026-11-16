import type { PaymentStatus, ReminderCategory } from '../../types/domain';

type BadgeVariant = 'neutral' | 'accent' | 'success' | 'warning' | 'error';

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  neutral: 'bg-bg text-text-secondary border-border',
  accent: 'bg-accent-soft text-accent border-transparent',
  success: 'bg-success-soft text-success border-transparent',
  warning: 'bg-warning-soft text-warning border-transparent',
  error: 'bg-error-soft text-error border-transparent',
};

export function Badge({
  children,
  variant = 'neutral',
  className = '',
}: {
  children: React.ReactNode;
  variant?: BadgeVariant;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium leading-tight ${VARIANT_CLASSES[variant]} ${className}`}
    >
      {children}
    </span>
  );
}

export function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  const variant: BadgeVariant =
    status === 'Paid'
      ? 'success'
      : status === 'Partially Paid'
        ? 'warning'
        : status === 'Refunded'
          ? 'neutral'
          : 'error';
  return <Badge variant={variant}>{status}</Badge>;
}

export function ReminderCategoryBadge({ category }: { category: ReminderCategory }) {
  const variant: BadgeVariant =
    category === 'Overdue'
      ? 'error'
      : category === 'Due Today'
        ? 'warning'
        : category === 'Confirmed'
          ? 'success'
          : category === 'Contacted' || category === 'Upcoming'
            ? 'accent'
            : 'neutral';
  return <Badge variant={variant}>{category}</Badge>;
}
