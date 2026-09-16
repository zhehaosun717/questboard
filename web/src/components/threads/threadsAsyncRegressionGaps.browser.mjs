// Real-browser regressions for the gaps QB-FB-REVIEW-THREAD4 found beyond the batch3 happy path (G1-G5
// in that report): stale rows after a bin/filter/search switch, a same-id write leaking across a project
// switch, loading states that lie about being empty, and keyboard focus dropping to <body>. Shares its
// interception harness with threadsAsyncRegression.browser.mjs — see regressionHarness.mjs for how the
// mock origin, fixtures and `h` scenario API work; this file only adds scenario bodies (X1-X15).
//
// Same environment variables as threadsAsyncRegression.browser.mjs (PLAYWRIGHT_DRIVER, PLAYWRIGHT_CHROME,
// THREADS_REGRESSION_DIST, THREADS_REGRESSION_PORT), plus THREADS_REGRESSION_GAPS_RESULTS for where the
// results JSON lands (omit for a fresh os.tmpdir() folder). Run from `web/`:
//   node src/components/threads/threadsAsyncRegressionGaps.browser.mjs
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveChromium, launchChromium } from './regressionPlaywrightResolver.mjs';
import { createRec, createScenarioRunner, wait } from './regressionHarness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DIST = process.env.THREADS_REGRESSION_DIST || path.join(HERE, '..', '..', '..', 'dist');
const PORT = process.env.THREADS_REGRESSION_PORT || '3532';
const ORIGIN = `http://127.0.0.1:${PORT}`;
const RESULTS_FILE = process.env.THREADS_REGRESSION_GAPS_RESULTS
  ? path.resolve(process.env.THREADS_REGRESSION_GAPS_RESULTS)
  : path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'threads-async-regression-gaps-')),
      'threadsAsyncRegressionGaps.results.json',
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
const scenario = createScenarioRunner(browser, { origin: ORIGIN, dist: DIST, results, rec });

// X1 — G1: switching into the recycle bin while the list is held must not keep showing the live rows it
// replaces, and a checkbox tick against one of those now-hidden rows must not reach the server at all.
await scenario('X1-stale-live-rows-in-bin', async (h) => {
  await h.open('#/threads');
  h.hold('list');
  await h.page.getByRole('button', { name: '打开回收站' }).click();
  const l = await h.queued('list');
  await wait(150);
  const o = await h.observe();
  rec('X1-stale-live-rows-in-bin', 'while the bin list loads, live rows are not shown under 回收站', !o.rows.some((r) => /^A-[一二三]号/.test(r)), o);
  const m = h.mark();
  await h.check('A-一号').check({ timeout: 1000 }).catch(() => {});
  await h.bulkBtn('还原所选').click({ timeout: 1000 }).catch(() => {});
  await wait(300);
  const bodies = h.since(m, 'bulk').map((e) => e.body);
  rec('X1-stale-live-rows-in-bin', 'no restore POST for a live id ticked from a stale row', bodies.length === 0, { bodies, after: await h.observe() });
  h.take('list'); await l.release();
});

// X1b — the reverse direction of X1: leaving the bin while the list is held must not keep trashed rows
// showing as live, selectable ones.
await scenario('X1b-stale-bin-rows-in-list', async (h) => {
  await h.open('#/threads');
  await h.page.getByRole('button', { name: '打开回收站' }).click();
  await h.page.waitForSelector('.thread-item >> text=A-回收号');
  h.hold('list');
  await h.page.getByRole('button', { name: '返回主题列表' }).click();
  const l = await h.queued('list');
  await wait(150);
  const o = await h.observe();
  rec('X1b-stale-bin-rows-in-list', 'while the normal list loads, recycle-bin rows are not shown as live rows', !o.rows.some((r) => r.startsWith('A-回收')), o);
  const m = h.mark();
  await h.check('A-回收号').check({ timeout: 1000 }).catch(() => {});
  await h.bulkBtn('置顶').click({ timeout: 1000 }).catch(() => {});
  await wait(300);
  const bodies = h.since(m, 'bulk').map((e) => e.body);
  rec('X1b-stale-bin-rows-in-list', 'no pin POST for a trashed id ticked from a stale bin row', bodies.length === 0, { bodies, after: await h.observe() });
  h.take('list'); await l.release();
});

