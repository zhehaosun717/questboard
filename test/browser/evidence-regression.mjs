// Portable browser acceptance regression for the S2 attempt-evidence drawer section
// (web/src/components/quest/EvidenceSection.tsx). Env vars (no defaults, no private machine paths):
//   PW_DRIVER  path to a local playwright-core (or playwright) driver module to import
//   CHROME     path to a local Chromium/Chrome executable
//   OUT_DIR    a writable directory for results.json and screenshots (created if missing)
//   DIST       a built `web/dist` to serve (npm --prefix web run build)
// Every request is served from an in-memory fixture (route interception on a fake origin) or the given DIST;
// non-GET requests are aborted and counted, off-origin requests are aborted except real font hosts.
// Run with: PW_DRIVER=... CHROME=... OUT_DIR=... DIST=... node test/browser/evidence-regression.mjs
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── fixtures ──
const baseQuest = (id, overrides = {}) => ({
  id, kind: 'code', status: 'dispatched', title: `${id} 的测试委托`, brief: `docs/briefs/${id}-x.md`,
  priority: 2, parents: [], conflicts: [], allowedLanes: [], needsOwner: '', reviewPage: '',
  assignee: { adventurerId: 'codex-luna', family: null, lane: 'codex', model: 'gpt-5.6-luna', variant: 'high', name: 'w1', at: '2026-09-14T00:00:00.000Z', by: 'owner', attemptId: 'att-1' },
  dispatches: [{ adventurerId: 'codex-luna', family: null, lane: 'codex', model: 'gpt-5.6-luna', variant: 'high', name: 'w1', at: '2026-09-14T00:00:00.000Z', by: 'owner', attemptId: 'att-1' }],
  rulings: [], files: [], createdAt: '2026-09-13T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z',
  ...overrides,
});

const reportItem = (bound = true) => ({
  kind: 'report', label: '模型自报', state: 'passed', source: 'delivery', ref: '.work/codex/w1.md',
  digest: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd', capturedAt: '2026-09-14T00:05:00.000Z',
  attemptId: 'att-1', bound,
});

// A STALE progress.txt from before the attempt (2026-09-13, attempt is 2026-09-14): bound:false, never
// styled as passed even though its own recorded state reads passed.
const staleVerificationItem = () => ({
  kind: 'project-verification', label: '项目验证记录', state: 'passed', source: 'progress-strip',
  ref: '.work/full/progress.txt', digest: 'deadbeefcafefeed'.repeat(4).slice(0, 64), capturedAt: '2026-09-13T00:00:00.000Z',
  attemptId: 'att-1', bound: false, reason: '这是这次派遣之前的记录，不算这次的证据',
});

// A FRESH progress.txt written after the attempt: bound:true, styled as passed.
const freshVerificationItem = () => ({
  kind: 'project-verification', label: '项目验证记录', state: 'passed', source: 'progress-strip',
  ref: '.work/full/progress.txt', digest: 'a1b2c3d4e5f60718'.repeat(4).slice(0, 64), capturedAt: '2026-09-14T01:00:00.000Z',
  attemptId: 'att-1', bound: true,
});

const failedVerificationItem = () => ({
  kind: 'project-verification', label: '项目验证记录', state: 'failed', source: 'progress-strip',
  ref: '.work/full/progress.txt', digest: 'f0f0f0f0f0f0f0f0'.repeat(4).slice(0, 64), capturedAt: '2026-09-14T01:00:00.000Z',
  attemptId: 'att-1', bound: true,
});

const hookNotConfigured = () => ({
  kind: 'hook', label: '验证钩子', state: 'not_configured', source: null, ref: null, digest: null,
  capturedAt: null, attemptId: 'att-1', bound: false, reason: '项目没有启用验证钩子',
});

// A long, real-shaped hook record so the R4-style overflow check at 1024/1440 has something to stress —
// a long commandRef and a deeply nested logPath.
const hookLong = () => ({
  kind: 'hook', label: '验证钩子', state: 'failed', source: 'npm run verify -- --project e2e-suite --long-flag-name-that-keeps-going-and-going',
  ref: 'hooks/att-1/very/deeply/nested/log/directory/that/keeps/going/and/going/output.log',
  digest: 'bbbbccccddddeeee'.repeat(4).slice(0, 64), capturedAt: '2026-09-14T01:10:00.000Z',
  attemptId: 'att-1', bound: true, commandRef: 'npm run verify -- --project e2e-suite --long-flag-name-that-keeps-going-and-going',
  startedAt: '2026-09-14T01:05:00.000Z', endedAt: '2026-09-14T01:10:00.000Z', exitCode: 1,
  logPath: 'hooks/att-1/very/deeply/nested/log/directory/that/keeps/going/and/going/output.log',
  logDigest: 'bbbbccccddddeeee'.repeat(4).slice(0, 64),
});

