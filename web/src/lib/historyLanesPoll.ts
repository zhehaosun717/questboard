// The dispatch-history lanes poll driver (QB-FB-HISTORY revision 5, D2). Plain, no React: HistoryView
// owns exactly one of these via useEffect, the same split as lib/historyScan.ts's runHistoryScan — a
// pure, injectable driver so the abort/timeout/in-flight contract is unit-testable with fake timers
// instead of only ever proven in a real browser.
import { fetchLanesReport } from '../api/historyLanes';
import type { LanesReport } from '../api/types';

export interface LanesPollHandlers {
  onSuccess: (data: LanesReport) => void;
  onError: (message: string) => void;
  /** Fired when the bound elapses; the read is aborted right after. A later abort-caused rejection is
   * never also reported through onError — this is the one message for that read. */
  onTimeout: () => void;
}

export interface LanesPollOptions {
  intervalMs: number;
  timeoutMs: number;
  /** Injected for tests; production code omits it and gets the real `/api/lanes` reader. */
  fetchImpl?: typeof fetchLanesReport;
}

/**
 * Polls `/api/lanes` on `intervalMs`, one read in flight at a time. A read past `timeoutMs` is aborted
 * (never left to hang forever) and reported once via `onTimeout`; the in-flight flag only clears once
 * that read actually settles, so the next tick recovers on its own rather than piling a second read on
 * top of one still technically outstanding. `stop()` (unmount, or a newer poll instance) aborts whatever
 * is in flight too. If a test's mock deliberately ignores the abort signal and never settles, the flag
 * simply never clears and no further reads start — that is the intended "no pileup" behaviour, not a bug.
 */
export function startLanesPoll(handlers: LanesPollHandlers, options: LanesPollOptions): () => void {
  const fetchImpl = options.fetchImpl ?? fetchLanesReport;
  let stopped = false;
  let inFlight = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;

  const tick = () => {
    if (stopped || inFlight) return;
    inFlight = true;
    controller = new AbortController();
    const own = controller;
    timeoutId = setTimeout(() => {
      handlers.onTimeout();
      own.abort();
    }, options.timeoutMs);
    fetchImpl({ signal: own.signal })
      .then((data) => {
        if (timeoutId) clearTimeout(timeoutId);
        if (stopped) return;
        handlers.onSuccess(data);
      })
      .catch((err) => {
        if (timeoutId) clearTimeout(timeoutId);
        if (stopped || own.signal.aborted) return;
        handlers.onError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        inFlight = false;
      });
  };

  tick();
  const interval = setInterval(tick, options.intervalMs);
  return () => {
    stopped = true;
    clearInterval(interval);
    if (timeoutId) clearTimeout(timeoutId);
    controller?.abort();
  };
}
