import path from 'node:path';
import { check, deferred, observe, OUT, sleep } from './context.mjs';
import { report, three } from './fixtures.mjs';
import { btnState, card, cardText, closeApp, openApp, storageDump, toggleTab, viewText, waitCards } from './page.mjs';

// ---------------------------------------------------------------- U5 hung reads, failures, retry
export async function s6(browser) {
  {
    let hang = false;
    const app = await openApp(browser, {
      clock: true,
      usageFn: async (u) => {
        if (hang && !u.searchParams.get('provider')) await new Promise(() => {});
        return report(three(u.searchParams.get('provider') ? 44 : 10));
      },
    });
    const { page, log } = app;
    try {
      await waitCards(page);
      await page.clock.runFor(16000);
      hang = true;
      await page.locator('.usage-refresh-all-btn').click({ force: true });
      await page.clock.runFor(120000);
      const stuck = await btnState(page.locator('.usage-refresh-all-btn'));
      observe('U5', 'refresh-all after 120s with a hung request', stuck);
      check('U5', 'hung whole-report read times out or can be manually retried', stuck && stuck.ariaDisabled !== 'true', stuck);
      await toggleTab(page, 1);
      observe('U5', 'after tab remount', await btnState(page.locator('.usage-refresh-all-btn')));
      await page.locator('.usage-mode-select select').first().selectOption('interval');
      const before = log.usage.length;
      await page.clock.runFor(180000);
      observe('H3', 'interval ticks while whole read hung (blocked until a manual retry or a confirmed late settle)', { newRequests: log.usage.length - before });
      await card(page, 'T Two').locator('.usage-refresh-btn').click({ force: true });
      await sleep(800);
      observe('U5', 'per-provider refresh during hung refresh-all', { text: (await cardText(page, 'T One')).slice(0, 40), last: log.usage.at(-1) });
    } finally {
      await closeApp(app);
    }
  }
  {
    let hang = false;
    const app = await openApp(browser, { clock: true, usageFn: async () => { if (hang) await new Promise(() => {}); return report(three()); } });
    const { page, log } = app;
    try {
      await waitCards(page);
      await page.clock.runFor(16000);
      hang = true;
      const btn = card(page, 'T One').locator('.usage-refresh-btn');
      await btn.click({ force: true });
      await sleep(300);
      const during = await btnState(btn);
      await page.clock.runFor(16000);
      const later = await btnState(btn);
      const before = log.usage.length;
      await btn.click({ force: true });
      await sleep(300);
      observe('U5', 'per-provider hung read: button while pending, after cooldown, click count', { during, later, newRequests: log.usage.length - before, ariaBusy: await card(page, 'T One').getAttribute('aria-busy') });
      check('U5', 'a still-pending per-provider read is shown as reading (not an enabled no-op button)', later && (later.ariaDisabled === 'true' || /读取/.test(later.text)), later);
    } finally {
      await closeApp(app);
    }
  }
  {
    let mode = 'good';
    const app = await openApp(browser, { clock: true, usageFn: () => (mode === 'fail' ? { status: 500, body: { error: '服务暂时不可用' } } : report(three(mode === 'good' ? 10 : 55))) });
    const { page } = app;
    try {
      await waitCards(page);
      await page.clock.runFor(16000);
      mode = 'fail';
      await page.locator('.usage-refresh-all-btn').click({ force: true });
      await sleep(600);
      const afterFail = await viewText(page);
      check('U5', 'failed refresh keeps old numbers with a banner', afterFail.includes('10%') && afterFail.includes('读取用量报告失败'));
      observe('U5', 'refresh-all right after failure', await btnState(page.locator('.usage-refresh-all-btn')));
      await page.clock.runFor(16000);
      mode = 'recovered';
      await page.locator('.usage-refresh-all-btn').click({ force: true });
      await sleep(600);
      const rec = await viewText(page);
      check('U5', 'manual retry after cooldown recovers and clears the banner', rec.includes('55%') && !rec.includes('读取用量报告失败'));
    } finally {
      await closeApp(app);
    }
  }
  {
    const app = await openApp(browser, { usageFn: () => ({ status: 500, body: { error: '服务暂时不可用' } }) });
    try {
      await app.page.waitForSelector('.usage-global-error', { timeout: 10000 });
      const before = app.log.usage.length;
      await toggleTab(app.page, 5);
      await sleep(800);
      observe('U8', 'never-succeeded scope: 5 tab remounts', { newRequests: app.log.usage.length - before });
      check('U8', 'remounting after failure is bounded (no request per tab visit)', app.log.usage.length - before <= 1, app.log.usage.length - before);
    } finally {
      await closeApp(app);
    }
  }
}

