// Real-browser regression for ThreadsView's async scope guards (project switch, route change, bulk
// races, unmount, dialog focus — see threadAsyncGuards.ts and the ThreadsView effects that use it). This
// drives a real Chromium tab through Playwright's core driver, so it verifies the real browser behavior
// these guards depend on — actual navigation timing, actual focus/blur and a real event loop — rather than
// what a function returns given fixed inputs (threadAsyncGuards.test.ts and bulkComponents.test.tsx
// already cover that half).
//
// Every request to `ORIGIN` is intercepted: static files come from a built `web/dist`, every `/api` call
// is answered from in-memory fixtures (regressionFixtures.mjs), and `route.continue()` is never called —
// any other host is aborted. Nothing here ever reaches a live server. Playwright discovery/launch lives in
// regressionPlaywrightResolver.mjs, split out to keep this file under the project's line-count limit.
//
// Prerequisites (none of this is an npm dependency of the project — it reuses whatever Playwright/
// Chromium install is already on the machine running it, the same way a `webapp-testing`-style script
// would):
//   1. `npm run build` in `web/` (or `vite build --outDir <dir>` and point DIST at it).
//   2. A Playwright Node or Python install with its Chromium browser downloaded, so a driver entry point
//      and a Chromium executable both exist on disk somewhere.
// Configure via environment variables. None of these default to a machine-specific path — point them at
// whatever Playwright install already exists on the machine running this, or leave PLAYWRIGHT_DRIVER unset
// to let Node resolve an installed `playwright`/`playwright-core` package instead:
//   PLAYWRIGHT_DRIVER           path to a driver entry point, e.g. a Python install's
//                                `.../playwright/driver/package/index.mjs`. Omit to resolve an installed
//                                `playwright`/`playwright-core` npm package instead.
//   PLAYWRIGHT_CHROME           path to the Chromium executable. Omit to let the resolved driver find its
//                                own installed browser.
//   THREADS_REGRESSION_DIST     path to a built `web/dist` (must exist; this script never builds it);
//                                defaults to `web/dist` next to this file.
//   THREADS_REGRESSION_PORT     port the mock origin binds to in URLs only (no real listener; default 3532)
//   THREADS_REGRESSION_RESULTS  path to write the results JSON. Omit to get a fresh `os.tmpdir()` folder
//                                per run (printed at the end) — never written next to source.
// Run: `node src/components/threads/threadsAsyncRegression.browser.mjs` from `web/`. Results are printed
// to stdout and written as JSON to THREADS_REGRESSION_RESULTS or the generated temp path, for
// scenario-by-scenario inspection.
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveChromium, launchChromium } from './regressionPlaywrightResolver.mjs';
import { thread } from './regressionFixtures.mjs';
import { createRec, createScenarioRunner, wait } from './regressionHarness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DIST = process.env.THREADS_REGRESSION_DIST || path.join(HERE, '..', '..', '..', 'dist');
const PORT = process.env.THREADS_REGRESSION_PORT || '3532';
const ORIGIN = `http://127.0.0.1:${PORT}`;
const RESULTS_FILE = process.env.THREADS_REGRESSION_RESULTS
  ? path.resolve(process.env.THREADS_REGRESSION_RESULTS)
  : path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'threads-async-regression-')),
      'threadsAsyncRegression.results.json',
    );

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  throw new Error(
    `No build at ${DIST} (index.html missing). Run \`npm run build\` in web/ first, or set ` +
      `THREADS_REGRESSION_DIST to an existing build.`,
  );
}

const chromium = await resolveChromium();

const results = [];
const rec = createRec(results);

const browser = await launchChromium(chromium);
const runScenario = createScenarioRunner(browser, { origin: ORIGIN, dist: DIST, results, rec });
// Every call site below still reads `scenario(browser, name, fn, opts)` — the leading `browser` arg is
// kept only so none of them needed touching when the runner moved into regressionHarness.mjs.
const scenario = (_browser, name, fn, opts) => runScenario(name, fn, opts);