// X2 — the same stale-rows property under a plain status-filter switch (open → 已关闭), not just the bin
// toggle. The second line is a NOTE: it lists whatever bulk writes went out from previous-filter rows for
// the record, since they would still target the same project (unlike X1/X1b's cross-scope ids).
await scenario('X2-stale-filter-rows', async (h) => {
  await h.open('#/threads');
  h.hold('list');
  await h.page.selectOption('.filters-grid select', 'closed');
  const l = await h.queued('list');
  await wait(150);
  const o = await h.observe();
  rec('X2-stale-filter-rows', 'under 已关闭 while loading, open rows from the previous filter are not shown', !o.rows.some((r) => /^A-[一二三]号/.test(r)), o);
  const m = h.mark();
  await h.check('A-一号').check({ timeout: 1000 }).catch(() => {});
  await h.bulkBtn('重新打开').click({ timeout: 1000 }).catch(() => {});
  await wait(300);
  rec('X2-stale-filter-rows', 'bulk writes sent from previous-filter rows (same project; listed)', null, h.since(m, 'bulk').map((e) => e.body));
  h.take('list'); await l.release();
});

// X3 — G3: while a switched-to project's list is still loading, the sidebar must not claim the truly-empty
// state (还没有主题) — that copy is reserved for a load that actually came back empty.
await scenario('X3-loading-list-truth', async (h) => {
  await h.open('#/threads');
  h.hold('list');
  await h.switchProject('B');
  await wait(200);
  const o = await h.observe();
  rec('X3-loading-list-truth', 'while project B list is loading, the list does not claim 还没有主题', o.listEmpty !== '还没有主题', o);
  const l = await h.queued('list'); h.take('list'); await l.release();
});

// X4 — G2: a reply pending for a shared id ("same") in project A must not lock B's composer for the same
// id, and A's reply completing after the switch must not wipe a draft the owner has since typed into B.
await scenario('X4-same-id-pending-reply-across-switch', async (h) => {
  await h.open('#/threads');
  await h.row('A-同号ID').click();
  await h.page.waitForSelector('.thread-detail-head h2');
  await h.page.fill('#th-reply-author', '测试');
  await h.page.fill('.thread-composer textarea', 'A回复');
  h.hold('reply');
  await h.page.getByRole('button', { name: '发送回复' }).click();
  const r = await h.queued('reply');
  await h.switchProject('B');
  await h.page.waitForFunction(() => document.querySelector('.thread-detail-head h2')?.textContent === 'B-同号ID', null, { timeout: 4000 });
  const o1 = await h.observe();
  rec('X4-same-id-pending-reply-across-switch', "B composer is not locked by project A's pending reply", o1.send === '发送回复', o1);
  await h.page.fill('.thread-composer textarea', 'B草稿');
  const m = h.mark();
  h.take('reply'); await r.release();
  await wait(500);
  const o2 = await h.observe();
  rec('X4-same-id-pending-reply-across-switch', "B draft survives project A's same-id reply completing", o2.draft === 'B草稿', { o2, after: h.since(m).map((e) => `${e.key} ${e.path} @${e.serverProject}`) });
});

// X7 — G2's other write path: a pin refusal from project A's pending request, for a shared id, must not
// surface under project B once the owner has switched.
await scenario('X7-same-id-pin-refusal-across-switch', async (h) => {
  await h.open('#/threads');
  await h.row('A-同号ID').click();
  await h.page.waitForSelector('.thread-detail-head h2');
  h.hold('pin');
  await h.paneBtn('置顶').click();
  const p = await h.queued('pin');
  await h.switchProject('B');
  await h.page.waitForFunction(() => document.querySelector('.thread-detail-head h2')?.textContent === 'B-同号ID', null, { timeout: 4000 });
  h.take('pin'); await p.release([500, { error: 'A 置顶失败' }]);
  await wait(400);
  const o = await h.observe();
  rec('X7-same-id-pin-refusal-across-switch', "project A's pin refusal is not shown under project B", !/A 置顶失败/.test(o.refusal || ''), o);
});

