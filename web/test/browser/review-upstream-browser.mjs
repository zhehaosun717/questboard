// Suggestion S3 — bounded, intercepted browser check for the review-order upstream warning/refusal.
// Unlike the fully-mocked usage/review-tab harnesses next to this file, this one drives the REAL in-process
// board server (src/server/server.js) against a synthetic, disposable project on a free loopback port: every
// HTTP call the page makes is a genuine request into the actual store/rules code this task changed, not a
// scripted JSON reply. "Intercepted" here means bounded, not mocked — Playwright's own request interception
// exists solely to abort anything that is not the local server's own origin (no real network egress, no
// Google Fonts, nothing external), never to fabricate an API response.
//
// Never touches a real project's 6097/6099, never installs anything. Runtime paths come from the
// environment; a missing one skips the run (exit 0) rather than failing a machine with no local Playwright:
//   QB_PW_DRIVER    path to the Playwright driver package's index.mjs
//   QB_PW_CHROMIUM  path to a Chromium executable compatible with that driver
//   QB_DIST         path to a built `web/dist` (or equivalent) directory to serve
//   QB_OUT          directory to write the JSON report into (defaults to cwd)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from '../../../src/server/server.js';
import { saveRoster } from '../../../src/core/roster.js';
import { captureAttemptReport } from '../../../src/core/reportEvidence.js';
import { makeProject, CARDS } from '../../../test/helpers.js';

const DRIVER = process.env.QB_PW_DRIVER;
const CHROME = process.env.QB_PW_CHROMIUM;
const DIST = process.env.QB_DIST;
const OUT = process.env.QB_OUT || process.cwd();
if (!DRIVER || !CHROME || !DIST) {
  console.log('review-upstream-browser: skipped (set QB_PW_DRIVER, QB_PW_CHROMIUM and QB_DIST to run this against a build).');
  process.exit(0);
}

const checks = [];
const check = (id, pass, evidence) => checks.push({ id, pass: Boolean(pass), evidence });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The real board keeps one long-lived SSE connection open (GET /api/quests/stream) for as long as the page
// is mounted. Node's plain server.close() only stops accepting new sockets and then waits for every existing
// one to end on its own — closing the Playwright context does not sever that keep-alive socket fast enough
// to avoid a hang here, so every open connection is force-closed before the close callback is awaited.
async function stopServer(server) {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
}