// S0 — deep link / reload on a thread route: the first snapshot always lands after mount (projectId undefined → id).
await scenario(browser, 'S0-deeplink', async (h) => {
  await h.open('#/threads/a1');
  await wait(1200);
  const o = await h.observe();
  const details = h.s.log.filter((e) => e.key === 'detail');
  rec('S0-deeplink', 'opening #/threads/a1 directly shows A-一号 in the pane', o.pane === 'A-一号', { observed: o, detailRequests: details.map((e) => e.path) });
  await h.row('A-一号').click();
  await wait(400);
  const o2 = await h.observe();
  rec('S0-deeplink', 'clicking the highlighted row of the same route reopens the pane', o2.pane === 'A-一号', { observed: o2 });
});

await scenario(browser, 'S0b-deeplink-snapshot-late', async (h) => {
  h.hold('snapshot');
  await h.page.goto(`${ORIGIN}/#/threads/a1`);
  await h.page.waitForSelector('.thread-detail-head h2', { timeout: 5000 });
  const before = await h.observe();
  const snap = await h.queued('snapshot');
  h.take('snapshot');
  await snap.release();
  await h.page.waitForFunction(() => document.title.startsWith('项目'), null, { timeout: 5000 });
  await wait(800);
  const after = await h.observe();
  rec('S0b-deeplink-snapshot-late', 'pane showing A-一号 before the first snapshot survives the first snapshot', after.pane === 'A-一号', { before, after });
});

// S1 — project A → B with pending A list + A detail; B list held.
await scenario(browser, 'S1-project-switch', async (h) => {
  await h.open('#/threads');
  await h.row('A-一号').click();
  await h.page.waitForSelector('.thread-detail-head h2');
  await h.page.fill('.thread-composer textarea', 'A 的草稿');
  await h.check('A-二号').check();
  // pending A list (search) and pending A detail (open a3)
  h.hold('list');
  await h.page.fill('input[type=search]', '号');
  const aList = await h.queued('list', 1);
  h.hold('detail');
  await h.row('A-三号').click();
  const aDetail = await h.queued('detail', 1);
  await wait(150);
  const beforeSwitch = await h.observe();
  h.hold('list');
  const m = h.mark();
  await h.switchProject('B');
  await wait(150);
  const afterSwitch = await h.observe();
  rec('S1-project-switch', 'right after the switch no project-A rows remain on screen', !afterSwitch.rows.some((r) => r.startsWith('A-')), { beforeSwitch, afterSwitch });
  rec('S1-project-switch', 'selection is cleared on switch', /已选 0/.test(afterSwitch.count || ''), afterSwitch.count);

  // release old A responses after the switch
  h.take('list');
  await aList.release([200, { threads: [...h.s.data.A.filter((t) => !t.trashed), thread('late', 'A-迟到号')] }]);
  h.take('detail');
  await aDetail.release();
  await wait(300);
  const afterStale = await h.observe();
  rec('S1-project-switch', 'stale A list response does not overwrite the view (no A-迟到号)', !afterStale.rows.includes('A-迟到号'), afterStale.rows);
  rec('S1-project-switch', 'stale A detail (a3) does not appear in the pane', afterStale.pane !== 'A-三号', afterStale);

  // interact with stale A rows while B list still pending
  const bList = await h.queued('list', 1);
  const staleVisible = afterStale.rows.some((r) => r.startsWith('A-'));
  let staleBulk = [];
  let staleDetail = [];
  if (staleVisible) {
    const m2 = h.mark();
    await h.check('A-一号').check({ timeout: 1500 }).catch(() => {});
    await h.bulkBtn('置顶').click({ timeout: 1500 }).catch(() => {});
    await wait(300);
    staleBulk = h.since(m2, 'bulk').map((e) => ({ body: e.body, serverProject: e.serverProject }));
    const m3 = h.mark();
    await h.row('A-二号').click({ timeout: 1500 }).catch(() => {});
    await wait(300);
    staleDetail = h.since(m3, 'detail').map((e) => ({ path: e.path, serverProject: e.serverProject }));
  }
  const whilePending = await h.observe();
  // G5: a real PASS/FAIL only when a stale row was actually there to interact with — otherwise this
  // asserts nothing (the click had no target) and says so as a NOTE instead of a silent, vacuous pass.
  rec('S1-project-switch', 'no bulk POST carrying project-A ids is sent to project B from stale rows', staleVisible ? staleBulk.length === 0 : null, { staleVisible, staleBulk, whilePending });
  rec('S1-project-switch', 'no detail GET for a project-A id is sent to project B from stale rows', staleVisible ? staleDetail.length === 0 : null, { staleVisible, staleDetail });
  h.take('list');
  await bList.release();
  await wait(400);
  const final = await h.observe();
  rec('S1-project-switch', 'after B list lands, B rows show', final.rows.some((r) => r.startsWith('B-')), final);
  rec('S1-project-switch', 'reply draft typed for A is not carried into project B', final.draft === null || final.draft === '', final);
  const crossA = h.since(m).filter((e) => /\/api\/threads\/(a\d|late)/.test(e.path) || (e.body || '').includes('"a'));
  rec('S1-project-switch', 'requests referencing A ids after the switch (all listed, incl. owner-clicked)', null, crossA.map((e) => ({ key: e.key, path: e.path, body: e.body, serverProject: e.serverProject })));
});