// ---------------------------------------------------------------- U6: concurrent-click dedup (browser-reachable)
//
// The original "an older whole-read started before a faster per-provider one must not overwrite it on
// arrival" race needs a real targeted request to exist concurrently with a refresh-all -- unreachable here
// for the same reason as s5 (USAGE_TARGETED_REFRESH_SUPPORTED is false, so a per-card click never actually
// sends a provider-scoped request; see usageCache.test.ts's cache-level merge-ordering suite for that
// contract instead). What real users CAN do, and what stays reachable end to end here, is rapid-click the
// same refresh-all button -- the dedup (single inflight attempt per key) must hold under that, and the
// project-scope version of "an older/slower response must never land under a newer identity" is exercised
// for real in s3 above (switching project mid-refresh).
export async function s7(browser) {
  const app = await openApp(browser, { clock: true, usageFn: () => report(three(20)) });
  const { page, log } = app;
  try {
    await waitCards(page);
    await page.clock.runFor(16000);
    const before = log.usage.length;
    const btn = page.locator('.usage-refresh-all-btn');
    await Promise.all([btn.click({ force: true }), btn.click({ force: true }), btn.click({ force: true })]);
    await sleep(600);
    check('U6', 'rapid repeated clicks on refresh-all dedupe into a single in-flight attempt', log.usage.length - before === 1, log.usage.length - before);
    const text = await viewText(page);
    check('U6', 'the single attempt still resolves and updates the cards normally', text.includes('20%'), text.replace(/\s+/g, ' ').slice(0, 160));
  } finally {
    await closeApp(app);
  }
}

// ---------------------------------------------------------------- interval, visibility, unmount, rollback, storage
export async function s8(browser) {
  const app = await openApp(browser, { clock: true, usageFn: () => report(three()) });
  const { page, log } = app;
  const count = () => log.usage.length;
  try {
    await waitCards(page);
    await page.clock.runFor(16000);
    await page.locator('.usage-mode-select select').first().selectOption('interval');
    await page.locator('.usage-mode-select select').nth(1).selectOption('30000');
    let c0 = count();
    await page.clock.runFor(300000);
    await sleep(500);
    observe('U8', 'interval 30s over 5 min', { requests: count() - c0, queries: [...new Set(log.usage.slice(c0))] });
    check('U8', 'interval 30s fires ~10 times in 5 min (bounded)', count() - c0 >= 9 && count() - c0 <= 11, count() - c0);
    await page.clock.runFor(1000);
    observe('U8', 'refresh-all button right after an automatic tick', await btnState(page.locator('.usage-refresh-all-btn')));
    await page.locator('.usage-mode-select select').nth(1).selectOption('300000');
    c0 = count();
    await page.clock.runFor(300000);
    await sleep(500);
    check('U8', 'changing interval to 5 min clears the 30s timer', count() - c0 >= 1 && count() - c0 <= 2, count() - c0);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    c0 = count();
    await page.clock.runFor(600000);
    await sleep(500);
    check('U8', 'hidden page makes no automatic requests over 10 min', count() === c0, count() - c0);
    observe('U8', 'status line while hidden', await page.locator('.usage-status-line').innerText());
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.evaluate(() => {
      window.location.hash = '#/';
    });
    await sleep(200);
    c0 = count();
    await page.clock.runFor(600000);
    await sleep(500);
    check('U8', 'unmounted usage view leaves no interval running', count() === c0, count() - c0);
    await page.evaluate(() => {
      window.location.hash = '#/usage';
    });
    await waitCards(page);
    observe('U8', 'mode survives remount', await page.locator('.usage-mode-select select').first().inputValue());
    await page.locator('.usage-mode-select select').first().selectOption('manual');
    await page.clock.runFor(16000);
    await page.locator('.usage-refresh-all-btn').click({ force: true });
    await sleep(300);
    await page.clock.setSystemTime(Date.now() + 16000 - 3600e3);
    await page.clock.runFor(2000);
    const rolled = await btnState(page.locator('.usage-refresh-all-btn'));
    check('U9', 'clock rollback does not freeze the cooldown for ~1h', rolled && !/冷却中 \d{3,}s/.test(rolled.text), rolled);
    const store = await storageDump(page);
    observe('U8', 'browser storage after interval use', store);
    const usageKeys = Object.keys(store.localStorage).filter((k) => /usage/i.test(k));
    check('U8', 'only the non-secret refresh preference is persisted for usage', usageKeys.length === 1 && /^\{"mode":"(manual|interval)","intervalMs":\d+\}$/.test(store.localStorage[usageKeys[0]]), usageKeys.map((k) => [k, store.localStorage[k]]));
  } finally {
    await closeApp(app);
  }
}

