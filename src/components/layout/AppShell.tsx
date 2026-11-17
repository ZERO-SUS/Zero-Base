import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  BarChart3,
  Bell,
  CalendarClock,
  CalendarDays,
  CreditCard,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Plus,
  Search,
  Settings,
  Sun,
  Users,
  X,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { resolveIsDark } from '../../lib/theme';
import { ServiceFormModal } from '../services/ServiceFormModal';

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/archive', label: 'Service Archive', icon: CalendarDays, end: false },
  { to: '/search', label: 'Search', icon: Search, end: false },
  { to: '/history', label: 'Service History', icon: CalendarClock, end: false },
  { to: '/customers', label: 'Customers', icon: Users, end: false },
  { to: '/reminders', label: 'Reminders', icon: Bell, end: false },
  { to: '/payments', label: 'Payments', icon: CreditCard, end: false },
  { to: '/reports', label: 'Reports', icon: BarChart3, end: false },
  { to: '/settings', label: 'Settings', icon: Settings, end: false },
];

export function AppShell() {
  const { user, settings, signOut } = useAuth();
  const { mode, setMode } = useTheme();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [addServiceOpen, setAddServiceOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const isDark = resolveIsDark(mode);

  const appName = settings.app_name || 'ZERO BASE';

  const toggleQuickTheme = () => {
    setMode(isDark ? 'light' : 'dark');
  };

  const renderLinks = (onNavigate?: () => void) => (
    <nav className="space-y-1 px-3" aria-label="Main Navigation">
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        return (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
                isActive
                  ? 'bg-accent-soft text-accent'
                  : 'text-text-secondary hover:bg-bg hover:text-text-primary'
              }`
            }
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span>{item.label}</span>
          </NavLink>
        );
      })}
    </nav>
  );

  const currentNav = NAV_ITEMS.find((i) =>
    i.end ? location.pathname === i.to : location.pathname.startsWith(i.to)
  );

  return (
    <div className="min-h-screen bg-bg text-text-primary lg:flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-64 lg:shrink-0 lg:flex-col lg:border-r lg:border-border lg:bg-sidebar">
        <div className="flex h-16 items-center gap-3 border-b border-border px-5">
          <img
            src="/assets/zero-base-logo.png"
            alt="ZERO BASE"
            className="h-8 w-8 shrink-0 object-contain"
          />
          <span className="text-sm font-semibold tracking-[0.14em] text-text-primary uppercase">
            {appName}
          </span>
        </div>

        <div className="px-3 pt-4 pb-2">
          <button
            type="button"
            onClick={() => setAddServiceOpen(true)}
            className="zb-btn-primary flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold tracking-wide uppercase"
          >
            <Plus className="h-4 w-4" />
            Add Service
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-2">{renderLinks()}</div>

        <div className="border-t border-border p-3 space-y-2">
          <div className="flex items-center justify-between rounded-lg bg-bg px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-text-primary">
                {user?.full_name ?? 'Administrator'}
              </p>
              <p className="truncate text-[11px] text-text-muted">{user?.email}</p>
            </div>
            <button
              type="button"
              onClick={toggleQuickTheme}
              title={`Switch to ${isDark ? 'Light' : 'Dark'} mode`}
              aria-label="Toggle color theme"
              className="rounded-md p-1.5 text-text-secondary hover:bg-surface hover:text-text-primary"
            >
              {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>
          <button
            type="button"
            onClick={() => void signOut()}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-xs font-medium text-text-secondary transition hover:bg-error-soft hover:text-error"
          >
            <LogOut className="h-4 w-4" />
            <span>Sign out</span>
          </button>
        </div>
      </aside>

      {/* Mobile Header */}
      <div className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-sidebar px-4 lg:hidden">
        <div className="flex items-center gap-2.5 min-w-0">
          <button
            type="button"
            onClick={() => setMobileMenuOpen(true)}
            aria-label="Open navigation menu"
            className="rounded-lg p-1.5 text-text-secondary hover:bg-bg hover:text-text-primary"
          >
            <Menu className="h-5 w-5" />
          </button>
          <img
            src="/assets/zero-base-logo.png"
            alt="ZERO BASE"
            className="h-6 w-6 shrink-0 object-contain"
          />
          <span className="text-xs font-semibold tracking-[0.14em] text-text-primary uppercase truncate">
            {appName}
          </span>
          {currentNav && (
            <span className="hidden sm:inline text-xs text-text-muted">/ {currentNav.label}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setAddServiceOpen(true)}
            className="zb-btn-primary inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium"
          >
            <Plus className="h-3.5 w-3.5" />
            Add
          </button>
          <button
            type="button"
            onClick={toggleQuickTheme}
            aria-label="Toggle color theme"
            className="rounded-lg p-1.5 text-text-secondary hover:bg-bg hover:text-text-primary"
          >
            {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div
            className="fixed inset-0 bg-black/50"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="relative z-10 flex h-full w-72 max-w-[85vw] flex-col border-r border-border bg-sidebar">
            <div className="flex h-14 items-center justify-between border-b border-border px-4">
              <div className="flex items-center gap-2.5">
                <img
                  src="/assets/zero-base-logo.png"
                  alt="ZERO BASE"
                  className="h-7 w-7 object-contain"
                />
                <span className="text-sm font-semibold tracking-[0.14em] uppercase">
                  {appName}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                aria-label="Close navigation menu"
                className="rounded-lg p-1.5 text-text-secondary hover:bg-bg"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto py-4">
              {renderLinks(() => setMobileMenuOpen(false))}
            </div>
            <div className="border-t border-border p-3">
              <p className="truncate px-3 text-xs font-medium text-text-primary">
                {user?.full_name}
              </p>
              <p className="truncate px-3 text-[11px] text-text-muted">{user?.email}</p>
              <button
                type="button"
                onClick={() => void signOut()}
                className="mt-2 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium text-error hover:bg-error-soft"
              >
                <LogOut className="h-4 w-4" />
                <span>Sign out</span>
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Main Content */}
      <main className="min-w-0 flex-1 pb-20 lg:pb-8">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </div>
      </main>

      {/* Mobile Bottom Quick Bar */}
      <nav
        aria-label="Mobile Quick Navigation"
        className="fixed bottom-0 left-0 right-0 z-30 grid grid-cols-5 border-t border-border bg-sidebar py-1.5 lg:hidden"
      >
        {[NAV_ITEMS[0], NAV_ITEMS[1], NAV_ITEMS[2], NAV_ITEMS[4], NAV_ITEMS[5]].map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `flex flex-col items-center justify-center gap-0.5 py-1 text-[10px] font-medium ${
                  isActive ? 'text-accent' : 'text-text-muted'
                }`
              }
            >
              <Icon className="h-4 w-4" />
              <span className="truncate">{item.label.split(' ')[0]}</span>
            </NavLink>
          );
        })}
      </nav>

      <ServiceFormModal
        open={addServiceOpen}
        onClose={() => setAddServiceOpen(false)}
        onSaved={(service) => {
          navigate(`/services/${service.id}`);
        }}
      />
    </div>
  );
}