// X8 — G3: the pane must say it is loading, not "选一个主题", while the routed thread reloads for the
// project just switched to. X8b — the same-project route-change case (an A→C→A revisit, not a project
// switch) — is ported into threadsAsyncRegressionRevision7.browser.mjs alongside this brief's other new
// coverage (QB-FB-REVIEW-THREAD6-report.md: this comment previously claimed X8b was "already in the
// checked-in harness", which was false — neither harness had it).
await scenario('X8-loading-pane-after-switch', async (h) => {
  await h.open('#/threads');
  await h.row('A-同号ID').click();
  await h.page.waitForSelector('.thread-detail-head h2');
  h.hold('detail');
  await h.switchProject('B');
  const d = await h.queued('detail');
  await wait(150);
  const o = await h.observe();
  rec('X8-loading-pane-after-switch', 'while the routed thread reloads for B, the pane says it is loading (not 选一个主题)', !/选一个主题/.test(o.paneEmpty || ''), o);
  rec('X8-loading-pane-after-switch', 'loading/refusal text in the pane is announced (role or aria-live)', Boolean(o.paneEmptyRole || o.paneEmptyLive), { role: o.paneEmptyRole, live: o.paneEmptyLive });
  h.take('detail'); await d.release();
  await wait(300);
});

// X10 — the Ctrl+Enter double-send guard under a real race: two keydowns dispatched inside the same task
// both read the same pre-flush `replySubmitting`, so only a synchronous ref (not just the state) can stop
// the second one. S3b (checked-in) already covers two physical key presses in separate tasks.
await scenario('X10-ctrl-enter-same-task', async (h) => {
  await h.open('#/threads');
  await h.row('A-一号').click();
  await h.page.waitForSelector('.thread-detail-head h2');
  await h.page.fill('#th-reply-author', '测试');
  await h.page.fill('.thread-composer textarea', '同帧');
  h.hold('reply', 3);
  const m = h.mark();
  await h.page.evaluate(() => {
    const ta = document.querySelector('.thread-composer textarea');
    for (let i = 0; i < 2; i += 1) ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
  });
  await wait(400);
  const sent = h.since(m, 'reply').length;
  rec('X10-ctrl-enter-same-task', 'two Ctrl+Enter keydowns dispatched in one task send one reply', sent === 1, { sent });
  for (const q of (h.s.queues.reply || []).splice(0)) await q.release();
  await wait(300);
  const o = await h.observe();
  rec('X10-ctrl-enter-same-task', 'after the reply the composer is cleared and enabled', o.draft === '' && o.send === '发送回复', o);
});

// X11 — G4: keyboard-invoked bulk actions (toolbar) must not strand focus on <body>, neither while the
// button is disabled for the run nor after it settles.
for (const action of ['置顶', '关闭']) {
  await scenario(`X11-keyboard-bulk-${action}`, async (h) => {
    await h.open('#/threads');
    await h.check('A-一号').check();
    await h.check('A-二号').check();
    h.s.bulkOverride = (act, ids) => ({ action: act, changed: 1, failed: 1, results: [{ id: 'a1', ok: true }, { id: 'a2', ok: false, error: 'thread not found' }] });
    h.hold('bulk');
    await h.bulkBtn(action).focus();
    await h.page.keyboard.press('Enter');
    await h.queued('bulk');
    await wait(100);
    const o1 = await h.observe();
    h.take('bulk').release();
    await wait(500);
    const o2 = await h.observe();
    rec(`X11-keyboard-bulk-${action}`, 'focus while busy is not stranded on body', o1.active !== 'BODY', o1.active);
    rec(`X11-keyboard-bulk-${action}`, 'focus after the run is not body', o2.active !== 'BODY', o2.active);
    rec(`X11-keyboard-bulk-${action}`, 'partial result counts 1 done, 1 failed and names a2', /部分完成/.test(o2.status || '') && /1 个失败/.test(o2.status || '') && /a2/.test(o2.status || ''), o2.status);
    rec(`X11-keyboard-bulk-${action}`, 'failed id stays selected (已选 1)', /已选 1/.test(o2.count || ''), o2.count);
  });
}

