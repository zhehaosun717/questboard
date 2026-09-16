// Real-browser regressions for QB-FB-THREAD-revision7 (QB-FB-REVIEW-THREAD6-report.md's D1-D7): detail
// read ordering, the double-translation regression, untrusted create-form fields, StrictMode's dev-only
// mount replay, list-scope-leaked bulk status, keyboard focus, and one-paint project provenance — plus the
// X8b coverage gap that report flagged (a false "already in the checked-in harness" comment). Shares its
// interception harness with the other two checked-in files — see regressionHarness.mjs for how the mock
// origin, fixtures and `h` scenario API work; this file only adds scenario bodies.
//
// Same environment variables as threadsAsyncRegression.browser.mjs (PLAYWRIGHT_DRIVER, PLAYWRIGHT_CHROME,
// THREADS_REGRESSION_DIST, THREADS_REGRESSION_PORT), plus:
//   THREADS_REGRESSION_DIST_DEV   path to a *development*-mode build (`vite build --mode development`,
//                                  NODE_ENV=development so React keeps its dev checks, StrictMode's
//                                  mount→unmount→mount replay included). Optional: the D4 dev-StrictMode
//                                  scenarios are skipped with a NOTE (not a failure) when this is unset or
//                                  the path has no build — a production build cannot exercise them at all,
//                                  since React strips StrictMode's double-invoke in production.
//   THREADS_REGRESSION_REVISION7_RESULTS   where the results JSON lands (omit for a fresh os.tmpdir()).
// Run from `web/`: node src/components/threads/threadsAsyncRegressionRevision7.browser.mjs
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveChromium, launchChromium } from './regressionPlaywrightResolver.mjs';
import { createRec, createScenarioRunner, wait } from './regressionHarness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DIST = process.env.THREADS_REGRESSION_DIST || path.join(HERE, '..', '..', '..', 'dist');
const DIST_DEV = process.env.THREADS_REGRESSION_DIST_DEV || path.join(HERE, '..', '..', '..', 'dist-dev');
const PORT = process.env.THREADS_REGRESSION_PORT || '3532';
const ORIGIN = `http://127.0.0.1:${PORT}`;
const RESULTS_FILE = process.env.THREADS_REGRESSION_REVISION7_RESULTS
  ? path.resolve(process.env.THREADS_REGRESSION_REVISION7_RESULTS)
  : path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'threads-async-regression-revision7-')),
      'threadsAsyncRegressionRevision7.results.json',
    );

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  throw new Error(
    `No build at ${DIST} (index.html missing). Run \`npm run build\` in web/ first, or set ` +
      `THREADS_REGRESSION_DIST to an existing build.`,
  );
}
const hasDevBuild = fs.existsSync(path.join(DIST_DEV, 'index.html'));

const chromium = await resolveChromium();

const results = [];
const rec = createRec(results);

const browser = await launchChromium(chromium);
const scenario = createScenarioRunner(browser, { origin: ORIGIN, dist: DIST, results, rec });
const devScenario = hasDevBuild
  ? createScenarioRunner(browser, { origin: ORIGIN, dist: DIST_DEV, results, rec })
  : async (name) => {
      rec(name, 'skipped: no dev build at THREADS_REGRESSION_DIST_DEV (React strips StrictMode double-invoke in production, so this cannot be checked against a prod dist)', null, { DIST_DEV });
    };

const SECRET = 'EACCES open /srv/private/threads.jsonl token=abc123';
const LEAK = /EACCES|\/srv\/private|token=abc123/;
const detailBody = (id, title, extra = {}) => ({
  id, title, tags: [], author: 'fixture', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', pinned: false, closed: false,
  messageCount: 1, lastMessageAt: '2026-09-01T00:00:00Z', trashed: false, messages: [{ id: `m-${id}`, threadId: id, body: 'x', author: 'fixture', createdAt: '2026-09-01T00:00:00Z' }], ...extra,
});
const paneIs = (h, title, timeout = 4000) =>
  h.page.waitForFunction((t) => document.querySelector('.thread-detail-head h2')?.textContent === t, title, { timeout });