const quests = {
  'EV-STALE': { quest: baseQuest('EV-STALE'), evidence: { version: 1, attemptId: 'att-1', attemptAt: '2026-09-14T00:00:00.000Z', items: [reportItem(true), staleVerificationItem(), hookNotConfigured()] } },
  'EV-FRESH': { quest: baseQuest('EV-FRESH'), evidence: { version: 1, attemptId: 'att-1', attemptAt: '2026-09-14T00:00:00.000Z', items: [reportItem(true), freshVerificationItem(), hookNotConfigured()] } },
  'EV-FAILED': { quest: baseQuest('EV-FAILED'), evidence: { version: 1, attemptId: 'att-1', attemptAt: '2026-09-14T00:00:00.000Z', items: [reportItem(true), failedVerificationItem(), hookLong()] } },
  'EV-NONE': { quest: baseQuest('EV-NONE', { status: 'posted', assignee: null, dispatches: [] }), evidence: { version: 1, attemptId: null, attemptAt: null, items: [
    { kind: 'report', label: '模型自报', state: 'missing', source: null, ref: null, digest: null, capturedAt: null, attemptId: null, bound: false, reason: '这次派遣没有报告' },
    { kind: 'project-verification', label: '项目验证记录', state: 'not_configured', source: null, ref: null, digest: null, capturedAt: null, attemptId: null, bound: false, reason: '项目没有配置验证目录' },
    hookNotConfigured(),
  ] } },
  // Simulates an older server: the detail route sends no `evidence` field at all.
  'EV-OLD': { quest: baseQuest('EV-OLD'), evidence: undefined },
};

const snapshot = {
  generatedAt: new Date().toISOString(),
  project: { name: 'fixture', id: 'fx-s2', lanes: ['codex'] },
  quests: Object.values(quests).map((q) => q.quest),
  roster: [], eligibility: {}, reviewEligibility: {}, env: { treeLocked: false }, live: {}, threads: {},
  reviewPages: [], unpostedBriefs: [], verification: null, laneLimits: {}, openQuestions: 0,
};

const ctl = { requests: [], writes: 0, blocked: [], injected: { offsite: 0 } };
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
async function handle(route) {
  const req = route.request(); const url = new URL(req.url());
  if (url.origin !== ORIGIN) { ctl.blocked.push(`offsite ${url.host}${url.pathname}`); ctl.injected.offsite += 1; return route.abort(); }
  if (req.method() !== 'GET') { ctl.writes += 1; ctl.blocked.push(`${req.method()} ${url.pathname}`); return route.abort(); }
  try {
    if (url.pathname === '/api/quests') { ctl.requests.push(url.pathname); return await route.fulfill({ json: snapshot }); }
    if (url.pathname === '/api/quests/stream') return await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'event: hello\ndata: {}\n\n' });
    const detailMatch = url.pathname.match(/^\/api\/quests\/([^/]+)$/);
    if (detailMatch) {
      ctl.requests.push(url.pathname);
      const id = decodeURIComponent(detailMatch[1]);
      const fixture = quests[id];
      if (!fixture) return await route.fulfill({ status: 404, json: { error: 'quest not found' } });
      const detail = { ...fixture.quest, live: null, threads: [], eligibility: { canTake: [], refused: {} } };
      if (fixture.evidence !== undefined) detail.evidence = fixture.evidence;
      return await route.fulfill({ json: { quest: detail } });
    }
    if (url.pathname.startsWith('/api/')) return await route.fulfill({ status: 404, json: { error: `fixture has no ${url.pathname}` } });
    const file = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const full = path.join(DIST, file);
    if (!full.startsWith(path.resolve(DIST)) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return await route.fulfill({ status: 404, body: 'nf' });
    return await route.fulfill({ status: 200, headers: { 'content-type': types[path.extname(full)] || 'application/octet-stream' }, body: fs.readFileSync(full) });
  } catch { return undefined; }
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Shanghai', locale: 'zh-CN' });
await context.route('**/*', handle);
const page = await context.newPage();
const consoleErrors = []; const pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push({ text: m.text(), url: m.location()?.url || '' }); });
page.on('pageerror', (e) => pageErrors.push(e.message));