// S1b — same thread id in both projects; route unchanged across the switch.
await scenario(browser, 'S1b-same-id-route', async (h) => {
  await h.open('#/threads');
  await h.row('A-同号ID').click();
  await h.page.waitForSelector('.thread-detail-head h2');
  await h.page.fill('#th-reply-author', '测试');
  await h.page.fill('.thread-composer textarea', '给A的回复草稿');
  const m = h.mark();
  await h.switchProject('B');
  await wait(900);
  const o = await h.observe();
  rec('S1b-same-id-route', 'route #/threads/same still open after switch → pane shows B-同号ID (reloaded)', o.pane === 'B-同号ID', { observed: o, detailAfter: h.since(m, 'detail').map((e) => e.path) });
  await h.row('B-同号ID').click();
  await wait(500);
  const o2 = await h.observe();
  rec('S1b-same-id-route', 'clicking the highlighted B-同号ID row brings the pane back', o2.pane === 'B-同号ID', o2);
  await h.row('B-一号').click();
  await h.page.waitForSelector('.thread-detail-head h2');
  const o3 = await h.observe();
  rec('S1b-same-id-route', 'A reply draft is not in the B-一号 composer', o3.draft === '', o3);
});

// S1c — list error from A still visible during B pending load.
await scenario(browser, 'S1c-list-error', async (h) => {
  await h.open('#/threads');
  h.hold('list');
  await h.page.selectOption('.filters-grid select', 'all');
  const l = await h.queued('list');
  h.take('list');
  await l.release([500, { error: 'A 项目读取失败' }]);
  await wait(200);
  const before = await h.observe();
  h.hold('list');
  await h.switchProject('B');
  await wait(200);
  const o = await h.observe();
  rec('S1c-list-error', 'project A list error is not shown under project B', o.listError === null, { before, after: o });
  const bl = await h.queued('list');
  h.take('list');
  await bl.release();
});

// S2 — B2 bulk then navigate to C.
await scenario(browser, 'S2-bulk-then-route', async (h) => {
  await h.open('#/threads');
  await h.row('A-一号').click();
  await h.page.waitForSelector('.thread-detail-head h2');
  await h.page.fill('#th-reply-author', '测试');
  await h.check('A-一号').check();
  await h.check('A-二号').check();
  h.hold('bulk');
  await h.bulkBtn('关闭').click();
  const b = await h.queued('bulk');
  await h.row('A-三号').click();
  await h.page.waitForFunction(() => document.querySelector('.thread-detail-head h2')?.textContent === 'A-三号');
  const m = h.mark();
  h.take('bulk');
  await b.release();
  await wait(500);
  const o = await h.observe();
  rec('S2-bulk-then-route', 'after close(A1,A2) lands on route a3, pane stays A-三号', o.pane === 'A-三号' && o.hash === '#/threads/a3', o);
  rec('S2-bulk-then-route', 'no reload of a1 detail after route moved', h.since(m, 'detail').every((e) => !e.path.endsWith('/a1')), h.since(m).map((e) => e.path));
  rec('S2-bulk-then-route', 'status reports the run honestly', /已关闭 2 个主题/.test(o.status || ''), o.status);
  const m2 = h.mark();
  await h.page.fill('.thread-composer textarea', '给三号');
  await h.page.getByRole('button', { name: '发送回复' }).click();
  await wait(400);
  const replies = h.since(m2, 'reply').map((e) => e.path);
  rec('S2-bulk-then-route', 'the next reply targets a3', replies.length === 1 && replies[0] === '/api/threads/a3/messages', replies);
});