const paneButtons = (h) => h.page.evaluate(() => [...document.querySelectorAll('.th-head-actions button')].map((b) => `${b.textContent.trim()}${b.disabled ? '|disabled' : ''}`));
const modal = (h) => h.page.evaluate(() => {
  const f = document.querySelector('form.order');
  return f ? { text: f.textContent, submit: f.querySelector('button[type=submit]')?.textContent, fieldErrors: [...f.querySelectorAll('.field-error-msg')].map((e) => e.textContent), general: f.querySelector('.warn-tape')?.textContent ?? null } : null;
});
async function openModal(h, title) {
  await h.page.getByRole('button', { name: '+ 新主题' }).click();
  await h.page.waitForSelector('#nt-title');
  await h.page.fill('#nt-author', '测试');
  await h.page.fill('#nt-title', title);
  await h.page.fill('#nt-body', '内容');
}

// X8b — G3, ported: the same-project route-change loading state (A→C→A), which
// threadsAsyncRegressionGaps.browser.mjs's own comment used to (falsely) claim was already covered.
await scenario('X8b-route-A-C-A-late-detail', async (h) => {
  await h.open('#/threads');
  await h.row('A-一号').click();
  await h.page.waitForSelector('.thread-detail-head h2');
  h.hold('detail');
  await h.row('A-三号').click();
  const d = await h.queued('detail');
  await wait(100);
  const o = await h.observe();
  rec('X8b-route-A-C-A-late-detail', 'route change shows a loading reason', /主题切换中/.test(o.refusal || ''), o);
  await h.row('A-一号').click();
  await paneIs(h, 'A-一号', 3000);
  h.take('detail'); await d.release();
  await wait(300);
  const o2 = await h.observe();
  rec('X8b-route-A-C-A-late-detail', 'A→C→A: late C detail does not replace A', o2.pane === 'A-一号' && !o2.refusal, o2);
});

// D1a — X→Y→X stale detail read: the first visit's GET resolving after the third-visit pane has already
// loaded must not overwrite it (ThreadsView.tsx's `detailCallRef` + `paneEpochRef`).
await scenario('D1a-xyx-stale-detail-read', async (h) => {
  await h.open('#/threads');
  h.hold('detail');
  await h.row('A-一号').click();
  const d1 = await h.queued('detail');
  await h.row('A-二号').click();
  await paneIs(h, 'A-二号');
  await h.row('A-一号').click();
  await paneIs(h, 'A-一号');
  h.take('detail');
  await d1.release([200, detailBody('a1', 'A-一号（第一次访问的旧读）')]);
  await wait(400);
  const o = await h.observe();
  rec('D1a-xyx-stale-detail-read', 'X→Y→X: first-visit detail resolving late does not overwrite the third-visit pane', o.pane === 'A-一号', o);
});

// D1b — same visit, two post-write detail reloads out of order: pin's reload (issued first) resolving
// after close's reload (issued second, already applied) must not revert the pane to not-closed.
await scenario('D1b-same-visit-out-of-order-detail', async (h) => {
  await h.open('#/threads');
  await h.row('A-一号').click();
  await paneIs(h, 'A-一号');
  h.hold('detail');
  await h.paneBtn('置顶').click();
  const dPin = await h.queued('detail');
  await h.page.waitForFunction(() => [...document.querySelectorAll('.th-head-actions button')].every((b) => !b.disabled), null, { timeout: 3000 });
  await h.paneBtn('关闭').click();
  await h.page.waitForFunction(() => /重新打开/.test(document.querySelector('.th-head-actions')?.textContent || ''), null, { timeout: 3000 });
  const before = await paneButtons(h);
  h.take('detail');
  await dPin.release([200, detailBody('a1', 'A-一号', { pinned: true, closed: false })]);
  await wait(400);
  const after = await paneButtons(h);
  rec('D1b-same-visit-out-of-order-detail', 'an older post-pin detail reload landing after the newer post-close reload does not revert the pane to open', after.some((b) => b.startsWith('重新打开')), { before, after });
});