await scenario('X11-keyboard-bulk-restore', async (h) => {
  await h.open('#/threads');
  await h.page.getByRole('button', { name: '打开回收站' }).click();
  await h.page.waitForSelector('.thread-item >> text=A-回收号');
  await h.check('A-回收号').check();
  h.hold('bulk');
  await h.bulkBtn('还原所选').focus();
  await h.page.keyboard.press('Enter');
  await h.queued('bulk');
  await wait(100);
  const o1 = await h.observe();
  h.take('bulk').release();
  await wait(500);
  const o2 = await h.observe();
  rec('X11-keyboard-bulk-restore', 'focus while busy is not stranded on body', o1.active !== 'BODY', o1.active);
  rec('X11-keyboard-bulk-restore', 'focus after the run is not body', o2.active !== 'BODY', o2.active);
  rec('X11-keyboard-bulk-restore', 'result reports 1 restored and row is gone', /还原/.test(o2.status || '') && !o2.rows.some((r) => r.startsWith('A-回收号')), o2);
});

// X11b — the pane's own restore action disables the same way the toolbar does; pane 关闭 is not gated by
// the busy flag and already keeps focus (checked here as a control, not expected to regress).
await scenario('X11b-keyboard-pane-actions', async (h) => {
  await h.open('#/threads');
  await h.page.getByRole('button', { name: '打开回收站' }).click();
  await h.page.waitForSelector('.thread-item >> text=A-回收号');
  await h.row('A-回收号').first().click();
  await h.page.waitForFunction(() => document.querySelector('.thread-detail-head h2')?.textContent === 'A-回收号');
  await h.paneBtn('还原出回收站').focus();
  await h.page.keyboard.press('Enter');
  await wait(800);
  const o1 = await h.observe();
  rec('X11b-keyboard-pane-actions', 'pane restore by keyboard: focus not body afterwards', o1.active !== 'BODY', o1);
  await h.page.getByRole('button', { name: '返回主题列表' }).click();
  await h.row('A-一号').click();
  await h.page.waitForFunction(() => document.querySelector('.thread-detail-head h2')?.textContent === 'A-一号');
  await h.paneBtn('关闭').focus();
  await h.page.keyboard.press('Enter');
  await wait(800);
  const o2 = await h.observe();
  rec('X11b-keyboard-pane-actions', 'pane close by keyboard: focus not body afterwards', o2.active !== 'BODY', o2);
});

// X12 — a reply and a list request both pending when the owner leaves #/threads entirely: neither may
// navigate back or write into the unmounted view once they land.
await scenario('X12-unmount-reply-list', async (h) => {
  await h.open('#/threads');
  await h.row('A-一号').click();
  await h.page.waitForSelector('.thread-detail-head h2');
  await h.page.fill('#th-reply-author', '测试');
  await h.page.fill('.thread-composer textarea', '离开前');
  h.hold('reply');
  await h.page.getByRole('button', { name: '发送回复' }).click();
  const r = await h.queued('reply');
  h.hold('list');
  await h.page.fill('input[type=search]', '号');
  const l = await h.queued('list');
  await h.page.evaluate(() => { location.hash = '#/board'; });
  await wait(300);
  const m = h.mark();
  h.take('reply'); await r.release();
  h.take('list'); await l.release();
  await wait(700);
  const o = await h.observe();
  rec('X12-unmount-reply-list', 'late reply/list after leaving keeps #/board', o.hash === '#/board', o.hash);
  rec('X12-unmount-reply-list', 'no thread requests issued by the unmounted view', h.since(m).filter((e) => ['list', 'detail'].includes(e.key)).length === 0, h.since(m).map((e) => e.path));
  rec('X12-unmount-reply-list', 'no page errors', h.s.errors.filter((e) => !/ERR_FAILED/.test(e)).length === 0, h.s.errors);
});

