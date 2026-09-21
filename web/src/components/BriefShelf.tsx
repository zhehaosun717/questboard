import { useMemo, useState } from 'react';
import type { BriefDiscovery, UnpostedBrief } from '../api/types';
import { formatClock } from '../lib/board';
import { useT } from '../lib/i18n';
import type { I18nKey } from '../lib/i18n';
import { api } from '../api/client';

interface BriefShelfProps {
  unpostedBriefs?: UnpostedBrief[];
  // Optional and backward compatible: an older server (or a caller that has not wired this up yet) sends
  // none, and the shelf falls back to exactly its previous behaviour — the plain list, no counts, no fold.
  briefDiscovery?: BriefDiscovery;
  onRescan?: () => void;
  pushToast?: (text: string) => void;
}

const BRIEFS_SHOWN = 8;

// FB2-08 item 4: the human name of every exclusion kind, so 「为什么还有 N 个文件没出现」can explain the
// counts by category instead of one opaque total.
const KIND_KEY: Record<string, I18nKey> = {
  duplicate: 'briefShelf.kind.duplicate',
  badId: 'briefShelf.kind.badId',
  unreadable: 'briefShelf.kind.unreadable',
  oversized: 'briefShelf.kind.oversized',
  posted: 'briefShelf.kind.posted',
  dispatched: 'briefShelf.kind.dispatched',
  old: 'briefShelf.kind.old',
  symlink: 'briefShelf.kind.symlink',
  dismissed: 'briefShelf.kind.dismissed',
};

