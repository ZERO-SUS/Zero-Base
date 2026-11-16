import { describe, expect, it } from 'vitest';
import {
  addMonthsToIsoDate,
  formatCurrency,
  formatDayMonth,
  formatServiceDate,
} from '../lib/format';

describe('Date and Currency Formatting Utilities', () => {
  it('formats INR currency cleanly', () => {
    expect(formatCurrency(1500)).toBe('₹1,500');
    expect(formatCurrency(1250.5)).toBe('₹1,250.50');
    expect(formatCurrency(0)).toBe('₹0');
  });

  it('formats service_date accurately without timezone drift', () => {
    expect(formatServiceDate('2025-12-20')).toBe('20 December 2025');
    expect(formatDayMonth('2026-11-16')).toBe('16 November');
  });

  it('adds reminder months accurately', () => {
    expect(addMonthsToIsoDate('2026-05-15', 6)).toBe('2026-11-15');
    expect(addMonthsToIsoDate('2025-12-20', 6)).toBe('2026-06-20');
  });
});
