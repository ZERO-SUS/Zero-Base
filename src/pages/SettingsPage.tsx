import React, { useEffect, useState } from 'react';
import {
  Check,
  DatabaseBackup,
  HardDrive,
  Monitor,
  Moon,
  Palette,
  Plus,
  Shield,
  Sun,
  Trash2,
} from 'lucide-react';
import { Badge } from '../components/ui/Badge';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { ErrorBanner } from '../components/ui/Feedback';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { apiFetch, ApiError } from '../lib/api';
import { formatBytes, formatDateTimeIst } from '../lib/format';
import {
  ACCENT_PRESETS,
  isValidHexColor,
  normalizeHexColor,
  type ThemeMode,
} from '../lib/theme';
import { resolveServiceCategories } from '../lib/cartPricing';
import type {
  AuditLogEntry,
  BusinessSettings,
  CategoryKind,
  ServiceCategoryConfig,
} from '../types/domain';

interface OrphanReport {
  total_db_files: number;
  total_storage_objects: number;
  storage_only_orphans: Array<{ path: string; size: number; updated_at: string }>;
  missing_in_storage: Array<{ id: string; storage_path: string; file_name: string }>;
}

export function SettingsPage() {
  const { user, settings, updateSettingsLocal } = useAuth();
  const { mode, accentColor, setMode, setAccentColor } = useTheme();

  const [hexInput, setHexInput] = useState(accentColor);
  const [hexError, setHexError] = useState<string | null>(null);
  const [themeSavedMsg, setThemeSavedMsg] = useState<string | null>(null);

  const [appName, setAppName] = useState(settings.app_name);
  const [serviceCategories, setServiceCategories] = useState<ServiceCategoryConfig[]>(() =>
    resolveServiceCategories(settings),
  );
  const [newServiceType, setNewServiceType] = useState('');
  const [newCategoryKind, setNewCategoryKind] = useState<CategoryKind>('tank');
  const [defaultMonths, setDefaultMonths] = useState(settings.default_reminder_months);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsMsg, setSettingsMsg] = useState<string | null>(null);

  const [orphanReport, setOrphanReport] = useState<OrphanReport | null>(null);
  const [scanningOrphans, setScanningOrphans] = useState(false);
  const [confirmCleanupOpen, setConfirmCleanupOpen] = useState(false);
  const [cleaningOrphans, setCleaningOrphans] = useState(false);
  const [exportingBackup, setExportingBackup] = useState(false);

  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setHexInput(accentColor);
  }, [accentColor]);

  useEffect(() => {
    setAppName(settings.app_name);
    setServiceCategories(resolveServiceCategories(settings));
    setDefaultMonths(settings.default_reminder_months);
  }, [settings]);

  const loadAuditLogs = async () => {
    if (user?.role !== 'admin') return;
    setLoadingLogs(true);
    try {
      const res = await apiFetch<{ audit_logs: AuditLogEntry[] }>('/api/audit-logs?limit=30');
      setAuditLogs(res.audit_logs);
    } catch {
      // Non-fatal on initial load
    } finally {
      setLoadingLogs(false);
    }
  };

  useEffect(() => {
    void loadAuditLogs();
  }, [user?.role]);

  const persistThemeToProfile = async (nextMode: ThemeMode, nextHex: string) => {
    setThemeSavedMsg(null);
    try {
      await apiFetch('/api/me/preferences', {
        method: 'PATCH',
        body: JSON.stringify({
          theme_mode: nextMode,
          accent_color: normalizeHexColor(nextHex),
        }),
      });
      setThemeSavedMsg('Theme preferences synced to your administrator profile.');
    } catch {
      // Locally persisted already
    }
  };

  const handleModeChange = (nextMode: ThemeMode) => {
    setMode(nextMode);
    void persistThemeToProfile(nextMode, accentColor);
  };

  const handleSelectAccent = (hex: string) => {
    const normalized = normalizeHexColor(hex);
    setHexError(null);
    setHexInput(normalized);
    setAccentColor(normalized);
    void persistThemeToProfile(mode, normalized);
  };

  const handleHexApply = (e: React.FormEvent) => {
    e.preventDefault();
    const candidate = hexInput.trim().startsWith('#') ? hexInput.trim() : `#${hexInput.trim()}`;
    if (!isValidHexColor(candidate)) {
      setHexError('Enter a valid 6-digit HEX colour (e.g. #2563EB).');
      return;
    }
    handleSelectAccent(candidate);
  };

  const handleSaveBusinessSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    const activeCount = serviceCategories.filter((c) => c.active).length;
    if (activeCount === 0) {
      setError('Keep at least one active service category.');
      return;
    }
    setSavingSettings(true);
    setSettingsMsg(null);
    setError(null);
    try {
      const res = await apiFetch<{ settings: BusinessSettings }>('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          app_name: appName.trim(),
          service_categories: serviceCategories,
          default_reminder_months: Number(defaultMonths),
        }),
      });
      updateSettingsLocal(res.settings);
      setSettingsMsg('Business settings saved.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save business settings.');
    } finally {
      setSavingSettings(false);
    }
  };

  const handleScanOrphans = async () => {
    setScanningOrphans(true);
    setError(null);
    try {
      const res = await apiFetch<OrphanReport>('/api/files/orphans');
      setOrphanReport(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to scan Supabase Storage.');
    } finally {
      setScanningOrphans(false);
    }
  };

  const handleCleanOrphans = async () => {
    if (!orphanReport || orphanReport.storage_only_orphans.length === 0) return;
    setCleaningOrphans(true);
    try {
      await apiFetch('/api/files/orphans', {
        method: 'DELETE',
        body: JSON.stringify({
          paths: orphanReport.storage_only_orphans.map((o) => o.path),
        }),
      });
      setConfirmCleanupOpen(false);
      await handleScanOrphans();
      await loadAuditLogs();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to remove orphaned storage objects.');
    } finally {
      setCleaningOrphans(false);
    }
  };

  const handleBackupExport = async () => {
    setExportingBackup(true);
    setError(null);
    try {
      const snapshot = await apiFetch<Record<string, unknown>>('/api/backup/export');
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `zero-base-snapshot-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      void loadAuditLogs();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to export database snapshot.');
    } finally {
      setExportingBackup(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-text-primary">Settings</h1>
        <p className="text-xs text-text-secondary">
          Theme customization, configurable business rules, Supabase Storage health, backups, and audit logs
        </p>
      </div>

      {error && <ErrorBanner message={error} />}

      {/* 1. Theme System */}
      <section className="zb-card p-5 space-y-5">
        <div className="flex items-center gap-2">
          <Palette className="h-4 w-4 text-accent" />
          <h2 className="text-sm font-semibold text-text-primary">
            Appearance & Accent Theme System
          </h2>
        </div>

        <div>
          <label className="mb-2 block text-xs font-medium text-text-secondary">
            Theme Mode
          </label>
          <div className="grid grid-cols-3 gap-2.5 max-w-md">
            {[
              { id: 'light' as ThemeMode, label: 'Light', icon: Sun },
              { id: 'dark' as ThemeMode, label: 'Dark', icon: Moon },
              { id: 'system' as ThemeMode, label: 'System Default', icon: Monitor },
            ].map((opt) => {
              const Icon = opt.icon;
              const active = mode === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => handleModeChange(opt.id)}
                  className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition ${
                    active
                      ? 'border-accent bg-accent-soft text-accent'
                      : 'border-border bg-surface text-text-secondary hover:bg-bg hover:text-text-primary'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label className="mb-2 block text-xs font-medium text-text-secondary">
            Preset Accent Palettes
          </label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
            {ACCENT_PRESETS.map((preset) => {
              const active = normalizeHexColor(accentColor) === normalizeHexColor(preset.hex);
              return (
                <button
                  key={preset.name}
                  type="button"
                  onClick={() => handleSelectAccent(preset.hex)}
                  className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-xs font-medium transition ${
                    active
                      ? 'border-accent bg-accent-soft text-text-primary'
                      : 'border-border bg-surface text-text-secondary hover:bg-bg'
                  }`}
                >
                  <span
                    className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-black/15"
                    style={{ backgroundColor: preset.hex }}
                  >
                    {active && <Check className="h-2.5 w-2.5 text-white" />}
                  </span>
                  <span className="truncate">{preset.name}</span>
                </button>
              );
            })}
          </div>
        </div>

        <form onSubmit={handleHexApply} className="space-y-2">
          <label className="block text-xs font-medium text-text-secondary">
            Custom Accent Colour (Picker or HEX)
          </label>
          <div className="flex flex-wrap items-center gap-2.5">
            <input
              type="color"
              aria-label="Custom accent colour picker"
              value={isValidHexColor(hexInput) ? normalizeHexColor(hexInput) : accentColor}
              onChange={(e) => handleSelectAccent(e.target.value)}
              className="h-9 w-12 cursor-pointer rounded-lg border border-border bg-surface p-0.5"
            />
            <input
              type="text"
              value={hexInput}
              onChange={(e) => {
                setHexInput(e.target.value);
                setHexError(null);
              }}
              placeholder="#2563EB"
              maxLength={7}
              className="w-32 rounded-lg border px-3 py-1.5 font-mono text-sm uppercase"
            />
            <button
              type="submit"
              className="zb-btn-primary rounded-lg px-3.5 py-1.5 text-xs font-medium"
            >
              Apply HEX
            </button>
          </div>
          {hexError && <p className="text-xs text-error">{hexError}</p>}
          {themeSavedMsg && <p className="text-xs text-success">{themeSavedMsg}</p>}
        </form>
      </section>

      {/* 2. Business Configuration */}
      {user?.role === 'admin' && (
        <section className="zb-card p-5 space-y-4">
          <h2 className="text-sm font-semibold text-text-primary">Business Configuration</h2>
          <form onSubmit={handleSaveBusinessSettings} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-text-secondary">
                  Application Name (Wordmark)
                </label>
                <input
                  type="text"
                  required
                  value={appName}
                  onChange={(e) => setAppName(e.target.value)}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-text-secondary">
                  Default Reminder Interval (Months)
                </label>
                <input
                  type="number"
                  min={1}
                  max={60}
                  required
                  value={defaultMonths}
                  onChange={(e) => setDefaultMonths(Number(e.target.value))}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                />
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-text-secondary">
                Configurable Service Categories
              </label>
              <p className="mb-2 text-[11px] text-text-muted">
                Active categories appear in the Service Cart menu. Deactivating or removing a category preserves all past bills.
              </p>
              <div className="space-y-2 mb-3">
                {serviceCategories.map((cat) => {
                  const activeCount = serviceCategories.filter((c) => c.active).length;
                  const disableDeactivate = cat.active && activeCount <= 1;
                  return (
                    <div
                      key={cat.name}
                      className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs ${
                        cat.active ? 'border-border bg-bg' : 'border-border/60 bg-bg/40 opacity-75'
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="font-medium text-text-primary truncate">{cat.name}</span>
                        <Badge variant={cat.active ? 'success' : 'neutral'}>
                          {cat.active ? 'Active' : 'Inactive'}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2">
                        <select
                          value={cat.kind || 'other'}
                          onChange={(e) => {
                            const nextKind = e.target.value as CategoryKind;
                            setServiceCategories((prev) =>
                              prev.map((c) => (c.name === cat.name ? { ...c, kind: nextKind } : c)),
                            );
                          }}
                          className="rounded border border-border bg-surface px-2 py-1 text-[11px]"
                          aria-label={`Field layout for ${cat.name}`}
                        >
                          <option value="tank">Tank (Litres + Qty)</option>
                          <option value="sump">Sump (Litres + Qty)</option>
                          <option value="solar">Solar Panels (Qty)</option>
                          <option value="plumbing">Plumbing (Qty)</option>
                          <option value="other">General / Other</option>
                        </select>
                        <button
                          type="button"
                          disabled={disableDeactivate}
                          onClick={() =>
                            setServiceCategories((prev) =>
                              prev.map((c) =>
                                c.name === cat.name ? { ...c, active: !c.active } : c,
                              ),
                            )
                          }
                          className="rounded border border-border bg-surface px-2 py-1 text-[11px] font-medium hover:bg-bg disabled:opacity-40"
                        >
                          {cat.active ? 'Disable' : 'Enable'}
                        </button>
                        {!disableDeactivate && serviceCategories.length > 1 && (
                          <button
                            type="button"
                            onClick={() =>
                              setServiceCategories((prev) =>
                                prev.filter((item) => item.name !== cat.name),
                              )
                            }
                            className="p-1 text-text-muted hover:text-error"
                            aria-label={`Remove ${cat.name}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="flex flex-wrap gap-2 max-w-xl">
                <input
                  type="text"
                  value={newServiceType}
                  onChange={(e) => setNewServiceType(e.target.value)}
                  placeholder="Add new category (e.g. Solar Panel Cleaning)..."
                  className="flex-1 min-w-[200px] rounded-lg border px-3 py-1.5 text-sm"
                />
                <select
                  value={newCategoryKind}
                  onChange={(e) => setNewCategoryKind(e.target.value as CategoryKind)}
                  className="rounded-lg border px-2.5 py-1.5 text-xs"
                  aria-label="New category field type"
                >
                  <option value="tank">Tank Layout</option>
                  <option value="sump">Sump Layout</option>
                  <option value="solar">Solar Layout</option>
                  <option value="plumbing">Plumbing Layout</option>
                  <option value="other">General Layout</option>
                </select>
                <button
                  type="button"
                  onClick={() => {
                    const trimmed = newServiceType.trim();
                    const exists = serviceCategories.some(
                      (c) => c.name.toLowerCase() === trimmed.toLowerCase(),
                    );
                    if (trimmed && !exists) {
                      setServiceCategories((prev) => [
                        ...prev,
                        { name: trimmed, active: true, kind: newCategoryKind },
                      ]);
                      setNewServiceType('');
                    }
                  }}
                  className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-bg"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add Category
                </button>
              </div>
            </div>

            {settingsMsg && <p className="text-xs text-success">{settingsMsg}</p>}

            <button
              type="submit"
              disabled={savingSettings}
              className="zb-btn-primary rounded-lg px-4 py-2 text-xs font-medium disabled:opacity-50"
            >
              {savingSettings ? 'Saving...' : 'Save Business Settings'}
            </button>
          </form>
        </section>
      )}

      {/* 3. Supabase Storage & Backup Health */}
      {user?.role === 'admin' && (
        <section className="zb-card p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <HardDrive className="h-4 w-4 text-accent" />
              <h2 className="text-sm font-semibold text-text-primary">
                Supabase Storage Integrity & Data Backup
              </h2>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={scanningOrphans}
                onClick={() => void handleScanOrphans()}
                className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium hover:bg-bg disabled:opacity-50"
              >
                {scanningOrphans ? 'Scanning Storage...' : 'Scan Storage Orphans'}
              </button>
              <button
                type="button"
                disabled={exportingBackup}
                onClick={() => void handleBackupExport()}
                className="zb-btn-primary inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-50"
              >
                <DatabaseBackup className="h-3.5 w-3.5" />
                {exportingBackup ? 'Exporting...' : 'Export JSON Snapshot'}
              </button>
            </div>
          </div>

          {orphanReport && (
            <div className="rounded-xl border border-border bg-bg p-4 space-y-3 text-xs">
              <div className="flex flex-wrap gap-4">
                <span>
                  DB File Records: <strong>{orphanReport.total_db_files}</strong>
                </span>
                <span>
                  Storage Objects: <strong>{orphanReport.total_storage_objects}</strong>
                </span>
                <span>
                  Storage-only Orphans:{' '}
                  <strong
                    className={
                      orphanReport.storage_only_orphans.length > 0 ? 'text-warning' : 'text-success'
                    }
                  >
                    {orphanReport.storage_only_orphans.length}
                  </strong>
                </span>
                <span>
                  Missing in Storage:{' '}
                  <strong
                    className={
                      orphanReport.missing_in_storage.length > 0 ? 'text-error' : 'text-success'
                    }
                  >
                    {orphanReport.missing_in_storage.length}
                  </strong>
                </span>
              </div>

              {orphanReport.storage_only_orphans.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-warning">Unreferenced Storage Paths</span>
                    <button
                      type="button"
                      onClick={() => setConfirmCleanupOpen(true)}
                      className="rounded-md bg-error px-2.5 py-1 text-xs font-medium text-white"
                    >
                      Clean Up Orphans
                    </button>
                  </div>
                  <div className="max-h-36 overflow-y-auto space-y-1 font-mono text-[11px]">
                    {orphanReport.storage_only_orphans.map((o) => (
                      <div key={o.path} className="flex justify-between">
                        <span className="truncate">{o.path}</span>
                        <span className="text-text-muted">{formatBytes(o.size)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* 4. Security Audit Trail */}
      {user?.role === 'admin' && (
        <section className="zb-card overflow-hidden">
          <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
            <div className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-accent" />
              <h2 className="text-sm font-semibold text-text-primary">Recent Audit Logs</h2>
            </div>
            <button
              type="button"
              onClick={() => void loadAuditLogs()}
              className="text-xs font-medium text-accent hover:underline"
            >
              Refresh
            </button>
          </div>
          {loadingLogs ? (
            <div className="p-4 text-xs text-text-muted">Loading audit logs...</div>
          ) : auditLogs.length === 0 ? (
            <div className="p-5 text-xs text-text-muted">No audit entries recorded yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-border bg-bg text-[11px] uppercase tracking-wider text-text-muted">
                  <tr>
                    <th className="px-4 py-2.5">Timestamp (IST)</th>
                    <th className="px-4 py-2.5">Actor</th>
                    <th className="px-4 py-2.5">Action</th>
                    <th className="px-4 py-2.5">Entity</th>
                    <th className="px-4 py-2.5">Entity ID</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {auditLogs.map((log) => (
                    <tr key={log.audit_id}>
                      <td className="px-4 py-2 text-text-secondary">
                        {formatDateTimeIst(log.created_at)}
                      </td>
                      <td className="px-4 py-2">{log.actor_email ?? 'System'}</td>
                      <td className="px-4 py-2">
                        <Badge
                          variant={
                            log.action === 'ARCHIVE' || log.action === 'DELETE_FILE'
                              ? 'warning'
                              : log.action === 'INSERT'
                                ? 'success'
                                : 'accent'
                          }
                        >
                          {log.action}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 font-medium">{log.entity_type}</td>
                      <td className="px-4 py-2 font-mono text-[11px] text-text-muted">
                        {log.entity_id ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <ConfirmDialog
        open={confirmCleanupOpen}
        onClose={() => setConfirmCleanupOpen(false)}
        onConfirm={() => void handleCleanOrphans()}
        title="Delete Storage-Only Orphaned Files"
        message="This permanently removes only files in Supabase Storage bucket zero-base-files that have NO matching row in the PostgreSQL service_files table."
        confirmLabel="Delete Orphans"
        danger
        loading={cleaningOrphans}
      />
    </div>
  );
}
