import React from 'react';
import { AlertCircle, Inbox, RefreshCw } from 'lucide-react';

export function ErrorBanner({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-error/30 bg-error-soft px-4 py-3 text-sm text-error"
    >
      <div className="flex items-center gap-2.5">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span>{message}</span>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 rounded-lg border border-error/30 bg-surface px-3 py-1 text-xs font-medium text-error hover:bg-bg"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Retry
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  icon,
  action,
}: {
  title: string;
  description: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="zb-card flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-3 rounded-xl border border-border bg-bg p-3 text-text-muted">
        {icon ?? <Inbox className="h-6 w-6" />}
      </div>
      <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
      <p className="mt-1 max-w-md text-xs leading-relaxed text-text-secondary">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="zb-card animate-pulse space-y-3 p-4">
      <div className="h-3.5 w-1/3 rounded bg-border" />
      {Array.from({ length: lines }).map((_, idx) => (
        <div key={idx} className="h-3 w-full rounded bg-border/70" />
      ))}
    </div>
  );
}
