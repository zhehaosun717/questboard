import { describe, expect, it } from 'vitest';
import { formatRoute, parseRoute, type Tab } from './route';

describe('route parsing and formatting', () => {
  it('parses and formats back every route', () => {
    const cases: Array<{
      route: { tab: Tab; threadId?: string | null; reviewUrl?: string | null };
      expectedHash: string;
    }> = [
      { route: { tab: 'board' }, expectedHash: '#/' },
      { route: { tab: 'graph' }, expectedHash: '#/graph' },
      { route: { tab: 'threads' }, expectedHash: '#/threads' },
      {
        route: { tab: 'threads', threadId: 'test-thread-1' },
        expectedHash: '#/threads/test-thread-1',
      },
      { route: { tab: 'review' }, expectedHash: '#/review' },
      {
        route: { tab: 'review', reviewUrl: '/review/chapter1.html' },
        expectedHash: '#/review?page=%2Freview%2Fchapter1.html',
      },
      { route: { tab: 'history' }, expectedHash: '#/history' },
      { route: { tab: 'roster' }, expectedHash: '#/roster' },
      { route: { tab: 'usage' }, expectedHash: '#/usage' },
      { route: { tab: 'settings' }, expectedHash: '#/settings' },
    ];

    for (const c of cases) {
      const formatted = formatRoute(c.route);
      expect(formatted).toBe(c.expectedHash);

      const parsed = parseRoute(formatted);
      expect(parsed.tab).toBe(c.route.tab);
      expect(parsed.threadId).toBe(c.route.threadId ?? null);
      expect(parsed.reviewUrl).toBe(c.route.reviewUrl ?? null);
    }
  });

  it('handles empty and root hashes as board', () => {
    expect(parseRoute('')).toEqual({ tab: 'board', threadId: null, reviewUrl: null });
    expect(parseRoute('#')).toEqual({ tab: 'board', threadId: null, reviewUrl: null });
    expect(parseRoute('#/')).toEqual({ tab: 'board', threadId: null, reviewUrl: null });
    expect(parseRoute('#/board')).toEqual({ tab: 'board', threadId: null, reviewUrl: null });
  });

  it('routes unknown hashes to board', () => {
    expect(parseRoute('#/unknown')).toEqual({ tab: 'board', threadId: null, reviewUrl: null });
    expect(parseRoute('#/something/else/entirely')).toEqual({
      tab: 'board',
      threadId: null,
      reviewUrl: null,
    });
  });

  it('decodes encoded thread ids', () => {
    const rawHash = '#/threads/%E6%B5%8B%E8%AF%95%E4%B8%BB%E9%A2%98';
    const parsed = parseRoute(rawHash);
    expect(parsed.tab).toBe('threads');
    expect(parsed.threadId).toBe('测试主题');

    const withSlash = '#/threads/quest%2F101';
    expect(parseRoute(withSlash).threadId).toBe('quest/101');
  });

  it('turns unsafe review URLs into null', () => {
    const external = '#/review?page=https%3A%2F%2Fevil.com';
    expect(parseRoute(external)).toEqual({ tab: 'review', threadId: null, reviewUrl: null });

    const traversal = '#/review?page=%2Freview%2F..%2Fsecret.txt';
    expect(parseRoute(traversal)).toEqual({ tab: 'review', threadId: null, reviewUrl: null });

    const backslash = '#/review?page=%2Freview%2F..%5Cwindows';
    expect(parseRoute(backslash)).toEqual({ tab: 'review', threadId: null, reviewUrl: null });
  });
});
