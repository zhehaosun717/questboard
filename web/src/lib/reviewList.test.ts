import { describe, expect, it } from 'vitest';
import type { ReviewPage } from '../api/types';
import {
  getAdjacentReviewPage,
  getNextUnansweredPage,
  getReviewProgressLabel,
  getReviewProgressPercent,
  isReviewPageIncomplete,
  sortReviewPages,
} from './reviewList';

const page = (url: string, answered: number, total: number, error?: string): ReviewPage => ({
  page: error ? null : url,
  title: url,
  url,
  total,
  answered,
  ...(error ? { error } : {}),
});

describe('review list logic', () => {
  it('puts unfinished pages first while preserving order within each group', () => {
    const pages = [page('done', 2, 2), page('first', 0, 2), page('second', 1, 3)];

    expect(sortReviewPages(pages).map((item) => item.url)).toEqual(['first', 'second', 'done']);
  });

  it('keeps manual pages out of progress statistics', () => {
    const manual = page('manual', 0, 0, 'no annotation stats');

    expect(isReviewPageIncomplete(manual)).toBe(false);
    expect(getReviewProgressLabel(manual)).toBe('手工页面，没有批注统计');
    expect(getReviewProgressPercent(manual)).toBeNull();
  });

  it('finds the next unanswered page and returns none when there is no later one', () => {
    const pages = [
      page('a', 0, 1),
      page('manual', 0, 0, 'no annotation stats'),
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
});