await scenario(browser, 'S2b-trash-then-route', async (h) => {
  await h.open('#/threads');
  await h.row('A-一号').click();
  await h.page.waitForSelector('.thread-detail-head h2');
  await h.check('A-一号').check();
  await h.bulkBtn('删除').click();
  await h.page.waitForSelector('.tb-confirm');
  h.hold('bulk');
  await h.page.locator('.tb-confirm .btn.danger').click();
  const b = await h.queued('bulk');
  await h.row('A-三号').click();
  await h.page.waitForFunction(() => document.querySelector('.thread-detail-head h2')?.textContent === 'A-三号');
  h.take('bulk');
  await b.release();
  await wait(500);
  const o = await h.observe();
  rec('S2b-trash-then-route', 'trashing A1 does not close C (route stays a3, pane A-三号)', o.hash === '#/threads/a3' && o.pane === 'A-三号', o);
});

// S2c — stale closure: filter changed while bulk pending; the post-bulk reload must use the current filter.
await scenario(browser, 'S2c-bulk-then-filter', async (h) => {
  await h.open('#/threads');
  await h.check('A-一号').check();
  h.hold('bulk');
  await h.bulkBtn('置顶').click();
  const b = await h.queued('bulk');
  await h.page.selectOption('.filters-grid select', 'closed');
  await wait(400);
  const mid = await h.observe();
  const m = h.mark();
  h.take('bulk');
  await b.release();
  await wait(600);
  const o = await h.observe();
  const lists = h.since(m, 'list').map((e) => e.path);
  rec('S2c-bulk-then-filter', 'post-bulk list reload uses the current filter (status=closed)', lists.length > 0 && lists.every((p) => p.includes('status=closed')), { lists, mid, after: o });
  rec('S2c-bulk-then-filter', 'list under 已关闭 shows only closed rows after the bulk lands', o.rows.every((r) => r.startsWith('A-四号关')), o.rows);
  rec('S2c-bulk-then-filter', 'selection before filter change (a1) is cleared by the filter change', /已选 0/.test(mid.count || ''), mid.count);
});

// S3 — pane still shows A while C detail is pending.
await scenario(browser, 'S3-stale-pane-while-loading', async (h) => {
  await h.open('#/threads');
  await h.row('A-一号').click();
  await h.page.waitForSelector('.thread-detail-head h2');
  await h.page.fill('#th-reply-author', '测试');
  h.hold('detail');
  await h.row('A-三号').click();
  const d = await h.queued('detail');
  await wait(150);
  const mid = await h.observe();
  rec('S3-stale-pane-while-loading', 'while route is a3 and its detail pending, pane no longer offers A-一号 controls', mid.pane !== 'A-一号', mid);
  const m = h.mark();
  await h.paneBtn('置顶').click({ timeout: 1000 }).catch(() => {});
  await wait(250);
  const pins = h.since(m, 'pin').map((e) => e.path);
  rec('S3-stale-pane-while-loading', 'no pin POST for a1 while route is a3', pins.length === 0, pins);
  const m2 = h.mark();
  await h.page.fill('.thread-composer textarea', '错投').catch(() => {});
  await h.page.getByRole('button', { name: '发送回复' }).click({ timeout: 1000 }).catch(() => {});
  await wait(250);
  const o = await h.observe();
  const replies = h.since(m2, 'reply').map((e) => e.path);
  rec('S3-stale-pane-while-loading', 'no reply POST to a1 while route is a3', replies.length === 0, replies);
  rec('S3-stale-pane-while-loading', 'the blocked send says why (refusal text visible)', Boolean(o.refusal), o);
  h.take('detail');
  await d.release();
  await wait(300);
  const end = await h.observe();
  rec('S3-stale-pane-while-loading', 'pane shows A-三号 after its detail lands', end.pane === 'A-三号', end);
});

