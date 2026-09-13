import type { ReviewPage } from '../api/types';

export type ReviewDirection = 'previous' | 'next';

export function hasReviewError(page: ReviewPage): boolean {
  return typeof page.error === 'string' && page.error.trim().length > 0;
}

export function isReviewPageIncomplete(page: ReviewPage): boolean {
  return !hasReviewError(page) && page.answered < page.total;
}

export function getReviewProgressLabel(page: ReviewPage): string {
  return hasReviewError(page)
    ? '手工页面，没有批注统计'
    : `已批注 ${page.answered} / 共 ${page.total}`;
}

export function getReviewProgressPercent(page: ReviewPage): number | null {
  if (hasReviewError(page)) return null;
  if (page.total <= 0) return 0;
  return Math.min(100, Math.max(0, (page.answered / page.total) * 100));
}

export function sortReviewPages(pages: ReviewPage[]): ReviewPage[] {
  return pages
    .map((page, index) => ({ page, index }))
    .sort((a, b) => {
      const rankA = hasReviewError(a.page)
        ? 2
        : isReviewPageIncomplete(a.page)
          ? 0
          : 1;
      const rankB = hasReviewError(b.page)
        ? 2
        : isReviewPageIncomplete(b.page)
          ? 0
          : 1;
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