const openQuest = async (id) => {
  // Close any drawer already open first (real user flow) so the previous quest's EvidenceSection actually
  // unmounts before the next one mounts — a same-hash page.goto is a no-op navigation here (SPA, hash
  // unchanged), so it never remounts the app on its own.
  if (await page.locator('#drawer .close').count()) {
    await page.locator('#drawer .close').click();
    await page.waitForSelector('#drawer', { state: 'detached', timeout: 5000 }).catch(() => undefined);
  }
  await page.waitForSelector(`article[data-quest="${id}"]`, { timeout: 10000 });
  await page.locator(`article[data-quest="${id}"]`).click();
  await page.waitForSelector('#drawer', { timeout: 10000 });
};
const evidenceSection = () => page.locator('.d-sec', { hasText: '这次派遣的证据' });
const waitEvidenceSettled = async () => {
  await page.waitForFunction(() => {
    const sections = [...document.querySelectorAll('.d-sec')];
    const sec = sections.find((s) => s.querySelector('h3')?.textContent?.includes('这次派遣的证据'));
    return sec ? !sec.textContent.includes('证据读取中') : true;
  }, null, { timeout: 10000 });
};

try {
  await page.goto(`${ORIGIN}/#/board`);

  // ── EV-STALE: report bound+passed, project-verification bound:false, hook not_configured ──
  await openQuest('EV-STALE');
  await waitEvidenceSettled();
  const staleText = await evidenceSection().innerText();
  check('EV-STALE section renders all three kinds with Chinese labels', ['模型自报', '项目验证记录', '验证钩子'].every((s) => staleText.includes(s)), staleText.slice(0, 200));
  check('EV-STALE report item shows 通过 and is not marked unbound', staleText.includes('通过') && (await evidenceSection().locator('.attempt-evidence-item').first().locator('.attempt-evidence-chip-unbound').count()) === 0);
  const staleItems = evidenceSection().locator('.attempt-evidence-item');
  const staleVerify = staleItems.nth(1);
  check('EV-STALE project-verification is visibly unbound (chip + class) despite state=passed', (await staleVerify.locator('.attempt-evidence-chip-unbound').count()) === 1 && (await staleVerify.evaluate((el) => el.className.includes('attempt-evidence-unbound'))), await staleVerify.innerText());
  check('EV-STALE project-verification shows the stale reason text', (await staleVerify.innerText()).includes('这是这次派遣之前的记录，不算这次的证据'));
  check('EV-STALE hook item is 未配置 with its reason', (await staleItems.nth(2).innerText()).includes('未配置') && (await staleItems.nth(2).innerText()).includes('项目没有启用验证钩子'));
  check('EV-STALE reference row shows source/ref/digest as copyable text', staleText.includes('.work/codex/w1.md') && staleText.includes('0123456789ab'));

  // ── EV-FRESH: project-verification bound:true, no unbound chip ──
  await openQuest('EV-FRESH');
  await waitEvidenceSettled();
  const freshVerify = evidenceSection().locator('.attempt-evidence-item').nth(1);
  check('EV-FRESH project-verification is bound (no unbound chip), state 通过', (await freshVerify.locator('.attempt-evidence-chip-unbound').count()) === 0 && (await freshVerify.innerText()).includes('通过'), await freshVerify.innerText());

  // ── F1: switching quests WITHOUT closing the drawer must not leave the previous quest's evidence section
  // mounted (duplicate React key with MetadataSection let this slip through in round 1). Deliberately skip
  // openQuest()'s close-first step here — that is exactly the case round 1's regression never exercised. ──
  await openQuest('EV-STALE');
  await waitEvidenceSettled();
  await page.locator(`article[data-quest="EV-FRESH"]`).click();
  await page.waitForFunction(() => document.querySelector('#drawer')?.textContent?.includes('EV-FRESH') ?? false, null, { timeout: 10000 });
  await waitEvidenceSettled();
  const switchSectionCount = await evidenceSection().count();
  check('switching quests without closing the drawer leaves exactly one evidence section (F1)', switchSectionCount === 1, String(switchSectionCount));
  const switchText = switchSectionCount ? await evidenceSection().innerText() : '';
  check(
    'the evidence section after switching shows only the new quest\'s data, none of the previous quest\'s (F1)',
    switchText.includes('a1b2c3d4e5f6') && !switchText.includes('deadbeefcafe'),
    switchText.slice(0, 300),
  );
  await evidenceSection().screenshot({ path: path.join(SHOTS, 'switch-without-close.png') }).catch(() => undefined);

  // ── EV-FAILED: failed verification + a real-shaped, long hook record ──
  await openQuest('EV-FAILED');
  await waitEvidenceSettled();
  const failedVerify = evidenceSection().locator('.attempt-evidence-item').nth(1);
  check('EV-FAILED project-verification reads 失败', (await failedVerify.innerText()).includes('失败'));
  const hookRow = evidenceSection().locator('.attempt-evidence-item').nth(2);
  check('EV-FAILED hook item shows the long commandRef as source, bound, state 失败', (await hookRow.innerText()).includes('npm run verify') && (await hookRow.innerText()).includes('失败') && (await hookRow.locator('.attempt-evidence-chip-unbound').count()) === 0);

  // ── EV-NONE: never dispatched — every item missing/not_configured, none styled as passed ──
  await openQuest('EV-NONE');
  await waitEvidenceSettled();
  const noneText = await evidenceSection().innerText();
  check('EV-NONE shows 缺失/未配置 for every item, no 通过 anywhere', noneText.includes('缺失') && noneText.includes('未配置') && !noneText.includes('通过'), noneText.slice(0, 200));
  check('EV-NONE attempt line reads 还没有派遣', noneText.includes('还没有派遣'));

  // ── EV-OLD: older server sends no `evidence` field — section fully hidden after the fetch settles ──
  await openQuest('EV-OLD');
  await page.waitForTimeout(600); // give the on-demand fetch time to resolve
  check('EV-OLD (no evidence field) renders no attempt-evidence section at all, and no 这次派遣的证据 heading', (await evidenceSection().count()) === 0);

  // ── R4-style overflow check at 1024 and 1440 (long hook commandRef/logPath from EV-FAILED) ──
  await openQuest('EV-FAILED');
  await waitEvidenceSettled();
  for (const w of [1024, 1440]) {
    await page.setViewportSize({ width: w, height: 900 });
    await sleep(200);
    const overflow = await page.evaluate(() => {
      const sec = [...document.querySelectorAll('.d-sec')].find((s) => s.querySelector('h3')?.textContent?.includes('这次派遣的证据'));
      if (!sec) return { doc: 0, sec: 0, over: [] };
      const right = sec.getBoundingClientRect().right;
      const over = [];
      sec.querySelectorAll('*').forEach((el) => {
        const d = Math.round(el.getBoundingClientRect().right - right);
        if (d > 1) over.push(`${el.className || el.tagName}:+${d}`);
      });
      return { doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, sec: sec.scrollWidth - sec.clientWidth, over };
    });
    check(`no horizontal overflow in the evidence section at ${w}px`, overflow.doc <= 0 && overflow.sec <= 0 && overflow.over.length === 0, JSON.stringify(overflow.over.slice(0, 5)));
    await evidenceSection().screenshot({ path: path.join(SHOTS, `evidence-${w}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
} catch (err) {
  check('probe completed without exception', false, err.stack?.split('\n').slice(0, 4).join(' | '));
  await page.screenshot({ path: path.join(SHOTS, 'failure.png') }).catch(() => undefined);
} finally {
  check('no non-GET requests issued by the page', ctl.writes === 0, ctl.blocked.filter((b) => !b.startsWith('offsite')).join(', ') || 'none');
  const offsiteHosts = [...new Set(ctl.blocked.filter((b) => b.startsWith('offsite')).map((b) => b.split(' ')[1].split('/')[0]))];
  check('off-origin requests only to font hosts (all aborted)', offsiteHosts.every((h) => /^fonts\.(googleapis|gstatic)\.com$/.test(h)), offsiteHosts.join(','));
  check('no pageerror', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  const unexpected = consoleErrors.filter((m) => !/fonts\.(googleapis|gstatic)\.com/.test(m.url) && !/status of 404/.test(m.text));
  check('no unexpected console errors', unexpected.length === 0, JSON.stringify(unexpected.slice(0, 5)));
  const summary = { pass: results.filter((r) => r.pass === true).length, fail: results.filter((r) => r.pass === false).length };
  console.log('SUMMARY', JSON.stringify(summary));
  fs.writeFileSync(path.join(OUT, 'evidence-regression-results.json'), JSON.stringify({ summary, results }, null, 2));
  await browser.close();
}