await scenario(browser, 'S3b-reply-draft-wipe', async (h) => {
  await h.open('#/threads');
  await h.row('A-一号').click();
  await h.page.waitForSelector('.thread-detail-head h2');
  await h.page.fill('#th-reply-author', '测试');
  await h.page.fill('.thread-composer textarea', '一号回复');
  h.hold('reply');
  await h.page.getByRole('button', { name: '发送回复' }).click();
  const r = await h.queued('reply');
  await h.row('A-三号').click();
  await h.page.waitForFunction(() => document.querySelector('.thread-detail-head h2')?.textContent === 'A-三号');
  const carried = (await h.observe()).draft;
  await h.page.fill('.thread-composer textarea', '三号草稿');
  h.take('reply');
  await r.release();
  await wait(400);
  const o = await h.observe();
  rec('S3b-reply-draft-wipe', 'draft being typed for a3 survives a1 reply completing', o.draft === '三号草稿', { carriedIntoA3: carried, after: o });
  rec('S3b-reply-draft-wipe', 'a1 draft is not carried into the a3 composer while the a1 reply is pending', carried === '', carried);
  // Ctrl+Enter while a reply is pending
  await h.page.fill('.thread-composer textarea', '双发');
  h.hold('reply');
  const m = h.mark();
  await h.page.focus('.thread-composer textarea');
  await h.page.keyboard.press('Control+Enter');
  await h.queued('reply', 1);
  await h.page.keyboard.press('Control+Enter');
  await wait(300);
  const sent = h.since(m, 'reply').length;
  rec('S3b-reply-draft-wipe', 'Ctrl+Enter twice while submitting sends one reply', sent === 1, { sent });
  for (const q of h.s.queues.reply.splice(0)) await q.release();
});

// S4 — restore from pane while route moved.
await scenario(browser, 'S4-restore-route', async (h) => {
  await h.open('#/threads');
  await h.page.getByRole('button', { name: '打开回收站' }).click();
  await h.page.waitForSelector('.thread-item >> text=A-回收号');
  await h.row('A-回收号').first().click();
  await h.page.waitForFunction(() => document.querySelector('.thread-detail-head h2')?.textContent === 'A-回收号');
  h.hold('detail');
  await h.row('A-回收二号').click();
  const d = await h.queued('detail');
  const m = h.mark();
  await h.paneBtn('还原出回收站').click({ timeout: 1000 }).catch(() => {});
  await wait(300);
  const restores = h.since(m, 'bulk').map((e) => e.body);
  rec('S4-restore-route', 'no restore POST for a9 once route moved to a8 (pre-POST check)', restores.length === 0, { restores, observed: await h.observe() });
  h.take('detail');
  await d.release();
  await wait(300);
});

await scenario(browser, 'S4b-restore-report-dropped', async (h) => {
  await h.open('#/threads');
  await h.page.getByRole('button', { name: '打开回收站' }).click();
  await h.page.waitForSelector('.thread-item >> text=A-回收号');
  await h.row('A-回收号').first().click();
  await h.page.waitForFunction(() => document.querySelector('.thread-detail-head h2')?.textContent === 'A-回收号');
  h.hold('bulk');
  await h.paneBtn('还原出回收站').click();
  const b = await h.queued('bulk');
  await h.row('A-回收二号').click();
  await h.page.waitForFunction(() => document.querySelector('.thread-detail-head h2')?.textContent === 'A-回收二号');
  const m = h.mark();
  h.take('bulk');
  await b.release();
  await wait(600);
  const o = await h.observe();
  rec('S4b-restore-report-dropped', 'a successful restore is still reported after the owner moved on', /还原/.test(o.status || ''), o);
  rec('S4b-restore-report-dropped', 'the recycle list refreshes after the restore (a9 gone)', !o.rows.some((r) => r.startsWith('A-回收号')), { rows: o.rows, listAfter: h.since(m, 'list').map((e) => e.path) });
});