// X14 — an older server snapshot with no `project.id` field must not block a deep link into a thread.
await scenario('X14-deeplink-no-project-id', async (h) => {
  await h.open('#/threads/a1');
  await wait(800);
  const o = await h.observe();
  rec('X14-deeplink-no-project-id', 'older snapshot with no project.id: deep link shows A-一号', o.pane === 'A-一号', o);
}, { noId: true });

// X15 — the "Low" translation gap: a routed id missing under the switched-to project must show its
// refusal in Chinese (the raw server text is English), and must not show a stale pane from the old project.
await scenario('X15-route-missing-in-B', async (h) => {
  await h.open('#/threads');
  await h.row('A-一号').click();
  await h.page.waitForSelector('.thread-detail-head h2');
  await h.switchProject('B');
  await wait(800);
  const o = await h.observe();
  rec('X15-route-missing-in-B', 'routed id missing in B: pane error is in Chinese', /[一-龥]/.test(o.paneError || ''), o);
  rec('X15-route-missing-in-B', 'no stale A pane under B', o.pane === null, o.pane);
});

// revision6 (QB-FB-REVIEW-THREAD5-report.md R5-1..R5-5): the checks below port the reviewer's a18 probes
// (P1-P9c) into this checked-in harness — the ones that stayed real after switching from a hand-rolled
// `stillCurrentPane` per handler to threadOperationController.ts's scoped slots (see that file's matrix
// comment for what "current" means for each write below).

// P1 — R5-1: X→Y→X within one project. A reply pending on the first visit to a thread must not clear a
// draft retyped after a second visit to that same thread — a route change is a new pane generation even
// when the thread id repeats.
await scenario('P1-reply-xyx-stale-draft', async (h) => {
  await h.open('#/threads');
  await h.row('A-一号').click();
  await h.page.waitForSelector('.thread-detail-head h2');
  await h.page.fill('#th-reply-author', '测试');
  await h.page.fill('.thread-composer textarea', '旧草稿');
  h.hold('reply');
  await h.page.getByRole('button', { name: '发送回复' }).click();
  const r = await h.queued('reply', 1);
  await h.row('A-二号').click();
  await h.page.waitForFunction(() => document.querySelector('.thread-detail-head h2')?.textContent === 'A-二号');
  await h.row('A-一号').click();
  await h.page.waitForFunction(() => document.querySelector('.thread-detail-head h2')?.textContent === 'A-一号');
  await h.page.fill('.thread-composer textarea', '回来后新草稿');
  h.take('reply');
  await r.release();
  await wait(400);
  const o = await h.observe();
  rec('P1-reply-xyx-stale-draft', 'a reply pending from the first visit to A-一号 does not clear the draft retyped after returning to it (X→Y→X)', o.draft === '回来后新草稿', o);
});

