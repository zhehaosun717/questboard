import { beforeEach, describe, expect, it } from 'vitest';
import type { UsageReport } from '../api/types';
import {
  USAGE_MAX_AGE_MS,
  clearCachedUsage,
  getCachedUsage,
  isFresh,
  setCachedUsage,
} from './usageCache';

const report = (generatedAt: string): UsageReport => ({ generatedAt, providers: [] });

beforeEach(() => {
  clearCachedUsage();
});

describe('usageCache', () => {
  it('keeps the last report across unmounts, which is what tab switching does', () => {
    expect(getCachedUsage()).toBeNull();
    setCachedUsage(report('2026-09-13T10:00:00Z'), 1000);
    expect(getCachedUsage()).toEqual({ report: report('2026-09-13T10:00:00Z'), at: 1000 });
  });

  it('replaces the previous report rather than accumulating', () => {
    setCachedUsage(report('2026-09-13T10:00:00Z'), 1000);
    setCachedUsage(report('2026-09-13T10:05:00Z'), 2000);
    expect(getCachedUsage()?.at).toBe(2000);
    expect(getCachedUsage()?.report.generatedAt).toBe('2026-09-13T10:05:00Z');
  });
});

describe('isFresh', () => {
  it('counts a result fresh until the max age, so switching back does not refetch', () => {
    expect(isFresh(0, 0)).toBe(true);
    expect(isFresh(0, USAGE_MAX_AGE_MS - 1)).toBe(true);
  });

  it('counts a result at or past the max age as stale', () => {
    expect(isFresh(0, USAGE_MAX_AGE_MS)).toBe(false);
    expect(isFresh(0, USAGE_MAX_AGE_MS + 1)).toBe(false);
  });

  it('treats a backwards clock as stale instead of fresh forever', () => {
    expect(isFresh(5000, 1000)).toBe(false);
  });
});
