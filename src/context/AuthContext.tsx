import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { apiFetch, ApiError } from '../lib/api';
import { isSupabaseConfigured, supabase } from '../lib/supabase';
import type { BusinessSettings, UserProfile } from '../types/domain';
import { useTheme } from './ThemeContext';

interface AuthContextValue {
  loading: boolean;
  user: UserProfile | null;
  settings: BusinessSettings;
  authError: string | null;
  refreshProfile: () => Promise<void>;
  signOut: () => Promise<void>;
  updateSettingsLocal: (next: BusinessSettings) => void;
}

const DEFAULT_SETTINGS: BusinessSettings = {
  app_name: (import.meta.env.VITE_APP_NAME as string | undefined) || 'ZERO BASE',
  timezone: 'Asia/Kolkata',
  currency_code: 'INR',
  currency_symbol: '₹',
  service_types: [
    'Overhead Tank Cleaning',
    'Underground Sump Cleaning',
    'Loft Tank Cleaning',
    'Commercial Tank Cleaning',
    'Pipeline & Disinfection',
  ],
  service_categories: [
    { name: 'Overhead Tank Cleaning', active: true, kind: 'tank' },
    { name: 'Underground Sump Cleaning', active: true, kind: 'sump' },
    { name: 'Loft Tank Cleaning', active: true, kind: 'tank' },
    { name: 'Commercial Tank Cleaning', active: true, kind: 'tank' },
    { name: 'Pipeline & Disinfection', active: true, kind: 'plumbing' },
  ],
  default_reminder_months: 6,
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [settings, setSettings] = useState<BusinessSettings>(DEFAULT_SETTINGS);
  const [authError, setAuthError] = useState<string | null>(null);
  const { syncFromServer } = useTheme();

  const refreshProfile = useCallback(async () => {
    if (!isSupabaseConfigured) {
      setAuthError('Supabase environment variables are not configured.');
      setUser(null);
      setLoading(false);
      return;
    }

    const { data: sessionData } = await supabase.auth.getSession();
    if (!sessionData.session) {
      setUser(null);
      setAuthError(null);
      setLoading(false);
      return;
    }

    try {
      const me = await apiFetch<{ user: UserProfile; settings: BusinessSettings }>('/api/me');
      setUser(me.user);
      setSettings(me.settings);
      setAuthError(null);
      syncFromServer(me.user.theme_mode, me.user.accent_color);
      document.title = me.settings.app_name || 'ZERO BASE';
    } catch (err) {
      setUser(null);
      if (err instanceof ApiError) {
        setAuthError(err.message);
        if (err.status === 401 || err.status === 403) {
          await supabase.auth.signOut();
        }
      } else {
        setAuthError('Unable to verify session with ZERO BASE API.');
      }
    } finally {
      setLoading(false);
    }
  }, [syncFromServer]);

  useEffect(() => {
    void refreshProfile();

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) {
        setUser(null);
        setLoading(false);
      } else {
        void refreshProfile();
      }
    });

    return () => listener.subscription.unsubscribe();
  }, [refreshProfile]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setUser(null);
  }, []);

  const updateSettingsLocal = useCallback((next: BusinessSettings) => {
    setSettings(next);
    document.title = next.app_name || 'ZERO BASE';
  }, []);

  return (
    <AuthContext.Provider
      value={{
        loading,
        user,
        settings,
        authError,
        refreshProfile,
        signOut,
        updateSettingsLocal,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