// ---------------------------------------------------------------- U10 keyboard, focus
export async function s9(browser) {
  const app = await openApp(browser, { clock: true, viewport: { width: 1024, height: 768 }, usageFn: () => report(three()) });
  const { page } = app;
  try {
    await waitCards(page);
    await page.clock.runFor(16000);
    await page.locator('.usage-view-container h2').click();
    const seq = [];
    for (let i = 0; i < 40; i += 1) {
      await page.keyboard.press('Tab');
      const d = await page.evaluate(() => {
        const a = document.activeElement;
        if (!a || !a.closest('.usage-view-container')) return null;
        return `${a.tagName.toLowerCase()}.${a.className}${a.getAttribute('aria-label') ? `[${a.getAttribute('aria-label')}]` : ''}`;
      });
      if (d) seq.push(d);
      if (seq.length >= 7) break;
    }
    observe('U10', 'tab order inside usage view', seq);
    check('U10', 'mode select, refresh-all and per-card refresh are keyboard reachable', seq.some((s) => s.startsWith('select')) && seq.some((s) => s.includes('usage-refresh-all-btn')) && seq.some((s) => s.includes('usage-refresh-btn')));
    const btn = card(page, 'T Two').locator('.usage-refresh-btn');
    await btn.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    const ring = await page.evaluate(() => {
      const s = getComputedStyle(document.activeElement);
      return { el: document.activeElement.className, outline: `${s.outlineStyle} ${s.outlineWidth}`, boxShadow: s.boxShadow, focusVisible: document.activeElement.matches(':focus-visible') };
    });
    observe('U10', 'focus indicator on per-card refresh', ring);
    await page.screenshot({ path: path.join(OUT, 's9-focus-1024.png') });
    await page.keyboard.press('Enter');
    await sleep(400);
    const after = await page.evaluate(() => ({ active: document.activeElement?.tagName + '.' + document.activeElement?.className, text: document.activeElement?.textContent }));
    observe('U10', 'focus after Enter on per-card refresh (button becomes disabled)', after);
    check('U10', 'keyboard focus is not dropped to <body> after activating refresh', !after.active.startsWith('BODY'), after);
  } finally {
    await closeApp(app);
  }
}

// ---------------------------------------------------------------- unmount late completion
export async function s10(browser) {
  let gate = null;
  const app = await openApp(browser, { clock: true, usageFn: async () => { if (gate) { await gate.p; return report(three(66)); } return report(three()); } });
  const { page, log } = app;
  try {
    await waitCards(page);
    await page.clock.runFor(16000);
    gate = deferred();
    await page.locator('.usage-refresh-all-btn').click({ force: true });
    await sleep(200);
    await page.evaluate(() => {
      window.location.hash = '#/';
    });
    await sleep(300);
    gate.resolve();
    gate = null;
    await sleep(600);
    const before = log.usage.length;
    await page.evaluate(() => {
      window.location.hash = '#/usage';
    });
    await waitCards(page);
    await sleep(500);
    check('U6', 'completion after unmount is kept and shown on return without refetch', (await cardText(page, 'T One')).includes('66%') && log.usage.length === before);
    check('U6', 'no page errors or React warnings', log.pageErrors.length === 0 && !log.console.some((c) => /unmounted|act\(|Warning/.test(c)), { pageErrors: log.pageErrors, console: log.console.slice(0, 3) });
  } finally {
    await closeApp(app);
  }
}