export function BriefShelf({ unpostedBriefs = [], briefDiscovery, onRescan, pushToast }: BriefShelfProps) {
  const t = useT();
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

  // FB2-08 item 2: every physical copy of a shared id is its own row — the superseded copies are listed
  // right after the ready ones, labelled 与 <主副本> 同编号, each with its own dismiss button.
  const duplicates = useMemo(() => (briefDiscovery
    ? briefDiscovery.excluded.filter((x) => x.kind === 'duplicate')
    : []), [briefDiscovery]);

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
  const windowLabel = briefDiscovery
    ? t('briefShelf.windowDays', { days: briefDiscovery.recentDays })
    : t('briefShelf.windowDefault');

  const dismiss = async (pkg: string, brief?: string) => {
    try {
      await api.dismissBrief(pkg, brief);
      onRescan?.();
    } catch (error) {
      pushToast?.(t('briefShelf.dismissFailed', { error: error instanceof Error ? error.message : String(error) }));
    }
  };
  const undismiss = async (record: { package: string; brief?: string }) => {
    try {
      await api.undismissBrief(record.package, record.brief);
      onRescan?.();
    } catch (error) {
      pushToast?.(t('briefShelf.undismissFailed', { error: error instanceof Error ? error.message : String(error) }));
    }
  };

  const dismissButton = (pkg: string, brief?: string) => (
    <button className="plate" type="button" onClick={() => void dismiss(pkg, brief)}>
      {t('briefShelf.dismissButton')}
    </button>
  );

  return (
    <section className="reviews" aria-labelledby="briefsTitle">
      <header className="sec-head">
        <span className="eyebrow">{t('briefShelf.eyebrow')}</span>
        <h2 id="briefsTitle">{t('briefShelf.title')}</h2>
      </header>
      <p className="hint">
        {windowLabel}{t('briefShelf.hint')}
        {briefDiscovery && t('briefShelf.lastScan', { time: formatClock(briefDiscovery.scannedAt), folders: briefDiscovery.folders.join(t('common.listSeparator')) })}
        {onRescan && (
          <button className="plate" type="button" onClick={onRescan} style={{ marginLeft: '8px' }}>
            {t('briefShelf.rescan')}
          </button>
        )}
      </p>
      {briefDiscovery && briefDiscovery.errors.length > 0 && (
        <p className="hint" style={{ color: 'var(--amber, #d9b45a)' }}>
          ⚠ {briefDiscovery.errors.map((e) => t('briefShelf.errorItem', { folder: e.folder, reason: e.reason })).join(t('common.statementSeparator'))}
        </p>
      )}
      {(oldCount > 0 || dispatchedCount > 0) && (
        <p className="hint">
          {oldCount > 0 && (
            <label style={{ marginRight: '12px' }}>
              <input type="checkbox" checked={showOld} onChange={(e) => setShowOld(e.target.checked)} /> {t('briefShelf.showOld', { count: oldCount })}
            </label>
          )}
          {dispatchedCount > 0 && (
            <label>
              <input type="checkbox" checked={showDispatched} onChange={(e) => setShowDispatched(e.target.checked)} /> {t('briefShelf.showDispatched', { count: dispatchedCount })}
            </label>
          )}
        </p>
      )}
      <div id="briefs" className="bf-list">
        {combined.length === 0 && duplicates.length === 0 ? (
          <div className="empty">{t('briefShelf.empty')}</div>
        ) : (
          (expanded ? combined : combined.slice(0, BRIEFS_SHOWN)).map(
            (b) => (
              <div className="bf" key={b.brief}>
                <span className="pid">{b.package}</span>
                <span>{b.title}</span>
                <code>{b.brief}</code>
                {dismissButton(b.package, b.brief)}
              </div>
            ),
          )
        )}
        {duplicates.map((x) => (
          <div className="bf" key={x.brief}>
            <span className="pid">{x.package}</span>
            <span>{x.title ?? '—'}</span>
            <code>{x.brief}</code>
            <span className="hint">{x.primary ? t('briefShelf.sameIdAs', { primary: x.primary }) : x.reason}</span>
            {dismissButton(x.package as string, x.brief)}
          </div>
        ))}
      </div>
      {combined.length > BRIEFS_SHOWN && (
        <button
          className="plate bf-toggle"
          type="button"
          onClick={() => setExpanded(!expanded)}
          style={{ marginTop: '10px' }}
        >
          {expanded ? t('briefShelf.collapse') : t('briefShelf.expandAll', { count: combined.length })}
        </button>
      )}
      {briefDiscovery && (briefDiscovery.dismissed ?? []).length > 0 && (
        <div style={{ marginTop: '10px' }}>
          <p className="hint">{t('briefShelf.dismissedTitle', { count: briefDiscovery.dismissed.length })}</p>
          <ul className="hint">
            {briefDiscovery.dismissed.map((record, i) => (
              <li key={record.package + '-' + (record.brief ?? '') + '-' + i}>
                <code>{record.package}{record.brief ? ' ' + record.brief : ''}</code>
                {record.note ? t('briefShelf.dismissNote', { note: record.note }) : ''}
                <button className="plate" type="button" style={{ marginLeft: '8px' }} onClick={() => void undismiss(record)}>
                  {t('briefShelf.undo')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {otherExcludedCount > 0 && (
        <div style={{ marginTop: '10px' }}>
          <button className="plate" type="button" onClick={() => setShowDiagnostics(!showDiagnostics)}>
            {showDiagnostics ? t('briefShelf.collapse') : t('briefShelf.whyMissing', { count: otherExcludedCount })}
          </button>
          {showDiagnostics && (
            <>
              <ul className="hint">
                {/* FB2-08 item 4: the total, split by category from byKind — duplicate, bad file name,
                    unreadable, dismissed and so on — so the number is explained, never one opaque lump. */}
                {Object.entries(briefDiscovery?.byKind ?? {})
                  .filter(([, count]) => (count ?? 0) > 0)
                  .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
                  .map(([kind, count]) => (
                    <li key={kind}>{t(KIND_KEY[kind] ?? 'briefShelf.kind.other')}：{count}</li>
                  ))}
              </ul>
              <ul className="hint">
                {otherExcludedShown.map((x, i) => (
                  <li key={x.brief + '-' + i}>
                    <code>{x.brief}</code>{t('briefShelf.diagSeparator')}{x.reason}
                  </li>
                ))}
                {unlistedOther > 0 && <li>{t('briefShelf.unlistedOther', { count: unlistedOther, total: briefDiscovery?.excludedTotal ?? 0 })}</li>}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}