async function startProject({ reviewRequires = [] } = {}) {
  const project = makeProject({ verification: { progressDirs: ['.work/full'] }, policy: { reviewRequires } });
  project.write('docs/briefs/RUN-1-x.md', 'RUN-1');
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-browser-home-'));
  const home = { home: homeDir, roster: path.join(homeDir, 'roster.json'), status: path.join(homeDir, 'status.jsonl') };
  saveRoster(home.roster, { adventurers: CARDS.map(({ status, ...card }) => card) });
  const server = createServer({
    config: project.config, home, evidenceWaitMs: 0, getLanes: () => null, webDist: DIST,
    writeDelivery: async (config, lane, name) => path.join(config.root, '.work', 'oc', `${name}.md`),
    runners: { run: async () => ({ code: 0 }), session: async () => ({ code: 0, session: 'ses_x' }) },
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (route, method = 'GET', body) => {
    const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json', 'x-questboard-source': 'ui' }, body: body && JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { project, server, base, api };
}

// Posts the quest (first call only), assigns oc-mimo, waits for the fake runner, writes a PASS report at the
// delivery path the lane expects, captures it and moves the quest to delivered with that reference bound —
// mirrors test/server/fixture.js's real-store recipe (see test/server/quest-detail.test.js's RP-1 case),
// driven here over real HTTP.
async function deliverWithPassReport(ctx, id, { post = false } = {}) {
  if (post) {
    const posted = await ctx.api('/api/quests', 'POST', { package: id, brief: `docs/briefs/${id}-x.md` });
    check(`setup.${id}.posted`, posted.status === 201, posted.body);
  }
  const assigned = await ctx.api(`/api/quests/${id}/assign`, 'POST', { adventurer: 'oc-mimo' });
  check(`setup.${id}.assigned`, assigned.status === 200, assigned.body);
  await delay(200);
  const store = ctx.server.store;
  const name = store.get(id).assignee.name;
  fs.mkdirSync(path.join(ctx.project.root, '.work', 'oc'), { recursive: true });
  fs.writeFileSync(path.join(ctx.project.root, '.work', 'oc', `${name}.md`), 'VERDICT: PASS\n');
  const report = captureAttemptReport({ config: ctx.project.config, quest: store.get(id) });
  store.setStatus(id, 'delivered', {
    detail: 'done', by: 'lanes', report, source: 'collector',
    evidence: { kind: 'collector', attemptId: store.get(id).assignee.attemptId },
  });
}

// Only the local server's own origin ever answers; everything else (fonts, any stray absolute URL) is
// aborted — the network is bounded, never mocked: a same-origin request always reaches the real server.
async function boundedContext(browser, base, viewport) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  await context.route('**/*', (route) => {
    const url = route.request().url();
    return url.startsWith(base) ? route.continue() : route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  return { context, page, pageErrors };
}

async function openDrawer(page, base, questId) {
  await page.goto(`${base}/`);
  await page.waitForSelector(`article[data-quest="${questId}"]`, { timeout: 10000 });
  await page.click(`article[data-quest="${questId}"]`);
  await page.waitForSelector('#drawer', { timeout: 10000 });
}

async function upstreamText(page) {
  await page.waitForSelector('.upstream-evidence, .receipt-none', { timeout: 10000 });
  return page.$eval('#drawer', (el) => el.textContent || '');
}

// The board's own CSP (script-src 'self', no unsafe-eval) refuses page.waitForFunction's polling eval, so
// waiting for a text change after an action polls the real DOM through $eval instead — the same primitive
// upstreamText already uses successfully under this CSP.
async function waitForDrawerText(page, substring, { timeoutMs = 10000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = await page.$eval('#drawer', (el) => el.textContent || '').catch(() => '');
    if (text.includes(substring)) return text;
    if (Date.now() >= deadline) throw new Error(`waitForDrawerText: timed out waiting for "${substring}"; last text: ${text.slice(0, 400)}`);
    await delay(intervalMs);
  }
}

async function runForWidth(browser, width) {
  const viewport = { width, height: width === 1024 ? 800 : 900 };
  const label = `w${width}`;

  // ---- Scenario 1: default policy — warns, never refuses, and the drop is already allowed by the time the
  // review quest exists (POST .../review with an adventurer succeeded during setup).
  {
    const ctx = await startProject({ reviewRequires: [] });
    await deliverWithPassReport(ctx, 'RUN-1', { post: true });
    const dropped = await ctx.api('/api/quests/RUN-1/review', 'POST', { adventurer: 'agy-gemini' });
    check(`${label}.default.drop-allowed`, dropped.status === 201, dropped.body);

    const { context, page, pageErrors } = await boundedContext(browser, ctx.base, viewport);
    await openDrawer(page, ctx.base, 'REVIEW-RUN-1');
    const text = await upstreamText(page);
    check(`${label}.default.shows-upstream-evidence-block`, text.includes('上游证据'), text.slice(0, 400));
    check(`${label}.default.names-parent-and-gap`, text.includes('RUN-1') && text.includes('未经项目验证'), text.slice(0, 400));
    check(`${label}.default.not-blocked-no-override-form`, !/(?<!已)记录例外/.test(text), text.slice(0, 400));
    check(`${label}.default.no-page-errors`, pageErrors.length === 0, pageErrors);
    await context.close();
    await stopServer(ctx.server);
  }

  // ---- Scenario 2: policy.reviewRequires refuses the combined drop, then a posted-without-a-card review
  // shows the refusal in the drawer, an override lifts it, and a later re-dispatch shows it invalidated.
  {
    const ctx = await startProject({ reviewRequires: ['project-verification'] });
    await deliverWithPassReport(ctx, 'RUN-1', { post: true });
    const refused = await ctx.api('/api/quests/RUN-1/review', 'POST', { adventurer: 'agy-gemini' });
    check(`${label}.strict.combined-drop-refused`, refused.status === 409, refused.body);
    const posted = await ctx.api('/api/quests/RUN-1/review', 'POST', { note: '看一下' });
    check(`${label}.strict.review-posted-without-a-card`, posted.status === 201, posted.body);

    const { context, page, pageErrors } = await boundedContext(browser, ctx.base, viewport);
    await openDrawer(page, ctx.base, 'REVIEW-RUN-1');
    const blockedText = await upstreamText(page);
    check(`${label}.strict.shows-refusal-explanation`, blockedText.includes('还没满足') || blockedText.includes('派不出去'), blockedText.slice(0, 400));
    check(`${label}.strict.shows-override-control`, /(?<!已)记录例外/.test(blockedText), blockedText.slice(0, 400));

    // F1: the server's plain assign route must refuse this still-blocked review exactly like the preview,
    // checked as a direct API call (no button click; see the module comment on "intercepted, not mocked")
    // so it never disturbs the quest — status and assignee stay untouched for the override flow below.
    const blockedAssign = await ctx.api('/api/quests/REVIEW-RUN-1/assign', 'POST', { adventurer: 'agy-gemini' });
    check(`${label}.strict.f1-assign-refused-409`, blockedAssign.status === 409 && blockedAssign.body.error === 'refused', blockedAssign.body);
    check(`${label}.strict.f1-assign-refusal-names-upstream`, (blockedAssign.body.reasons || []).some((r) => r.code === 'upstream_unverified'), blockedAssign.body);
    const stillPosted = await ctx.api('/api/quests/REVIEW-RUN-1');
    check(`${label}.strict.f1-assign-posted-nothing`, stillPosted.body.quest.status === 'posted' && stillPosted.body.quest.assignee === null, stillPosted.body.quest);

    await page.fill('.upstream-evidence-override-form textarea', '手工确认过测试通过');
    await page.click('.upstream-evidence-override-form button');
    const overriddenText = await waitForDrawerText(page, '已记录例外');
    check(`${label}.strict.override-recorded-and-shown`, overriddenText.includes('已记录例外'), overriddenText.slice(0, 400));
    check(`${label}.strict.override-form-gone-once-recorded`, !/(?<!已)记录例外/.test(overriddenText), overriddenText.slice(0, 400));
    const afterOverride = await ctx.api('/api/quests/REVIEW-RUN-1');
    check(`${label}.strict.eligibility-now-ok`, afterOverride.body.quest.upstreamReview.blocked === false, afterOverride.body.quest.upstreamReview);

    // R2-F2: with the override recorded and nothing about the quest changed since, UpstreamEvidence's effect
    // must not refetch merely because a later snapshot delivery hands it a new `reviewOverride` object with
    // the same `at` — its deps are now the primitive `quest.reviewOverride?.at` plus `parentsKey`, neither of
    // which drifts here. Previously this polled the detail route roughly every 10s forever; 12s idle with no
    // request proves the fix, well inside a single poll interval of the old behavior.
    let detailRequestsWhileIdle = 0;
    const countDetailRequest = (req) => { if (req.url() === `${ctx.base}/api/quests/REVIEW-RUN-1`) detailRequestsWhileIdle += 1; };
    page.on('request', countDetailRequest);
    await delay(12000);
    page.off('request', countDetailRequest);
    check(`${label}.strict.r2f2-no-idle-refetch-with-override`, detailRequestsWhileIdle === 0, { detailRequestsWhileIdle });

    // F3: re-dispatch the parent (bounce then redeliver) while REVIEW-RUN-1's drawer stays open, with no
    // reload and no reselect — the recorded override was bound to the earlier attempt id, so the drawer's
    // own live SSE refresh (useBoard's refresh(), triggered by the events this produces) must be what shows
    // it invalidated, not a fresh page load re-fetching the detail route from scratch.
    await ctx.api('/api/quests/RUN-1/status', 'POST', { status: 'bounced', detail: '退回重跑', by: 'owner' });
    await deliverWithPassReport(ctx, 'RUN-1');
    const invalidatedText = await waitForDrawerText(page, '已失效');
    check(`${label}.strict.f3-override-invalidated-without-reload`, invalidatedText.includes('已失效'), invalidatedText.slice(0, 400));
    check(`${label}.strict.f3-blocked-again-without-reload`, invalidatedText.includes('还没满足') || invalidatedText.includes('派不出去'), invalidatedText.slice(0, 400));
    check(`${label}.strict.no-page-errors`, pageErrors.length === 0, pageErrors);
    await context.close();
    await stopServer(ctx.server);
  }
}

async function main() {
  const { chromium } = await import(pathToFileURL(DRIVER).href);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-proxy-server', '--disable-background-networking'] });
  let fatal = null;
  try {
    // Bounded, so a stuck page/selector/server-close cannot hang this script forever.
    await Promise.race([
      (async () => { for (const width of [1024, 1440]) await runForWidth(browser, width); })(),
      delay(120000).then(() => { throw new Error('review-upstream-browser: exceeded 120s overall budget'); }),
    ]);
  } catch (error) {
    fatal = String((error && error.stack) || error);
  } finally {
    await browser.close();
  }
  const passed = checks.filter((c) => c.pass).length;
  const failed = checks.filter((c) => !c.pass).map((c) => c.id);
  const report = { fatal, passed, failed, total: checks.length, checks };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'review-upstream-browser-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ fatal, passed, total: checks.length, failed }, null, 2));
  if (fatal || failed.length > 0) process.exitCode = 1;
  // Bounded exit: any leftover handle (a server this run's own error path failed to close) must never keep
  // the process alive past its own report being written.
  process.exit(process.exitCode || 0);
}

main();
