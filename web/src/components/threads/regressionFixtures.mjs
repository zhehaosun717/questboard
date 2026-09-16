// In-memory thread fixtures and request classification shared by threadsAsyncRegression.browser.mjs's
// intercepted `/api` routes — kept separate so the scenario file stays under the file-size limit.
export function thread(id, title, extra = {}) {
  return {
    id, title, tags: [], author: 'fixture', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    pinned: false, closed: false, messageCount: 1, lastMessageAt: '2026-09-01T00:00:00Z', trashed: false, ...extra,
  };
}

export function fixtures() {
  return {
    A: [
      thread('a1', 'A-一号'), thread('a2', 'A-二号'), thread('a3', 'A-三号'),
      thread('a4', 'A-四号关', { closed: true }),
      thread('a9', 'A-回收号', { trashed: true }), thread('a8', 'A-回收二号', { trashed: true }),
      thread('same', 'A-同号ID'),
    ],
    B: [thread('b1', 'B-一号'), thread('b2', 'B-二号'), thread('same', 'B-同号ID')],
  };
}

// `noId` mirrors an older server snapshot with no `project.id` field (X14): the reader must fall back to
// showing the routed thread rather than assuming a project digest that predates it.
export function snapshot(project, noId = false) {
  return {
    generatedAt: new Date().toISOString(),
    project: noId ? { name: `项目${project}`, lanes: [] } : { name: `项目${project}`, id: `proj-${project}`, lanes: [] },
    quests: [], roster: [], eligibility: {}, reviewEligibility: {}, env: { treeLocked: false }, live: {},
    threads: {}, reviewPages: [], unpostedBriefs: [], verification: null, laneLimits: {}, openQuestions: 0,
  };
}

export const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

export function classify(method, p) {
  if (p === '/api/quests') return 'snapshot';
  if (p === '/api/quests/stream') return 'stream';
  if (method === 'GET' && p === '/api/threads') return 'list';
  if (method === 'POST' && p === '/api/threads/bulk') return 'bulk';
  if (method === 'POST' && p === '/api/threads') return 'create';
  if (method === 'GET' && /^\/api\/threads\/[^/]+$/.test(p)) return 'detail';
  if (method === 'POST' && /\/messages$/.test(p)) return 'reply';
  if (method === 'POST' && /\/pin$/.test(p)) return 'pin';
  if (method === 'POST' && /\/close$/.test(p)) return 'close';
  return method === 'POST' ? 'unexpected-post' : 'other';
}