// S5 — F5 dialog keyboard, confirm focus, partial failure, prune.
await scenario(browser, 'S5-dialog-focus', async (h) => {
  await h.open('#/threads');
  await h.check('A-一号').check();
  await h.check('A-二号').check();
  await h.bulkBtn('删除').focus();
  await h.page.keyboard.press('Enter');
  await h.page.waitForSelector('.tb-confirm');
  const o1 = await h.observe();
  rec('S5-dialog-focus', 'initial focus on 取消', o1.active.startsWith('BUTTON|取消'), o1.active);
  await h.page.keyboard.press('Tab');
  const t1 = (await h.observe()).active;
  await h.page.keyboard.press('Tab');
  const t2 = (await h.observe()).active;
  await h.page.keyboard.press('Shift+Tab');
  const t3 = (await h.observe()).active;
  rec('S5-dialog-focus', 'Tab/Shift+Tab wrap inside the dialog', t1.includes('确认') && t2.startsWith('BUTTON|取消') && t3.includes('确认'), { t1, t2, t3 });
  await h.page.keyboard.press('Escape');
  await wait(150);
  const o2 = await h.observe();
  rec('S5-dialog-focus', 'Escape closes and returns focus to 删除', !o2.dialog && o2.active.startsWith('BUTTON|删除'), o2);

  await h.page.keyboard.press('Enter');
  await h.page.waitForSelector('.tb-confirm');
  h.s.bulkOverride = (action, ids) => {
    const a = h.s.data.A.find((t) => t.id === 'a1'); a.trashed = true;
    return { action, changed: 1, failed: 1, results: [{ id: 'a1', ok: true }, { id: 'a2', ok: false, error: 'thread is already in the recycle bin' }] };
  };
  h.hold('bulk');
  await h.page.keyboard.press('Tab');
  await h.page.keyboard.press('Enter');
  await h.queued('bulk');
  await wait(100);
  const o3 = await h.observe();
  rec('S5-dialog-focus', 'after confirm (busy, 删除 disabled) focus lands on the search box, not body', o3.active.startsWith('INPUT|搜索主题'), o3);
  const b = h.take('bulk');
  await b.release();
  await wait(500);
  const o4 = await h.observe();
  rec('S5-dialog-focus', 'partial result names the failed id and reason', /部分完成：1 个已放入回收站，1 个失败（a2：这个主题已经在回收站里了）/.test(o4.status || ''), o4.status);
  rec('S5-dialog-focus', 'failed id stays selected', /已选 1/.test(o4.count || ''), o4.count);
  rec('S5-dialog-focus', 'focus not stranded on body after the run', o4.active !== 'BODY', o4.active);
  h.s.bulkOverride = null;

  // prune empties selection while the dialog is open
  await h.bulkBtn('删除').click();
  await h.page.waitForSelector('.tb-confirm');
  h.s.data.A.find((t) => t.id === 'a2').trashed = true;
  const m = h.mark();
  const end = Date.now() + 13000;
  while (Date.now() < end && h.since(m, 'list').length === 0) await wait(100);
  await wait(400);
  const o5 = await h.observe();
  rec('S5-dialog-focus', 'poll prune closes the dialog and clears selection', !o5.dialog && /已选 0/.test(o5.count || ''), { o5, polled: h.since(m, 'list').length });
  rec('S5-dialog-focus', 'focus after prune-close is not body', o5.active !== 'BODY', o5.active);
  await h.check('A-三号').check();
  await wait(200);
  const o6 = await h.observe();
  rec('S5-dialog-focus', 'next checkbox tick does not reopen the dialog', !o6.dialog, o6);
  // normal trash keyboard path
  const m2 = h.mark();
  await h.bulkBtn('删除').focus();
  await h.page.keyboard.press('Enter');
  await h.page.waitForSelector('.tb-confirm');
  await h.page.keyboard.press('Tab');
  await h.page.keyboard.press('Enter');
  await wait(500);
  const o7 = await h.observe();
  const bodies = h.since(m2, 'bulk').map((e) => e.body);
  rec('S5-dialog-focus', 'normal keyboard trash sends exactly the selected id and reports', bodies.length === 1 && bodies[0] === '{"action":"trash","ids":["a3"]}' && /已放入回收站 1 个主题/.test(o7.status || ''), { bodies, o7 });
});

