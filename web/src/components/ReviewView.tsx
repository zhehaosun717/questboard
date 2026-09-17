import { useEffect, useRef, useState } from 'react';
import type { Quest, ReviewPage, UnpostedBrief } from '../api/types';
import { isSafeReviewUrl } from '../lib/board';
import {
  filterReviewPagesByQuery,
  filterReviewPagesByStats,
  getAdjacentReviewPage,
  getLaterPendingBreakdown,
  getNextUnansweredHint,
  getNextUnansweredPage,
  getReviewDisplayTitle,
  getReviewListEmptyMessage,
  getReviewProgressLabel,
  getReviewProgressPercent,
  getReviewScopedSummaryText,
  getReviewSecondaryText,
  getReviewSummaryText,
  hasReviewError,
  isReviewPageIncomplete,
  sortReviewPages,
  summarizeReviewStats,
  type ReviewStatsFilter,
} from '../lib/reviewList';
import { RedoArtDialog } from './review/RedoArtDialog';
import './../styles/review.css';
import './../styles/review-redo.css';

interface ReviewViewProps {
  reviewPages?: ReviewPage[];
  selectedUrl: string | null;
  onSelectPage: (url: string | null) => void;
  // Feedback 11: the redo dialog posts an art quest bound to one review page. Optional so older callers and
  // tests keep working; the dialog degrades honestly when the snapshot has no brief list (old server).
  redoBriefs?: UnpostedBrief[];
  // Feedback 11 round 2 (F1): the board's quests, so the dialog can refuse a package id that already
  // exists (POST /api/quests upserts it and would silently rewrite that quest).
  boardQuests?: Quest[];
  projectId?: string;
  onRedoPosted?: (questId: string) => void;
}

const STATS_FILTER_OPTIONS: { value: ReviewStatsFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'available', label: '有统计' },
  { value: 'unavailable', label: '统计不可用' },
];

