/**
 * The owner's choice of how the usage page refreshes: by hand only, or on a bounded auto interval. This is
 * the one usage-page setting allowed to survive a reload — it carries no quota numbers, no keys, nothing
 * fetched from a provider, just "manual" or a clamped interval length, so persisting it never risks leaking
 * anything the rest of this page goes out of its way to keep in memory only.
 */
export type UsageRefreshMode = 'manual' | 'interval';

export interface UsageRefreshPreference {
  mode: UsageRefreshMode;
  intervalMs: number;
}

export const USAGE_MIN_INTERVAL_MS = 30 * 1000;
export const USAGE_MAX_INTERVAL_MS = 30 * 60 * 1000;
export const USAGE_DEFAULT_INTERVAL_MS = 60 * 1000;

export const USAGE_INTERVAL_PRESETS_MS = [30 * 1000, 60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000];

const STORAGE_KEY = 'questboard.usage.refreshPreference.v1';

const DEFAULT_PREFERENCE: UsageRefreshPreference = { mode: 'manual', intervalMs: USAGE_DEFAULT_INTERVAL_MS };

export function clampIntervalMs(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : USAGE_DEFAULT_INTERVAL_MS;
  return Math.min(USAGE_MAX_INTERVAL_MS, Math.max(USAGE_MIN_INTERVAL_MS, n));
}

type ReadableStorage = Pick<Storage, 'getItem'>;
type WritableStorage = Pick<Storage, 'setItem'>;

function browserLocalStorage(): Storage {
  return window.localStorage;
}

/** A malformed or hand-edited value degrades to the default rather than throwing — this preference is not
 * load-bearing, so a bad read must never break the page. */
export function loadUsageRefreshPreference(storage: ReadableStorage = browserLocalStorage()): UsageRefreshPreference {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFERENCE;
    const parsed = JSON.parse(raw) as Partial<UsageRefreshPreference> | null;
    const mode: UsageRefreshMode = parsed?.mode === 'interval' ? 'interval' : 'manual';
    return { mode, intervalMs: clampIntervalMs(parsed?.intervalMs) };
  } catch {
    return DEFAULT_PREFERENCE;
  }
}

export function saveUsageRefreshPreference(
  preference: UsageRefreshPreference,
  storage: WritableStorage = browserLocalStorage(),
): void {
  const safe: UsageRefreshPreference = {
    mode: preference.mode === 'interval' ? 'interval' : 'manual',
    intervalMs: clampIntervalMs(preference.intervalMs),
  };
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(safe));
  } catch {
    // Private browsing, blocked site data, a full quota: the choice just won't survive a reload. A
    // convenience preference degrading silently is correct here; the page itself is unaffected.
  }
}
