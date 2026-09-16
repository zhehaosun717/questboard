import { describe, expect, it } from 'vitest';
import type { UsageProvider } from '../api/types';
import {
  formatBalance,
  formatClockTime,
  formatPercentOrUnknown,
  formatResetTime,
  formatSourceLabel,
  formatUsageDate,
  providerGuidanceText,
  usageColorClass,
  usageStateInfo,
} from './usage';

function baseProvider(overrides: Partial<UsageProvider> = {}): UsageProvider {
  return {
    id: 'codex',
    name: 'OpenAI Codex',
    source: 'cli',
    ok: true,
    configured: true,
    windows: [],
    balances: [],
    plan: '',
    note: '',
    asOf: null,
    fetchedAt: '2026-09-15T00:00:00Z',
    ...overrides,
  };
}

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

  it('formats a clock as zero-padded HH:MM', () => {
    const at = new Date(2026, 8, 15, 9, 5).getTime();
    expect(formatClockTime(at)).toBe('09:05');
  });

  it('keeps 0% distinct from an unknown percent', () => {
    expect(formatPercentOrUnknown(0)).toBe('0%');
    expect(formatPercentOrUnknown(42)).toBe('42%');
    expect(formatPercentOrUnknown(null)).toBe('未知');
    expect(formatPercentOrUnknown(undefined)).toBe('未知');
  });
});

describe('usageStateInfo', () => {
  it('reads the rich state field when present', () => {
    expect(usageStateInfo(baseProvider({ state: 'fresh' })).tone).toBe('data');
    expect(usageStateInfo(baseProvider({ state: 'stale' })).tone).toBe('data');
    expect(usageStateInfo(baseProvider({ state: 'pending' })).tone).toBe('pending');
    expect(usageStateInfo(baseProvider({ state: 'unconfigured' })).tone).toBe('neutral');
    expect(usageStateInfo(baseProvider({ state: 'unavailable' })).tone).toBe('neutral');
    expect(usageStateInfo(baseProvider({ state: 'expired' })).tone).toBe('neutral');
    expect(usageStateInfo(baseProvider({ state: 'failed' })).tone).toBe('neutral');
  });

  it('never classifies a pending provider as "not configured" even though configured is false while pending', () => {
    const info = usageStateInfo(baseProvider({ state: 'pending', configured: false }));
    expect(info.tone).toBe('pending');
    expect(info.state).toBe('pending');
  });

  it('falls back to the legacy ok/configured pair when the backend sends no state field', () => {
    expect(usageStateInfo(baseProvider({ configured: false })).state).toBe('unconfigured');
    expect(usageStateInfo(baseProvider({ configured: true, ok: false })).state).toBe('failed');
    expect(usageStateInfo(baseProvider({ configured: true, ok: true })).state).toBe('fresh');
  });
});

describe('providerGuidanceText', () => {
  it('never echoes the raw `error` field, even when the backend sent one (sentinels/Referer have leaked through it before)', () => {
    expect(providerGuidanceText(baseProvider({ configured: false, error: '没有找到 key：CODEX_API_KEY' }))).toBe('未接入 / 未配置');
  });

  it('shows a known errorCode\'s own fixed text', () => {
    expect(providerGuidanceText(baseProvider({ errorCode: 'missing_key', error: 'raw text' }))).toBe(
      '未找到对应的 API Key，请检查设置',
    );
  });

  it('ignores an unrecognized errorCode and falls back to the state text instead of showing the code itself', () => {
    expect(providerGuidanceText(baseProvider({ configured: false, errorCode: 'brand_new_code' }))).toBe('未接入 / 未配置');
  });

  it('falls back to a neutral fixed message when the server gives no error text', () => {
    expect(providerGuidanceText(baseProvider({ configured: false, error: undefined }))).toBe('未接入 / 未配置');
  });
});
