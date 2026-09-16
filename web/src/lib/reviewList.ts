import type { ReviewPage } from '../api/types';
import { isSafeReviewUrl } from './board';

export type ReviewDirection = 'previous' | 'next';
export type ReviewStatsCategory = 'pending' | 'complete' | 'empty' | 'unknown';
export type ReviewStatsFilter = 'all' | 'available' | 'unavailable';

// The legacy backend cannot tell "no manifest on purpose" apart from "manifest present but broken" — both
// hit this exact string (src/core/snapshot.js, reviewPages()). Treat both as one honest "unknown" category
// instead of claiming either "this is a valid manual page" or "this page is broken".
export const REVIEW_NO_MANIFEST_ERROR = '手工页面，无批注统计';

const STATS_FILTER_LABELS: Record<ReviewStatsFilter, string> = {
  all: '全部',
  available: '有统计',
  unavailable: '统计不可用',
};

function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
}

// `total`/`answered` cross a JSON boundary (src/core/snapshot.js) — the TypeScript type is only a promise,
// not a guarantee. Anything that is not a finite, non-negative, ordered pair of integers is unreadable, not
// a real count, and must never be shown as one (CLAUDE.md: validate at the boundary).
function hasReadableStats(page: ReviewPage): boolean {
  const total = page.total as unknown;
  const answered = page.answered as unknown;
  return (
    isFiniteInteger(total) &&
    isFiniteInteger(answered) &&
    (answered as number) >= 0 &&
    (total as number) >= 0 &&
    (answered as number) <= (total as number)
  );
}

// A present `error` — string or not — means the backend is telling us it could not produce real stats.
// Only an empty/absent error leaves the numeric fields eligible to be trusted.
export function hasReviewError(page: ReviewPage): boolean {
  const error = page.error as unknown;
  if (error === undefined || error === null) return false;
  if (typeof error === 'string') return error.trim().length > 0;
  return true;
}

function hasKnownStats(page: ReviewPage): boolean {
  return !hasReviewError(page) && hasReadableStats(page);
}

export function isReviewPageIncomplete(page: ReviewPage): boolean {
  return hasKnownStats(page) && page.answered < page.total;
}

export function getReviewStatsCategory(page: ReviewPage): ReviewStatsCategory {
  if (!hasKnownStats(page)) return 'unknown';
  if (page.total === 0) return 'empty';
  return page.answered < page.total ? 'pending' : 'complete';
}

export function getReviewProgressLabel(page: ReviewPage): string {
  if (hasReviewError(page)) {
    // Never surface the server's raw error text verbatim: only the one known legacy string gets a
    // specific, neutral label. Anything else is an unrecognised error and gets a fixed safe message.
    return page.error === REVIEW_NO_MANIFEST_ERROR ? '统计不可用 · 仅查看页面' : '页面信息无法读取';
  }
  if (!hasReadableStats(page)) return '统计不可用';
  return `已批注 ${page.answered} / 共 ${page.total}`;
}

export function getReviewProgressPercent(page: ReviewPage): number | null {
  if (!hasKnownStats(page)) return null;
  if (page.total <= 0) return 0;
  return Math.min(100, Math.max(0, (page.answered / page.total) * 100));
}

export interface ReviewStatsSummary {
  pending: number;
  complete: number;
  empty: number;
  unknown: number;
}

export function summarizeReviewStats(pages: ReviewPage[]): ReviewStatsSummary {
  return pages.reduce<ReviewStatsSummary>(
    (acc, page) => {
      const category = getReviewStatsCategory(page);
      return { ...acc, [category]: acc[category] + 1 };
    },
    { pending: 0, complete: 0, empty: 0, unknown: 0 },
  );
}

// Only claims "都处理完了" when every known page is complete AND nothing has unreadable stats AND nothing
// is a zero-section manifest — a page with unreadable stats or no sections at all might still need a human
// to look at it, so neither may be silently folded into "done". Always pass the whole list here, never a
// filtered/searched subset: a narrowed view must describe itself (see getReviewScopedSummaryText), not
// stand in for the real completion state.
export function getReviewSummaryText(pages: ReviewPage[]): string {
  if (pages.length === 0) return '没有符合条件的评审页';
  const { pending, complete, empty, unknown } = summarizeReviewStats(pages);
  if (pending === 0 && empty === 0 && unknown === 0) return '都处理完了';
  const parts: string[] = [];
  if (pending > 0) parts.push(`${pending} 份未处理`);
  if (complete > 0) parts.push(`${complete} 份已完成`);
  if (empty > 0) parts.push(`${empty} 份无批注项`);
  if (unknown > 0) parts.push(`${unknown} 份统计不可用`);
  return parts.join(' · ');
}

