import { describe, expect, it, beforeEach } from 'vitest';
import {
  applyThemeToDocument,
  getContrastingForeground,
  isValidHexColor,
  normalizeHexColor,
  persistThemeLocally,
  readPersistedTheme,
} from '../lib/theme';

describe('ZERO BASE Theme System', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    document.documentElement.removeAttribute('style');
  });

  it('validates and normalizes HEX colors strictly', () => {
    expect(isValidHexColor('#2563eb')).toBe(true);
    expect(isValidHexColor('#0284C7')).toBe(true);
    expect(isValidHexColor('#12345')).toBe(false);
    expect(isValidHexColor('blue')).toBe(false);
    expect(isValidHexColor('#GGGGGG')).toBe(false);

    expect(normalizeHexColor('2563eb')).toBe('#2563EB');
    expect(normalizeHexColor('#059669')).toBe('#059669');
  });

  it('computes high-contrast foreground text for dark and light accents', () => {
    expect(getContrastingForeground('#2563EB')).toBe('#FFFFFF');
    expect(getContrastingForeground('#18181B')).toBe('#FFFFFF');
    expect(getContrastingForeground('#FACC15')).toBe('#0F172A');
    expect(getContrastingForeground('#E4E4E7')).toBe('#0F172A');
  });

  it('switches dark/light modes and updates CSS custom properties immediately', () => {
    applyThemeToDocument('dark', '#059669');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--zb-accent')).toBe('#059669');
    expect(document.documentElement.style.getPropertyValue('--zb-accent-fg')).toBe('#FFFFFF');

    applyThemeToDocument('light', '#0284C7');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--zb-accent')).toBe('#0284C7');
  });

  it('persists theme mode and custom accent color across reloads/logouts', () => {
    persistThemeLocally('dark', '#7c3aed');
    const restored = readPersistedTheme();
    expect(restored.mode).toBe('dark');
    expect(restored.accentColor).toBe('#7C3AED');
  });
});
