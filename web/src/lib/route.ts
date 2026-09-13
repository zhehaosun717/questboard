import { isSafeReviewUrl } from './board';

export type Tab =
  | 'board'
  | 'graph'
  | 'threads'
  | 'review'
  | 'history'
  | 'roster'
  | 'usage'
  | 'settings';

export interface ParsedRoute {
  tab: Tab;
  threadId: string | null;
  reviewUrl: string | null;
}

export type Route = ParsedRoute;

export function parseRoute(hash: string): ParsedRoute {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw || raw === '/' || raw === '/board') {
    return { tab: 'board', threadId: null, reviewUrl: null };
  }

  const qIndex = raw.indexOf('?');
  const path = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
  const search = qIndex >= 0 ? raw.slice(qIndex) : '';

  if (path === '/graph') {
    return { tab: 'graph', threadId: null, reviewUrl: null };
  }

  if (path === '/history') {
    return { tab: 'history', threadId: null, reviewUrl: null };
  }

  if (path === '/roster') {
    return { tab: 'roster', threadId: null, reviewUrl: null };
  }

  if (path === '/usage') {
    return { tab: 'usage', threadId: null, reviewUrl: null };
  }

  if (path === '/settings') {
    return { tab: 'settings', threadId: null, reviewUrl: null };
  }

  if (path === '/threads') {
    return { tab: 'threads', threadId: null, reviewUrl: null };
  }

  if (path.startsWith('/threads/')) {
    const rawId = path.slice('/threads/'.length);
    if (!rawId) {
      return { tab: 'threads', threadId: null, reviewUrl: null };
    }
    let threadId: string | null = null;
    try {
      threadId = decodeURIComponent(rawId);
    } catch {
      threadId = rawId;
    }
    return { tab: 'threads', threadId, reviewUrl: null };
  }

  if (path === '/review') {
    let reviewUrl: string | null = null;
    if (search) {
      const params = new URLSearchParams(search);
      const page = params.get('page');
      if (page && isSafeReviewUrl(page)) {
        reviewUrl = page;
      }
    }
    return { tab: 'review', threadId: null, reviewUrl };
  }

  return { tab: 'board', threadId: null, reviewUrl: null };
}

export function formatRoute(route: {
  tab: Tab;
  threadId?: string | null;
  reviewUrl?: string | null;
}): string {
  switch (route.tab) {
    case 'graph':
      return '#/graph';
    case 'threads':
      return route.threadId
        ? `#/threads/${encodeURIComponent(route.threadId)}`
        : '#/threads';
    case 'review':
      return route.reviewUrl
        ? `#/review?page=${encodeURIComponent(route.reviewUrl)}`
        : '#/review';
    case 'history':
      return '#/history';
    case 'roster':
      return '#/roster';
    case 'usage':
      return '#/usage';
    case 'settings':
      return '#/settings';
    case 'board':
    default:
      return '#/';
  }
}