// S6 — recycle-bin toggle with a live selection and the bin list pending.
await scenario(browser, 'S6-trash-toggle-selection', async (h) => {
  await h.open('#/threads');
  await h.check('A-一号').check();
  h.hold('list');
  await h.page.getByRole('button', { name: '打开回收站' }).click();
  await h.queued('list');
  await wait(150);
  const o = await h.observe();
  const m = h.mark();
  await h.bulkBtn('还原所选').click({ timeout: 1000 }).catch(() => {});
  await wait(300);
  const bodies = h.since(m, 'bulk').map((e) => e.body);
  rec('S6-trash-toggle-selection', 'switching to the recycle bin clears the live selection', /已选 0/.test(o.count || ''), o);
  rec('S6-trash-toggle-selection', 'no restore POST with a live (non-trashed) id from the carried selection', bodies.length === 0, { bodies, status: (await h.observe()).status });
  const l = h.take('list');
  await l.release();
});

// S7 — unmount mid-flight (leave the tab while trash of the active thread is pending).
await scenario(browser, 'S7-unmount', async (h) => {
  await h.open('#/threads');
  await h.row('A-一号').click();
  await h.page.waitForSelector('.thread-detail-head h2');
  await h.check('A-一号').check();
  await h.bulkBtn('删除').click();
  await h.page.waitForSelector('.tb-confirm');
  h.hold('bulk');
  await h.page.locator('.tb-confirm .btn.danger').click();
  const b = await h.queued('bulk');
  await h.page.evaluate(() => { location.hash = '#/board'; });
  await wait(300);
  const m = h.mark();
  h.take('bulk');
  await b.release();
  await wait(700);
  const o = await h.observe();
  rec('S7-unmount', 'after leaving to #/board, the finished trash run does not navigate back to threads', o.hash === '#/board', o.hash);
  rec('S7-unmount', 'no thread requests issued by the unmounted view', h.since(m).filter((e) => e.key === 'list' || e.key === 'detail').length === 0, h.since(m).map((e) => e.path));
});

// S8 — project switch and bulk response delivered together (ordering best effort, both orders).
for (const order of ['snapshot-first', 'bulk-first']) {
  await scenario(browser, `S8-same-tick-${order}`, async (h) => {
    await h.open('#/threads');
    await h.check('A-一号').check();
    h.hold('bulk');
    await h.bulkBtn('置顶').click();
    const b = await h.queued('bulk');
    h.hold('snapshot');
    h.s.project = 'B';
    const st = await h.queued('stream', 1, 6000);
    h.s.queues.stream.shift();
    await st.fire();
    const sn = await h.queued('snapshot');
    h.take('snapshot'); h.take('bulk');
    const m = h.mark();
    if (order === 'snapshot-first') { sn.release(); b.release(); } else { b.release(); sn.release(); }
    await h.page.waitForFunction(() => document.title.startsWith('项目B'), null, { timeout: 5000 });
    await wait(700);
    const o = await h.observe();
    rec(`S8-same-tick-${order}`, 'A bulk report is not shown under project B', !/置顶/.test(o.status || ''), o);
    rec(`S8-same-tick-${order}`, 'bar not busy under B', !/处理中/.test(o.status || ''), o.status);
    rec(`S8-same-tick-${order}`, 'requests after release', null, h.since(m).map((e) => `${e.key} ${e.path} @${e.serverProject}`));
  });
}

