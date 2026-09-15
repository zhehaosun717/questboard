import type { LanesReport } from './types';

/**
 * A history-only `/api/lanes` read that honours an AbortSignal. Kept separate from `api/client.ts`'s
 * `call()` (used well beyond this tab, with no signal parameter) so the history tab alone can bound and
 * cancel its own poll: a bounded timeout on the wait, and cancellation on unmount, without touching the
 * shared client every other tab depends on (revision 5 D2).
 */
export async function fetchLanesReport(options: { signal?: AbortSignal } = {}): Promise<LanesReport> {
  const response = await fetch('/api/lanes', { signal: options.signal });
  const value = (await response.json().catch(() => ({}))) as Partial<LanesReport> & { error?: string };
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value as LanesReport;
}
