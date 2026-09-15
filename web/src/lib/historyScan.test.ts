import { describe, expect, it } from 'vitest';
import { HistoryProtocolError, type DispatchEvent, type EventsPage } from '../api/historyEvents';
import {
  createScanState,
  historyCoverageLabel,
  runHistoryScan,
  scanReducer,
  type ScanAction,
} from './historyScan';

function ev(seq: number): DispatchEvent {
  return {
    seq,
    at: '2026-09-12T10:00:00.000Z',
    event: 'dispatched',
    package: 'RUN-1',
    lane: 'codex',
    model: 'gpt-5.6-luna',
    variant: null,
    name: 'w-1',
    by: 'owner',
    detail: '',
  };
}

/** A harness that plays the real reducer forward as the driver dispatches, exactly like React's
 * useReducer would, so a driver test can assert on the resulting state, not just the action log. */
function harness() {
  let state = createScanState();
  const actions: ScanAction[] = [];
  const dispatch = (action: ScanAction) => {
    actions.push(action);
    state = scanReducer(state, action);
  };
  return { dispatch, actions, get state() { return state; } };
}

describe('runHistoryScan: the four operations', () => {
  it('initial: reads pages until an atEnd page, merging by seq', async () => {
    const h = harness();
    const pages: EventsPage[] = [
      { events: [ev(1), ev(2)], nextAfter: 2, atEnd: false },
      { events: [], nextAfter: 2, atEnd: true },
    ];
    let call = 0;
    const fetchPage = async (after: number) => {
      expect(after).toBe(call === 0 ? 0 : 2);
      const page = pages[call]!;
      call += 1;
      return page;
    };
    await runHistoryScan({ after: 0, op: 'initial', generation: 1, signal: new AbortController().signal, dispatch: h.dispatch, fetchPage });
    expect(h.state.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(h.state.atEnd).toBe(true);
    expect(h.state.loading).toBe(false);
    expect(h.state.op).toBe('initial');
    expect(h.actions.map((a) => a.type)).toEqual(['scan/start', 'scan/page', 'scan/page', 'scan/done']);
  });

  it('continue: extends what is already held, never resets it', async () => {
    const h = harness();
    h.dispatch({ type: 'scan/start', op: 'initial', generation: 1 });
    h.dispatch({ type: 'scan/page', page: { events: [ev(1)], nextAfter: 1, atEnd: false }, generation: 1 });
    h.dispatch({ type: 'scan/done', generation: 1 });
    const fetchPage = async (after: number) => {
      expect(after).toBe(1);
      return { events: [], nextAfter: 1, atEnd: true } satisfies EventsPage;
    };
    await runHistoryScan({ after: h.state.nextAfter, op: 'continue', generation: 2, signal: new AbortController().signal, dispatch: h.dispatch, fetchPage });
    expect(h.state.events.map((e) => e.seq)).toEqual([1]);
    expect(h.state.atEnd).toBe(true);
    expect(h.state.op).toBe('continue');
  });

  it('refresh: reads only what is new after an already-finished scan', async () => {
    const h = harness();
    h.dispatch({ type: 'scan/start', op: 'initial', generation: 1 });
    h.dispatch({ type: 'scan/page', page: { events: [ev(1)], nextAfter: 1, atEnd: true }, generation: 1 });
    h.dispatch({ type: 'scan/done', generation: 1 });
    const fetchPage = async (after: number) => {
      expect(after).toBe(1);
      return { events: [ev(2)], nextAfter: 2, atEnd: true } satisfies EventsPage;
    };
    await runHistoryScan({ after: h.state.nextAfter, op: 'refresh', generation: 2, signal: new AbortController().signal, dispatch: h.dispatch, fetchPage });
    expect(h.state.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(h.state.op).toBe('refresh');
  });

  it('reread: a genuinely fresh scan, never a union with what was held before (B4)', async () => {
    const h = harness();
    // First scan holds seq 1/2 from a log that gets replaced (or just re-read from scratch).
    h.dispatch({ type: 'scan/start', op: 'initial', generation: 1 });
    h.dispatch({ type: 'scan/page', page: { events: [ev(1), ev(2)], nextAfter: 2, atEnd: true }, generation: 1 });
    h.dispatch({ type: 'scan/done', generation: 1 });
    expect(h.state.events.map((e) => e.seq)).toEqual([1, 2]);

    // Immediately at the 'scan/start' dispatch for the reread, before any page arrives, the held
    // records are already gone — a simple reset, not deferred until the first page lands.
    const fetchPage = async (after: number) => {
      expect(after).toBe(0);
      return { events: [ev(100), ev(101)], nextAfter: 101, atEnd: true } satisfies EventsPage;
    };
    const startAction: ScanAction = { type: 'scan/start', op: 'reread', generation: 2 };
    const stateRightAfterStart = scanReducer(h.state, startAction);
    expect(stateRightAfterStart.events).toEqual([]);
    expect(stateRightAfterStart.loading).toBe(true);

    await runHistoryScan({ after: 0, op: 'reread', generation: 2, signal: new AbortController().signal, dispatch: h.dispatch, fetchPage });
    expect(h.state.events.map((e) => e.seq)).toEqual([100, 101]);
    expect(h.state.op).toBe('reread');
  });
});

describe('runHistoryScan: budget stop', () => {
  it('stops at the page budget without claiming the end, and never spins past it', async () => {
    const h = harness();
    let calls = 0;
    const fetchPage = async (after: number) => {
      calls += 1;
      return { events: [ev(after + 1)], nextAfter: after + 1, atEnd: false } satisfies EventsPage;
    };
    await runHistoryScan({ after: 0, op: 'initial', generation: 1, signal: new AbortController().signal, dispatch: h.dispatch, fetchPage, maxPages: 3 });
    expect(calls).toBe(3);
    expect(h.state.events.length).toBe(3);
    expect(h.state.atEnd).toBe(false);
    expect(h.state.loading).toBe(false);
    expect(h.state.error).toBeNull();
  });
});

describe('runHistoryScan: abort', () => {
  it('an abort mid-loop stops dispatching immediately, leaving no further pages applied', async () => {
    const h = harness();
    const controller = new AbortController();
    let calls = 0;
    const fetchPage = async (after: number) => {
      calls += 1;
      controller.abort(); // simulate unmount/a newer scan racing this response
      return { events: [ev(after + 1)], nextAfter: after + 1, atEnd: false } satisfies EventsPage;
    };
    await runHistoryScan({ after: 0, op: 'initial', generation: 1, signal: controller.signal, dispatch: h.dispatch, fetchPage, maxPages: 5 });
    expect(calls).toBe(1);
    expect(h.actions.map((a) => a.type)).toEqual(['scan/start']); // the page that resolved after abort is dropped
  });
});

describe('runHistoryScan: errors', () => {
  it('an HTTP-shaped failure is recoverable by resuming at the same cursor', async () => {
    const h = harness();
    const fetchPage = async () => { throw new Error('事件接口返回 500：boom'); };
    await runHistoryScan({ after: 5, op: 'continue', generation: 1, signal: new AbortController().signal, dispatch: h.dispatch, fetchPage });
    expect(h.state.error).toBe('事件接口返回 500：boom');
    expect(h.state.errorKind).toBe('http');
    expect(h.state.loading).toBe(false);
  });

  it('a cursor-protocol break is marked distinctly: retrying the same cursor cannot fix it', async () => {
    const h = harness();
    const fetchPage = async () => { throw new HistoryProtocolError('游标没有前进'); };
    await runHistoryScan({ after: 5, op: 'continue', generation: 1, signal: new AbortController().signal, dispatch: h.dispatch, fetchPage });
    expect(h.state.errorKind).toBe('protocol');
    expect(h.state.error).toContain('游标没有前进');
  });
});

describe('scanReducer: stale generations are ignored', () => {
  it('a page dispatched under an old generation never reaches the current state', () => {
    let state = createScanState();
    state = scanReducer(state, { type: 'scan/start', op: 'initial', generation: 1 });
    state = scanReducer(state, { type: 'scan/page', page: { events: [ev(1)], nextAfter: 1, atEnd: false }, generation: 1 });
    // A newer scan (e.g. the user clicked 全部重新读取 before the first page's sibling request landed)
    // bumps the generation and resets.
    state = scanReducer(state, { type: 'scan/start', op: 'reread', generation: 2 });
    expect(state.events).toEqual([]);
    // The stale page from generation 1, arriving late, must not resurrect the old record.
    state = scanReducer(state, { type: 'scan/page', page: { events: [ev(1)], nextAfter: 1, atEnd: false }, generation: 1 });
    expect(state.events).toEqual([]);
    // Nor can a stale error from generation 1 clobber the fresh scan's loading state.
    state = scanReducer(state, { type: 'scan/error', message: 'stale failure', kind: 'http', generation: 1 });
    expect(state.loading).toBe(true);
    expect(state.error).toBeNull();
  });
});

describe('historyCoverageLabel: the four operations stay identifiable', () => {
  it('initial (empty so far) reads "正在读取事件记录…"', () => {
    const state = scanReducer(createScanState(), { type: 'scan/start', op: 'initial', generation: 1 });
    expect(historyCoverageLabel(state)).toBe('正在读取事件记录…');
  });

  it('reread says "正在从头读取…" even while events from before the reset briefly linger in memory', () => {
    let state = createScanState();
    state = scanReducer(state, { type: 'scan/start', op: 'initial', generation: 1 });
    state = scanReducer(state, { type: 'scan/page', page: { events: [ev(1)], nextAfter: 1, atEnd: true }, generation: 1 });
    state = scanReducer(state, { type: 'scan/done', generation: 1 });
    const rereading = scanReducer(state, { type: 'scan/start', op: 'reread', generation: 2 });
    expect(historyCoverageLabel(rereading)).toBe('正在从头读取…');
    expect(rereading.events).toEqual([]); // the reset already happened, so this is never a stale claim
  });

  it('page 2+ of the INITIAL load still reads "正在读取事件记录…", never borrowing 继续加载\'s label (note 1)', () => {
    let state = createScanState();
    state = scanReducer(state, { type: 'scan/start', op: 'initial', generation: 1 });
    state = scanReducer(state, { type: 'scan/page', page: { events: [ev(1)], nextAfter: 1, atEnd: false }, generation: 1 });
    // Still loading, still the SAME 'initial' op — runHistoryScan's page loop dispatches scan/page
    // without an intervening scan/done, so the state here is exactly what page 2 of one load sees.
    expect(historyCoverageLabel(state)).toBe('已读取 1 条事件记录，正在读取事件记录…');
  });

  it('continue (already holding records) reads "…正在继续读取…"', () => {
    let state = createScanState();
    state = scanReducer(state, { type: 'scan/start', op: 'initial', generation: 1 });
    state = scanReducer(state, { type: 'scan/page', page: { events: [ev(1)], nextAfter: 1, atEnd: false }, generation: 1 });
    state = scanReducer(state, { type: 'scan/done', generation: 1 });
    state = scanReducer(state, { type: 'scan/start', op: 'continue', generation: 2 });
    expect(historyCoverageLabel(state)).toBe('已读取 1 条事件记录，正在继续读取…');
  });

  it('refresh (already at the end) reads "…正在刷新新事件…", never a full-reread claim', () => {
    let state = createScanState();
    state = scanReducer(state, { type: 'scan/start', op: 'initial', generation: 1 });
    state = scanReducer(state, { type: 'scan/page', page: { events: [ev(1)], nextAfter: 1, atEnd: true }, generation: 1 });
    state = scanReducer(state, { type: 'scan/done', generation: 1 });
    state = scanReducer(state, { type: 'scan/start', op: 'refresh', generation: 2 });
    expect(historyCoverageLabel(state)).toBe('已读取 1 条事件记录，正在刷新新事件…');
  });

  it('a finished scan claims 全部 only once truly at the end', () => {
    let state = createScanState();
    state = scanReducer(state, { type: 'scan/start', op: 'initial', generation: 1 });
    state = scanReducer(state, { type: 'scan/page', page: { events: [ev(1)], nextAfter: 1, atEnd: true }, generation: 1 });
    state = scanReducer(state, { type: 'scan/done', generation: 1 });
    expect(historyCoverageLabel(state)).toBe('已读取全部事件记录（共 1 条）');
  });

  it('a budget stop says what is unread, not 全部', () => {
    let state = createScanState();
    state = scanReducer(state, { type: 'scan/start', op: 'initial', generation: 1 });
    state = scanReducer(state, { type: 'scan/page', page: { events: [ev(1)], nextAfter: 1, atEnd: false }, generation: 1 });
    state = scanReducer(state, { type: 'scan/done', generation: 1 });
    const label = historyCoverageLabel(state);
    expect(label).toContain('还没读完');
    expect(label).not.toContain('全部');
  });

  it('an error keeps the read count visible next to the failure', () => {
    let state = createScanState();
    state = scanReducer(state, { type: 'scan/start', op: 'initial', generation: 1 });
    state = scanReducer(state, { type: 'scan/page', page: { events: [ev(1)], nextAfter: 1, atEnd: false }, generation: 1 });
    state = scanReducer(state, { type: 'scan/error', message: '事件接口返回 500', kind: 'http', generation: 1 });
    expect(historyCoverageLabel(state)).toBe('已读取 1 条事件记录，读取失败：事件接口返回 500');
  });
});