// P2 — R5-1: the old send's `finally` must not release the new send's lock, and a third attempt while
// the new (second) send is still pending sends no extra POST.
await scenario('P2-reply-old-finally-does-not-release-new-lock', async (h) => {
  await h.open('#/threads');
  await h.row('A-一号').click();
  await h.page.waitForSelector('.thread-detail-head h2');
  await h.page.fill('#th-reply-author', '测试');
  await h.page.fill('.thread-composer textarea', '旧草稿');
  h.hold('reply');
  await h.page.getByRole('button', { name: '发送回复' }).click();
  const r1 = await h.queued('reply', 1);
  await h.row('A-二号').click();
  await h.page.waitForFunction(() => document.querySelector('.thread-detail-head h2')?.textContent === 'A-二号');
  await h.row('A-一号').click();
  await h.page.waitForFunction(() => document.querySelector('.thread-detail-head h2')?.textContent === 'A-一号');
  await h.page.fill('.thread-composer textarea', '新草稿');
  h.hold('reply');
  await h.page.getByRole('button', { name: '发送回复' }).click();
  const r2 = await h.queued('reply', 2);
  h.take('reply'); // shifts r1 (still queue[0]) off; r2 stays held
  await r1.release();
  await wait(300);
  const afterStale = await h.observe();
  rec('P2-reply-old-finally-does-not-release-new-lock', "the stale (first-visit) send resolving does not clear the new send's busy state", afterStale.send === '发送中…|disabled', afterStale);
  const m = h.mark();
  await h.page.getByRole('button', { name: '发送中…' }).click({ timeout: 500 }).catch(() => {});
  await wait(200);
  rec('P2-reply-old-finally-does-not-release-new-lock', 'a third send attempted while #2 is pending sends no extra POST', h.since(m, 'reply').length === 0, h.since(m, 'reply').length);
  await r2.release();
  await wait(400);
  const o = await h.observe();
  rec('P2-reply-old-finally-does-not-release-new-lock', 'once the current (second) send resolves, the composer clears and re-enables', o.draft === '' && o.send === '发送回复', o);
});

// P3/P5 — R5-3: a synchronous same-task double click (dispatched before React can flush the first click's
// `disabled` attribute — the same premise X10 already proved for Ctrl+Enter) on a bulk-bar or pane write
// button sends exactly one POST, not two.
async function doubleClick(h, selector, label) {
  await h.page.evaluate(
    ({ selector, label }) => {
      const btn = [...document.querySelectorAll(selector)].find((b) => b.textContent.trim() === label);
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    },
    { selector, label },
  );
}

await scenario('P3-bulk-pin-sync-double-click', async (h) => {
  await h.open('#/threads');
  await h.check('A-一号').check();
  h.hold('bulk', 3);
  const m = h.mark();
  await doubleClick(h, '.tb-bulk-bar button', '置顶');
  await wait(300);
  rec('P3-bulk-pin-sync-double-click', 'two synchronous clicks on the bulk-bar 置顶 button send exactly one bulk POST', h.since(m, 'bulk').length === 1, h.since(m, 'bulk').length);
  for (const q of (h.s.queues.bulk || []).splice(0)) await q.release();
  await wait(300);
});

// P4 — R5-3: the pane's own restore button shares bulk's slot; same guarantee.
await scenario('P4-pane-restore-sync-double-click', async (h) => {
  await h.open('#/threads');
  await h.page.getByRole('button', { name: '打开回收站' }).click();
  await h.page.waitForSelector('.thread-item >> text=A-回收号');
  await h.row('A-回收号').first().click();
  await h.page.waitForFunction(() => document.querySelector('.thread-detail-head h2')?.textContent === 'A-回收号');
  h.hold('bulk', 3);
  const m = h.mark();
  await doubleClick(h, '.th-head-actions button', '还原出回收站');
  await wait(300);
  rec('P4-pane-restore-sync-double-click', 'two synchronous clicks on 还原出回收站 send exactly one restore POST', h.since(m, 'bulk').length === 1, h.since(m, 'bulk').length);
  for (const q of (h.s.queues.bulk || []).splice(0)) await q.release();
  await wait(300);
});

await scenario('P5-pane-pin-sync-double-click', async (h) => {
  await h.open('#/threads');
  await h.row('A-一号').click();
  await h.page.waitForSelector('.thread-detail-head h2');
  h.hold('pin', 3);
  const m = h.mark();
  await doubleClick(h, '.th-head-actions button', '置顶');
  await wait(300);
  rec('P5-pane-pin-sync-double-click', 'two synchronous clicks on the pane 置顶 button send exactly one pin POST', h.since(m, 'pin').length === 1, h.since(m, 'pin').length);
  for (const q of (h.s.queues.pin || []).splice(0)) await q.release();
  await wait(300);
});

