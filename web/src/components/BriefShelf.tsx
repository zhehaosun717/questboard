import { useMemo, useState } from 'react';
import type { BriefDiscovery, UnpostedBrief } from '../api/types';
import { formatClock } from '../lib/board';

interface BriefShelfProps {
  unpostedBriefs?: UnpostedBrief[];
  // Optional and backward compatible: an older server (or a caller that has not wired this up yet) sends
  // none, and the shelf falls back to exactly its previous behaviour — the plain list, no counts, no fold.
  briefDiscovery?: BriefDiscovery;
  onRescan?: () => void;
}

const BRIEFS_SHOWN = 8;

export function BriefShelf({ unpostedBriefs = [], briefDiscovery, onRescan }: BriefShelfProps) {
  const [expanded, setExpanded] = useState(false);
  const [showOld, setShowOld] = useState(false);
  const [showDispatched, setShowDispatched] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  // Excluded files a viewer may choose to reveal anyway, rather than trust discovery silently dropped them:
  // "already dispatched elsewhere" and "older than the recency window". Both carry a title/writtenAt because
  // they were actually read; this can only ever reveal rows that survived the server's MAX_EXCLUDED cap —
  // the counts below are truthful regardless of whether a given row is revealable.
  const revealed = useMemo(() => {
    if (!briefDiscovery) return [];
    return briefDiscovery.excluded
      .filter((x) => x.title !== undefined && x.writtenAt !== undefined)
      .filter((x) => (showOld && x.kind === 'old') || (showDispatched && x.kind === 'dispatched'))
      .map((x): UnpostedBrief => ({ package: x.package as string, brief: x.brief, title: x.title as string, writtenAt: x.writtenAt as string }));
  }, [briefDiscovery, showOld, showDispatched]);

  const combined = useMemo(
    () => [...unpostedBriefs, ...revealed].sort((a, b) => b.writtenAt.localeCompare(a.writtenAt)),
    [unpostedBriefs, revealed],
  );

  // Always from byKind (every exclusion, counted server-side before the MAX_EXCLUDED cap) — never derived by
  // filtering the capped excluded array on this side, which would silently read as 0 once a folder has more
  // than the cap's worth of skipped files even though old/dispatched briefs genuinely exist.
  const oldCount = briefDiscovery?.byKind.old ?? 0;
  const dispatchedCount = briefDiscovery?.byKind.dispatched ?? 0;
  const otherExcludedCount = briefDiscovery
    ? briefDiscovery.excludedTotal - oldCount - dispatchedCount
    : 0;
  const otherExcludedShown = briefDiscovery?.excluded.filter((x) => x.kind !== 'old' && x.kind !== 'dispatched') ?? [];
  const unlistedOther = briefDiscovery
    ? Math.max(0, otherExcludedCount - otherExcludedShown.length)
    : 0;
  const windowLabel = briefDiscovery ? `最近 ${briefDiscovery.recentDays} 天` : '最近几天';

  return (
    <section className="reviews" aria-labelledby="briefsTitle">
      <header className="sec-head">
        <span className="eyebrow">DRAFTS</span>
        <h2 id="briefsTitle">还没上板的 brief</h2>
      </header>
      <p className="hint">
        {windowLabel}写好、还没发布也没派过的 brief。coordinator 发布后才能派出。
        {briefDiscovery && `上次扫描：${formatClock(briefDiscovery.scannedAt)}，看了 ${briefDiscovery.folders.join('、')}。`}
        {onRescan && (
          <button className="plate" type="button" onClick={onRescan} style={{ marginLeft: '8px' }}>
            立即重新扫描
          </button>
        )}
      </p>
      {briefDiscovery && briefDiscovery.errors.length > 0 && (
        <p className="hint" style={{ color: 'var(--amber, #d9b45a)' }}>
          ⚠ {briefDiscovery.errors.map((e) => `${e.folder}（${e.reason}）`).join('；')}
        </p>
      )}
      {(oldCount > 0 || dispatchedCount > 0) && (
        <p className="hint">
          {oldCount > 0 && (
            <label style={{ marginRight: '12px' }}>
              <input type="checkbox" checked={showOld} onChange={(e) => setShowOld(e.target.checked)} /> 也显示超出时间窗口的 {oldCount} 份
            </label>
          )}
          {dispatchedCount > 0 && (
            <label>
              <input type="checkbox" checked={showDispatched} onChange={(e) => setShowDispatched(e.target.checked)} /> 也显示已在别处派出的 {dispatchedCount} 份
            </label>
          )}
        </p>
      )}
      <div id="briefs" className="bf-list">
        {combined.length === 0 ? (
          <div className="empty">没有待发布的 brief</div>
        ) : (
          (expanded ? combined : combined.slice(0, BRIEFS_SHOWN)).map(
            (b) => (
              <div className="bf" key={b.brief}>
                <span className="pid">{b.package}</span>
                <span>{b.title}</span>
                <code>{b.brief}</code>
              </div>
            ),
          )
        )}
      </div>
      {combined.length > BRIEFS_SHOWN && (
        <button
          className="plate bf-toggle"
          type="button"
          onClick={() => setExpanded(!expanded)}
          style={{ marginTop: '10px' }}
        >
          {expanded ? '收起' : `展开全部 ${combined.length} 份`}
        </button>
      )}
      {otherExcludedCount > 0 && (
        <div style={{ marginTop: '10px' }}>
          <button className="plate" type="button" onClick={() => setShowDiagnostics(!showDiagnostics)}>
            {showDiagnostics ? '收起' : `为什么还有 ${otherExcludedCount} 个文件没出现`}
          </button>
          {showDiagnostics && (
            <ul className="hint">
              {otherExcludedShown.map((x, i) => (
                <li key={`${x.brief}-${i}`}>
                  <code>{x.brief}</code>：{x.reason}
                </li>
              ))}
              {unlistedOther > 0 && <li>还有 {unlistedOther} 项未列出（本次扫描共排除 {briefDiscovery?.excludedTotal} 项）</li>}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