export function ReviewView({
  reviewPages = [],
  selectedUrl,
  onSelectPage,
  redoBriefs,
  boardQuests,
  projectId,
  onRedoPosted,
}: ReviewViewProps) {
  const [onlyUnanswered, setOnlyUnanswered] = useState(false);
  const [redoPage, setRedoPage] = useState<ReviewPage | null>(null);
  const [statsFilter, setStatsFilter] = useState<ReviewStatsFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [frameVersion, setFrameVersion] = useState(0);
  const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const redoActionRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const orderedPages = sortReviewPages(reviewPages);
  const statsFiltered = filterReviewPagesByStats(orderedPages, statsFilter);
  const searchFiltered = filterReviewPagesByQuery(statsFiltered, searchQuery);
  const filteredPages = onlyUnanswered ? searchFiltered.filter(isReviewPageIncomplete) : searchFiltered;
  const navigablePages = filteredPages.filter((page) => isSafeReviewUrl(page.url));
  const selectedPage = reviewPages.find((page) => page.url === selectedUrl);
  const isSelectedHidden = Boolean(selectedPage) && !filteredPages.some((page) => page.url === selectedUrl);
  const nextUnanswered = getNextUnansweredPage(navigablePages, selectedUrl);
  const isFilterScoped = searchQuery.trim().length > 0 || statsFilter !== 'all' || onlyUnanswered;
  // The completion claim and the "还有多少" hints must come from the whole list, never from whatever a
  // search or filter happens to leave on screen (feedback 26, R1/R2/R3) — a filter only changes what is
  // drawn, not what is actually pending.
  const fullStats = summarizeReviewStats(reviewPages);
  const fullOrderIndex = orderedPages.findIndex((page) => page.url === selectedUrl);
  const earlierPendingCount =
    fullOrderIndex < 0 ? 0 : orderedPages.slice(0, fullOrderIndex).filter(isReviewPageIncomplete).length;
  // Same whole-list rule applies forward: a pending page later in the order must not vanish into "都处理完
  // 了" just because the current search/stats/unanswered filter hides its row (feedback 26, B1).
  const laterPendingBreakdown = getLaterPendingBreakdown(orderedPages, navigablePages, selectedUrl);
  const nextUnansweredHint = getNextUnansweredHint(Boolean(nextUnanswered), fullStats.unknown, earlierPendingCount, {
    filterHiddenLaterPendingCount: laterPendingBreakdown.filterHiddenCount,
    unsafeLaterPendingCount: laterPendingBreakdown.unsafeCount,
  });
  const selectedRowAvailable = filteredPages.some((page) => page.url === selectedUrl);

  useEffect(() => {
    // Depends on booleans/strings, not on `filteredPages` itself: an SSE snapshot repaint that changes
    // none of these must not steal the reader's scroll position (feedback 26, R7). It re-fires exactly
    // when a deep-linked row's data finally arrives, when a fold/unfold remounts the row, or when a
    // filter/search stops hiding the selected row (feedback 26, R6) — not on every repaint.
    if (!selectedUrl || !selectedRowAvailable) return;
    const row = rowRefs.current.get(selectedUrl);
    row?.scrollIntoView({ block: 'nearest' });
  }, [selectedUrl, selectedRowAvailable, isSidebarOpen]);

  // Feedback 11 round 2 (M1): a project switch replaces the whole board, so a dialog opened from the
  // previous project closes instead of lingering (possibly mid-submit, with cancel disabled) over the
  // new project's list. The dialog's own stillCurrent() guard keeps the stale result from being applied.
  useEffect(() => {
    setRedoPage(null);
  }, [projectId]);

  const goToAdjacent = (direction: 'previous' | 'next') => {
    const page = getAdjacentReviewPage(navigablePages, selectedUrl, direction);
    if (page) onSelectPage(page.url);
  };

  // Explicit, on-click only — never fires on its own, so it never contradicts "do not silently reset
  // search" (feedback 26). Offered only when a filter is the actual reason a later pending page is hidden.
  const clearFilters = () => {
    setSearchQuery('');
    setStatsFilter('all');
    setOnlyUnanswered(false);
  };

  const handleListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      goToAdjacent('next');
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      goToAdjacent('previous');
    }
  };

  // L1: closing the dialog returns focus to the row action that opened it, so keyboard users are not
  // dropped to <body>.
  const closeRedo = () => {
    const openingUrl = redoPage?.url;
    setRedoPage(null);
    if (openingUrl) redoActionRefs.current.get(openingUrl)?.focus();
  };

  const renderPage = (page: ReviewPage) => {
    const progress = getReviewProgressPercent(page);
    const isSelected = page.url === selectedUrl;
    const key = `${page.url}-${page.title}`;
    const pageId = page.page ?? '';
    const content = (
      <>
        <span className="review-page-title">{getReviewDisplayTitle(page)}</span>
        <span className="review-page-secondary">{getReviewSecondaryText(page)}</span>
        <span className={hasReviewError(page) ? 'review-page-label is-unknown' : 'review-page-label'}>
          {getReviewProgressLabel(page)}
        </span>
        {progress !== null && (
          <span
            className="review-progress-track"
            role="progressbar"
            aria-label={`${getReviewDisplayTitle(page)} 批注进度`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
          >
            <span className="review-progress-fill" style={{ width: `${progress}%` }} />
          </span>
        )}
      </>
    );

    const row = isSafeReviewUrl(page.url) ? (
      <button
        ref={(node) => {
          if (node) rowRefs.current.set(page.url, node);
          else rowRefs.current.delete(page.url);
        }}
        className={isSelected ? 'review-page is-selected' : 'review-page'}
        type="button"
        role="option"
        aria-selected={isSelected}
        aria-current={isSelected ? 'page' : undefined}
        onClick={() => onSelectPage(page.url)}
      >
        {content}
      </button>
    ) : (
      <div className="review-page is-disabled" role="option" aria-selected={false} aria-disabled="true">
        {content}
      </div>
    );

    return (
      <div key={key} className="review-page-slot" role="presentation">
        {row}
        {pageId ? (
          <button
            ref={(node) => {
              if (node) redoActionRefs.current.set(page.url, node);
              else redoActionRefs.current.delete(page.url);
            }}
            className="review-redo-action"
            type="button"
            aria-label={`为 ${pageId} 发起重做委托`}
            onClick={() => setRedoPage(page)}
          >
            发起重做委托
          </button>
        ) : (
          <span className="review-redo-note">这是手写的页面，没有页面编号，没法从这里发起重做</span>
        )}
      </div>
    );
  };

  return (
    <div className={isSidebarOpen ? 'reviews-tab-view' : 'reviews-tab-view sidebar-closed'}>
      <div className="review-shell">
        {isSidebarOpen && (
          <aside className="review-sidebar" aria-label="评审页列表">
            <div className="review-sidebar-head">
              <div>
                <span className="eyebrow">评审列表</span>
                <h2>评审顺序</h2>
              </div>
              <input
                className="review-search"
                type="search"
                placeholder="搜索标题或页面 ID"
                aria-label="搜索评审页"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
              <div className="review-stats-filter" role="group" aria-label="按统计可用性筛选">
                {STATS_FILTER_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={statsFilter === option.value ? 'review-chip is-active' : 'review-chip'}
                    aria-pressed={statsFilter === option.value}
                    onClick={() => setStatsFilter(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <label className="review-filter">
                <input
                  type="checkbox"
                  checked={onlyUnanswered}
                  onChange={(event) => setOnlyUnanswered(event.target.checked)}
                />
                <span>只看未处理</span>
              </label>
            </div>
            <div className="review-sidebar-summary">
              {reviewPages.length === 0 ? '暂无评审页' : getReviewSummaryText(reviewPages)}
            </div>
            {isFilterScoped && reviewPages.length > 0 && (
              <div className="review-sidebar-scoped-summary">{getReviewScopedSummaryText(filteredPages)}</div>
            )}
            {isSelectedHidden && (
              <div className="review-sidebar-note">
                当前选中的页面不在筛选结果中，右侧仍可继续查看；调整筛选或搜索可以重新看到它。
              </div>
            )}
            <div
              className="review-page-list"
              role="listbox"
              aria-label="评审页顺序"
              onKeyDown={handleListKeyDown}
            >
              {reviewPages.length === 0 ? (
                <p className="review-list-empty">暂无评审页，页面加载后会显示在这里。</p>
              ) : filteredPages.length === 0 ? (
                <p className="review-list-empty">
                  {getReviewListEmptyMessage({
                    totalCount: reviewPages.length,
                    hasQuery: searchQuery.trim().length > 0,
                    onlyUnanswered,
                    statsFilter,
                    fullPendingCount: fullStats.pending,
                    fullUnknownCount: fullStats.unknown,
                  })}
                </p>
              ) : (
                filteredPages.map(renderPage)
              )}
            </div>
          </aside>
        )}

        <section className="review-reader" aria-label="评审阅读区">
          <div className="review-toolbar">
            <div className="review-toolbar-title">
              <span className="eyebrow">当前评审</span>
              <h2>{selectedPage ? getReviewDisplayTitle(selectedPage) : '还没有选择评审页'}</h2>
            </div>
            <div className="review-toolbar-actions">
              {selectedUrl && isSafeReviewUrl(selectedUrl) && (
                <>
                  <button
                    className="btn ghost"
                    type="button"
                    onClick={() => setFrameVersion((version) => version + 1)}
                  >
                    重新载入
                  </button>
                  <a
                    className="btn ghost"
                    href={selectedUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    新窗口打开 ↗
                  </a>
                  <div className="review-nav" aria-label="连续评审">
                    <button
                      className="btn ghost"
                      type="button"
                      onClick={() => goToAdjacent('previous')}
                      disabled={!getAdjacentReviewPage(navigablePages, selectedUrl, 'previous')}
                    >
                      ← 上一份
                    </button>
                    <button
                      className="btn ghost"
                      type="button"
                      onClick={() => onSelectPage(nextUnanswered?.url ?? null)}
                      disabled={!nextUnanswered}
                      title={nextUnansweredHint}
                    >
                      下一份未处理
                      {!nextUnanswered && <span className="review-disabled-note">{nextUnansweredHint}</span>}
                    </button>
                    {!nextUnanswered && laterPendingBreakdown.filterHiddenCount > 0 && (
                      <button className="btn ghost" type="button" onClick={clearFilters}>
                        清空筛选
                      </button>
                    )}
                    <button
                      className="btn ghost"
                      type="button"
                      onClick={() => goToAdjacent('next')}
                      disabled={!getAdjacentReviewPage(navigablePages, selectedUrl, 'next')}
                    >
                      下一份 →
                    </button>
                  </div>
                </>
              )}
              <button
                className="btn ghost review-sidebar-toggle"
                type="button"
                aria-pressed={isSidebarOpen}
                onClick={() => setIsSidebarOpen((open) => !open)}
              >
                {isSidebarOpen ? '收起列表' : '展开列表'}
              </button>
            </div>
          </div>

          {selectedUrl && isSafeReviewUrl(selectedUrl) ? (
            <div className="review-frame-wrap">
              <iframe
                key={frameVersion}
                className="review-iframe"
                src={selectedUrl}
                title={selectedPage ? getReviewDisplayTitle(selectedPage) : '美术评审页'}
              />
            </div>
          ) : (
            <div className="review-reader-empty">
              <p>先从左侧选择一份评审页。</p>
              <span>打开后，按页面内容写批注或给出判断；完成一份再继续下一份。</span>
            </div>
          )}
        </section>
      </div>
      {redoPage ? (
        <RedoArtDialog
          page={redoPage}
          briefs={redoBriefs}
          existingQuests={boardQuests}
          projectId={projectId}
          onClose={closeRedo}
          onPosted={(questId) => {
            setRedoPage(null);
            onRedoPosted?.(questId);
          }}
        />
      ) : null}
    </div>
  );
}
