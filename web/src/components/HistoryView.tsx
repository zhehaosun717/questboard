import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { LaneLimit, LanesReport } from '../api/types';
import { startLanesPoll } from '../lib/historyLanesPoll';
import {
  countInvalidAt,
  emptyHistoryFilters,
  filterHistoryEvents,
  groupEventsByTask,
  historyFilterOptions,
  laneLabel,
  parseTimeBounds,
  splitStale,
  type HistoryFilters,
} from '../lib/history';
import {
  createScanState,
  historyCoverageLabel,
  runHistoryScan,
  scanReducer,
  type ScanOp,
} from '../lib/historyScan';
import { formatClock } from '../lib/board';
import { HistoryEvents } from './history/HistoryEvents';
import { HistoryFilterBar } from './history/HistoryFilterBar';
import { HistoryRow } from './history/HistoryRow';
import { ProjectTests } from './history/ProjectTests';
import '../styles/history.css';

/** How long one lanes poll may run before it is actually aborted and the header shows the last good
 * result plus a failure note instead of waiting on it forever (review 73f4bd71 non-blocking #3, R8;
 * revision 5 D2). lib/historyLanesPoll.ts owns the real AbortController and the in-flight guard, kept
 * out of the shared api client since that one has no signal parameter and is used well beyond this tab. */
const LANES_POLL_TIMEOUT_MS = 8000;

// N16: `cleared` is timing-dependent, not proof of an owner click — word it neutrally. GET /api/lanes only
// ever sends the raw collector laneEvidence (N17), so most entries here simply have no `cleared` at all
// (their own known reset passed); that case reads as an honest "expired or unattributable" too.
const CLEARED_LABEL: Record<string, string> = {
  owner: '该卡片已不再限额',
  status: '该卡片状态已改变',
  no_card: '名册里已经找不到这张卡片',
};

export function evidenceReason(cleared: string | undefined): string {
  if (cleared && CLEARED_LABEL[cleared]) return CLEARED_LABEL[cleared];
  return '已过期或无法归因的证据';
}

export interface LaneEvidenceRow {
  key: string;
  lane: string;
  name: string;
  reason: string;
}

// Never a limit (requirement 5): every row here already fell out of laneLimits, on the roster side, before
// this report was even generated — so no `laneLimits` cross-check belongs here, only wording.
export function buildLaneEvidenceRows(laneEvidence: LanesReport['laneEvidence']): LaneEvidenceRow[] {
  return Object.entries(laneEvidence || {}).flatMap(([lane, evidence]) => [
    ...Object.entries(evidence.cards || {}).map(([adventurerId, entry]) => ({
      key: `${lane}-${adventurerId}`,
      lane,
      name: entry.name || adventurerId,
      reason: evidenceReason(entry.cleared),
    })),
    // N1: unidentified evidence has no adventurerId to key or attribute by, but the strip claims to cover
    // "已过期或无法归因" — an entry that could not be attributed to any card belongs here too.
    ...(evidence.unidentified || []).map((entry, i) => ({
      key: `${lane}-unid-${i}`,
      lane,
      name: entry.name || '未知来源',
      reason: evidenceReason(undefined),
    })),
  ]);
}

// A dated `until` can outlive the window it named (a passed known reset, or a manual relimit that keeps the
// old bounce's dated text while resetsAt is cleared to null) — never show it unless resetsAt still parses to
// a real future time (review B3; also covers N18 here since a manual relimit's resetsAt is null).
export function laneLimitUntilLabel(limit: Pick<LaneLimit, 'until' | 'resetsAt'>): string {
  if (!limit.until || !limit.resetsAt) return '';
  const t = Date.parse(limit.resetsAt);
  if (!Number.isFinite(t) || t <= Date.now()) return '';
  return `，${limit.until} 恢复`;
}

/**
 * The history tab (QB-FB-HISTORY): three clearly separated parts —
 * 1. 事件时间线: /api/events read page by page after the cursor, filterable, grouped by task;
 * 2. 项目测试: one labelled project-wide verification result (never per-task proof);
 * 3. 派出详情: the lane/package table, kept for per-worker detail inspection.
 * The events reader (lib/historyScan.ts) is honest about coverage: a finished scan says 全部, a
 * stopped one says what is still unread and offers to continue. Unmount or a new load cancels the
 * running one, and a full reread is a genuinely fresh scan, never a union with what was held before.
 */