// D2 — threadBatch.ts's request() must throw the raw refusal exactly once (revision6 pre-translated it,
// so describeThreadError's own translation ran on already-Chinese text and fell through to the generic
// fallback even for known refusals).
await scenario('D2-bulk-known-refusal-mapping', async (h) => {
  await h.open('#/threads');
  await h.check('A-一号').check();
  h.hold('bulk');
  await h.bulkBtn('置顶').click();
  const b = await h.queued('bulk', 1);
  h.take('bulk'); await b.release([403, { error: 'cross-site request refused' }]);
  await wait(300);
  rec('D2-bulk-known-refusal-mapping', 'bulk 403 cross-site refusal shows its Chinese reason', /跨站/.test((await h.observe()).status || ''), (await h.observe()).status);
  h.hold('bulk');
  await h.bulkBtn('置顶').click();
  const b2 = await h.queued('bulk', 1);
  h.take('bulk'); await b2.release([502, {}]);
  await wait(300);
  rec('D2-bulk-known-refusal-mapping', 'bodyless 502 shows 请求失败（HTTP 502） (control: a client-synthesized status is not a translation target)', /HTTP 502/.test((await h.observe()).status || ''), (await h.observe()).status);
  h.hold('bulk');
  await h.bulkBtn('置顶').click();
  const b3 = await h.queued('bulk', 1);
  h.take('bulk'); await b3.release([500, { error: 'thread not found' }]);
  await wait(300);
  rec('D2-bulk-known-refusal-mapping', 'bulk 500 with a known refusal text keeps its Chinese reason (主题不存在), not the generic fallback', /主题不存在/.test((await h.observe()).status || ''), (await h.observe()).status);
});

// D2b — control: reply goes through client.ts's `call()`, which never pre-translated — confirms the D2
// fix to threadBatch.ts's `request()` did not disturb this already-correct path.
await scenario('D2b-reply-known-refusal-mapping', async (h) => {
  await h.open('#/threads');
  await h.row('A-一号').click(); await paneIs(h, 'A-一号');
  await h.page.fill('#th-reply-author', '测试');
  await h.page.fill('.thread-composer textarea', '回复');
  h.hold('reply');
  await h.page.getByRole('button', { name: '发送回复' }).click();
  const r = await h.queued('reply', 1);
  h.take('reply'); await r.release([409, { error: 'thread is closed' }]);
  await wait(300);
  rec('D2b-reply-known-refusal-mapping', 'reply 409 thread-is-closed shows its Chinese reason (control)', /已关闭/.test((await h.observe()).refusal || ''), (await h.observe()).refusal);
  h.hold('reply');
  await h.page.getByRole('button', { name: '发送回复' }).click();
  const r2 = await h.queued('reply', 1);
  h.take('reply'); await r2.release([500, { error: SECRET }]);
  await wait(300);
  const o2 = await h.observe();
  rec('D2b-reply-known-refusal-mapping', 'reply 500 secret body is not reflected; generic Chinese shown', Boolean(o2.refusal) && !LEAK.test(o2.refusal) && /[一-龥]/.test(o2.refusal), o2.refusal);
});

// D3a — NewThreadModal's `fields` are untrusted runtime data: a secret-shaped field value must not render
// raw, and only allowlisted fields are read (threadBatch.ts's `describeFieldErrors`).
await scenario('D3a-create-fields-raw-server-text', async (h) => {
  await h.open('#/threads');
  await openModal(h, '字段');
  h.hold('create');
  await h.page.getByRole('button', { name: '发布主题' }).click();
  const c = await h.queued('create');
  h.take('create'); await c.release([400, { error: 'validation failed', fields: { title: SECRET, author: 'x'.repeat(3) } }]);
  await wait(300);
  const m = await modal(h);
  rec('D3a-create-fields-raw-server-text', 'secret-shaped server field text is not shown in the dialog', m && !LEAK.test(m.text), m);
  rec('D3a-create-fields-raw-server-text', 'general error is the fixed Chinese mapping (not raw)', m && m.general && !/validation failed/.test(m.general), m?.general);
});

