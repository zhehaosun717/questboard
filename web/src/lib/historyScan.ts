// The dispatch-history event scan controller (QB-FB-HISTORY revision 4, B6). A pure reducer plus an
// injected-fetch driver: no React, no default network access, so the whole scan — page loop, abort,
// budget stop, error recovery, and the four distinct read operations — is unit-testable in plain node.
// HistoryView owns exactly one of these via useReducer; it is the only production scan loop.
import {
  fetchEventsPage,
  HISTORY_MAX_PAGES_PER_LOAD,
  HISTORY_PAGE_SIZE,
  HistoryProtocolError,
  mergeEventsBySeq,
  type DispatchEvent,
  type EventsPage,
} from '../api/historyEvents';

/** The four distinct read operations the brief requires to stay identifiable, never conflated. */
export type ScanOp = 'initial' | 'continue' | 'refresh' | 'reread';

export interface ScanState {
  /** Merged pages, unique by seq, oldest-first. */
  events: DispatchEvent[];
  nextAfter: number;
  /** Proven only by an empty, cursor-unchanged page (api/historyEvents.ts fetchEventsPage). */
  atEnd: boolean;
  loading: boolean;
  error: string | null;
  /** Which class of error: a protocol break can't be fixed by retrying the same cursor. */
  errorKind: 'http' | 'protocol' | null;
  /** The operation currently running, or the last one that finished/failed. Drives the coverage text. */
  op: ScanOp | null;
  /** Bumped by every new scan (continue/refresh/reread/initial alike); a page or error carrying an
   * older generation is a stale async completion from a superseded scan and is ignored — this is a
   * second guard alongside AbortController, not a replacement for it. */
  generation: number;
}

export function createScanState(): ScanState {
  return {
    events: [],
    nextAfter: 0,
    atEnd: false,
    loading: false,
    error: null,
    errorKind: null,
    op: null,
    generation: 0,
  };
}

export type ScanAction =
  | { type: 'scan/start'; op: ScanOp; generation: number }
  | { type: 'scan/page'; page: EventsPage; generation: number }
  | { type: 'scan/done'; generation: number }
  | { type: 'scan/error'; message: string; kind: 'http' | 'protocol'; generation: number };

/**
 * Pure state transition. A `reread` starts a genuinely fresh scan generation with records/cursor/end
 * reset to empty (the brief's preferred "simple reset", not a union with the old log — B4): a replaced
 * or truncated log is handled the same way, never leaving deleted old events visibly cached. `continue`,
 * `refresh` and `initial` all extend the held state instead. Every action but `scan/start` is ignored
 * once it carries a generation older than the current one.
 */
export function scanReducer(state: ScanState, action: ScanAction): ScanState {
  if (action.type !== 'scan/start' && action.generation !== state.generation) return state;
  switch (action.type) {
    case 'scan/start': {
      const base = action.op === 'reread' ? createScanState() : state;
      return { ...base, loading: true, error: null, errorKind: null, op: action.op, generation: action.generation };
    }
    case 'scan/page':
      return {
        ...state,
        events: mergeEventsBySeq(state.events, action.page.events),
        nextAfter: action.page.nextAfter,
        atEnd: action.page.atEnd,
      };
    case 'scan/done':
      return { ...state, loading: false };
    case 'scan/error':
      return { ...state, loading: false, error: action.message, errorKind: action.kind };
    default:
      return state;
  }
}

export interface RunScanOptions {
  /** Cursor to start from: 0 for `initial`/`reread`, the held `nextAfter` for `continue`/`refresh`. */
  after: number;
  op: ScanOp;
  generation: number;
  signal: AbortSignal;
  dispatch: (action: ScanAction) => void;
  /** Injected for tests; production code omits it and gets the real `/api/events` reader. */
  fetchPage?: typeof fetchEventsPage;
  /** Injected for tests to shrink the budget; production code uses the real per-load cap. */
  maxPages?: number;
}

/**
 * Read pages after `after` until the log proves its own end or the page budget runs out, dispatching
 * each page as it lands so the caller can render progressively. Never spins unbounded: a budget stop
 * simply ends the run with `atEnd` still false, which the coverage label reports honestly, and the
 * caller's own `continue` action picks up the remainder later. Every dispatch checks the abort signal
 * first, so an aborted scan (a newer scan superseding it, or unmount) never reaches the reducer again.
 */
export async function runHistoryScan(options: RunScanOptions): Promise<void> {
  const { after, op, generation, signal, dispatch } = options;
  const fetchPage = options.fetchPage ?? fetchEventsPage;
  const maxPages = options.maxPages ?? HISTORY_MAX_PAGES_PER_LOAD;
  dispatch({ type: 'scan/start', op, generation });
  let cursor = after;
  try {
    for (let page = 0; page < maxPages; page += 1) {
      if (signal.aborted) return;
      const result = await fetchPage(cursor, { limit: HISTORY_PAGE_SIZE, signal });
      if (signal.aborted) return;
      dispatch({ type: 'scan/page', page: result, generation });
      cursor = result.nextAfter;
      if (result.atEnd) break;
    }
    if (!signal.aborted) dispatch({ type: 'scan/done', generation });
  } catch (err) {
    if (signal.aborted) return;
    const kind: 'http' | 'protocol' = err instanceof HistoryProtocolError ? 'protocol' : 'http';
    dispatch({ type: 'scan/error', message: err instanceof Error ? err.message : String(err), kind, generation });
  }
}

/**
 * Honest coverage text, keyed off the explicit operation so a full reread never borrows the "refreshing"
 * label a stale `atEnd` would otherwise suggest (review 73f4bd71 B4). The API only pages forward, so an
 * unfinished scan holds the OLDEST records; the label says which part is missing rather than pretending
 * the newest ones are on screen.
 */
export function historyCoverageLabel(state: ScanState): string {
  const read = `已读取 ${state.events.length} 条事件记录`;
  if (state.error) return `${read}，读取失败：${state.error}`;
  if (state.loading && state.op === 'reread') return '正在从头读取…';
  if (state.loading && state.events.length === 0) return '正在读取事件记录…';
  // Page 2+ of the INITIAL load is still the first load, just further in — it must not borrow
  // 继续加载's own "继续读取" label, which implies an operator asked for more (revision 5 note 1).
  if (state.loading && state.op === 'initial') return `${read}，正在读取事件记录…`;
  if (state.loading && state.op === 'refresh') return `${read}，正在刷新新事件…`;
  if (state.loading) return `${read}，正在继续读取…`;
  if (state.atEnd) return `已读取全部事件记录（共 ${state.events.length} 条）`;
  return `${read}，更新的记录还没读完（可继续加载）`;
}
