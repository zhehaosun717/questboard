// Portable browser acceptance regression for the dispatch-history tab (web/src/components/HistoryView.tsx
// and friends). Every path comes from required env vars (no defaults, no private machine paths):
//   PW_DRIVER  path to a local playwright-core (or playwright) `chromium.js`/index module to import
//   CHROME     path to a local Chromium/Chrome executable
//   OUT_DIR    a writable directory for results.json and screenshots (created if missing)
//   DIST       a built `web/dist` to serve (npm --prefix web run build)
// Nothing here reaches a real service: every request is served from an in-memory fixture server or the
// given DIST, non-GET requests are aborted and counted, and off-origin requests are aborted except real
// font hosts (also counted). Run with: PW_DRIVER=... CHROME=... OUT_DIR=... DIST=... node
// test/browser/history-regression.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const need = (k) => { const v = process.env[k]; if (!v) { console.error(`missing env ${k}`); process.exit(2); } return v; };
const PW = need('PW_DRIVER'); const CHROME = need('CHROME'); const OUT = need('OUT_DIR'); const DIST = need('DIST');
const { chromium } = await import(pathToFileURL(PW).href);
const SHOTS = path.join(OUT, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
const ORIGIN = 'http://questboard.test';
const results = [];
const check = (id, pass, detail = '') => { results.push({ id, pass: Boolean(pass), detail: String(detail) }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id}${detail ? ' — ' + detail : ''}`); };
const note = (id, detail) => { results.push({ id, pass: null, detail: String(detail) }); console.log(`NOTE ${id} — ${detail}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── fixtures (store.emitEvent shape: src/core/store.js) ──
function gen(total, prefix = 'Q') {
  const rows = [];
  const t0 = Date.parse('2026-09-01T00:00:00.000Z');
  const push = (event, pkg, extra = {}) => rows.push({ event, package: pkg, lane: null, model: null, variant: null, name: null, by: 'board', detail: '', ...extra });
  const who = (lane, model, name, variant = 'high') => ({ lane, model, variant, name });
  if (prefix === 'Q') {
    const A = who('codex', 'gpt-5.6-luna', 'w-order'); const B = who('opencode', 'qwen3.8-flash', 'w-stall');
    push('posted', 'P-ORDER', { by: 'coordinator' }); push('posted', 'P-STALL', { by: 'coordinator' });
    push('assigned', 'P-ORDER', { ...A, by: 'owner' }); push('dispatched', 'P-ORDER', A);
    push('assigned', 'P-STALL', { ...B, by: 'owner' }); push('dispatched', 'P-STALL', B);
    push('delivered', 'P-ORDER', { ...A, by: 'lanes' }); push('stalled', 'P-STALL', { ...B, by: 'lanes', detail: '派出 10 分钟后登记表里仍没有 worker' });
    push('status_reviewing', 'P-ORDER', { ...A, by: 'coordinator' }); push('status_dispatched', 'P-STALL', { ...B, by: 'lanes' });
    push('status_done', 'P-ORDER', { ...A, by: 'coordinator' });
    const C = who('claude-cli', 'sonnet-5', 'w-reopen', null);
    push('posted', 'P-REOPEN'); push('assigned', 'P-REOPEN', C); push('dispatched', 'P-REOPEN', C); push('failed', 'P-REOPEN', C); push('status_posted', 'P-REOPEN', { by: 'owner' });
    push('posted', 'P-BADDATE', { at: 'not-a-date' });
    push('delivered', 'P-' + 'LONGNAME'.repeat(20), { ...C, detail: 'D'.repeat(2000) });
    push('delivered', 'P-TWIN', { ...C, detail: 'identical' }); push('delivered', 'P-TWIN', { ...C, detail: 'identical' });
  }
  const ls = [who('codex', 'gpt-5.6-luna', 'x'), who('opencode', 'qwen3.8-flash', 'y'), who('claude-cli', 'sonnet-5', 'z')];
  let i = 0;
  while (rows.length < total) {
    const pkg = `${prefix}-${String(i).padStart(4, '0')}`; const L = { ...ls[i % 3], name: `w-${i}` };
    push('posted', pkg); push('assigned', pkg, L); push('dispatched', pkg, L); push('delivered', pkg, L); push('status_done', pkg, L);
    i += 1;
  }
  return rows.slice(0, total).map((r, idx) => ({ seq: idx + 1, ...r, at: r.at ?? new Date(t0 + idx * 60000).toISOString() }));
}
const lanesReport = () => ({
  generatedAt: new Date().toISOString(),
  packages: [{ package: 'P-ORDER', lane: 'codex', model: 'gpt-5.6-luna', variant: 'high', name: 'w-order', session: null, dispatchedAt: '2026-09-01T00:03:00.000Z', elapsed: 90000, state: 'done', reason: '', stale: false, edits: 3, tokens: null, lastText: 'ok', bounceUntil: null, history: [] }],
  laneLimits: {}, board: { openQuestions: 0 },
  verification: { steps: [{ name: 'build', kind: 'exit', value: '0' }, { name: 'build', kind: 'exit', value: '1' }], done: true, editXml: null, playXml: null },
});
const snapshot = { generatedAt: new Date().toISOString(), project: { name: 'fixture', id: 'fx', lanes: ['codex'] }, quests: [], roster: [], eligibility: {}, env: { treeLocked: false }, live: {}, threads: {}, reviewPages: [], unpostedBriefs: [], verification: null, laneLimits: {}, openQuestions: 0 };

// ── fake server ── nextAfter = last seq, or unchanged when empty (questRoutes.js contract)
const ctl = {
  events: gen(1234), delayMs: 0, clamp: 500, requests: [], blocked: [], writes: 0,
  failOnceAfter: null, cursorMode: null, cursorAt: null,
  lanesMode: 'ok', lanesReqs: [], lanesInFlight: 0, lanesOverlap: 0, hangs: [], laneSlots: new Map(),
  injected: { events500: 0, lanes500: 0, offsite: 0, api404: [] }, aborted: 0,
};
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
async function handle(route) {
  const req = route.request(); const url = new URL(req.url());
  if (url.origin !== ORIGIN) { ctl.blocked.push(`offsite ${url.host}${url.pathname}`); ctl.injected.offsite += 1; return route.abort(); }
  if (req.method() !== 'GET') { ctl.writes += 1; ctl.blocked.push(`${req.method()} ${url.pathname}`); return route.abort(); }
  try {
    if (url.pathname === '/api/events') {
      const after = Number(url.searchParams.get('after')); const limit = Number(url.searchParams.get('limit'));
      ctl.requests.push({ after, limit });
      if (ctl.delayMs) await sleep(ctl.delayMs);
      if (ctl.failOnceAfter === after) { ctl.failOnceAfter = null; ctl.injected.events500 += 1; return await route.fulfill({ status: 500, json: { error: 'boom' } }); }
      const events = ctl.events.filter((e) => e.seq > after).slice(0, Math.min(limit, ctl.clamp));
      let body = { events, nextAfter: events.length ? events.at(-1).seq : after };
      if (ctl.cursorAt === after) {
        if (ctl.cursorMode === 'stall') body = { events, nextAfter: after };
        if (ctl.cursorMode === 'regress') body = { events, nextAfter: after - 1 };
        if (ctl.cursorMode === 'missing') body = { events };
        if (ctl.cursorMode === 'moved-empty') body = { events: [], nextAfter: after + 66 };
      }
      return await route.fulfill({ status: 200, json: body });
    }
    if (url.pathname === '/api/lanes') {
      ctl.lanesInFlight += 1; if (ctl.lanesInFlight > 1) ctl.lanesOverlap += 1; ctl.lanesReqs.push(Date.now());
      // D2: once the client's own AbortController fires, the real fetch is really cancelled — a real
      // server would see the connection drop too. This fixture's `slot` mirrors that: the page-level
      // `requestfailed` listener below marks it settled (freeing lanesInFlight) the moment the browser
      // actually aborts, instead of only when this handler's own `await` on `ctl.hangs` is released —
      // otherwise every legitimate retry after a timeout would misreport as "still overlapping" simply
      // because THIS fixture (unlike a real server) has no other way to notice the client gave up.
      const slot = { settled: false };
      ctl.laneSlots.set(req, slot);
      try {
        if (ctl.lanesMode === 'hang') await new Promise((r) => ctl.hangs.push(r));
        if (ctl.lanesMode === 'fail') { ctl.injected.lanes500 += 1; return await route.fulfill({ status: 500, json: { error: 'lanes fixture down' } }); }
        return await route.fulfill({ json: lanesReport() });
      } finally { if (!slot.settled) { slot.settled = true; ctl.lanesInFlight -= 1; } }
    }
    if (url.pathname === '/api/quests') return await route.fulfill({ json: snapshot });
    if (url.pathname === '/api/quests/stream') return await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'event: hello\ndata: {}\n\n' });
    if (url.pathname.startsWith('/api/')) { ctl.injected.api404.push(url.pathname); return await route.fulfill({ status: 404, json: { error: `fixture has no ${url.pathname}` } }); }
    const file = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const full = path.join(DIST, file);
    if (!full.startsWith(path.resolve(DIST)) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return await route.fulfill({ status: 404, body: 'nf' });
    return await route.fulfill({ status: 200, headers: { 'content-type': types[path.extname(full)] || 'application/octet-stream' }, body: fs.readFileSync(full) });
  } catch { ctl.aborted += 1; return undefined; }
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Shanghai', locale: 'zh-CN' });
await context.route('**/*', handle);
const page = await context.newPage();
const consoleAll = []; const pageErrors = []; let eventsReqFailed = 0;
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleAll.push({ type: m.type(), text: m.text(), url: m.location()?.url || '' }); });
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('requestfailed', (r) => {
  if (r.url().includes('/api/events')) eventsReqFailed += 1;
  if (r.url().includes('/api/lanes')) {
    const slot = ctl.laneSlots.get(r);
    if (slot && !slot.settled) { slot.settled = true; ctl.lanesInFlight -= 1; }
  }
});