// A search or stats filter narrows what is on screen; describe that subset as counts, never as a
// completion claim ("都处理完了") — the pages it hides may still be pending or unknown.
export function getReviewScopedSummaryText(scopedPages: ReviewPage[]): string {
  const { pending, complete, empty, unknown } = summarizeReviewStats(scopedPages);
  const parts: string[] = [];
  if (pending > 0) parts.push(`${pending} 份未处理`);
  if (complete > 0) parts.push(`${complete} 份已完成`);
  if (empty > 0) parts.push(`${empty} 份无批注项`);
  if (unknown > 0) parts.push(`${unknown} 份统计不可用`);
  return `筛选结果：${parts.join(' · ') || '共 0 份'}`;
}

export function getReviewListEmptyMessage(params: {
  totalCount: number;
  hasQuery: boolean;
  onlyUnanswered: boolean;
  statsFilter: ReviewStatsFilter;
  fullPendingCount: number;
  fullUnknownCount: number;
}): string {
  const { totalCount, hasQuery, onlyUnanswered, statsFilter, fullPendingCount, fullUnknownCount } = params;
  if (totalCount === 0) return '暂无评审页，页面加载后会显示在这里。';
  if (hasQuery) return '没有找到匹配的评审页，换个关键词或清空搜索试试。';
  if (onlyUnanswered) {
    // The stats filter (not just the unanswered toggle) can be what is hiding a genuinely pending page —
    // count from the whole list, not the already-filtered view, or "cleared" becomes a false claim.
    if (fullPendingCount > 0) {
      return statsFilter === 'all'
        ? '还有未处理的页面没有确认。'
        : `“${STATS_FILTER_LABELS[statsFilter]}”筛选把一些页面排除在外了，其中还有未处理的页面没有确认，取消筛选即可看到。`;
    }
    if (fullUnknownCount > 0) return '未处理的页面都清空了，但还有统计不可用的页面没有确认。';
    return '都处理完了，可以取消筛选查看全部页面。';
  }
  return '没有符合筛选条件的评审页。';
}

export interface NextUnansweredHiddenCounts {
  // Later in the whole ordered list, URL-safe, but excluded by the active search/stats/unanswered filter —
  // the exact false-completion case feedback 26 flagged (B1): "下一份未处理" must not claim 都处理完了 just
  // because a filter hid the next pending row.
  filterHiddenLaterPendingCount?: number;
  // Later in the whole ordered list and pending, but its URL fails isSafeReviewUrl — this button can never
  // navigate to it regardless of filters, so it needs its own distinct wording, not folded into "hidden by
  // a filter you can clear" nor into "done".
  unsafeLaterPendingCount?: number;
}

export function getNextUnansweredHint(
  hasNext: boolean,
  unresolvedUnknownCount: number,
  earlierPendingCount: number = 0,
  hidden: NextUnansweredHiddenCounts = {},
): string {
  if (hasNext) return '跳到下一份未处理页面';
  const { filterHiddenLaterPendingCount = 0, unsafeLaterPendingCount = 0 } = hidden;
  if (filterHiddenLaterPendingCount > 0) {
    return `筛选隐藏了后面 ${filterHiddenLaterPendingCount} 份未处理，清空筛选即可看到`;
  }
  if (earlierPendingCount > 0) return `后面没有未处理的了，前面还有 ${earlierPendingCount} 份未处理`;
  if (unsafeLaterPendingCount > 0) {
    return `后面还有 ${unsafeLaterPendingCount} 份未处理页面无法安全打开`;
  }
  return unresolvedUnknownCount > 0
    ? '已知的都处理完了，但还有统计不可用的页面'
    : '都处理完了';
}

export interface LaterPendingBreakdown {
  filterHiddenCount: number;
  unsafeCount: number;
}

