import { describe, expect, it } from 'vitest';
import type { ReviewPage } from '../api/types';
import {
  REVIEW_NO_MANIFEST_ERROR,
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
  getReviewStatsCategory,
  getReviewSummaryText,
  hasReviewError,
  isReviewPageIncomplete,
  matchesReviewQuery,
  sortReviewPages,
  summarizeReviewStats,
} from './reviewList';

const page = (url: string, answered: number, total: number, error?: string): ReviewPage => ({
  page: error ? null : url,
  title: url,
  url,
  total,
  answered,
  ...(error ? { error } : {}),
});

const manifestPage = (opts: {
  path: string;
  id: string;
  title: string;
  answered: number;
  total: number;
}): ReviewPage => ({
  page: opts.id,
  title: opts.title,
  url: `/review/${opts.path}`,
  total: opts.total,
  answered: opts.answered,
});

const legacyPage = (path: string): ReviewPage => ({
  page: null,
  title: path,
  url: `/review/${path}`,
  total: 0,
  answered: 0,
  error: REVIEW_NO_MANIFEST_ERROR,
});

describe('review list logic', () => {
  it('puts unfinished pages first while preserving order within each group', () => {
    const pages = [page('done', 2, 2), page('first', 0, 2), page('second', 1, 3)];

    expect(sortReviewPages(pages).map((item) => item.url)).toEqual(['first', 'second', 'done']);
  });

  it('keeps manual/unknown pages out of progress statistics without claiming they are a valid manual page', () => {
    const manual = page('manual', 0, 0, REVIEW_NO_MANIFEST_ERROR);

    expect(isReviewPageIncomplete(manual)).toBe(false);
    expect(getReviewProgressLabel(manual)).toBe('统计不可用 · 仅查看页面');
    expect(getReviewProgressLabel(manual)).not.toContain('手工页面');
    expect(getReviewProgressPercent(manual)).toBeNull();
  });

  it('never shows the server error text verbatim for an unrecognised error', () => {
    const broken = page('broken', 0, 0, 'ENOENT: no such file or directory, open C:/secret/path');
    expect(getReviewProgressLabel(broken)).toBe('页面信息无法读取');
    expect(getReviewProgressLabel(broken)).not.toContain('ENOENT');
    expect(getReviewProgressLabel(broken)).not.toContain('secret');
    expect(isReviewPageIncomplete(broken)).toBe(false);
    expect(getReviewProgressPercent(broken)).toBeNull();
  });

  it('never fabricates 100% for a zero-total manifest', () => {
    expect(getReviewProgressPercent(page('empty', 0, 0))).toBe(0);
  });

  it('finds the next unanswered page and returns none when there is no later one', () => {
    const pages = [
      page('a', 0, 1),
      page('manual', 0, 0, REVIEW_NO_MANIFEST_ERROR),
      page('b', 1, 1),
      page('c', 0, 2),
    ];

    expect(getNextUnansweredPage(pages, 'a')?.url).toBe('c');
    expect(getNextUnansweredPage(pages, 'c')).toBeUndefined();
  });

  it('handles adjacent navigation boundaries', () => {
    const pages = [page('a', 0, 1), page('b', 1, 1)];

    expect(getAdjacentReviewPage(pages, 'a', 'previous')).toBeUndefined();
    expect(getAdjacentReviewPage(pages, 'b', 'next')).toBeUndefined();
    expect(getAdjacentReviewPage(pages, 'a', 'next')?.url).toBe('b');
  });

  describe('summarizeReviewStats / getReviewSummaryText', () => {
    it('separates known-pending, known-complete and unknown buckets', () => {
      const pages = [page('a', 0, 2), page('b', 2, 2), page('c', 0, 0, REVIEW_NO_MANIFEST_ERROR)];
      expect(summarizeReviewStats(pages)).toEqual({ pending: 1, complete: 1, empty: 0, unknown: 1 });
      expect(getReviewSummaryText(pages)).toBe('1 份未处理 · 1 份已完成 · 1 份统计不可用');
    });

    it('says 都处理完了 only when nothing is pending and nothing is unknown', () => {
      const allDone = [page('a', 2, 2), page('b', 1, 1)];
      expect(getReviewSummaryText(allDone)).toBe('都处理完了');

      const doneWithUnknown = [page('a', 2, 2), page('b', 0, 0, REVIEW_NO_MANIFEST_ERROR)];
      expect(getReviewSummaryText(doneWithUnknown)).not.toBe('都处理完了');
    });

    it('does not claim 暂无评审页 for an empty filtered result', () => {
      expect(getReviewSummaryText([])).toBe('没有符合条件的评审页');
    });

    it('R5: a zero-section manifest is a neutral 无批注项, never 都处理完了', () => {
      const zeroA = page('a', 0, 0);
      const zeroOnly = [zeroA, page('b', 0, 0)];
      expect(getReviewStatsCategory(zeroA)).toBe('empty');
      expect(summarizeReviewStats(zeroOnly)).toEqual({ pending: 0, complete: 0, empty: 2, unknown: 0 });
      expect(getReviewSummaryText(zeroOnly)).not.toBe('都处理完了');
      expect(getReviewSummaryText(zeroOnly)).toContain('无批注项');
    });

    it('R1: getReviewSummaryText must be given the whole list, not a search/filter subset, or completion is a false claim', () => {
      const full = [page('done', 2, 2), page('todo', 0, 1), page('manual', 0, 0, REVIEW_NO_MANIFEST_ERROR)];
      // A caller that (incorrectly) passes only the subset a search happens to match would see this:
      const searchSubset = full.filter((p) => p.url === 'done');
      expect(getReviewSummaryText(searchSubset)).toBe('都处理完了');
      // ...which is exactly why callers must always pass the whole list instead:
      expect(getReviewSummaryText(full)).not.toBe('都处理完了');
    });

    it('R1: getReviewScopedSummaryText describes a subset as counts, never as a completion claim', () => {
      const scoped = [page('done', 2, 2)];
      const text = getReviewScopedSummaryText(scoped);
      expect(text).not.toContain('都处理完了');
      expect(text).toBe('筛选结果：1 份已完成');
      expect(getReviewScopedSummaryText([])).toBe('筛选结果：共 0 份');
    });
  });

  describe('getReviewListEmptyMessage', () => {
    it('a genuinely empty board gets its own message', () => {
      const msg = getReviewListEmptyMessage({
        totalCount: 0,
        hasQuery: false,
        onlyUnanswered: false,
        statsFilter: 'all',
        fullPendingCount: 0,
        fullUnknownCount: 0,
      });
      expect(msg).toContain('暂无评审页');
    });

    it('search-no-match never claims everything is reviewed', () => {
      const msg = getReviewListEmptyMessage({
        totalCount: 5,
        hasQuery: true,
        onlyUnanswered: false,
        statsFilter: 'all',
        fullPendingCount: 0,
        fullUnknownCount: 0,
      });
      expect(msg).not.toContain('都处理完了');
      expect(msg).toContain('没有找到匹配');
    });

    it('search-no-match wins even while the unanswered-only toggle is on', () => {
      const msg = getReviewListEmptyMessage({
        totalCount: 5,
        hasQuery: true,
        onlyUnanswered: true,
        statsFilter: 'all',
        fullPendingCount: 0,
        fullUnknownCount: 2,
      });
      expect(msg).not.toContain('都处理完了');
    });

    it('unanswered-only with nothing pending and no unknown pages says 都处理完了', () => {
      const msg = getReviewListEmptyMessage({
        totalCount: 5,
        hasQuery: false,
        onlyUnanswered: true,
        statsFilter: 'all',
        fullPendingCount: 0,
        fullUnknownCount: 0,
      });
      expect(msg).toContain('都处理完了');
    });

    it('unanswered-only with nothing pending but unknown pages still around does not claim completion', () => {
      const msg = getReviewListEmptyMessage({
        totalCount: 5,
        hasQuery: false,
        onlyUnanswered: true,
        statsFilter: 'all',
        fullPendingCount: 0,
        fullUnknownCount: 3,
      });
      expect(msg).not.toContain('都处理完了');
      expect(msg).toContain('统计不可用');
    });

    it('R2: a stats filter that hides a genuinely pending page must not claim everything is cleared', () => {
      const msg = getReviewListEmptyMessage({
        totalCount: 5,
        hasQuery: false,
        onlyUnanswered: true,
        statsFilter: 'unavailable',
        fullPendingCount: 1,
        fullUnknownCount: 1,
      });
      expect(msg).not.toContain('都处理完了');
      expect(msg).not.toContain('都清空');
      expect(msg).toContain('统计不可用');
    });
  });

  describe('getNextUnansweredHint', () => {
    it('does not claim unknown pages are done when only the known-pending queue is empty', () => {
      expect(getNextUnansweredHint(false, 2)).not.toBe('都处理完了');
      expect(getNextUnansweredHint(false, 0)).toBe('都处理完了');
      expect(getNextUnansweredHint(true, 2)).toBe('跳到下一份未处理页面');
    });

    it('R3: does not claim 都处理完了 when an earlier page in the list is still pending', () => {
      const hint = getNextUnansweredHint(false, 0, 1);
      expect(hint).not.toBe('都处理完了');
      expect(hint).toContain('前面还有');
    });

    it('B1: names a later page hidden by the current filter instead of claiming 都处理完了', () => {
      const hint = getNextUnansweredHint(false, 0, 0, { filterHiddenLaterPendingCount: 2 });
      expect(hint).not.toBe('都处理完了');
      expect(hint).not.toContain('前面还有');
      expect(hint).toContain('筛选隐藏了后面 2 份未处理');
    });

    it('B1: a filter-hidden later pending page outranks an earlier-pending message', () => {
      const hint = getNextUnansweredHint(false, 0, 1, { filterHiddenLaterPendingCount: 1 });
      expect(hint).toContain('筛选隐藏了后面');
      expect(hint).not.toContain('前面还有');
    });

    it('B1: names an unsafe later pending page distinctly from done and from filter-hidden', () => {
      const hint = getNextUnansweredHint(false, 0, 0, { unsafeLaterPendingCount: 1 });
      expect(hint).not.toBe('都处理完了');
      expect(hint).not.toContain('筛选隐藏了');
      expect(hint).toContain('无法安全打开');
    });
  });

  describe('getLaterPendingBreakdown', () => {
    it('B1: counts a later pending page hidden by a search/filter as filterHiddenCount, not unsafeCount', () => {
      const a = manifestPage({ path: 't/a.html', id: 'ta', title: '待处理A', answered: 0, total: 1 });
      const b = manifestPage({ path: 't/b.html', id: 'tb', title: '待处理B', answered: 0, total: 1 });
      const c = manifestPage({ path: 't/c.html', id: 'tc', title: '已完成C', answered: 1, total: 1 });
      const orderedPages = [a, b, c];
      // A search for "待处理A" narrows the navigable list down to just `a` — `b` is safe, pending, later,
      // and hidden by the filter, not gone.
      const navigablePages = [a];
      expect(getLaterPendingBreakdown(orderedPages, navigablePages, a.url)).toEqual({
        filterHiddenCount: 1,
        unsafeCount: 0,
      });
    });

    it('counts a later pending page with an unsafe URL as unsafeCount even with no filter active', () => {
      const a = manifestPage({ path: 't/a.html', id: 'ta', title: '待处理A', answered: 0, total: 1 });
      const unsafe: ReviewPage = { page: 'tx', title: '待处理X', url: '/review/../x.html', total: 1, answered: 0 };
      const orderedPages = [a, unsafe];
      const navigablePages = [a];
      expect(getLaterPendingBreakdown(orderedPages, navigablePages, a.url)).toEqual({
        filterHiddenCount: 0,
        unsafeCount: 1,
      });
    });

    it('returns zero counts when nothing later is pending or when nothing is selected', () => {
      const a = manifestPage({ path: 't/a.html', id: 'ta', title: '待处理A', answered: 0, total: 1 });
      const done = manifestPage({ path: 't/b.html', id: 'tb', title: '已完成B', answered: 1, total: 1 });
      const orderedPages = [a, done];
      expect(getLaterPendingBreakdown(orderedPages, [a, done], a.url)).toEqual({
        filterHiddenCount: 0,
        unsafeCount: 0,
      });
      expect(getLaterPendingBreakdown(orderedPages, [a, done], null)).toEqual({
        filterHiddenCount: 0,
        unsafeCount: 0,
      });
    });

    it('never counts a page earlier than the selection, even if hidden by a filter', () => {
      const earlier = manifestPage({ path: 't/a.html', id: 'ta', title: '待处理A', answered: 0, total: 1 });
      const selected = manifestPage({ path: 't/b.html', id: 'tb', title: '待处理B', answered: 0, total: 1 });
      const orderedPages = [earlier, selected];
      // Only `selected` is navigable — `earlier` is hidden by the filter, but it is not "later".
      expect(getLaterPendingBreakdown(orderedPages, [selected], selected.url)).toEqual({
        filterHiddenCount: 0,
        unsafeCount: 0,
      });
    });
  });

  describe('display title / secondary text (duplicate filenames across folders)', () => {
    it('prefers the manifest title for a generated page', () => {
      const p = manifestPage({ path: 'art/charA/final.html', id: 'p1', title: '角色A 最终稿', answered: 1, total: 2 });
      expect(getReviewDisplayTitle(p)).toBe('角色A 最终稿');
      expect(getReviewSecondaryText(p)).toContain('art/charA');
    });

    it('falls back to a cleaned URL basename for a legacy/unknown page whose title is just the raw path', () => {
      const p = legacyPage('art/charA/final.html');
      expect(getReviewDisplayTitle(p)).toBe('final');
      expect(getReviewSecondaryText(p)).toContain('art/charA');
    });

    it('keeps duplicate filenames in different folders distinguishable via the secondary line', () => {
      const a = legacyPage('art/charA/final.html');
      const b = legacyPage('art/charB/final.html');
      expect(getReviewDisplayTitle(a)).toBe(getReviewDisplayTitle(b));
      expect(getReviewSecondaryText(a)).not.toBe(getReviewSecondaryText(b));
    });

    it('labels a root-level page instead of leaving the secondary line blank', () => {
      const p = legacyPage('final.html');
      expect(getReviewSecondaryText(p)).toContain('根目录');
    });
  });

  describe('search / stats filter', () => {
    const charA = manifestPage({ path: 'art/charA/final.html', id: 'p1', title: '角色A 最终稿', answered: 1, total: 2 });
    const charB = manifestPage({ path: 'art/charB/final.html', id: 'p2', title: '角色B 立绘', answered: 2, total: 2 });
    const handoff = legacyPage('notes/handoff.html');
    const pages = [charA, charB, handoff];

    it('matches case-insensitively on title', () => {
      expect(matchesReviewQuery(charA, '角色a')).toBe(true);
      expect(matchesReviewQuery(charA, 'ZZZ_NO_SUCH_PAGE')).toBe(false);
    });

    it('matches on page id', () => {
      expect(matchesReviewQuery(charB, 'p2')).toBe(true);
      expect(matchesReviewQuery(charA, 'p2')).toBe(false);
    });

    it('matches on folder text so duplicate filenames can still be told apart by query', () => {
      expect(filterReviewPagesByQuery(pages, 'charb').map((p) => p.page)).toEqual(['p2']);
    });

    it('filters by statistics availability', () => {
      expect(filterReviewPagesByStats(pages, 'available').map((p) => p.page)).toEqual(['p1', 'p2']);
      expect(filterReviewPagesByStats(pages, 'unavailable').map((p) => p.url)).toEqual(['/review/notes/handoff.html']);
      expect(filterReviewPagesByStats(pages, 'all')).toHaveLength(3);
    });
  });

  describe('R4: malformed statistics never count as real, complete, or navigable', () => {
    const malformed = {
      negativeTotal: { page: 'neg', title: '负数统计', url: '/review/m/neg.html', total: -3, answered: 0 } as ReviewPage,
      overAnswered: { page: 'over', title: '超出统计', url: '/review/m/over.html', total: 2, answered: 7 } as ReviewPage,
      stringStats: {
        page: 'str',
        title: '字符串统计',
        url: '/review/m/str.html',
        total: '5' as unknown as number,
        answered: '1' as unknown as number,
      } as ReviewPage,
      nullStats: {
        page: 'nul',
        title: '空统计',
        url: '/review/m/nul.html',
        total: null as unknown as number,
        answered: null as unknown as number,
      } as ReviewPage,
      nonStringError: {
        page: 'errnum',
        title: '非字符串错误',
        url: '/review/m/errnum.html',
        total: 0,
        answered: 0,
        error: 42 as unknown as string,
      } as ReviewPage,
    };

    it.each(Object.entries(malformed))('%s is unknown, incomplete, and shown with no fabricated progress', (_name, p) => {
      expect(getReviewStatsCategory(p)).toBe('unknown');
      expect(isReviewPageIncomplete(p)).toBe(false);
      expect(getReviewProgressPercent(p)).toBeNull();
      expect(getReviewProgressLabel(p)).not.toMatch(/^已批注/);
    });

    it('a non-empty non-string error is treated as an error, even though it is not a string', () => {
      expect(hasReviewError(malformed.nonStringError)).toBe(true);
      expect(getReviewProgressLabel(malformed.nonStringError)).toBe('页面信息无法读取');
    });

    it('malformed stats never inflate the whole-list summary into 都处理完了', () => {
      const pages = Object.values(malformed);
      expect(getReviewSummaryText(pages)).not.toContain('都处理完了');
      expect(getReviewSummaryText(pages)).not.toContain('已完成');
      expect(getReviewSummaryText(pages)).toContain('统计不可用');
    });

    it('a malformed page never becomes the "next unanswered" target', () => {
      const good = page('ok', 0, 1);
      expect(getNextUnansweredPage([good, malformed.negativeTotal], 'ok')).toBeUndefined();
    });
  });
});
