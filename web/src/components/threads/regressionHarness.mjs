// Shared Playwright interception harness for the thread-view browser regressions
// (threadsAsyncRegression.browser.mjs and threadsAsyncRegressionGaps.browser.mjs) — split out so neither
// scenario file has to carry its own copy of the mock-origin plumbing, keeping both under the project's
// file-size limit. Every request to `origin` is intercepted; `/api` calls are answered from in-memory
// fixtures (regressionFixtures.mjs), everything else is served from a built `web/dist`, and any other
// host is aborted. `route.continue()` is never called — nothing here ever reaches a live server.
import fs from 'node:fs';
import path from 'node:path';
import { fixtures, MIME, classify, snapshot, thread } from './regressionFixtures.mjs';

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function createRec(results) {
  return function rec(scenarioName, check, pass, detail) {
    results.push({ scenario: scenarioName, check, pass, detail });
    console.log(`${pass === null ? 'NOTE' : pass ? 'PASS' : 'FAIL'}  [${scenarioName}] ${check}`);
  };
}

// One intercepted browser context per scenario, plus the small query/assertion API every scenario body
// drives it through. `opts.noId` mirrors an older server snapshot with no `project.id` (X14).
export async function createHarness(browser, { origin, dist }, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const s = { project: 'A', data: fixtures(), log: [], holds: {}, queues: {}, blocked: [], errors: [], bulkOverride: null };
  page.on('console', (m) => { if (m.type() === 'error') s.errors.push(m.text()); });
  page.on('pageerror', (e) => s.errors.push(`pageerror ${e.message}`));

  const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  function respond(key, entry, u) {
    const list = s.data[entry.serverProject];
    const id = decodeURIComponent(u.pathname.split('/')[3] || '');
    const find = () => list.find((t) => t.id === id);
    switch (key) {
      case 'snapshot': return [200, snapshot(s.project, opts.noId)];
      case 'list': {
        const st = u.searchParams.get('status');
        const trash = u.searchParams.get('trash') === 'only';
        const q = (u.searchParams.get('q') || '').toLowerCase();
        const threads = list.filter((t) => (trash ? t.trashed : !t.trashed))
          .filter((t) => trash || st === 'all' || (st === 'closed' ? t.closed : !t.closed))
          .filter((t) => !q || t.title.toLowerCase().includes(q));
        return [200, { threads }];
      }
      case 'detail': {
        const t = find();
        if (!t) return [404, { error: 'thread not found' }];
        return [200, { ...t, messages: [{ id: `m-${t.id}`, threadId: t.id, body: `${t.title} 的消息`, author: 'fixture', createdAt: t.createdAt }] }];
      }
      case 'bulk': {
        const { action, ids } = JSON.parse(entry.body);
        if (s.bulkOverride) return [200, s.bulkOverride(action, ids)];
        const res = ids.map((i) => {
          const t = list.find((x) => x.id === i);
          if (!t) return { id: i, ok: false, error: 'thread not found' };
          const next = { close: { closed: true }, reopen: { closed: false }, pin: { pinned: true }, unpin: { pinned: false }, trash: { trashed: true }, restore: { trashed: false } }[action];
          Object.assign(t, next);
          return { id: i, ok: true };
        });
        return [200, { action, changed: res.filter((r) => r.ok).length, failed: res.filter((r) => !r.ok).length, results: res }];
      }
      case 'create': {
        const body = JSON.parse(entry.body || '{}');
        s.createCount = (s.createCount || 0) + 1;
        const id = `created-${s.createCount}`;
        const t = thread(id, body.title || id, { author: body.author || 'fixture' });
        list.push(t);
        return [200, { thread: { ...t, messages: [] }, message: { id: `m-${id}`, threadId: id, body: body.body || '', author: t.author, createdAt: t.createdAt } }];
      }
      case 'reply': case 'pin': case 'close': {
        const t = find();
        if (!t) return [404, { error: 'thread not found' }];
        const body = JSON.parse(entry.body || '{}');
        if (key === 'pin') t.pinned = body.pinned;
        if (key === 'close') t.closed = body.closed;
        return [200, key === 'reply' ? { message: {}, thread: t } : t];
      }
      default: return [404, { error: 'not mocked' }];
    }
  }

  await ctx.route('**/*', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.origin !== origin) { s.blocked.push(req.url()); return route.abort(); }
    if (!u.pathname.startsWith('/api/')) {
      const rel = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
      const file = path.join(dist, rel);
      if (!file.startsWith(path.normalize(dist)) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ status: 200, contentType: MIME[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
    }
    const key = classify(req.method(), u.pathname);
    const entry = { i: s.log.length, t: Date.now(), key, method: req.method(), path: u.pathname + u.search, body: req.postData(), serverProject: s.project };
    s.log.push(entry);
    const queue = (s.queues[key] ||= []);
    if (key === 'stream') {
      queue.push({ entry, fire: () => route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'retry: 400\nevent: hello\ndata: {}\n\n' }) });
      return;
    }
    const release = (override) => {
      const [status, body] = override ?? respond(key, entry, u);
      return json(route, status, body);
    };
    if (s.holds[key] > 0) { s.holds[key] -= 1; queue.push({ entry, release }); return; }
    return release();
  });

  const h = {
    page, s,
    hold: (key, n = 1) => { s.holds[key] = (s.holds[key] || 0) + n; },
    async queued(key, n = 1, ms = 4000) {
      const end = Date.now() + ms;
      while (Date.now() < end) { if ((s.queues[key] || []).length >= n) return s.queues[key][n - 1]; await wait(25); }
      throw new Error(`timeout waiting for held ${key} #${n}`);
    },
    take: (key) => (s.queues[key] || []).shift(),
    async switchProject(to) {
      s.project = to;
      const st = await h.queued('stream', 1, 6000);
      s.queues.stream.shift();
      await st.fire();
      await page.waitForFunction((name) => document.title.startsWith(name), `项目${to}`, { timeout: 5000 });
    },
    mark: () => s.log.length,
    since: (m, key) => s.log.slice(m).filter((e) => !key || e.key === key),
    async open(hash = '#/threads') {
      await page.goto(`${origin}/${hash}`);
      await page.waitForFunction(() => document.title.startsWith('项目'), null, { timeout: 8000 });
      await page.waitForSelector('.thread-item', { timeout: 8000 });
      await wait(300);
    },
    row: (title) => page.locator('.thread-item', { hasText: title }),
    check: (title) => page.getByLabel(`选择主题：${title}`),
    bulkBtn: (label) => page.locator('.tb-bulk-bar button', { hasText: new RegExp(`^${label}$`) }),
    paneBtn: (label) => page.locator('.th-head-actions button', { hasText: new RegExp(`^${label}$`) }),
    observe: () => page.evaluate(() => {
      const a = document.activeElement;
      const active = !a || a === document.body ? 'BODY'
        : `${a.tagName}|${(a.getAttribute('placeholder') || a.textContent || '').trim().slice(0, 24)}${a.disabled ? '|disabled' : ''}`;
      const send = [...document.querySelectorAll('.thread-composer button')].find((b) => /发送/.test(b.textContent));
      return {
        hash: location.hash, title: document.title,
        rows: [...document.querySelectorAll('.thread-item')].map((b) => `${b.querySelector('.th-item-title')?.textContent}${b.classList.contains('on') ? '*' : ''}`),
        listEmpty: document.querySelector('.threads-list .empty')?.textContent ?? null,
        count: document.querySelector('.tb-count')?.textContent ?? null,
        status: document.querySelector('.tb-status')?.textContent ?? null,
        listError: document.querySelector('.threads-sidebar .th-error-line')?.textContent ?? null,
        pane: document.querySelector('.thread-detail-head h2')?.textContent ?? null,
        paneEmpty: document.querySelector('.threads-content .empty')?.textContent ?? null,
        paneEmptyRole: document.querySelector('.threads-content .empty')?.getAttribute('role') ?? null,
        paneEmptyLive: document.querySelector('.threads-content .empty')?.getAttribute('aria-live') ?? null,
        paneError: document.querySelector('.threads-content .th-error-line')?.textContent ?? null,
        draft: document.querySelector('.thread-composer textarea')?.value ?? null,
        send: send ? `${send.textContent}${send.disabled ? '|disabled' : ''}` : null,
        refusal: document.querySelector('.th-refusal')?.textContent ?? null,
        dialog: Boolean(document.querySelector('.tb-confirm')),
        active,
      };
    }),
    close: () => ctx.close(),
  };
  return h;
}

// Runs one scenario in its own harness/context, recording a `scenario ran to completion` failure if the
// body throws, plus a request-log summary row for post-hoc inspection either way.
export function createScenarioRunner(browser, { origin, dist, results, rec }) {
  return async function scenario(name, fn, opts) {
    const h = await createHarness(browser, { origin, dist }, opts);
    try { await fn(h); } catch (err) { rec(name, 'scenario ran to completion', false, String(err?.stack || err)); }
    const posts = h.s.log.filter((e) => e.method === 'POST');
    const unexpected = h.s.log.filter((e) => e.key === 'unexpected-post' || e.key === 'other');
    results.push({ scenario: name, requestLog: h.s.log.map(({ t, ...e }) => e), blocked: h.s.blocked, consoleErrors: h.s.errors, posts: posts.length, unmocked: unexpected.map((e) => e.path) });
    await h.close();
  };
}