// D3b — a non-string field value from the server must not crash the app (React error #31: objects are not
// valid children).
await scenario('D3b-create-fields-non-string', async (h) => {
  await h.open('#/threads');
  await openModal(h, '字段2');
  h.hold('create');
  await h.page.getByRole('button', { name: '发布主题' }).click();
  const c = await h.queued('create');
  h.take('create'); await c.release([400, { error: 'validation failed', fields: { title: { code: 'too_long', max: 120 } } }]);
  await wait(400);
  const alive = await h.page.evaluate(() => Boolean(document.querySelector('.threads-view')));
  rec('D3b-create-fields-non-string', 'app still rendered, no page error, after an object-valued field error', alive && !h.s.errors.some((e) => /pageerror|Objects are not valid/.test(e)), { alive, errors: h.s.errors.filter((e) => !/ERR_FAILED/.test(e)).slice(0, 3) });
});

// D3c — same untrusted-echo rule applied to bulk report ids (R13): a result id the client never sent is
// server-echoed data too, and is never named raw (describeBulkReport's `sentIds`).
await scenario('D3c-bulk-report-server-ids', async (h) => {
  await h.open('#/threads');
  await h.check('A-一号').check();
  h.s.bulkOverride = (action) => ({ action, changed: 0, failed: 1, results: [{ id: SECRET, ok: false, error: 'thread not found' }] });
  await h.bulkBtn('置顶').click();
  await wait(400);
  const o = await h.observe();
  rec('D3c-bulk-report-server-ids', 'a server-echoed id that the client never sent is not reflected raw', !LEAK.test(o.status || ''), o.status);
  rec('D3c-bulk-report-server-ids', 'the unmatched id is named generically instead', /未知 id/.test(o.status || ''), o.status);
});

// D4 — StrictMode (development build only: main.tsx wraps <App/> in <StrictMode>, and React strips its
// mount→unmount→mount replay in production). NewThreadModal's `mountedRef` used to only ever get set back
// to `false` in cleanup, never `true` again on the replay's second mount — a real, current create's own
// success handler then read itself as already-unmounted and could never close the dialog or navigate.
await devScenario('D4-dev-strictmode-create-completes', async (h) => {
  await h.open('#/threads');
  await openModal(h, '严格模式');
  await h.page.getByRole('button', { name: '发布主题' }).click();
  await wait(1000);
  const o = { hash: await h.page.evaluate(() => location.hash), modal: await modal(h), rows: (await h.observe()).rows };
  rec('D4-dev-strictmode-create-completes', 'dev StrictMode: a successful create closes the dialog and opens the new thread', o.modal === null && o.hash === '#/threads/created-1', o);
});

await devScenario('D4b-dev-strictmode-reply-control', async (h) => {
  await h.open('#/threads');
  await h.row('A-一号').click(); await paneIs(h, 'A-一号');
  await h.page.fill('#th-reply-author', '测试');
  await h.page.fill('.thread-composer textarea', '严格');
  await h.page.getByRole('button', { name: '发送回复' }).click();
  await wait(600);
  const o = await h.observe();
  rec('D4b-dev-strictmode-reply-control', 'dev StrictMode: reply success clears and re-enables (control: aliveRef already handled this correctly pre-revision7)', o.draft === '' && o.send === '发送回复', o);
});

await devScenario('D4c-dev-strictmode-focus-mount', async (h) => {
  await h.open('#/threads');
  const o = await h.observe();
  rec('D4c-dev-strictmode-focus-mount', 'dev StrictMode: no focus theft on mount', !o.active.startsWith('INPUT|搜索主题'), o.active);
});