// S1r — every list held across the switch, so any stale A row would be on screen (and clickable) right
// now if the switch left one. G5: the label used to say the opposite of what it asserted, and the click
// used to swallow its own timeout and call that "no detail GET", which passes whether or not a stale row
// is actually there to click — it proved nothing once R2 started clearing `threads` on switch. The second
// check here instead inspects the request log directly, so it stays meaningful either way: it is a real
// assertion about what was sent, not a side effect of a click that may or may not have found a target.
await scenario(browser, 'S1r-stale-row-click', async (h) => {
  await h.open('#/threads');
  h.hold('list', 6);
  await h.switchProject('B');
  await wait(200);
  const o = await h.observe();
  const staleVisible = o.rows.some((r) => r.startsWith('A-'));
  rec('S1r-stale-row-click', 'stale A rows are not rendered under project B while B list is pending', !staleVisible, o);
  const m = h.mark();
  if (staleVisible) {
    // Only worth attempting when a stale row actually rendered; recorded in the detail below either way
    // so a future regression that brings one back shows up in `staleVisible`, not silently here.
    await h.row('A-二号').click({ timeout: 1500 }).catch(() => {});
  }
  await wait(500);
  const o2 = await h.observe();
  const details = h.since(m, 'detail').map((e) => `${e.path} @${e.serverProject}`);
  const bulk = h.since(m, 'bulk').map((e) => `${e.path} @${e.serverProject}`);
  rec('S1r-stale-row-click', 'no A-id detail or bulk request reaches project B in this window', details.length === 0 && bulk.length === 0, { staleVisible, details, bulk, after: o2 });
  for (const q of (h.s.queues.list || []).splice(0)) await q.release();
  await wait(300);
});

// S9 — normal restore paths without navigation.
await scenario(browser, 'S9-normal-restore', async (h) => {
  await h.open('#/threads');
  await h.page.getByRole('button', { name: '打开回收站' }).click();
  await h.page.waitForSelector('.thread-item >> text=A-回收号');
  await h.check('A-回收号').check();
  const m = h.mark();
  await h.bulkBtn('还原所选').click();
  await wait(600);
  const o = await h.observe();
  const bodies = h.since(m, 'bulk').map((e) => e.body);
  rec('S9-normal-restore', 'bulk-bar restore sends the selected id, reports, and drops the row', bodies[0] === '{"action":"restore","ids":["a9"]}' && /已还原 1 个主题/.test(o.status || '') && !o.rows.some((r) => r.startsWith('A-回收号')), { bodies, o });
  await h.row('A-回收二号').click();
  await h.page.waitForFunction(() => document.querySelector('.thread-detail-head h2')?.textContent === 'A-回收二号');
  const m2 = h.mark();
  await h.paneBtn('还原出回收站').click();
  await wait(600);
  const o2 = await h.observe();
  const b2 = h.since(m2, 'bulk').map((e) => e.body);
  rec('S9-normal-restore', 'pane restore sends a8, reports, reloads pane out of trash (composer back)', b2[0] === '{"action":"restore","ids":["a8"]}' && /已还原 1 个主题/.test(o2.status || '') && o2.draft !== null, { b2, o2, after: h.since(m2).map((e) => e.path) });
});

// S10 — normal bulk close on the thread that is open (F4 path, no navigation).
await scenario(browser, 'S10-normal-close-active', async (h) => {
  await h.open('#/threads');
  await h.row('A-一号').click();
  await h.page.waitForSelector('.thread-detail-head h2');
  await h.check('A-一号').check();
  const m = h.mark();
  await h.bulkBtn('关闭').click();
  await wait(600);
  const o = await h.observe();
  const closedTape = await h.page.locator('.th-closed-tape').count();
  rec('S10-normal-close-active', 'close on the open thread reloads the pane to its closed state', closedTape === 1 && o.pane === 'A-一号' && /已关闭 1 个主题/.test(o.status || ''), { o, closedTape, after: h.since(m).map((e) => e.path) });
});

await browser.close();
fs.mkdirSync(path.dirname(RESULTS_FILE), { recursive: true });
fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
const checks = results.filter((r) => 'pass' in r);
const failed = checks.filter((r) => r.pass === false);
console.log(`\n${checks.filter((r) => r.pass === true).length} pass, ${failed.length} fail, ${checks.filter((r) => r.pass === null).length} notes`);
console.log(`Results written to ${RESULTS_FILE}`);
if (failed.length > 0) process.exitCode = 1;
