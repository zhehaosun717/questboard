import { describe, expect, it } from 'vitest';
import {
  USAGE_DEFAULT_INTERVAL_MS,
  USAGE_MAX_INTERVAL_MS,
  USAGE_MIN_INTERVAL_MS,
  clampIntervalMs,
  loadUsageRefreshPreference,
  saveUsageRefreshPreference,
  type UsageRefreshPreference,
} from './usagePreference';

class FakeStorage {
  private data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

describe('clampIntervalMs', () => {
  it('clamps below the minimum up to it', () => {
    expect(clampIntervalMs(1)).toBe(USAGE_MIN_INTERVAL_MS);
  });

  it('clamps above the maximum down to it', () => {
    expect(clampIntervalMs(USAGE_MAX_INTERVAL_MS + 1000)).toBe(USAGE_MAX_INTERVAL_MS);
  });

  it('falls back to the default for a non-finite or missing value', () => {
    expect(clampIntervalMs(undefined)).toBe(USAGE_DEFAULT_INTERVAL_MS);
    expect(clampIntervalMs(Number.NaN)).toBe(USAGE_DEFAULT_INTERVAL_MS);
    expect(clampIntervalMs('60000')).toBe(USAGE_DEFAULT_INTERVAL_MS);
  });

  it('keeps an in-range value unchanged', () => {
    const mid = (USAGE_MIN_INTERVAL_MS + USAGE_MAX_INTERVAL_MS) / 2;
    expect(clampIntervalMs(mid)).toBe(mid);
  });
});

describe('loadUsageRefreshPreference', () => {
  it('defaults to manual when nothing is stored', () => {
    expect(loadUsageRefreshPreference(new FakeStorage())).toEqual({ mode: 'manual', intervalMs: USAGE_DEFAULT_INTERVAL_MS });
  });

  it('round-trips a saved interval preference', () => {
    const storage = new FakeStorage();
    saveUsageRefreshPreference({ mode: 'interval', intervalMs: 5 * 60 * 1000 }, storage);
    expect(loadUsageRefreshPreference(storage)).toEqual({ mode: 'interval', intervalMs: 5 * 60 * 1000 });
  });

  it('degrades a corrupted value to the default instead of throwing', () => {
    const storage = new FakeStorage();
    storage.setItem('questboard.usage.refreshPreference.v1', '{not json');
    expect(loadUsageRefreshPreference(storage)).toEqual({ mode: 'manual', intervalMs: USAGE_DEFAULT_INTERVAL_MS });
  });

  it('clamps a hand-edited out-of-range interval on read', () => {
    const storage = new FakeStorage();
    storage.setItem('questboard.usage.refreshPreference.v1', JSON.stringify({ mode: 'interval', intervalMs: 1 }));
    expect(loadUsageRefreshPreference(storage).intervalMs).toBe(USAGE_MIN_INTERVAL_MS);
  });

  it('never stores anything beyond mode and intervalMs, no matter what is passed in', () => {
    const storage = new FakeStorage();
    const withExtra = { mode: 'interval', intervalMs: 60000, apiKey: 'secret' } as UsageRefreshPreference & { apiKey: string };
    saveUsageRefreshPreference(withExtra, storage);
    expect(storage.getItem('questboard.usage.refreshPreference.v1')).not.toContain('secret');
  });
});