// D5 — a same-project list→bin switch while a bulk run is pending: the old list scope's late report/error
// must not appear under the new scope (useThreadWriteOperations.ts's `listScopeRef`/`isSameListScope`).
await scenario('D5-bulk-error-after-bin-switch', async (h) => {
  await h.open('#/threads');
  await h.check('A-一号').check();
  h.hold('bulk');
  await h.bulkBtn('置顶').click();
  const b = await h.queued('bulk');
  await h.page.getByRole('button', { name: '打开回收站' }).click();
  await h.page.waitForSelector('.thread-item >> text=A-回收号');
  h.take('bulk'); await b.release([500, { error: SECRET }]);
  await wait(300);
  const o = await h.observe();
  rec('D5-bulk-error-after-bin-switch', 'a list-scope bulk error is not shown under the recycle bin', !o.status, o);
  rec('D5-bulk-error-after-bin-switch', 'the error text never leaks raw (control, even if the above regresses)', !LEAK.test(o.status || ''), o.status);
});

// D5b — note only: a late *success* after a bin switch is arguably fine to still show (the report calls
// this "arguably acceptable", unlike D5's error case) — recorded, not asserted.
await scenario('D5b-bulk-success-after-bin-switch', async (h) => {
  await h.open('#/threads');
  await h.row('A-一号').click(); await paneIs(h, 'A-一号');
  await h.check('A-一号').check();
  h.hold('bulk');
  await h.page.locator('.tb-bulk-bar button', { hasText: /删除/ }).click();
  await h.page.waitForSelector('.tb-confirm');
  await h.page.getByRole('button', { name: /确认放入回收站/ }).click();
  const b = await h.queued('bulk');
  await h.page.getByRole('button', { name: '打开回收站' }).click();
  await wait(300);
  h.take('bulk'); await b.release();
  await wait(500);
  const o = await h.observe();
  rec('D5b-bulk-success-after-bin-switch', 'trash of the open thread completing after a bin switch (status/nav/focus recorded, not asserted)', null, o);
});

// D6a — reply's own focus-restore instance (new in revision7): busy must not strand focus on <body>, and
// it returns once the send settles.
await scenario('D6a-reply-keyboard-focus', async (h) => {
  await h.open('#/threads');
  await h.row('A-一号').click(); await paneIs(h, 'A-一号');
  await h.page.fill('#th-reply-author', '测试');
  await h.page.fill('.thread-composer textarea', '键盘');
  h.hold('reply');
  await h.page.getByRole('button', { name: '发送回复' }).focus();
  await h.page.keyboard.press('Enter');
  const r = await h.queued('reply');
  await wait(100);
  const busy = (await h.observe()).active;
  h.take('reply'); await r.release();
  await wait(500);
  const o = await h.observe();
  rec('D6a-reply-keyboard-focus', 'reply by keyboard on 发送回复: focus not stranded on body while busy', busy !== 'BODY', busy);
  rec('D6a-reply-keyboard-focus', 'reply by keyboard on 发送回复: focus not body afterwards', o.active !== 'BODY', o.active);
});

// D6b — create's modal now opens focus inside it and returns it to the opener on close (Escape here; a
// successful create is covered by D4/R9's existing navigation checks).
await scenario('D6b-create-keyboard-focus', async (h) => {
  await h.open('#/threads');
  await h.page.getByRole('button', { name: '+ 新主题' }).focus();
  await h.page.keyboard.press('Enter');
  await h.page.waitForSelector('#nt-title');
  const afterOpen = (await h.observe()).active;
  await h.page.keyboard.press('Escape');
  await wait(200);
  const afterEsc = (await h.observe()).active;
  await h.page.getByRole('button', { name: '+ 新主题' }).focus();
  await h.page.keyboard.press('Enter');
  await h.page.waitForSelector('#nt-title');
  await h.page.fill('#nt-author', '测试');
  await h.page.fill('#nt-body', '内容');
  await h.page.fill('#nt-title', '键盘新建');
  await h.page.keyboard.press('Enter');
  await h.page.waitForFunction(() => location.hash.includes('created-'), null, { timeout: 3000 });
  await wait(400);
  const afterCreate = (await h.observe()).active;
  rec('D6b-create-keyboard-focus', 'opening the dialog by keyboard moves focus into it', /^(INPUT|TEXTAREA)/.test(afterOpen), afterOpen);
  rec('D6b-create-keyboard-focus', 'Escape closes the dialog and returns focus to + 新主题 (not body)', afterEsc !== 'BODY' && afterEsc.startsWith('BUTTON|+ 新主题'), afterEsc);
  rec('D6b-create-keyboard-focus', 'create by keyboard: focus not body afterwards', afterCreate !== 'BODY', afterCreate);
});