const cov = () => page.locator('.hist-coverage').textContent();
const waitCov = async (re, timeout = 30000) => { await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.hist-coverage')?.textContent || ''), re.source, { timeout }); return cov(); };
const afters = () => ctl.requests.map((r) => r.after);
const vis = (sel) => page.locator(sel).first().isVisible().catch(() => false);
const active = () => page.evaluate(() => { const a = document.activeElement; return a === document.body ? 'BODY' : `${a?.tagName}.${a?.className || a?.id}`; });
const load = async (events, re = /已读取全部|还没读完|读取失败/, setup = () => {}) => { ctl.events = events; ctl.requests = []; setup(); await page.reload(); return waitCov(re); };
async function until(fn, pred, timeout) { const t = Date.now(); for (;;) { const v = await fn(); if (pred(v) || Date.now() - t > timeout) return v; await sleep(150); } }

try {
  // ── S1 initial load, delayed pages, per-op labels ──
  ctl.delayMs = 500;
  await page.goto(`${ORIGIN}/#/history`);
  await page.waitForSelector('.hist-loading[role=status]', { timeout: 8000 });
  check('S1 explicit loading status before first page', (await page.locator('.hist-loading[role=status]').textContent()).includes('正在读取事件记录'));
  check('S1 no load/refresh/reread buttons while loading', !(await vis('.hist-load-more')) && !(await vis('.hist-refresh')) && !(await vis('.hist-reset-secondary')));
  await page.waitForFunction(() => /已读取 500 条/.test(document.querySelector('.hist-coverage')?.textContent || ''), null, { timeout: 8000 });
  // Page 2+ of the initial load must keep its own label, not borrow 继续加载's (revision 5 note 1).
  check('S1 initial-op label after page 1 is still the initial-load label, not 继续读取', (await cov()).includes('正在读取事件记录…') && !(await cov()).includes('正在继续读取'), await cov());
  const c1 = await waitCov(/已读取全部/);
  check('S1 1234 complete, afters 0,500,1000,1234', c1 === '已读取全部事件记录（共 1234 条）' && JSON.stringify(afters()) === '[0,500,1000,1234]', `${c1} ${afters()}`);
  ctl.delayMs = 0;
  check('S1 1234 lines rendered, group counts sum', (await page.locator('.hist-timeline .hist-event-line').count()) === 1234 && (await page.$$eval('.hist-group-count', (els) => els.reduce((n, e) => n + parseInt(e.textContent, 10), 0))) === 1234);

  // ── S2 real event shape: lane + model/variant + name + by; order; unknown raw ──
  const lineText = async (pkg, kind) => (await page.locator(`article[aria-label="任务 ${pkg}"] .hist-event-line`).allInnerTexts()).find((t) => t.includes(kind)) || '';
  const disp = await lineText('P-ORDER', '派出开工');
  check('S2/B1 dispatched line shows lane, model/variant, name and by', /codex/.test(disp) && disp.includes('gpt-5.6-luna/high') && disp.includes('w-order') && disp.includes('由 board'), disp.replace(/\s+/g, ' '));
  const reopenDisp = await lineText('P-REOPEN', '派出开工');
  check('S2/B1 null variant shows model without a dangling slash', reopenDisp.includes('claude-cli · sonnet-5 · w-reopen') && !reopenDisp.includes('sonnet-5/'), reopenDisp.replace(/\s+/g, ' '));
  const kinds = (pkg) => page.$$eval(`article[aria-label="任务 ${pkg}"] .hist-ev-kind`, (els) => els.map((e) => e.textContent));
  check('S2 P-STALL seq order incl stall recovery', JSON.stringify(await kinds('P-STALL')) === JSON.stringify(['发布委托', '指派冒险者', '派出开工', '失联了', '委托状态：进行中']));
  check('S2 P-REOPEN manual reopen line', JSON.stringify(await kinds('P-REOPEN')) === JSON.stringify(['发布委托', '指派冒险者', '派出开工', '任务失败了', '委托状态：待接']));
  check('S2 bad `at` raw + per-line badge; none on valid lines', (await page.locator('article[aria-label="任务 P-BADDATE"] .hist-ev-time').textContent()) === 'not-a-date' && (await page.locator('article[aria-label="任务 P-BADDATE"] .hist-ev-badtime').count()) === 1 && (await page.locator('article[aria-label="任务 P-ORDER"] .hist-ev-badtime').count()) === 0);
  check('S2 twins with distinct seq both kept; no <details>; article not section', (await page.locator('article[aria-label="任务 P-TWIN"] .hist-event-line').count()) === 2 && (await page.locator('.hist-timeline details').count()) === 0 && (await page.locator('section[aria-label^="任务 "]').count()) === 0);
  // Note 5 fixed this: .hist-ev-who no longer carries an aria-label (invalid on a generic span, and
  // redundant with its own visible text anyway) — so there is no attribute left to inspect here.
  const whoNoLabel = await page.locator('article[aria-label="任务 P-ORDER"] .hist-ev-who').nth(1).evaluate((el) => el.getAttribute('aria-label'));
  check('S2/note5 .hist-ev-who carries no aria-label (invalid on a generic span; text is already complete)', whoNoLabel === null, String(whoNoLabel));

  // ── S3 filters: no request per keystroke; state preserved; inspect toggle by keyboard ──
  let before = ctl.requests.length;
  await page.locator('#hist-pkg').click(); await page.keyboard.type('P-STA', { delay: 60 }); await sleep(500);
  check('S3 typing sends 0 event requests', ctl.requests.length === before, `${before}->${ctl.requests.length}`);
  check('S3 count P-STALL 5/1234', (await page.locator('.hist-filter-count').textContent()).includes('符合条件 5 / 已加载 1234 条'));
  await page.locator('#hist-pkg').fill(''); await page.locator('#hist-lane').selectOption('opencode'); await page.locator('#hist-kind').selectOption('status_*');
  const k3 = await page.$$eval('.hist-timeline .hist-ev-kind', (els) => [...new Set(els.map((e) => e.textContent))]);
  check('S3 lane + status_* combine, no request', ctl.requests.length === before && k3.every((k) => k.startsWith('委托状态') || k.startsWith('状态记录')), k3.join(','));
  await page.locator('.hist-filter-foot .hist-filter-clear').click();
  await page.locator('#hist-pkg').fill('zzz-none');
  check('S3 no-match with clear, never with empty', (await vis('.hist-no-match')) && !(await vis('.hist-empty')));
  await page.locator('.hist-no-match .hist-filter-clear').click();
  const inspect = page.locator('.hist-filter-inspect');
  check('S3 inspect toggle present without a time window (invalid records exist)', await inspect.isVisible());
  // Fixed probe artifact (revision 5): a `datetime-local` input has several internal segments the
  // browser treats as separate Tab stops, so a short, fixed-count walk from BEFORE both #hist-from and
  // #hist-to under-counts and reports a false FAIL here. Focusing #hist-to (the LAST field before the
  // toolbar) and allowing enough presses — the fix independently verified in job 91c0c430's targeted
  // recheck (7/7 pass) — removes the false negative without weakening what is actually asserted: the
  // control must still really be reached by real Tab presses, nothing here is skipped or assumed.
  await page.locator('#hist-to').focus();
  let reached = false; const path3 = [];
  for (let k = 0; k < 24 && !reached; k += 1) {
    await page.keyboard.press('Tab');
    const cls = await page.evaluate(() => document.activeElement?.className || document.activeElement?.id);
    if (path3.at(-1) !== cls) path3.push(cls);
    reached = cls === 'hist-filter-inspect';
  }
  check('S3 inspect toggle reachable by Tab (from the last time field onward)', reached, path3.join(' > '));
  await page.keyboard.press('Space'); await sleep(150);
  check('S3 Space toggles inspect: aria-pressed true, only invalid records', (await inspect.getAttribute('aria-pressed')) === 'true' && (await page.locator('.hist-filter-count').textContent()).includes('符合条件 1 /'), await page.locator('.hist-filter-count').textContent());
  await page.keyboard.press('Enter'); await sleep(150);
  check('S3 Enter toggles back', (await inspect.getAttribute('aria-pressed')) === 'false');

  // ── S4 time window: inverted refusal aria, Shanghai minute-inclusive, invalid retained ──
  await page.locator('#hist-from').fill('2026-09-01T10:00'); await page.locator('#hist-to').fill('2026-09-01T09:00');
  const aria4 = await page.evaluate(() => { const f = document.getElementById('hist-from'); const id = f.getAttribute('aria-describedby'); return { inv: f.getAttribute('aria-invalid'), desc: id && document.getElementById(id)?.textContent, role: id && document.getElementById(id)?.getAttribute('role') }; });
  // Note 3 fixed this: the refusal now says 时间 (matching the field labels 开始时间/结束时间), never 日期.
  check('S4 inverted window refused, inputs aria-invalid + describedby alert, wording matches 时间 labels', aria4.inv === 'true' && aria4.role === 'alert' && /开始时间晚于结束时间/.test(aria4.desc || '') && (await page.locator('.hist-filter-count').textContent()).includes('符合条件 1234 / 已加载 1234'), JSON.stringify(aria4));
  await page.locator('#hist-from').fill('2026-09-01T08:30'); await page.locator('#hist-to').fill('2026-09-01T09:00');
  const fromMs = Date.parse('2026-09-01T00:30:00Z'); const toMs = Date.parse('2026-09-01T01:00:59.999Z');
  const exp4 = ctl.events.filter((e) => { const t = Date.parse(e.at); return Number.isNaN(t) || (t >= fromMs && t <= toMs); }).length;
  check('S4 Shanghai window inclusive + invalid kept', (await page.locator('.hist-filter-count').textContent()).includes(`符合条件 ${exp4} /`) && (await vis('article[aria-label="任务 P-BADDATE"]')), `expected ${exp4}: ${await page.locator('.hist-filter-count').textContent()}`);
  await page.locator('.hist-filter-foot .hist-filter-clear').click();

  // ── S5 accessible reread description; Tab reaches toolbar buttons ──
  const rd = await page.evaluate(() => { const b = document.querySelector('.hist-reset-secondary'); const d = b && document.getElementById(b.getAttribute('aria-describedby')); return d ? { text: d.textContent, visible: d.getBoundingClientRect().width > 2 } : null; });
  check('S5 reread button has aria-describedby text (sr-only)', rd && rd.text.includes('从头') && !rd.visible, JSON.stringify(rd));
  await page.locator('.hist-coverage').click();
  const t5 = []; for (let k = 0; k < 3; k += 1) { await page.keyboard.press('Tab'); t5.push(await page.evaluate(() => document.activeElement?.className)); }
  check('S5 Tab from coverage reaches 刷新新事件 then 全部重新读取', t5.includes('hist-refresh') && t5.includes('hist-reset-secondary'), t5.join(' > '));

  // ── S6 project tests + worker table ──
  const pt = await page.locator('.hist-project-tests').textContent();
  check('S6 project tests separate with disclaimer; worker table kept', (await page.locator('.hist-events-section .hist-project-tests').count()) === 0 && pt.includes('不能作为任何一个委托完成的证明') && (await page.locator('.hist-workers-section tbody tr').count()) >= 1);

  // ── S7/B3 long detail keyboard expand ──
  const longArt = page.locator('article[aria-label^="任务 P-LONGNAME"]');
  await longArt.scrollIntoViewIfNeeded();
  await longArt.locator('.hist-ev-time').click();
  await page.keyboard.press('Tab');
  const focusCls = await page.evaluate(() => document.activeElement?.className);
  const tog = longArt.locator('.hist-ev-detail-toggle');
  const beforeH = await longArt.locator('.hist-ev-detail').evaluate((d) => ({ sh: d.scrollHeight, ch: d.clientHeight }));
  await page.keyboard.press('Enter'); await sleep(120);
  const afterH = await longArt.locator('.hist-ev-detail').evaluate((d) => ({ sh: d.scrollHeight, ch: d.clientHeight, len: d.textContent.length, id: d.id }));
  const ctrls = await tog.getAttribute('aria-controls');
  check('B3 Tab reaches toggle; Enter expands full 2000 chars; aria-expanded/controls; focus stays',
    focusCls === 'hist-ev-detail-toggle' && beforeH.sh > beforeH.ch + 1 && (await tog.getAttribute('aria-expanded')) === 'true' && afterH.sh <= afterH.ch + 1 && afterH.len === 2000 && ctrls === afterH.id && (await page.evaluate(() => document.activeElement?.className)) === 'hist-ev-detail-toggle',
    `focus=${focusCls} before=${JSON.stringify(beforeH)} after=${JSON.stringify(afterH)} controls=${ctrls}`);
  await page.keyboard.press('Space'); await sleep(120);
  check('B3 Space collapses', (await tog.getAttribute('aria-expanded')) === 'false');

  // ── S8 HTTP error mid-scan: kept records, single retry, resumes at cursor ──
  ctl.failOnceAfter = 500; ctl.delayMs = 30;
  await load(gen(1234), /读取失败/);
  const e8 = await page.locator('.hist-load-error').textContent();
  check('S8 500 at cursor: reason, 500 kept, only 重试', e8.includes('事件接口返回 500：boom') && (await cov()).startsWith('已读取 500 条事件记录，读取失败') && !(await vis('.hist-load-more')) && !(await vis('.hist-reset-secondary')) && (await page.locator('.hist-retry').textContent()) === '重试', e8);
  ctl.requests = []; await page.locator('.hist-retry').click();
  const c8 = await waitCov(/已读取全部/);
  check('S8 retry resumes at 500 and completes', c8.includes('共 1234 条') && afters()[0] === 500, afters());
  ctl.delayMs = 0;

  // ── S9 unmount mid-scan aborts; rapid flips exact ──
  ctl.requests = []; ctl.delayMs = 1500; eventsReqFailed = 0;
  await page.evaluate(() => { location.hash = '#/board'; }); await sleep(200);
  await page.evaluate(() => { location.hash = '#/history'; }); await sleep(300);
  await page.evaluate(() => { location.hash = '#/board'; }); await sleep(3200);
  check('S9 unmount aborts in-flight page, no follow-up', ctl.requests.length === 1 && eventsReqFailed >= 1, `requests=${ctl.requests.length} failed=${eventsReqFailed}`);
  ctl.delayMs = 250; ctl.requests = [];
  for (let k = 0; k < 4; k += 1) { await page.evaluate(() => { location.hash = '#/history'; }); await sleep(100); await page.evaluate(() => { location.hash = '#/board'; }); await sleep(100); }
  await page.evaluate(() => { location.hash = '#/history'; });
  const c9 = await waitCov(/已读取全部/);
  check('S9 after flips exact 1234 lines', c9.includes('共 1234 条') && (await page.locator('.hist-timeline .hist-event-line').count()) === 1234);
  ctl.delayMs = 0;

  // ── S10/B4/B5 5600: budget, continue, refresh, reread with own budget ──
  const c10 = await load(gen(5600), /还没读完/);
  check('S10 5600 budget stop at 5000 (10 requests), 继续加载 offered, no 全部', c10 === '已读取 5000 条事件记录，更新的记录还没读完（可继续加载）' && ctl.requests.length === 10 && (await vis('.hist-load-more')), `${c10} n=${ctl.requests.length}`);
  ctl.requests = []; ctl.delayMs = 300;
  await page.locator('.hist-load-more').click(); await sleep(100);
  note('S10 continue-op label while running', await cov());
  const c10b = await waitCov(/已读取全部/);
  check('S10 continue afters 5000,5500,5600 → 共 5600', c10b.includes('共 5600 条') && JSON.stringify(afters()) === '[5000,5500,5600]', afters());
  ctl.events = [...ctl.events, ...gen(5603).slice(5600).map((e) => ({ ...e, package: 'NEW-TAIL' }))]; ctl.requests = [];
  await page.locator('.hist-refresh').click(); await sleep(100);
  const during10 = await cov();
  const c10c = await waitCov(/共 5603 条/);
  check('S10 refresh label + afters 5600,5603', during10 === '已读取 5600 条事件记录，正在刷新新事件…' && JSON.stringify(afters()) === '[5600,5603]', `${during10} ${afters()}`);
  await page.locator('#hist-lane').selectOption('codex');
  const laneCount = await page.locator('.hist-filter-count').textContent();
  ctl.requests = []; ctl.delayMs = 400;
  await page.locator('.hist-reset-secondary').click(); await sleep(150);
  const during4 = await cov();
  const linesDuring = await page.locator('.hist-timeline .hist-event-line').count();
  const loadingStatus = await vis('.hist-loading[role=status]');
  check('B4 reread label 正在从头读取…, old records cleared, explicit loading status, no empty/no-match', during4 === '正在从头读取…' && linesDuring === 0 && loadingStatus && !(await vis('.hist-empty')) && !(await vis('.hist-no-match')), `${during4} lines=${linesDuring} status=${loadingStatus}`);
  // Note 4: reread's own button unmounts while loading (the toolbar swaps in the coverage label), so
  // focus must land back on it — never on BODY — once the button reappears.
  await page.waitForFunction(() => /已读取全部|还没读完/.test(document.querySelector('.hist-coverage')?.textContent || ''), null, { timeout: 15000 }).catch(() => undefined);
  const focusAfterReread = await page.evaluate(() => document.activeElement?.tagName + '.' + (document.activeElement?.className || document.activeElement === document.body ? 'BODY' : ''));
  check('note4 focus restored after 全部重新读取 finishes loading, not left on BODY', await page.evaluate(() => document.activeElement !== document.body), focusAfterReread);
  ctl.delayMs = 0;
  const c4 = await waitCov(/还没读完|已读取全部/);
  check('B4 reread starts at 0, own 10-page budget → 5000 + 还没读完', afters()[0] === 0 && ctl.requests.length === 10 && c4 === '已读取 5000 条事件记录，更新的记录还没读完（可继续加载）', `${c4} afters=${afters().slice(0, 3)}… n=${ctl.requests.length}`);
  check('S3 filter state preserved across reread (lane=codex still selected)', (await page.locator('#hist-lane').inputValue()) === 'codex', `${laneCount} → ${await page.locator('.hist-filter-count').textContent()}`);
  ctl.requests = []; await page.locator('.hist-load-more').click();
  const c4b = await waitCov(/已读取全部/);
  check('B4 continue completes reread to 5603', c4b.includes('共 5603 条') && JSON.stringify(afters()) === '[5000,5500,5603]', afters());
  await page.locator('.hist-filter-foot .hist-filter-clear').click();

  // ── replaced / truncated log via reread ──
  ctl.events = gen(300, 'NEW'); ctl.requests = [];
  await page.locator('.hist-refresh').click(); await waitCov(/已读取全部/);
  note('refresh after the log was truncated/replaced (keeps old 5603, expected: refresh only reads after cursor)', await cov());
  await page.locator('.hist-reset-secondary').click();
  const cTr = await waitCov(/共 300 条/);
  const oldLeft = await page.locator('article[aria-label^="任务 Q-"], article[aria-label^="任务 P-"]').count();
  check('B4 reread of replaced 300-record log keeps no deleted records', cTr.includes('共 300 条') && oldLeft === 0, `${cTr} old=${oldLeft}`);

  // ── B5 end detection variants ──
  let c = await load(gen(1000));
  check('B5 exact multiple 1000: afters 0,500,1000', c.includes('共 1000 条') && JSON.stringify(afters()) === '[0,500,1000]', afters());
  c = await load(gen(1234), /已读取全部|还没读完/, () => { ctl.clamp = 200; });
  check('B5 server clamp 200, 1234: 8 requests to true end', c.includes('共 1234 条') && JSON.stringify(afters()) === '[0,200,400,600,800,1000,1200,1234]', afters());
  c = await load(gen(5600), /已读取全部|还没读完/);
  check('B5 server clamp 200, 5600: budget stop at 2000, not 全部', c === '已读取 2000 条事件记录，更新的记录还没读完（可继续加载）', c);
  ctl.clamp = 500;
  c = await load([], /已读取全部/);
  check('B5 empty log: 1 request, 共 0 条, empty message only', c.includes('共 0 条') && JSON.stringify(afters()) === '[0]' && (await vis('.hist-empty')) && !(await vis('.hist-no-match')));
  await page.locator('#hist-pkg').fill('x');
  check('S11 empty log + filter: only empty message', (await vis('.hist-empty')) && !(await vis('.hist-no-match')));

  // ── cursor protocol errors (D1: missing/non-integer nextAfter now classifies as protocol too) ──
  for (const mode of ['stall', 'regress', 'moved-empty', 'missing']) {
    const at = mode === 'moved-empty' ? 1234 : 500;
    c = await load(gen(1234), /读取失败/, () => { ctl.cursorMode = mode; ctl.cursorAt = at; });
    const msg = await page.locator('.hist-load-error').textContent();
    const btn = await page.locator('.hist-retry').textContent();
    const rereadVisible = await vis('.hist-reset-secondary');
    const nBefore = ctl.requests.length; await sleep(1500); const nIdle = ctl.requests.length - nBefore;
    ctl.requests = []; await page.locator('.hist-retry').click();
    await page.waitForFunction(() => /读取失败|已读取全部/.test(document.querySelector('.hist-coverage')?.textContent || ''), null, { timeout: 15000 }).catch(() => undefined);
    await sleep(300);
    const retryAfters = afters();
    const actionable = btn === '从头重新读取' && retryAfters[0] === 0 && nIdle === 0;
    check(`B5/cursor ${mode}@${at}: stops without spin, recovery restarts from 0 (not same-cursor retry)`, actionable, `msg="${msg.slice(0, 90)}" button=${btn} rereadVisible=${rereadVisible} idleRequests=${nIdle} retryAfters=${retryAfters}`);
    if (mode === 'missing') check('D1: missing nextAfter classifies as HistoryProtocolError, button offers 从头重新读取 (not 重试 at a dead cursor)', btn === '从头重新读取', `button=${btn}`);
    ctl.cursorMode = null; ctl.cursorAt = null;
  }

  // ── B2 strict time parsing in the browser; date note 6: 0000-0099 stay real years ──
  const base = { lane: null, model: null, variant: null, name: null, by: 'board', detail: '', event: 'posted' };
  const tev = [
    ['T-LEAP2024', '2024-02-29T16:00:00.000Z', '03-01 00:00'], ['T-2000', '2000-02-29T00:00:00Z', '02-29 08:00'],
    ['T-OFFSET', '2026-09-01T08:00:00-05:00', '09-01 21:00'], ['T-PLUS8', '2026-09-01T08:00:00+08:00', '09-01 08:00'],
    ['T-FEB31', '2026-02-31T10:00:00.000Z', null], ['T-LEAP2026', '2026-02-29T10:00:00.000Z', null], ['T-1900', '1900-02-29T00:00:00Z', null],
    ['T-BADOFF', '2026-09-01T08:00:00+25:00', null], ['T-LEGACY', 'legacy 5', null], ['T-SPACE', '2026-09-01 08:00:00Z', null],
    // Date note 6: year 44 is a real year, never fabricated into 1944 by the legacy Date-constructor
    // remap. Its exact local clock is NOT asserted here: pre-1901 Asia/Shanghai used local mean time
    // (≈ +08:05:43, not the flat +08:00 modern offset) in real ICU tz data, a genuine historical-offset
    // fact unrelated to this parser — the century fix itself is asserted exactly, TZ-independently, in
    // web/src/lib/history.test.ts via getUTCFullYear(). Here only "parsed at all, no badge" is checked.
    ['T-Y0044', '0044-03-01T08:00:00.000Z', 'ANY'],
    // Date note 6: a naive, no-offset `at` is not the documented event shape — it stays raw/unrecognised
    // rather than being silently guessed as local time (that guess is only ever made for filter bounds).
    ['T-NAIVE', '2026-09-01T09:00:00', null],
  ].map(([pkg, at, want], i) => ({ seq: i + 1, ...base, package: pkg, at, want }));
  await load(tev.map(({ want, ...e }) => e), /已读取全部/);
  const clocks = {}; let okClock = true;
  for (const e of tev) {
    const shown = await page.locator(`article[aria-label="任务 ${e.package}"] .hist-ev-time`).textContent();
    const badge = await page.locator(`article[aria-label="任务 ${e.package}"] .hist-ev-badtime`).count();
    clocks[e.package] = `${shown}${badge ? ' ⚠' : ''}`;
    if (e.want === 'ANY') { if (badge || !shown.startsWith('03-01')) okClock = false; }
    else if (e.want ? (shown !== e.want || badge) : (shown !== e.at || badge !== 1)) okClock = false;
  }
  check('B2/date-note6 leap years / offsets / year 44 formatted; impossible, loose and naive kept raw with badge', okClock, JSON.stringify(clocks));
  await page.locator('#hist-from').fill('2026-09-01T21:00'); await page.locator('#hist-to').fill('2026-09-01T21:00');
  const cnt2 = await page.locator('.hist-filter-count').textContent(); const note2 = await page.locator('.hist-filter-note').textContent().catch(() => '');
  check('B2 one-minute window: T-OFFSET + unrecognised (incl T-NAIVE) kept and counted', cnt2.includes('符合条件 8 / 已加载 12') && note2.includes('7 条时间无法识别') && (await vis('article[aria-label="任务 T-LEGACY"]')) && !(await vis('article[aria-label="任务 T-PLUS8"]')), `${cnt2} | ${note2}`);
  await page.locator('.hist-filter-inspect').click();
  check('B2 inspect under time window narrows to the unrecognised set', (await page.locator('.hist-filter-count').textContent()).includes('符合条件 7 /'));
  await page.locator('.hist-filter-foot .hist-filter-clear').click();

  // ── R4/B3 long fields, overflow at 1024/1440; clipped details without a toggle ──
  const lw = { lane: 'lane-' + 'l'.repeat(200), model: 'model-' + 'm'.repeat(200), variant: 'v-' + 'x'.repeat(80), name: 'worker-' + 'n'.repeat(200) };
  const realWho = { lane: 'opencode', model: 'openrouter/qwen3.8-coder-flash-preview-0901', variant: 'high', name: 'w-medium-worker', by: 'coordinator' };
  const longRows = [
    { event: 'dispatched', package: 'R-LONGWHO', ...lw, by: 'by-' + 'b'.repeat(300) },
    { event: 'status_' + 'x'.repeat(200), package: 'R-LONGKIND' }, { event: 'weird_' + 'k'.repeat(200), package: 'R-LONGKIND' },
    { event: 'delivered', package: 'R-DETAIL377', lane: 'codex', model: 'gpt-5.6-luna', name: 'w', detail: '交付说明'.repeat(94) + '完' },
    ...[40, 60, 70, 79, 80].map((n) => ({ event: 'status_owner_playtest', package: `R-CJK${n}`, ...realWho, detail: '中文详情说明文字'.repeat(12).slice(0, n) })),
    { event: 'delivered', package: 'R-PATH79', ...realWho, detail: 'E:/some/very/long/unbroken/path/segment/that/keeps/going/and/going/file.txt'.slice(0, 79) },
  ].map((r, i) => ({ seq: i + 1, at: `2026-09-01T01:${String(i).padStart(2, '0')}:00.000Z`, lane: null, model: null, variant: null, name: null, by: 'board', detail: '', ...r }));
  await load(longRows, /已读取全部/);
  const lwText = await page.locator('article[aria-label="任务 R-LONGWHO"] .hist-event-line').innerText();
  check('R4 long lane/model/variant/name/by all fully present', [lw.lane, lw.model, lw.variant, lw.name, 'b'.repeat(300)].every((s) => lwText.includes(s)));
  for (const w of [1024, 1440]) {
    await page.setViewportSize({ width: w, height: 900 }); await sleep(300);
    const r = await page.evaluate(() => {
      const s = document.querySelector('.hist-events-section'); const right = s.getBoundingClientRect().right;
      const over = []; document.querySelectorAll('.hist-event-line *, .hist-group-head > *, .hist-filters select, .hist-filters input').forEach((el) => { const d = Math.round(el.getBoundingClientRect().right - right); if (d > 0) over.push(`${el.className || el.tagName}:+${d}`); });
      const clippedNoToggle = []; const clipped = [];
      document.querySelectorAll('.hist-ev-detail:not(.expanded)').forEach((d) => { if (d.scrollHeight > d.clientHeight + 1) { const art = d.closest('article')?.getAttribute('aria-label'); clipped.push(art); if (!d.parentElement.querySelector('.hist-ev-detail-toggle')) clippedNoToggle.push(`${art} len=${d.textContent.length} w=${Math.round(d.getBoundingClientRect().width)}`); } });
      const narrowWho = []; document.querySelectorAll('.hist-ev-who, .hist-ev-by, .hist-ev-kind').forEach((el) => { if (el.getBoundingClientRect().width < 40 && el.textContent.length > 8) narrowWho.push(`${el.className}:${Math.round(el.getBoundingClientRect().width)}`); });
      return { doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, sec: s.scrollWidth - s.clientWidth, over, clipped, clippedNoToggle, narrowWho };
    });
    check(`R4 no horizontal overflow at ${w}px (long who/by/kind/variant)`, r.doc <= 0 && r.sec <= 0 && r.over.length === 0, JSON.stringify({ doc: r.doc, sec: r.sec, over: r.over.slice(0, 5) }));
    check(`B3 every clipped detail has an expand control at ${w}px`, r.clippedNoToggle.length === 0, JSON.stringify({ clipped: r.clipped, clippedNoToggle: r.clippedNoToggle }));
    note(`R4 squeezed who/by/kind columns at ${w}px (<40px wide)`, JSON.stringify(r.narrowWho.slice(0, 6)));
    for (const pkg of ['R-LONGWHO', 'R-LONGKIND', 'R-DETAIL377', 'R-CJK79']) await page.locator(`article[aria-label="任务 ${pkg}"]`).screenshot({ path: path.join(SHOTS, `${pkg}-${w}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // ── F1 opener identity + click-during-load cancels restore (revision 6) ──
  await load(gen(5600), /还没读完/);
  ctl.delayMs = 300;
  await page.locator('.hist-reset-secondary').focus(); await page.keyboard.press('Enter'); await sleep(80);
  await waitCov(/还没读完/, 40000); await sleep(150);
  check('F1 opener identity: keyboard 全部重新读取 restores focus to the SAME button, not the first toolbar one', (await active()) === 'BUTTON.hist-reset-secondary', await active());

  // F5: a reread resets events to [] the instant loading starts (scanReducer 'scan/start'), so a click
  // right after starting lands while the page is still short — the same window the reviewer's probe
  // used — rather than mid-way through a long continue, where organic content growth alone shifts
  // scrollY and would make this assertion meaningless.
  await page.locator('.hist-reset-secondary').focus(); await page.keyboard.press('Enter'); await sleep(100);
  await page.locator('.hist-workers-section h3').click();
  const yClick = await page.evaluate(() => window.scrollY);
  const activeAtClick = await active();
  await waitCov(/还没读完/, 40000); await sleep(250);
  const yAfterClick = await page.evaluate(() => window.scrollY);
  const activeAfterClick = await active();
  check(
    'F5 click on non-focusable content during load cancels the restore: focus/scroll stay where the operator left them',
    activeAfterClick === activeAtClick && Math.abs(yAfterClick - yClick) < 5,
    `atClick=${activeAtClick} y=${yClick} → after=${activeAfterClick} y=${yAfterClick}`,
  );
  ctl.delayMs = 0;

  ctl.requests = [];
  await page.locator('.hist-load-more').click();
  await waitCov(/已读取全部/);
  await page.locator('.hist-refresh').focus(); await page.keyboard.press('Enter');
  await waitCov(/已读取全部/); await sleep(150);
  check('F1 opener identity: keyboard 刷新新事件 restores focus to itself when still the same action after completing', (await active()) === 'BUTTON.hist-refresh', await active());

  // ── lanes polling: failure, hang, recovery (D2: real AbortController on the timeout + unmount) ──
  ctl.events = gen(20);
  ctl.lanesMode = 'fail'; await page.reload(); await waitCov(/已读取全部/);
  const headFail = await until(() => page.locator('.history-timestamp').innerText(), (t) => t.includes('刷新失败'), 8000);
  // Note 2 fixed this: a failure before any success ever landed must not say 加载中 nor claim
  // 仍显示上一次的结果 (there is nothing to fall back to yet).
  check('note2 lanes initial failure: no 加载中, no false 仍显示上一次的结果 claim', headFail.includes('刷新失败') && !headFail.includes('加载中') && !headFail.includes('仍显示上一次的结果'), headFail);
  const ptFail = await page.locator('.hist-project-tests').innerText();
  const tbFail = await page.locator('.hist-workers-section tbody').innerText();
  check('HON-project-tests: on first lanes failure, panel says the read failed, never "not configured" (revision 6 F2)', !ptFail.includes('没有配置验证进度文件') && ptFail.includes('读取失败'), ptFail.replace(/\s+/g, ' '));
  check('HON-table: on first lanes failure, worker table says the read failed, never "暂无派出记录" (revision 6 F2)', !tbFail.includes('暂无派出记录') && tbFail.includes('读取失败'), tbFail.replace(/\s+/g, ' '));
  ctl.lanesMode = 'ok';
  const headRec = await until(() => page.locator('.history-timestamp').innerText(), (t) => /更新于 \d/.test(t) && !t.includes('刷新失败'), 8000);
  check('lanes recovers on next poll after failure', /更新于 \d/.test(headRec) && !headRec.includes('刷新失败'), headRec);
  const good = headRec.match(/更新于 (\S+)/)?.[1];
  ctl.lanesMode = 'hang'; ctl.lanesReqs = []; ctl.lanesOverlap = 0;
  const headHang = await until(() => page.locator('.history-timestamp').innerText(), (t) => /超时/.test(t), 16000);
  check('lanes hang: bounded, shows last good time + timeout failure (now WITH 仍显示上一次的结果), table data kept', headHang.includes(good) && /超时/.test(headHang) && headHang.includes('仍显示上一次的结果') && (await page.locator('.hist-workers-section tbody tr').first().innerText()).includes('P-ORDER'), headHang);
  ctl.lanesMode = 'ok';
  await sleep(12000);
  check('lanes hang: no concurrent pileup', ctl.lanesOverlap === 0, `overlap=${ctl.lanesOverlap}`);
  check('D2: lanes hang — own read is really aborted and polling resumes after the timeout', ctl.lanesReqs.length >= 2, `lanes requests in 20+s since hang began=${ctl.lanesReqs.length}; header="${await page.locator('.history-timestamp').innerText()}"`);
  ctl.hangs.splice(0).forEach((r) => r());
  await sleep(6000);
  note('lanes after the hung request finally settles', `requests=${ctl.lanesReqs.length} header="${await page.locator('.history-timestamp').innerText()}"`);
  ctl.lanesMode = 'hang'; ctl.lanesReqs = [];
  await page.reload(); await waitCov(/已读取全部/);
  const ptPending = await page.locator('.hist-project-tests').innerText();
  const tbPending = await page.locator('.hist-workers-section tbody').innerText();
  check('HON-project-tests pending: while the very first lanes read is still in flight, panel reads as pending, never "not configured"', !ptPending.includes('没有配置验证进度文件') && ptPending.includes('正在读取'), ptPending.replace(/\s+/g, ' '));
  check('HON-table pending: while the very first lanes read is still in flight, table reads as pending, never "暂无派出记录"', !tbPending.includes('暂无派出记录') && tbPending.includes('正在读取'), tbPending.replace(/\s+/g, ' '));
  const headInitHang = await until(() => page.locator('.history-timestamp').innerText(), (t) => /超时/.test(t), 12000);
  check('note2 lanes initial hang timeout: no false 仍显示上一次的结果 either (still no success yet)', /超时/.test(headInitHang) && !headInitHang.includes('仍显示上一次的结果'), headInitHang);
  ctl.lanesMode = 'ok'; ctl.hangs.splice(0).forEach((r) => r());

  // ── theme media ──
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme }); await sleep(200);
    const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.hist-events-section')).backgroundImage.slice(0, 60));
    note(`palette under prefers-color-scheme ${scheme}`, bg);
  }
  await page.emulateMedia({ colorScheme: null });
} catch (err) {
  check('probe completed without exception', false, err.stack?.split('\n').slice(0, 4).join(' | '));
  await page.screenshot({ path: path.join(SHOTS, 'failure.png') }).catch(() => undefined);
} finally {
  ctl.hangs.splice(0).forEach((r) => r());
  check('no non-GET requests issued by the page', ctl.writes === 0, ctl.blocked.filter((b) => !b.startsWith('offsite')).join(', ') || 'none');
  const offsiteHosts = [...new Set(ctl.blocked.filter((b) => b.startsWith('offsite')).map((b) => b.split(' ')[1].split('/')[0]))];
  check('off-origin requests only to font hosts (all aborted)', offsiteHosts.every((h) => /^fonts\.(googleapis|gstatic)\.com$/.test(h)), offsiteHosts.join(','));
  check('no pageerror', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  // Classify every console error by URL AND by the injection that should have produced it — never a
  // blanket ignore of console errors as a class.
  const cls = { font: 0, events500: 0, lanes500: 0, api404: 0 }; const unexpected = [];
  for (const m of consoleAll) {
    if (m.type !== 'error') continue;
    const u = m.url;
    if (/^Failed to load resource: net::ERR_FAILED/.test(m.text) && /fonts\.(googleapis|gstatic)\.com/.test(u)) cls.font += 1;
    else if (/status of 500/.test(m.text) && /\/api\/events\?/.test(u)) cls.events500 += 1;
    else if (/status of 500/.test(m.text) && /\/api\/lanes$/.test(u)) cls.lanes500 += 1;
    else if (/status of 404/.test(m.text) && /\/api\//.test(u)) cls.api404 += 1;
    else unexpected.push(m);
  }
  note('console errors classified', JSON.stringify({ ...cls, injected: { offsite: ctl.injected.offsite, events500: ctl.injected.events500, lanes500: ctl.injected.lanes500, api404: [...new Set(ctl.injected.api404)] } }));
  check('classified console errors do not exceed their injections', cls.font <= ctl.injected.offsite && cls.events500 <= ctl.injected.events500 && cls.lanes500 <= ctl.injected.lanes500 && cls.api404 <= ctl.injected.api404.length, JSON.stringify(cls));
  check('no unexpected console errors', unexpected.length === 0, JSON.stringify(unexpected.slice(0, 5)));
  note('console warnings', JSON.stringify(consoleAll.filter((m) => m.type === 'warning').slice(0, 5)));
  const summary = { pass: results.filter((r) => r.pass === true).length, fail: results.filter((r) => r.pass === false).length, notes: results.filter((r) => r.pass === null).length };
  console.log('SUMMARY', JSON.stringify(summary));
  fs.writeFileSync(path.join(OUT, 'history-regression-results.json'), JSON.stringify({ summary, results }, null, 2));
  await browser.close();
}