export function HistoryView() {
  const [report, setReport] = useState<LanesReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string>('');
  const [expandedPkg, setExpandedPkg] = useState<string | null>(null);
  const [showStale, setShowStale] = useState<boolean>(false);

  useEffect(() => {
    // lib/historyLanesPoll.ts owns the AbortController, the timeout and the one-in-flight guard; this
    // effect only wires its results into state and stops it on unmount (which aborts whatever read is
    // still out there, instead of leaving it to finish into a dead component).
    const stop = startLanesPoll(
      {
        onSuccess: (data) => {
          setReport(data);
          setError(null);
          const stamp = data.generatedAt
            ? new Date(data.generatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
            : new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          setLastUpdated(stamp);
        },
        onError: (message) => setError(message),
        onTimeout: () => setError('联络接入方式超时'),
      },
      { intervalMs: 5000, timeoutMs: LANES_POLL_TIMEOUT_MS },
    );
    return stop;
  }, []);

  const [hist, dispatchScan] = useReducer(scanReducer, undefined, createScanState);
  const scanRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);

  /**
   * The one production scan loop (lib/historyScan.ts runHistoryScan): reads pages after `after` under
   * `op`'s label until the log proves its own end or the page budget runs out. Only one scan may own
   * the reader — a newer call aborts the older one, and so does unmount — and every dispatch from it
   * carries the generation it started with, so a page that arrives after being superseded is dropped
   * by the reducer even if the abort signal check raced it.
   */
  const startScan = (after: number, op: ScanOp) => {
    scanRef.current?.abort();
    const controller = new AbortController();
    scanRef.current = controller;
    generationRef.current += 1;
    void runHistoryScan({ after, op, generation: generationRef.current, signal: controller.signal, dispatch: dispatchScan });
  };

  useEffect(() => {
    startScan(0, 'initial');
    return () => scanRef.current?.abort();
    // The first page starts at the beginning of the log; cleanup cancels whatever is running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** A cursor-protocol break can't be fixed by retrying the same cursor (api/historyEvents.ts
   * HistoryProtocolError): only starting over proves anything again. An ordinary HTTP failure resumes
   * where it left off, same as before. Neither ever spins unbounded on its own. */
  const handleRetry = () => {
    if (hist.errorKind === 'protocol') startScan(0, 'reread');
    else startScan(hist.nextAfter, 'continue');
  };

  /**
   * 继续加载/刷新新事件/全部重新读取 all unmount their own button the instant loading starts (the
   * toolbar swaps in the coverage label instead), which drops keyboard focus to BODY — revision 5 note 4.
   * `wantsFocusRef` remembers that a load was started by activating a button in this toolbar; once
   * loading ends, focus is restored to the SAME action if it is still rendered, else the first toolbar
   * button — but only if the operator never did anything else meanwhile. "Did something else" is not
   * just "focus left BODY": clicking non-focusable content (a heading, table text) also leaves focus on
   * BODY, so a real `pointerdown`/`focusin` anywhere while loading cancels the restore outright (revision
   * 6 F1) — stealing it back would be exactly the mount-theft this must not do.
   */
  const toolsRef = useRef<HTMLDivElement | null>(null);
  const wantsFocusRef = useRef(false);
  const openerRef = useRef<string | null>(null);
  const restoreCancelledRef = useRef(false);
  const startScanFromToolbar = (after: number, op: ScanOp, opener: string) => {
    wantsFocusRef.current = true;
    openerRef.current = opener;
    restoreCancelledRef.current = false;
    startScan(after, op);
  };
  useEffect(() => {
    if (!hist.loading || !wantsFocusRef.current) return;
    const cancel = () => {
      restoreCancelledRef.current = true;
    };
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('focusin', cancel, true);
    return () => {
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('focusin', cancel, true);
    };
  }, [hist.loading]);
  useEffect(() => {
    if (hist.loading || !wantsFocusRef.current) return;
    wantsFocusRef.current = false;
    const opener = openerRef.current;
    openerRef.current = null;
    const cancelled = restoreCancelledRef.current;
    restoreCancelledRef.current = false;
    if (cancelled) return;
    if (typeof document === 'undefined' || document.activeElement !== document.body) return;
    const tools = toolsRef.current;
    const same = opener ? tools?.querySelector<HTMLButtonElement>(`.${opener}`) : null;
    (same ?? tools?.querySelector<HTMLButtonElement>('button'))?.focus();
  }, [hist.loading]);

  const [filters, setFilters] = useState<HistoryFilters>(emptyHistoryFilters);
  // Memoized: hist.events can hold thousands of records, and the lanes poll re-renders this component
  // every 5 s whether or not a single event changed — recomputing the filter/group pass on every one
  // of those unrelated polls would be pure waste (review 25756a14 N9).
  const bounds = useMemo(() => parseTimeBounds(filters.from, filters.to), [filters.from, filters.to]);
  const options = useMemo(() => historyFilterOptions(hist.events), [hist.events]);
  const matched = useMemo(() => filterHistoryEvents(hist.events, filters, bounds), [hist.events, filters, bounds]);
  const groups = useMemo(() => groupEventsByTask(matched), [matched]);
  const invalidAtCount = useMemo(
    () => (filters.onlyInvalidAt ? matched.length : countInvalidAt(matched)),
    [filters.onlyInvalidAt, matched],
  );
  const filtersDirty =
    JSON.stringify(filters) !== JSON.stringify(emptyHistoryFilters);

  const packages = report?.packages || [];
  const { active, stale } = splitStale(packages);
  const openQuestions = report?.board?.openQuestions ?? 0;
  const laneLimitEntries = Object.entries(report?.laneLimits || {});
  const laneEvidenceRows = buildLaneEvidenceRows(report?.laneEvidence);
  /** 派出详情/项目测试 read from the SAME lanes report as the header, and must be just as honest about
   * not having one yet (revision 6 F2): `report` only ever holds the last SUCCESSFUL read, so its
   * presence alone — never `error` — proves "known empty" is real and not just "haven't read it". */
  const lanesState: 'loading' | 'failed' | 'ok' = report ? 'ok' : error ? 'failed' : 'loading';
  const lanesPendingNote = lanesState === 'loading' ? '正在读取…' : '读取失败，暂时无法显示';

  const handleToggleRow = (pkgId: string) => {
    setExpandedPkg((curr) => (curr === pkgId ? null : pkgId));
  };

  const handleClear = () => {
    setFilters(emptyHistoryFilters);
  };

  return (
    <div className="history-tab-view">
      <header className="history-head">
        <div>
          <span className="eyebrow">DISPATCH LOG</span>
          <h2>派出记录</h2>
        </div>
        <div className="history-timestamp">
          {/* A failure before any success ever landed must not say "加载中" (it already failed) nor
              claim "仍显示上一次的结果" (there is no previous result to fall back to) — revision 5 note 2. */}
          <span>更新于 {lastUpdated || (error ? '尚无成功结果' : '加载中…')}</span>
          {error && (
            <span className="error-text">
              {' '}
              · 刷新失败：{error}
              {lastUpdated ? '，仍显示上一次的结果' : '（派出详情和项目测试还没有读到）'}
            </span>
          )}
        </div>
      </header>

      {openQuestions > 0 && (
        <div className="history-chips-strip">
          <span className="chip warn">
            <i className="led warn" />
            待答问题 {openQuestions}
          </span>
          {laneLimitEntries.map(([lane, lim]) => (
            <span key={lane} className="chip warn">
              <i className="led warn" />
              {laneLabel(lane)} 限额中（{formatClock(lim.since)} 起{laneLimitUntilLabel(lim)}）
            </span>
          ))}
        </div>
      )}

      {laneEvidenceRows.length > 0 && (
        <div className="history-chips-strip" aria-label="已过期或无法归因的限额证据">
          {laneEvidenceRows.map((row) => (
            <span key={row.key} className="chip">
              <i className="led" />
              {laneLabel(row.lane)} · {row.name} · {row.reason}
            </span>
          ))}
        </div>
      )}

      <section className="hist-events-section" aria-label="事件时间线">
        <header className="sec-head hist-events-head">
          <div>
            <span className="eyebrow">EVENT TIMELINE</span>
            <h3>事件时间线</h3>
          </div>
          <div className="hist-events-tools" ref={toolsRef}>
            <span className="hist-coverage" aria-live="polite">{historyCoverageLabel(hist)}</span>
            {/* Continuing (cheap: reads only what's unread) and catching up (cheap: reads only what's
                new) are distinct from a full reread (expensive: a genuinely fresh scan, never a union
                with what was held before). None of the three show during an error — the error block
                below owns the one recovery action (review 25756a14 Q2). */}
            {!hist.error && !hist.atEnd && !hist.loading && (
              <button
                type="button"
                className="hist-load-more"
                onClick={() => startScanFromToolbar(hist.nextAfter, 'continue', 'hist-load-more')}
              >
                继续加载
              </button>
            )}
            {!hist.error && hist.atEnd && !hist.loading && (
              <button
                type="button"
                className="hist-refresh"
                onClick={() => startScanFromToolbar(hist.nextAfter, 'refresh', 'hist-refresh')}
              >
                刷新新事件
              </button>
            )}
            {!hist.error && !hist.loading && (
              <>
                <button
                  type="button"
                  className="hist-reset-secondary"
                  aria-describedby="hist-reread-explain"
                  onClick={() => startScanFromToolbar(0, 'reread', 'hist-reset-secondary')}
                >
                  全部重新读取
                </button>
                <span id="hist-reread-explain" className="hist-sr-only">
                  从头重新读取整个事件日志：已经加载的部分也会重新请求一次，比继续加载或刷新新事件慢
                </span>
              </>
            )}
          </div>
        </header>

        <HistoryFilterBar
          value={filters}
          options={options}
          matched={matched.length}
          loaded={hist.events.length}
          timeError={bounds.error}
          invalidAtCount={invalidAtCount}
          onChange={setFilters}
          onClear={handleClear}
          idPrefix="hist"
        />

        {hist.loading && matched.length === 0 && (
          <div className="hist-loading" role="status">{historyCoverageLabel(hist)}</div>
        )}
        {hist.error && (
          <div className="hist-load-error" role="alert">
            事件读取失败：{hist.error}
            <button type="button" className="hist-retry" onClick={handleRetry}>
              {hist.errorKind === 'protocol' ? '从头重新读取' : '重试'}
            </button>
          </div>
        )}
        {!hist.loading && !hist.error && hist.events.length === 0 && (
          <div className="hist-empty">事件文件还没有任何记录。</div>
        )}
        {!hist.loading && matched.length === 0 && hist.events.length > 0 && !hist.error && (
          <div className="hist-no-match">
            没有符合条件的记录（在已读取的 {hist.events.length} 条里）。
            {filtersDirty && (
              <button type="button" className="hist-filter-clear" onClick={handleClear}>
                清除筛选
              </button>
            )}
          </div>
        )}
        <HistoryEvents groups={groups} />
      </section>

      <ProjectTests
        verification={report?.verification ?? null}
        asOf={report?.generatedAt ?? null}
        lanesState={lanesState}
      />

      <section className="hist-workers-section" aria-label="派出详情">
        <header className="sec-head">
          <div>
            <span className="eyebrow">WORKER SUMMARY</span>
            <h3>派出详情（每个工人的近况）</h3>
          </div>
        </header>
        <div className="history-table-container">
          <table className="history-table">
            <thead>
              <tr>
                <th>委托</th>
                <th>接入方式</th>
                <th>模型</th>
                <th>状态</th>
                <th>运行时长</th>
                <th>编辑次数</th>
                <th>最近一句话</th>
                <th>编号</th>
              </tr>
            </thead>
            <tbody>
              {packages.length === 0 ? (
                <tr>
                  <td colSpan={8} className="empty">
                    {lanesState === 'ok' ? '暂无派出记录' : lanesPendingNote}
                  </td>
                </tr>
              ) : (
                <>
                  {active.map((p) => (
                    <HistoryRow
                      key={p.package}
                      pkg={p}
                      isExpanded={expandedPkg === p.package}
                      onToggle={() => handleToggleRow(p.package)}
                    />
                  ))}
                  {stale.length > 0 && (
                    <tr className="stale-toggle-row" onClick={() => setShowStale((prev) => !prev)}>
                      <td colSpan={8}>
                        {showStale ? '▲' : '▼'} 三天前的记录 ({stale.length})
                      </td>
                    </tr>
                  )}
                  {showStale &&
                    stale.map((p) => (
                      <HistoryRow
                        key={p.package}
                        pkg={p}
                        isExpanded={expandedPkg === p.package}
                        onToggle={() => handleToggleRow(p.package)}
                      />
                    ))}
                </>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