// D6c — R14b, corrected: the owner typing into the parking spot while a pane write is busy is deliberate
// focus intent — the run settling must not pull focus back to 置顶 mid-typing (useBulkFocusRestore.ts's
// `isFocusStillParked`).
await scenario('D6c-pane-pin-focus-no-theft-after-typing', async (h) => {
  await h.open('#/threads');
  await h.row('A-一号').click(); await paneIs(h, 'A-一号');
  h.hold('pin');
  await h.paneBtn('置顶').focus();
  await h.page.keyboard.press('Enter');
  const p = await h.queued('pin', 1);
  await wait(150);
  const parked = (await h.observe()).active;
  await h.page.keyboard.type('A');
  h.take('pin'); await p.release();
  await wait(500);
  const mid = (await h.observe()).active;
  await h.page.keyboard.type('一');
  await wait(300);
  const v = await h.page.evaluate(() => document.querySelector('input[type=search]').value);
  rec('D6c-pane-pin-focus-no-theft-after-typing', 'focus parked in search while 置顶 is busy (setup)', null, parked);
  rec('D6c-pane-pin-focus-no-theft-after-typing', 'owner typing in the parking spot keeps focus there after the pin settles', parked.startsWith('INPUT|搜索主题') ? (v === 'A一' && mid.startsWith('INPUT|搜索主题')) : null, { parked, mid, value: v });
});

// D6d — R8: text typed into the composer after a send was captured must survive that send succeeding —
// only the exact sent draft is cleared (useThreadWriteOperations.ts's `sentBody` functional update).
await scenario('D6d-reply-draft-survives-send', async (h) => {
  await h.open('#/threads');
  await h.row('A-一号').click(); await paneIs(h, 'A-一号');
  await h.page.fill('#th-reply-author', '测试');
  await h.page.fill('.thread-composer textarea', '第一条');
  h.hold('reply');
  await h.page.getByRole('button', { name: '发送回复' }).click();
  const r = await h.queued('reply');
  await h.page.fill('.thread-composer textarea', '发送途中写的下一条');
  h.take('reply'); await r.release();
  await wait(400);
  const o = await h.observe();
  rec('D6d-reply-draft-survives-send', 'a draft typed after pressing send survives that send succeeding', o.draft === '发送途中写的下一条', o);
});

// D6e — revision8: Tab to 发布主题 then Enter. Unlike D6b's Enter-inside-a-text-field path, this focuses the
// submit button itself, which disables (and the browser blurs it to <body>) the instant `submitting`
// commits — the same busy/disable race useBulkFocusRestore.ts already covers for the bulk bar and
// pane-write buttons. NewThreadModal now reuses that hook, parked on the title field (the one control this
// form never disables), so focus is never stranded on <body> — not while the create is held, and not once
// the dialog unmounts on success (the existing rootRef cleanup hands it on from the parked field to
// restoreFocusRef's opener, + 新主题).
await scenario('D6e-create-tab-submit-button-focus', async (h) => {
  await h.open('#/threads');
  await openModal(h, 'Tab提交');
  h.hold('create');
  await h.page.getByRole('button', { name: '发布主题' }).focus();
  await h.page.keyboard.press('Enter');
  const c = await h.queued('create');
  await wait(150);
  const busy = (await h.observe()).active;
  h.take('create'); await c.release();
  await h.page.waitForFunction(() => location.hash.includes('created-'), null, { timeout: 3000 });
  await wait(400);
  const after = await h.observe();
  rec('D6e-create-tab-submit-button-focus', 'busy after Enter on 发布主题 (disabled button): focus not stranded on body', busy !== 'BODY', busy);
  rec('D6e-create-tab-submit-button-focus', 'after successful keyboard create: focus not body, dialog gone, new thread routed', after.active !== 'BODY' && (await modal(h)) === null && /created-1/.test(after.hash), after);
});