// "Later" always means after the selection in the whole ordered list, never in a filtered/searched view —
// a narrowed view only changes what is drawn (feedback 26, R1/R2/R3/B1). `navigablePages` is whatever the
// current search/stats/unanswered filter plus the safety check actually leaves selectable; a pending page
// missing from it is either hidden by that filter (safe, just not shown — offer to clear it) or permanently
// unsafe (never becomes reachable no matter what filter is active).
export function getLaterPendingBreakdown(
  orderedPages: ReviewPage[],
  navigablePages: ReviewPage[],
  selectedUrl: string | null,
): LaterPendingBreakdown {
  const selectedIndex = orderedPages.findIndex((page) => page.url === selectedUrl);
  if (selectedIndex < 0) return { filterHiddenCount: 0, unsafeCount: 0 };
  const navigableUrls = new Set(navigablePages.map((page) => page.url));
  return orderedPages
    .slice(selectedIndex + 1)
    .filter(isReviewPageIncomplete)
    .reduce<LaterPendingBreakdown>(
      (acc, page) => {
        if (!isSafeReviewUrl(page.url)) return { ...acc, unsafeCount: acc.unsafeCount + 1 };
        if (!navigableUrls.has(page.url)) return { ...acc, filterHiddenCount: acc.filterHiddenCount + 1 };
        return acc;
      },
      { filterHiddenCount: 0, unsafeCount: 0 },
    );
}

function toRelativePath(url: string): string {
  return url.startsWith('/review/') ? url.slice('/review/'.length) : url;
}

function pathSegments(url: string): string[] {
  return toRelativePath(url).split('/').filter(Boolean);
}

function stripKnownExtension(name: string): string {
  return name.replace(/\.(html?|htm)$/i, '');
}

// Legacy/unknown-stats pages carry their raw relative file path as `title` (snapshot.js sets
// `title: relative` when there is no manifest). Showing that raw path as-is is noisy, so fall back to the
// page id, then a cleaned-up URL basename, rather than ever reading the filesystem ourselves.
export function getReviewDisplayTitle(page: ReviewPage): string {
  const rawPath = toRelativePath(page.url);
  const title = page.title?.trim();
  if (title && title !== rawPath) return title;
  if (page.page && page.page.trim()) return page.page.trim();
  const segments = pathSegments(page.url);
  const base = segments[segments.length - 1] ?? '';
  const cleaned = stripKnownExtension(base);
  return cleaned || base || title || '未命名页面';
}

// Two pages with the same filename in different folders end up with the same display title above; this
// secondary line (folder + id) is what actually tells them apart.
export function getReviewSecondaryText(page: ReviewPage): string {
  const segments = pathSegments(page.url);
  segments.pop();
  const folder = segments.join('/');
  const displayTitle = getReviewDisplayTitle(page);
  const id = page.page && page.page.trim() && page.page.trim() !== displayTitle ? page.page.trim() : null;
  const parts = [folder || '根目录'];
  if (id) parts.push(`ID ${id}`);
  return parts.join(' · ');
}

export function matchesReviewQuery(page: ReviewPage, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [getReviewDisplayTitle(page), getReviewSecondaryText(page), page.title, page.page ?? '']
    .join(' ')
    .toLowerCase();
  return haystack.includes(q);
}

export function filterReviewPagesByQuery(pages: ReviewPage[], query: string): ReviewPage[] {
  return pages.filter((page) => matchesReviewQuery(page, query));
}

export function filterReviewPagesByStats(pages: ReviewPage[], filter: ReviewStatsFilter): ReviewPage[] {
  if (filter === 'all') return pages;
  return pages.filter((page) => (filter === 'available' ? !hasReviewError(page) : hasReviewError(page)));
}

export function sortReviewPages(pages: ReviewPage[]): ReviewPage[] {
  const rank: Record<ReviewStatsCategory, number> = { pending: 0, complete: 1, empty: 2, unknown: 3 };
  return pages
    .map((page, index) => ({ page, index }))
    .sort((a, b) => {
      const rankA = rank[getReviewStatsCategory(a.page)];
      const rankB = rank[getReviewStatsCategory(b.page)];
      return rankA - rankB || a.index - b.index;
    })
    .map(({ page }) => page);
}

export function getAdjacentReviewPage(
  pages: ReviewPage[],
  currentUrl: string | null,
  direction: ReviewDirection,
): ReviewPage | undefined {
  if (pages.length === 0) return undefined;

  const currentIndex = pages.findIndex((page) => page.url === currentUrl);
  if (currentIndex < 0) return direction === 'next' ? pages[0] : pages[pages.length - 1];

  const offset = direction === 'next' ? 1 : -1;
  const targetIndex = currentIndex + offset;
  return targetIndex >= 0 && targetIndex < pages.length
    ? pages[targetIndex]
    : undefined;
}

export function getNextUnansweredPage(
  pages: ReviewPage[],
  currentUrl: string | null,
): ReviewPage | undefined {
  const currentIndex = pages.findIndex((page) => page.url === currentUrl);
  const startIndex = currentIndex < 0 ? 0 : currentIndex + 1;
  return pages.slice(startIndex).find(isReviewPageIncomplete);
}
