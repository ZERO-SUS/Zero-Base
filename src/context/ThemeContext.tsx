import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  applyThemeToDocument,
  isValidHexColor,
  normalizeHexColor,
  persistThemeLocally,
  readPersistedTheme,
  type ThemeMode,
} from '../lib/theme';

interface ThemeContextValue {
  mode: ThemeMode;
  accentColor: string;
  setMode: (mode: ThemeMode) => void;
  setAccentColor: (hex: string) => void;
  syncFromServer: (mode: ThemeMode, accentColor: string) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const initial = readPersistedTheme();
  const [mode, setModeState] = useState<ThemeMode>(initial.mode);
  const [accentColor, setAccentColorState] = useState<string>(initial.accentColor);

  useEffect(() => {
    applyThemeToDocument(mode, accentColor);
    persistThemeLocally(mode, accentColor);
  }, [mode, accentColor]);

  useEffect(() => {
    if (mode !== 'system' || typeof window === 'undefined') return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyThemeToDocument('system', accentColor);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [mode, accentColor]);

  const setMode = useCallback((nextMode: ThemeMode) => {
    setModeState(nextMode);
  }, []);

  const setAccentColor = useCallback((hex: string) => {
    if (!isValidHexColor(hex)) return;
    setAccentColorState(normalizeHexColor(hex));
  }, []);

  const syncFromServer = useCallback((serverMode: ThemeMode, serverAccent: string) => {
    // Prefer locally persisted theme if user already chose one on this device;
    // otherwise hydrate from profile
    try {
      const hasLocalMode = localStorage.getItem('zb_theme_mode');
      const hasLocalAccent = localStorage.getItem('zb_accent_color');
      if (!hasLocalMode && serverMode) {
        setModeState(serverMode);
      }
      if (!hasLocalAccent && serverAccent && isValidHexColor(serverAccent)) {
        setAccentColorState(normalizeHexColor(serverAccent));
      }
    } catch {
      if (serverMode) setModeState(serverMode);
      if (serverAccent && isValidHexColor(serverAccent)) {
        setAccentColorState(normalizeHexColor(serverAccent));
      }
    }
  }, []);

  return (
    <ThemeContext.Provider
      value={{ mode, accentColor, setMode, setAccentColor, syncFromServer }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider');
  return ctx;
}