// D6f — revision8/F3: the owner clicking a nonfocusable spot (the `h2` heading) while a keyboard-focused
// submit is busy blurs to <body>, exactly like the disable itself does — indistinguishable from "nothing
// happened yet" by document.activeElement alone. NewThreadModal's own settle check (not
// useBulkFocusRestore.ts's shared one, which the bulk bar and pane still use unmodified) must tell the two
// apart and never restore focus onto 发布主题 once the create then fails.
async function headingClickWhileBusyThenError(h, label) {
  const name = `D6f-create-heading-click-busy-error-no-theft-${label}`;
  await h.open('#/threads');
  await openModal(h, 'F3标题');
  h.hold('create');
  await h.page.getByRole('button', { name: '发布主题' }).focus();
  await h.page.keyboard.press('Enter');
  const c = await h.queued('create');
  await wait(150);
  const busy = (await h.observe()).active;
  await h.page.click('form.order h2');
  await wait(100);
  const afterClick = (await h.observe()).active;
  h.take('create');
  await c.release([400, { error: 'validation failed', fields: { title: 'title is required' } }]);
  await wait(400);
  const after = (await h.observe()).active;
  rec(name, 'busy after Enter on 发布主题: focus not stranded on body', busy !== 'BODY', busy);
  rec(name, 'owner clicked nonfocusable heading while busy: focus now BODY (setup)', afterClick === 'BODY', afterClick);
  rec(name, 'error settle: focus left exactly where the owner put it, not pulled back onto 发布主题', after === afterClick, after);
}
await scenario('D6f-create-heading-click-busy-error-no-theft-prod', (h) => headingClickWhileBusyThenError(h, 'prod'));
await devScenario('D6f-create-heading-click-busy-error-no-theft-dev', (h) => headingClickWhileBusyThenError(h, 'dev'));

// D7 — project provenance at paint: after the stream delivers project B, no DOM commit may show project
// B's header together with project A's rows or pane (same id "same"). ThreadsView.tsx's `isListCurrent`/
// `isPaneCurrent` now compare `projectId` straight against the live prop at render time, not a generation
// ref that only bumps in a passive effect after the commit that matters.
await scenario('D7-project-provenance-paint', async (h) => {
  await h.open('#/threads');
  await h.row('A-同号ID').click(); await paneIs(h, 'A-同号ID');
  h.hold('list'); h.hold('detail');
  await h.page.evaluate(() => {
    window.__frames = [];
    const snap = () => {
      const header = document.querySelector('#root > *:first-child')?.textContent || '';
      window.__frames.push({
        headerB: header.includes('项目B'),
        rows: [...document.querySelectorAll('.thread-item .th-item-title')].map((e) => e.textContent),
        pane: document.querySelector('.thread-detail-head h2')?.textContent ?? null,
        writable: [...document.querySelectorAll('.th-head-actions button, .tb-check')].filter((b) => !b.disabled).length,
      });
    };
    new MutationObserver(snap).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  });
  await h.switchProject('B');
  await wait(300);
  const frames = await h.page.evaluate(() => window.__frames);
  const bad = frames.filter((f) => f.headerB && (f.rows.some((r) => r.startsWith('A-')) || (f.pane || '').startsWith('A-')));
  rec('D7-project-provenance-paint', 'no committed DOM frame shows project B header with project A rows/pane', bad.length === 0, { bad: bad.slice(0, 3), frames: frames.length });
  for (const k of ['list', 'detail']) for (const q of (h.s.queues[k] || []).splice(0)) await q.release();
});

await browser.close();
fs.mkdirSync(path.dirname(RESULTS_FILE), { recursive: true });
fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
const checks = results.filter((r) => 'pass' in r);
const failed = checks.filter((r) => r.pass === false);
console.log(`\n${checks.filter((r) => r.pass === true).length} pass, ${failed.length} fail, ${checks.filter((r) => r.pass === null).length} notes`);
console.log(`Results written to ${RESULTS_FILE}`);
if (failed.length > 0) process.exitCode = 1;
