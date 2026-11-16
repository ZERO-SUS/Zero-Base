export type ThemeMode = 'light' | 'dark' | 'system';

export interface AccentPreset {
  name: string;
  hex: string;
}

export const ACCENT_PRESETS: AccentPreset[] = [
  { name: 'Ocean Blue', hex: '#0284C7' },
  { name: 'Royal Blue', hex: '#2563EB' },
  { name: 'Emerald', hex: '#059669' },
  { name: 'Violet', hex: '#7C3AED' },
  { name: 'Amber', hex: '#D97706' },
  { name: 'Crimson', hex: '#DC2626' },
  { name: 'Slate', hex: '#475569' },
  { name: 'Monochrome', hex: '#18181B' },
];

export const THEME_MODE_STORAGE_KEY = 'zb_theme_mode';
export const ACCENT_COLOR_STORAGE_KEY = 'zb_accent_color';

export function isValidHexColor(hex: string): boolean {
  return /^#[0-9A-Fa-f]{6}$/.test(hex.trim());
}

export function normalizeHexColor(hex: string): string {
  const trimmed = hex.trim();
  const withHash = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  return withHash.toUpperCase();
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return (
    '#' +
    [clamp(r), clamp(g), clamp(b)]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  );
}

/**
 * Computes relative WCAG luminance (0..1) so custom accent colors always get
 * high-contrast button foreground text (#FFFFFF or #0F172A).
 */
export function getRelativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const toLinear = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

export function getContrastingForeground(hex: string): string {
  const lum = getRelativeLuminance(hex);
  return lum > 0.42 ? '#0F172A' : '#FFFFFF';
}

export function resolveIsDark(mode: ThemeMode): boolean {
  if (mode === 'dark') return true;
  if (mode === 'light') return false;
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function applyThemeToDocument(mode: ThemeMode, accentHex: string): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const isDark = resolveIsDark(mode);

  if (isDark) {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }

  let effectiveHex = isValidHexColor(accentHex) ? normalizeHexColor(accentHex) : '#2563EB';
  // If user chose near-black monochrome in dark mode, lift slightly for visibility on dark surfaces
  if (isDark && effectiveHex === '#18181B') {
    effectiveHex = '#E4E4E7';
  }

  const { r, g, b } = hexToRgb(effectiveHex);
  const fg = getContrastingForeground(effectiveHex);
  const hoverFactor = getRelativeLuminance(effectiveHex) > 0.42 ? 0.88 : 0.85;
  const hoverHex = rgbToHex(r * hoverFactor, g * hoverFactor, b * hoverFactor);

  root.style.setProperty('--zb-accent', effectiveHex);
  root.style.setProperty('--zb-accent-hover', hoverHex);
  root.style.setProperty('--zb-accent-fg', fg);
  root.style.setProperty('--zb-accent-soft', `rgba(${r}, ${g}, ${b}, ${isDark ? 0.18 : 0.11})`);
  root.style.setProperty('--zb-focus', `rgba(${r}, ${g}, ${b}, 0.35)`);
}

export function readPersistedTheme(): { mode: ThemeMode; accentColor: string } {
  try {
    const rawMode = localStorage.getItem(THEME_MODE_STORAGE_KEY);
    const mode: ThemeMode =
      rawMode === 'light' || rawMode === 'dark' || rawMode === 'system' ? rawMode : 'system';
    const rawAccent = localStorage.getItem(ACCENT_COLOR_STORAGE_KEY) ?? '#2563EB';
    const accentColor = isValidHexColor(rawAccent) ? normalizeHexColor(rawAccent) : '#2563EB';
    return { mode, accentColor };
  } catch {
    return { mode: 'system', accentColor: '#2563EB' };
  }
}

export function persistThemeLocally(mode: ThemeMode, accentColor: string): void {
  try {
    localStorage.setItem(THEME_MODE_STORAGE_KEY, mode);
    if (isValidHexColor(accentColor)) {
      localStorage.setItem(ACCENT_COLOR_STORAGE_KEY, normalizeHexColor(accentColor));
    }
  } catch {
    // Ignore storage quota errors
  }
}
