import { describe, expect, it } from 'vitest';
import {
  formatBalance,
  formatResetTime,
  formatSourceLabel,
  formatUsageDate,
  usageColorClass,
} from './usage';

describe('usage helpers', () => {
  it('colour class at 69.9, 70, 90, 90.1, null', () => {
    expect(usageColorClass(69.9)).toBe('green');
    expect(usageColorClass(70)).toBe('amber');
    expect(usageColorClass(90)).toBe('amber');
    expect(usageColorClass(90.1)).toBe('red');
    expect(usageColorClass(null)).toBe('unknown');
    expect(usageColorClass(undefined)).toBe('unknown');
  });

  it('¥ / $ / other currency formatting', () => {
    // CNY
    expect(formatBalance(12.5, 'CNY')).toBe('¥12.50');
    expect(formatBalance(0, 'cny')).toBe('¥0.00');

    // USD
    expect(formatBalance(45.678, 'USD')).toBe('$45.68');
    expect(formatBalance(100, 'usd')).toBe('$100.00');

    // other
    expect(formatBalance(88.8, 'EUR')).toBe('88.80 EUR');
    expect(formatBalance(1234.5, 'GBP')).toBe('1234.50 GBP');
  });

  it('reset date formatting from an ISO string', () => {
    const iso = '2026-05-15T12:30:00Z';
    const formatted = formatResetTime(iso);
    // Fixed timezone-free checks:
    // 1. Matches MM-DD HH:MM format
    expect(formatted).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
    // 2. Month-day is May 15 (or 16 depending on UTC offset, but month is May)
    expect(formatted.startsWith('05-')).toBe(true);

    // Empty or invalid input
    expect(formatUsageDate(null)).toBe('');
    expect(formatUsageDate('')).toBe('');
    expect(formatUsageDate('invalid-date')).toBe('');
  });

  it('formats provider source labels correctly', () => {
    expect(formatSourceLabel('local-log')).toBe('本机记录');
    expect(formatSourceLabel('api')).toBe('接口');
    expect(formatSourceLabel('cli')).toBe('命令行');
    expect(formatSourceLabel('local-app')).toBe('本机应用');
    expect(formatSourceLabel('other')).toBe('other');
  });
});