// P5b — the brief names close alongside pin/restore/bulk explicitly; pin and close share one slot, so this
// also proves starting close while pin (or vice versa) is mid-flight is refused, not just same-button.
await scenario('P5b-pane-close-sync-double-click', async (h) => {
  await h.open('#/threads');
  await h.row('A-一号').click();
  await h.page.waitForSelector('.thread-detail-head h2');
  h.hold('close', 3);
  const m = h.mark();
  await doubleClick(h, '.th-head-actions button', '关闭');
  await wait(300);
  rec('P5b-pane-close-sync-double-click', 'two synchronous clicks on 关闭 send exactly one close POST', h.since(m, 'close').length === 1, h.since(m, 'close').length);
  for (const q of (h.s.queues.close || []).splice(0)) await q.release();
  await wait(300);
});

// P3c — the same guarantee for the create form: a synchronous double submit (e.g. Enter fired twice
// before React flushes `submitting`) must not post the thread twice.
await scenario('P3c-create-sync-double-submit', async (h) => {
  await h.open('#/threads');
  await h.page.getByRole('button', { name: '+ 新主题' }).click();
  await h.page.waitForSelector('#nt-title');
  await h.page.fill('#nt-author', '测试');
  await h.page.fill('#nt-title', '双提交主题');
  await h.page.fill('#nt-body', '内容');
  h.hold('create', 3);
  const m = h.mark();
  await h.page.evaluate(() => {
    const form = document.querySelector('form.order');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await wait(300);
  rec('P3c-create-sync-double-submit', 'two synchronous form submits send exactly one create POST', h.since(m, 'create').length === 1, h.since(m, 'create').length);
  for (const q of (h.s.queues.create || []).splice(0)) await q.release();
  await wait(300);
});

// P6/P6b — R5-2: create resolving after the owner has moved on must not reload or navigate for the wrong
// scope. P6 is a project switch (view stays mounted); P6b is leaving the tab entirely (view unmounts).
await scenario('P6-late-create-after-project-switch', async (h) => {
  await h.open('#/threads');
  await h.page.getByRole('button', { name: '+ 新主题' }).click();
  await h.page.waitForSelector('#nt-title');
  await h.page.fill('#nt-author', '测试');
  await h.page.fill('#nt-title', '迟到主题');
  await h.page.fill('#nt-body', '内容');
  h.hold('create');
  await h.page.getByRole('button', { name: '发布主题' }).click();
  const c = await h.queued('create');
  await h.switchProject('B');
  await wait(200);
  const m = h.mark();
  h.take('create');
  await c.release();
  await wait(600);
  const o = await h.observe();
  rec('P6-late-create-after-project-switch', 'a create that resolves after a project switch does not navigate under the new project', !o.hash.includes('created-'), o.hash);
  rec('P6-late-create-after-project-switch', 'no detail GET for the orphaned created id under project B', h.since(m, 'detail').every((e) => !e.path.includes('created-')), h.since(m).map((e) => e.path));
});

await scenario('P6b-late-create-after-unmount', async (h) => {
  await h.open('#/threads');
  await h.page.getByRole('button', { name: '+ 新主题' }).click();
  await h.page.waitForSelector('#nt-title');
  await h.page.fill('#nt-author', '测试');
  await h.page.fill('#nt-title', '迟到主题2');
  await h.page.fill('#nt-body', '内容');
  h.hold('create');
  await h.page.getByRole('button', { name: '发布主题' }).click();
  const c = await h.queued('create');
  await h.page.evaluate(() => { location.hash = '#/board'; });
  await wait(200);
  const m = h.mark();
  h.take('create');
  await c.release();
  await wait(600);
  const o = await h.observe();
  rec('P6b-late-create-after-unmount', 'a create that resolves after leaving the view stays on #/board (no navigate-back)', o.hash === '#/board', o.hash);
  rec('P6b-late-create-after-unmount', 'no thread requests issued by the unmounted view', h.since(m).filter((e) => e.key === 'list' || e.key === 'detail').length === 0, h.since(m).map((e) => e.path));
  rec('P6b-late-create-after-unmount', 'no page errors (no setState-after-unmount warning surfaced as a console error)', h.s.errors.filter((e) => !/ERR_FAILED/.test(e)).length === 0, h.s.errors);
});

// P7 — R5-4: opening the view must never steal focus into the search box on its own; only a real
// busy→settled bulk/restore run parks and returns it.
await scenario('P7-no-focus-theft-on-mount', async (h) => {
  await h.open('#/threads');
  await wait(300);
  const o = await h.observe();
  rec('P7-no-focus-theft-on-mount', 'opening #/threads does not put focus in 搜索主题 without any action from the owner', !o.active.startsWith('INPUT|搜索主题'), o.active);
});

// P9c — R5-5: a 500 whose body is a fake, secret-shaped string must never reach the sidebar as-is —
// corrected from the reviewer's rejected first version (which held only one of the two initial list
// requests): both the mount-triggered and the projectId-triggered list calls are held here.
await scenario('P9c-list-error-no-secret-leak', async (h) => {
  h.hold('list', 2);
  await h.page.goto(`${ORIGIN}/#/threads`);
  await h.page.waitForFunction(() => document.title.startsWith('项目'), null, { timeout: 8000 });
  const first = await h.queued('list', 1);
  const second = await h.queued('list', 2);
  const pending = await h.observe();
  rec('P9c-list-error-no-secret-leak', 'both initial list calls held: the list shows loading, not empty, not an error', pending.listError === null && pending.rows.length === 0, pending);
  h.take('list');
  h.take('list');
  await first.release([500, { error: 'EACCES open /srv/private/threads.jsonl token=abc123' }]);
  await second.release([500, { error: 'EACCES open /srv/private/threads.jsonl token=abc123' }]);
  await wait(400);
  const o = await h.observe();
  rec('P9c-list-error-no-secret-leak', 'a fake EACCES/path/token server body is never shown verbatim in the sidebar', o.listError !== null && !/EACCES|\/srv\/private|token=abc123/.test(o.listError), o);
  rec('P9c-list-error-no-secret-leak', 'the shown list error is the fixed generic Chinese fallback', /[一-龥]/.test(o.listError || ''), o.listError);
});

// P12 — Minor (revision6 line 15): a failed list load must not keep claiming 加载中 through the gap before
// the next 10s poll (nothing is actually pending then), and a scope change must not carry the old scope's
// error into the new one's loading state.
await scenario('P12-list-error-not-shown-as-loading', async (h) => {
  await h.open('#/threads');
  h.hold('list');
  await h.page.selectOption('.filters-grid select', 'all');
  const l = await h.queued('list');
  h.take('list');
  // R5-5: an unrecognized server body (this fixture text is not in the known-refusal map) now shows the
  // fixed generic Chinese fallback, never verbatim — this scenario only cares that *some* error shows and
  // 加载中 does not, so it does not assert the exact fallback text (that's threadBatch.test.ts's job).
  await l.release([500, { error: 'A 项目读取失败（测试用，不在已知映射中）' }]);
  await wait(200);
  const afterFail = await h.observe();
  rec('P12-list-error-not-shown-as-loading', 'a failed load shows an error line, not 加载中, while nothing is pending', Boolean(afterFail.listError) && afterFail.listEmpty !== '加载中…', afterFail);
  h.hold('list');
  await h.page.getByRole('button', { name: '打开回收站' }).click();
  const l2 = await h.queued('list');
  await wait(150);
  const duringBinLoad = await h.observe();
  rec('P12-list-error-not-shown-as-loading', "switching to the bin (a new scope) clears the previous filter's error while it loads", duringBinLoad.listError === null, duringBinLoad);
  h.take('list');
  await l2.release();
  await wait(300);
});

await browser.close();
fs.mkdirSync(path.dirname(RESULTS_FILE), { recursive: true });
fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
const checks = results.filter((r) => 'pass' in r);
const failed = checks.filter((r) => r.pass === false);
console.log(`\n${checks.filter((r) => r.pass === true).length} pass, ${failed.length} fail, ${checks.filter((r) => r.pass === null).length} notes`);
console.log(`Results written to ${RESULTS_FILE}`);
