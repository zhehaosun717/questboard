// Portable full-app regression harness for the review tab (feedback 26). Mounts the real built app
// (App -> hash route -> useBoard -> ReviewView), never a synthetic stand-in: only a real mount runs the
// effects (scroll-into-view, keyboard focus) that a static render or a helper unit test cannot see.
//
// Every path comes from the environment; there is no server and no socket. `context.route('**/*')`
// answers each request from the built `dist`, a synthetic /api/quests snapshot, a synthetic /review/*
// page, or a 204/stream for the event source — everything else is aborted. No screenshots, no downloads.
//
// Not an installed gate: run by hand after `npm run build`, e.g.
//   QB_PW_DRIVER=/path/to/playwright/driver/package/index.mjs \
//   QB_CHROME=/path/to/chrome \
//   QB_DIST=./dist \
//   node test/review-browser-regression.mjs
//
// Missing env is not an error: the run is skipped (exit 0) so it never blocks anything that does not have
// a local Playwright + Chromium install.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DRIVER = process.env.QB_PW_DRIVER;
const CHROME = process.env.QB_CHROME;
const DIST = process.env.QB_DIST;
if (!DRIVER || !CHROME || !DIST) {
  console.log(
    'review-browser-regression: skipped (set QB_PW_DRIVER, QB_CHROME and QB_DIST to run this against a ' +
      '`npm run build` output).',
  );
  process.exit(0);
}
const OUT = process.env.QB_OUT || path.resolve(process.cwd(), 'review-browser-regression-report.json');
const ORIGIN = 'http://questboard-review-regression.invalid';

const { chromium } = await import(pathToFileURL(DRIVER).href);

const gen = (p, id, title, answered, total) => ({ page: id, title, url: `/review/${p}`, total, answered });
const legacy = (p) => ({ page: null, title: p, url: `/review/${p}`, total: 0, answered: 0, error: '手工页面，无批注统计' });
const LONG = '超长标题ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(8);

const SCENARIOS = {
  mixed: [
    gen('art/charA/final.html', 'charA-final', '角色A 最终稿', 1, 3),
    gen('art/charB/final.html', 'charB-final', '角色B 最终稿', 0, 2),
    gen(`art/${'很长的文件夹名Folder'.repeat(6)}/long.html`, 'long', LONG, 0, 1),
    legacy('art/charA/sketch.html'),
    legacy('art/charB/sketch.html'),
    gen('ui/menu.html', 'menu', '菜单完成稿', 2, 2),
    gen('ui/empty.html', 'empty', '空清单', 0, 0),
    { page: null, title: 'bad/page.html', url: '/review/bad/page.html', total: 0, answered: 0, error: 'ENOENT: open C:/Users/secret/x.html' },
    { page: null, title: 'traversal', url: '/review/../etc/passwd', total: 0, answered: 0, error: '手工页面，无批注统计' },
    { page: null, title: 'external', url: 'https://evil.example/x', total: 0, answered: 0, error: '手工页面，无批注统计' },
  ],
  malformed: [
    gen('m/neg.html', 'neg', '负数统计', 0, -3),
    gen('m/over.html', 'over', '超出统计', 7, 2),
    { page: 'str', title: '字符串统计', url: '/review/m/str.html', total: '5', answered: '1' },
    { page: 'nul', title: '空统计', url: '/review/m/nul.html', total: null, answered: null },
    { page: 'errnum', title: '非字符串错误', url: '/review/m/errnum.html', total: 0, answered: 0, error: 42 },
  ],
  zeroOnly: [gen('z/a.html', 'za', '零段落A', 0, 0), gen('z/b.html', 'zb', '零段落B', 0, 0)],
  completePlusUnknown: [gen('c/done.html', 'done', '已完成', 2, 2), legacy('c/manual.html')],
  pendingPlusUnknown: [gen('p/todo.html', 'todo', '待处理', 0, 2), legacy('p/manual.html')],
  threePending: [
    gen('t/a.html', 'ta', '待处理A', 0, 1),
    gen('t/b.html', 'tb', '待处理B', 0, 1),
    gen('t/c.html', 'tc', '已完成C', 1, 1),
  ],
  unsafeLaterPending: [
    gen('t/a.html', 'ta', '待处理A', 0, 1),
    { page: 'tx', title: '待处理X', url: '/review/../x.html', total: 1, answered: 0 },
  ],
  many: Array.from({ length: 60 }, (_, i) => gen(`many/p${String(i).padStart(2, '0')}.html`, `p${i}`, `页面 ${i}`, 0, 1)),
  empty: [],
};

