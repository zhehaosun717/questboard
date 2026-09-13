import type { UsageReport } from '../api/types';

/**
 * The last usage report, kept outside React.
 *
 * Switching tabs unmounts UsageView, so without this the page starts from an empty state every time and
 * reads as "it reloads on every click" — even though the server already caches for 60 s. The component
 * unmounts; this module does not.
 */
export const USAGE_MAX_AGE_MS = 5 * 60 * 1000;

export interface CachedUsage {
  report: UsageReport;
  at: number;
}

let cached: CachedUsage | null = null;

export function getCachedUsage(): CachedUsage | null {
  return cached;
}

export function setCachedUsage(report: UsageReport, at: number): void {
  cached = { report, at };
}

export function clearCachedUsage(): void {
  cached = null;
}

/** A result younger than maxAgeMs is shown as is. A clock that jumped backwards counts as stale. */
export function isFresh(at: number, now: number, maxAgeMs: number = USAGE_MAX_AGE_MS): boolean {
  const age = now - at;
  return age >= 0 && age < maxAgeMs;
}
