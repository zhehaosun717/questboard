// Page/context lifecycle and small DOM query helpers shared by every scenario module: routes every request
// on the synthetic origin (scripted `/api/usage` and `/api/quests`, static files off `DIST`, everything else
// aborted), then gives scenarios a `{ context, page, log }` handle to drive and a matching teardown.
import fs from 'node:fs';
import path from 'node:path';
import { DIST, MIME, NOW, ORIGIN, sleep } from './context.mjs';
import { snapshot } from './fixtures.mjs';

export async function openApp(browser, { viewport = { width: 1440, height: 900 }, clock = false, snapshotFn = () => snapshot('proj-a'), usageFn, hash = '#/usage', hijack = false } = {}) {
  const context = await browser.newContext({ viewport });
  if (hijack) {
    // A transport that genuinely ignores its own AbortSignal -- a real browser fetch() always rejects once
    // its signal fires (see the note above h3Abandoned), so the only way to exercise the watchdog's
    // force-release path end to end, in an actual page, is to swap in a fetch that never settles at all
    // while `window.__hang` is set. Installed before the page's own scripts run, so UsageView's own
    // `fetch` calls (via fetchUsageReport) go through this instead of the network.
    await context.addInitScript(() => {
      const orig = window.fetch.bind(window);
      window.__hang = false;
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        if (window.__hang && url.includes('/api/usage')) return new Promise(() => {});
        return orig(input, init);
      };
    });
  }
  const page = await context.newPage();
  const log = { usage: [], snapshots: 0, other: [], external: [], pageErrors: [], console: [] };
  page.on('pageerror', (e) => log.pageErrors.push(String(e.message).slice(0, 300)));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') log.console.push(m.text().slice(0, 300));
  });
  await context.route('**/*', async (route) => {
    let u;
    try {
      u = new URL(route.request().url());
    } catch {
      return route.abort().catch(() => {});
    }
    try {
      if (u.origin !== ORIGIN) {
        log.external.push(u.host);
        return await route.abort();
      }
      if (u.pathname === '/api/usage') {
        log.usage.push(u.search);
        const r = await usageFn(u, log.usage.length);
        const body = typeof r.raw === 'string' ? r.raw : JSON.stringify(r.body);
        return await route.fulfill({ status: r.status ?? 200, contentType: r.contentType ?? 'application/json', body });
      }
      if (u.pathname === '/api/quests/stream') return await route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
      if (u.pathname === '/api/quests') {
        log.snapshots += 1;
        const s = await snapshotFn(log.snapshots);
        return await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(s) });
      }
      if (u.pathname.startsWith('/api/')) {
        log.other.push(u.pathname);
        return await route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not mocked"}' });
      }
      const file = path.resolve(DIST, `.${decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname)}`);
      if (!file.startsWith(DIST) || !fs.existsSync(file)) return await route.fulfill({ status: 404, body: 'not found' });
      return await route.fulfill({ status: 200, contentType: MIME[path.extname(file)] ?? 'application/octet-stream', body: fs.readFileSync(file) });
    } catch {
      /* page or context already closed */
    }
  });
  if (clock) await page.clock.install({ time: NOW });
  await page.goto(`${ORIGIN}/${hash}`);
  return { context, page, log };
}
export async function closeApp({ context }) {
  await context.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
  await context.close().catch(() => {});
}
export const viewText = (page) => page.locator('.usage-view-container').first().innerText({ timeout: 3000 }).catch(() => '(no usage view)');
export const card = (page, name) => page.locator('article.usage-card').filter({ has: page.locator('h3', { hasText: name }) }).first();
export const cardText = (page, name) => card(page, name).innerText({ timeout: 3000 }).catch(() => '(no card)');
export async function btnState(locator) {
  return locator.evaluate((b) => ({ text: b.textContent, disabled: b.disabled, ariaDisabled: b.getAttribute('aria-disabled') })).catch(() => null);
}
export async function toggleTab(page, times = 1) {
  for (let i = 0; i < times; i += 1) {
    await page.evaluate(() => {
      window.location.hash = '#/';
    });
    await sleep(120);
    await page.evaluate(() => {
      window.location.hash = '#/usage';
    });
    await sleep(120);
  }
}
export const waitCards = (page) => page.waitForSelector('article.usage-card', { timeout: 10000 });
export async function storageDump(page) {
  return page.evaluate(async () => {
    const ls = Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)]));
    const ss = Object.fromEntries(Object.keys(sessionStorage).map((k) => [k, sessionStorage.getItem(k)]));
    const idb = indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : 'n/a';
    return { localStorage: ls, sessionStorage: ss, indexedDB: idb, cookie: document.cookie, caches: typeof caches !== 'undefined' ? await caches.keys() : 'n/a' };
  });
}