const snapshotFor = (reviewPages) => ({
  generatedAt: '2026-09-15T00:00:00.000Z',
  project: { name: 'synthetic', id: 'synthetic000', lanes: [] },
  quests: [], roster: [], eligibility: {}, reviewEligibility: {}, env: { treeLocked: false }, live: {},
  threads: {}, reviewPages, unpostedBriefs: [], verification: null, laneLimits: {}, openQuestions: 0,
});

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const checks = [];
const pageErrors = [];
const requests = [];
const check = (id, pass, evidence) => checks.push({ id, pass: Boolean(pass), evidence });

// `emitHello` fires the stream's one custom event that useBoard listens for (`hello` -> refresh()), so a
// scenario can force one extra, content-identical repaint shortly after mount without waiting for the
// 10s poll. Every other scenario gets the inert 204 the real board also gets when nothing has happened.
async function makeContext(browser, pages, viewport, { emitHello = false } = {}) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const record = (disposition) => requests.push({ url: url.href.slice(0, 160), disposition });
    if (url.origin !== ORIGIN) { record('aborted-external'); return route.abort('blockedbyclient'); }
    if (url.pathname === '/api/quests') {
      record('snapshot');
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshotFor(pages)) });
    }
    if (url.pathname === '/api/quests/stream') {
      record('stream');
      return emitHello
        ? route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: hello\ndata: {}\n\n' })
        : route.fulfill({ status: 204, body: '' });
    }
    if (url.pathname.startsWith('/api/')) { record('api-404'); return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"synthetic"}' }); }
    if (url.pathname.startsWith('/review/')) { record('review-html'); return route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><title>r</title><p>${url.pathname}</p>` }); }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.resolve(DIST, rel);
    if (!file.startsWith(path.resolve(DIST)) || !fs.existsSync(file)) { record('dist-404'); return route.fulfill({ status: 404, body: '' }); }
    record('dist');
    return route.fulfill({ status: 200, contentType: MIME[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  return { context, page };
}

async function open(browser, name, { viewport = { width: 1440, height: 900 }, hash = '#/review', emitHello = false } = {}) {
  const { context, page } = await makeContext(browser, SCENARIOS[name], viewport, { emitHello });
  await page.goto(`${ORIGIN}/${hash}`);
  await page.waitForSelector('.review-page, .review-list-empty', { timeout: 10000 });
  await page.waitForTimeout(150);
  return { context, page };
}

const text = (page, sel) => page.$eval(sel, (e) => e.textContent).catch(() => null);
const selectedParam = (page) => page.evaluate(() => new URLSearchParams(location.hash.split('?')[1] || '').get('page'));
const rowVisibility = (page) => page.evaluate(() => {
  const row = document.querySelector('button.review-page.is-selected');
  const list = document.querySelector('.review-page-list');
  if (!row || !list) return { found: false };
  const r = row.getBoundingClientRect();
  const l = list.getBoundingClientRect();
  return { found: true, visible: r.top >= l.top - 1 && r.bottom <= l.bottom + 1, scrollTop: list.scrollTop };
});

async function layout(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const shell = document.querySelector('.review-shell');
    const list = document.querySelector('.review-page-list');
    const clipped = [...document.querySelectorAll('.review-toolbar-actions button, .review-toolbar-actions a')]
      .filter((b) => { const r = b.getBoundingClientRect(); const shellRect = document.querySelector('.review-reader').getBoundingClientRect(); return r.right > shellRect.right + 1 || r.left < shellRect.left - 1; })
      .map((b) => b.textContent.trim());
    const titleH2 = document.querySelector('.review-toolbar-title h2');
    const th = titleH2 ? titleH2.getBoundingClientRect() : null;
    return {
      docScroll: de.scrollWidth, docClient: de.clientWidth,
      shellScroll: shell.scrollWidth, shellClient: shell.clientWidth,
      listScroll: list?.scrollWidth ?? null, listClient: list?.clientWidth ?? null,
      rowsOverflowing: [...document.querySelectorAll('.review-page')].filter((r) => r.scrollWidth > r.clientWidth + 1).length,
      clippedToolbarControls: clipped,
      titleOverflowsShell: th ? th.right > shell.getBoundingClientRect().right + 1 : false,
    };
  });
}

async function run(browser) {
  // ---- R1/R2: whole-list decides completion; a search/filter subset is described as counts, never claims done
  {
    const { context, page } = await open(browser, 'mixed', { hash: `#/review` });
    const search = page.getByRole('searchbox', { name: '搜索评审页' });
    await search.fill('菜单');
    const sum = await text(page, '.review-sidebar-summary');
    const scoped = await text(page, '.review-sidebar-scoped-summary');
    check('R1.search-subset-does-not-claim-all-done', !sum.includes('都处理完了'), { summary: sum, note: 'pending/unknown pages exist outside the search' });
    check('R1.scoped-line-describes-subset-not-completion', Boolean(scoped) && !scoped.includes('都处理完了'), scoped);
    await search.fill('');
    await context.close();
  }
  {
    const { context, page } = await open(browser, 'completePlusUnknown');
    check('R1.all.summary-does-not-claim-all-done', !(await text(page, '.review-sidebar-summary')).includes('都处理完了'), await text(page, '.review-sidebar-summary'));
    await page.getByRole('button', { name: '有统计', exact: true }).click();
    const s1 = await text(page, '.review-sidebar-summary');
    check('R1.filter.summary-still-whole-list-based', !s1.includes('都处理完了'), { summary: s1, note: '1 unknown page exists outside the filter' });
    await page.getByLabel('只看未处理').check();
    const m1 = await text(page, '.review-list-empty');
    check('R2.available+unanswered.empty-does-not-claim-all-done', !m1.includes('都处理完了'), m1);
    await context.close();
  }
  {
    const { context, page } = await open(browser, 'pendingPlusUnknown');
    await page.getByRole('button', { name: '统计不可用', exact: true }).click();
    await page.getByLabel('只看未处理').check();
    const m = await text(page, '.review-list-empty');
    check('R2.unavailable+unanswered.no-false-cleared-claim', !m.includes('都清空') && !m.includes('都处理完了'), { message: m, note: '待处理 is hidden by the stats filter, not actually done' });
    await context.close();
  }
  // ---- R3: "下一份未处理" never claims 都处理完了 while an earlier page is still pending
  {
    const { context, page } = await open(browser, 'threePending', { hash: `#/review?page=${encodeURIComponent('/review/t/b.html')}` });
    const btn = page.getByRole('button', { name: /下一份未处理/ });
    const info = { text: await btn.textContent(), title: await btn.getAttribute('title') };
    check('R3.no-false-done-when-earlier-pending', !(info.text + info.title).includes('都处理完了'), { ...info, note: '待处理A (earlier in order) is still pending' });
    check('R3.hint-names-earlier-pending', /前面还有/.test(info.text) || /前面还有/.test(info.title), info);
    await context.close();
  }
  // ---- B1: a search that hides a later pending page must not make "下一份未处理" claim 都处理完了
  {
    const { context, page } = await open(browser, 'threePending', { hash: `#/review?page=${encodeURIComponent('/review/t/a.html')}` });
    const btn = page.getByRole('button', { name: /下一份未处理/ });
    const search = page.getByRole('searchbox', { name: '搜索评审页' });
    await search.fill('待处理A');
    await page.waitForTimeout(150);
    const info = { text: await btn.textContent(), title: await btn.getAttribute('title'), disabled: await btn.isDisabled() };
    const summary = await text(page, '.review-sidebar-summary');
    check('B1.no-false-done-when-search-hides-later-pending', !(info.text + info.title).includes('都处理完了'), { ...info, note: '待处理B is hidden by the search but still pending', summary });
    check('B1.hint-names-filter-hidden-pending', /筛选隐藏了后面/.test(info.text) || /筛选隐藏了后面/.test(info.title), info);
    check('B1.summary-still-counts-hidden-pending', summary.includes('2 份未处理'), summary);
    const clearBtn = page.getByRole('button', { name: '清空筛选', exact: true });
    check('B1.clear-filter-control-offered', (await clearBtn.count()) === 1, await clearBtn.count());
    await clearBtn.click();
    await page.waitForTimeout(150);
    const afterClear = { text: await btn.textContent(), title: await btn.getAttribute('title'), disabled: await btn.isDisabled() };
    check('B1.clear-filter-restores-navigation', afterClear.disabled === false && !afterClear.text.includes('都处理完了'), afterClear);
    await context.close();
  }
  // ---- B1 (related, smaller): a later pending page with an unsafe URL is named, not folded into 都处理完了
  {
    const { context, page } = await open(browser, 'unsafeLaterPending', { hash: `#/review?page=${encodeURIComponent('/review/t/a.html')}` });
    const btn = page.getByRole('button', { name: /下一份未处理/ });
    const info = { text: await btn.textContent(), title: await btn.getAttribute('title') };
    const summary = await text(page, '.review-sidebar-summary');
    check('B1.unsafe-later-pending-not-claimed-done', !(info.text + info.title).includes('都处理完了'), { ...info, summary });
    check('B1.unsafe-later-pending-named-distinctly', /无法安全打开/.test(info.text) || /无法安全打开/.test(info.title), info);
    await context.close();
  }
  // ---- R4: malformed statistics are never shown as real counts and never count as complete
  {
    const { context, page } = await open(browser, 'malformed');
    const sum = await text(page, '.review-sidebar-summary');
    const labels = await page.$$eval('.review-page-label', (els) => els.map((e) => e.textContent));
    check('R4.malformed-neutral-not-complete', !sum.includes('都处理完了') && !sum.includes('已完成') && labels.every((l) => !l.startsWith('已批注')), { summary: sum, labels });
    const bars = await page.$$eval('[role=progressbar]', (els) => els.length);
    check('R4.no-progress-bar-for-malformed-stats', bars === 0, bars);
    await context.close();
  }
  // ---- R5: a zero-section manifest is a neutral bucket, never 都处理完了
  {
    const { context, page } = await open(browser, 'zeroOnly');
    const sum = await text(page, '.review-sidebar-summary');
    check('R5.zero-total-does-not-claim-all-done', !sum.includes('都处理完了'), sum);
    await context.close();
  }
  // ---- R6: deep-linked selection scrolls into view once the async snapshot has arrived
  {
    const target = '/review/many/p55.html';
    const { context, page } = await open(browser, 'many', { hash: `#/review?page=${encodeURIComponent(target)}` });
    await page.waitForTimeout(300);
    const v1 = await rowVisibility(page);
    check('R6.deeplink-row-visible-after-async-snapshot', v1.found && v1.visible, v1);

    // R6 (unfold): scroll the reader away, fold the sidebar, unfold it — the row must be found again.
    await page.evaluate(() => { document.querySelector('.review-page-list').scrollTop = 0; });
    await page.getByRole('button', { name: '收起列表' }).click();
    await page.getByRole('button', { name: '展开列表' }).click();
    await page.waitForTimeout(150);
    const v2 = await rowVisibility(page);
    check('R6.row-visible-after-unfold', v2.found && v2.visible, v2);

    // R6 (filter clear): hide the selected row behind a search that excludes it, then clear the search.
    const search = page.getByRole('searchbox', { name: '搜索评审页' });
    await page.evaluate(() => { document.querySelector('.review-page-list').scrollTop = 0; });
    await search.fill('页面 3');
    await page.waitForTimeout(100);
    await search.fill('');
    await page.waitForTimeout(150);
    const v3 = await rowVisibility(page);
    check('R6.row-visible-after-filter-clear', v3.found && v3.visible, v3);
    await context.close();
  }
  // ---- R7: an unrelated repaint (same content, new object) must not steal the reader's scroll position
  {
    const target = '/review/many/p55.html';
    const { context, page } = await open(browser, 'many', { hash: `#/review?page=${encodeURIComponent(target)}`, emitHello: true });
    await page.waitForTimeout(300);
    const before = await rowVisibility(page);
    check('R7.deeplink-visible-before-repaint', before.found && before.visible, before);
    await page.evaluate(() => { document.querySelector('.review-page-list').scrollTop = 0; });
    // The `hello` frame above debounces a refresh() ~250ms after mount; give it time to land.
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => document.querySelector('.review-page-list').scrollTop);
    check('R7.repaint-does-not-reset-manual-scroll', after === 0, { scrollTopAfterRepaint: after, note: 'selectedUrl/visibility/fold state were unchanged by the repaint' });
    await context.close();
  }
  // ---- general safety/behaviour, both required widths
  for (const width of [1024, 1440]) {
    const vp = { width, height: width === 1024 ? 800 : 900 };
    const { context, page } = await open(browser, 'mixed', { viewport: vp, hash: `#/review?page=${encodeURIComponent('/review/art/charB/final.html')}` });
    const rows = await page.$$eval('.review-page-list .review-page', (els) => els.map((e) => ({
      tag: e.tagName,
      title: e.querySelector('.review-page-title')?.textContent ?? '',
      secondary: e.querySelector('.review-page-secondary')?.textContent ?? '',
      label: e.querySelector('.review-page-label')?.textContent ?? '',
    })));
    const body = await page.evaluate(() => document.body.innerText);
    check(`safety.${width}.legacy-neutral-not-manual-claim`, rows.filter((r) => r.label === '统计不可用 · 仅查看页面').length === 4 && !body.includes('手工页面'), rows.map((r) => `${r.title}|${r.label}`));
    check(`safety.${width}.bad-error-safe-no-leak`, rows.some((r) => r.label === '页面信息无法读取') && !/ENOENT|secret/.test(body), 'raw error text absent');
    const unsafe = rows.filter((r) => r.title === 'traversal' || r.secondary.includes('evil'));
    check(`safety.${width}.unsafe-rows-not-buttons`, unsafe.length >= 2 && unsafe.every((r) => r.tag === 'DIV'), unsafe);
    check(`safety.${width}.no-anchor-or-iframe-to-unsafe`, await page.evaluate(() => ![...document.querySelectorAll('a[href],iframe[src]')].some((e) => /evil|\.\./.test(e.getAttribute('href') || e.getAttribute('src')))), '');
    const dup = rows.filter((r) => r.title === 'sketch');
    check(`safety.${width}.duplicate-filenames-distinguishable`, dup.length === 2 && dup[0].secondary !== dup[1].secondary, dup.map((r) => r.secondary));

    const L = await layout(page);
    check(`layout.${width}.no-horizontal-overflow`, L.docScroll <= L.docClient && L.shellScroll <= L.shellClient && (L.listScroll ?? 0) <= (L.listClient ?? 0) && L.rowsOverflowing === 0, L);
    check(`layout.${width}.toolbar-controls-not-clipped`, L.clippedToolbarControls.length === 0, L.clippedToolbarControls);

    if (width === 1024) {
      // O1: the long toolbar title must not be cut off with no ellipsis inside the ≤1050px column layout.
      await page.evaluate((u) => { location.hash = `#/review?page=${encodeURIComponent(u)}`; }, `/review/art/${'很长的文件夹名Folder'.repeat(6)}/long.html`);
      await page.waitForTimeout(150);
      const L2 = await layout(page);
      check('O1.long-title-not-overflowing-shell-at-1024', !L2.titleOverflowsShell, L2);
    }

    // keyboard: ArrowDown moves the selection
    await page.focus('button.review-page.is-selected');
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(120);
    check(`safety.${width}.keyboard-arrowdown-moves-selection`, (await selectedParam(page)) !== '/review/art/charB/final.html', await selectedParam(page));
    await context.close();
  }
  // ---- unsafe deep link never renders an iframe
  {
    const { context, page } = await open(browser, 'mixed', { hash: `#/review?page=${encodeURIComponent('/review/../etc/passwd')}` });
    check('safety.unsafe-deeplink-no-iframe', (await page.$('iframe')) === null, await page.evaluate(() => location.hash));
    await context.close();
  }
  // ---- empty board gets its own honest message
  {
    const { context, page } = await open(browser, 'empty');
    const sum = await text(page, '.review-sidebar-summary');
    const msg = await text(page, '.review-list-empty');
    check('empty.own-message-not-all-done', sum.includes('暂无评审页') && msg.includes('暂无评审页') && !(sum + msg).includes('都处理完了'), { sum, msg });
    await context.close();
  }
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-proxy-server', '--disable-background-networking'] });
let fatal = null;
try {
  await run(browser);
} catch (error) {
  fatal = String((error && error.stack) || error);
} finally {
  await browser.close();
}
check('network.no-unhandled-dist-request', !requests.some((r) => r.disposition === 'dist-404'), { dispositions: requests.reduce((acc, r) => ({ ...acc, [r.disposition]: (acc[r.disposition] || 0) + 1 }), {}) });
check('page.no-uncaught-errors', pageErrors.length === 0, pageErrors.slice(0, 5));
const report = { fatal, passed: checks.filter((c) => c.pass).length, failed: checks.filter((c) => !c.pass).map((c) => c.id), checks };
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ fatal, passed: report.passed, failed: report.failed }, null, 2));
if (fatal || report.failed.length > 0) process.exitCode = 1;
