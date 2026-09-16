import { check, observe, sleep } from './context.mjs';
import { report, three } from './fixtures.mjs';
import { btnState, closeApp, openApp, viewText, waitCards } from './page.mjs';

// ---------------------------------------------------------------- H1: cooldown rebase on backward clock
export async function h1Cooldown(browser) {
  const app = await openApp(browser, { clock: true, usageFn: () => report(three()) });
  const { page } = app;
  try {
    await waitCards(page);
    await page.clock.runFor(16000);
    await page.locator('.usage-refresh-all-btn').click({ force: true });
    await sleep(300);
    const beforeRollback = await btnState(page.locator('.usage-refresh-all-btn'));
    observe('H1', 'cooldown right after clicking refresh-all', beforeRollback);
    // roll the system clock back by roughly an hour, then advance it 20s past the 15s cooldown window
    await page.clock.setSystemTime(Date.now() - 3_600_000);
    await sleep(50);
    const justAfterRollback = await btnState(page.locator('.usage-refresh-all-btn'));
    observe('H1', 'cooldown immediately after a ~1h backward clock jump', justAfterRollback);
    await page.clock.runFor(20000);
    await sleep(50);
    const after20s = await btnState(page.locator('.usage-refresh-all-btn'));
    check('H1', 'a rollback followed by 20s of further advancement becomes usable again (no permanent freeze)', after20s && after20s.ariaDisabled !== 'true' && !/冷却中/.test(after20s.text), after20s);
  } finally {
    await closeApp(app);
  }
}

// ---------------------------------------------------------------- H2: malformed-to-empty provider payloads
export async function h2Malformed(browser) {
  for (const variant of [
    { id: 'providers-null-entry', body: { generatedAt: 'g2', providers: [null] } },
    { id: 'providers-no-id-entries', body: { generatedAt: 'g2', providers: [{ name: 'x' }, { name: 'y' }] } },
  ]) {
    let bad = false;
    const app = await openApp(browser, { clock: true, usageFn: () => (bad ? { status: 200, body: variant.body } : report(three(42))) });
    try {
      await waitCards(app.page);
      await app.page.clock.runFor(16000);
      bad = true;
      await app.page.locator('.usage-refresh-all-btn').click({ force: true });
      await sleep(600);
      const text = await viewText(app.page);
      const banner = await app.page.locator('.usage-global-error').innerText({ timeout: 500 }).catch(() => null);
      observe('H2', `${variant.id}: page state after a non-empty-but-all-garbage 200 body`, { keptOld42: text.includes('42%'), banner: banner?.slice(0, 120) });
      check('H2', `${variant.id}: good cards are not wiped to "no data" by garbage-but-nonempty providers`, text.includes('42%') && !/暂无服务商用量数据/.test(text), text.replace(/\s+/g, ' ').slice(0, 160));
    } finally {
      await closeApp(app);
    }
  }
  // A genuinely empty snapshot (`providers: []`, not degenerated-from-garbage) is still a legitimate result.
  {
    let empty = false;
    const app = await openApp(browser, { clock: true, usageFn: () => (empty ? { status: 200, body: { generatedAt: 'g2', providers: [] } } : report(three(42))) });
    try {
      await waitCards(app.page);
      await app.page.clock.runFor(16000);
      empty = true;
      await app.page.locator('.usage-refresh-all-btn').click({ force: true });
      await sleep(600);
      const text = await viewText(app.page);
      check('H2', 'a genuine empty providers array is accepted as a real "no providers" snapshot', /暂无服务商用量数据/.test(text), text.replace(/\s+/g, ' ').slice(0, 160));
    } finally {
      await closeApp(app);
    }
  }
}

// ---------------------------------------------------------------- H3: hung request timeout/retry (browser)
//
// NOTE on scope: the deeper "fetcher ignores AbortSignal, forceRelease must invalidate the owner epoch, a
// late-but-confirmed completion must never override a shown failure, auto-retry must stay blocked until a
// manual retry or a confirmed settle" behavior cannot be reproduced
// through a real browser `fetch()`: the Fetch spec guarantees `fetch()` itself rejects with AbortError once
// its AbortSignal fires, regardless of what a Playwright route handler does or does not call `fulfill()`
// with -- a route that just never resolves does not "ignore the abort", the browser's own fetch()
// implementation aborts the underlying request and settles the promise anyway. That contract is only
// exercisable through a custom UsageFetcher that genuinely never settles (the exact shape a misbehaving
// non-fetch transport would have), which is what usageCache.test.ts's "forceRelease / abandoned attempts"
// suite drives directly against the cache module -- see that file for the actual ignored-abort/abandoned/
// bounded-auto-retry proof. What IS genuinely observable here, end to end in a real browser, is the ordinary
// path this app actually ships: a request that hangs server-side times out via the real AbortController,
// settles as a normal failure (not the forceRelease/abandoned path), the button recovers, and auto-refresh
// is free to try again on its own schedule once that normal failure has actually happened -- which is
// correct, not a bug: nothing was left unconfirmed here.
export async function h3Abandoned(browser) {
  let hang = false;
  const app = await openApp(browser, {
    clock: true,
    usageFn: async (u) => {
      if (hang && !u.searchParams.get('provider')) await new Promise(() => {}); // hangs server-side forever
      return report(three(10));
    },
  });
  const { page, log } = app;
  try {
    await waitCards(page);
    await page.clock.runFor(16000);
    hang = true;
    await page.locator('.usage-refresh-all-btn').click({ force: true });
    // production timeout+grace is 25s of (fake) time; the real AbortController fires at 20s and the fetch()
    // promise settles (rejects) right there, well before the 25s watchdog would ever need to force-release
    await page.clock.runFor(30000);
    const released = await btnState(page.locator('.usage-refresh-all-btn'));
    check('H3', 'a server-hung request times out via the real AbortController and recovers to a retryable state', released && released.ariaDisabled !== 'true', released);
    const afterTimeout = await viewText(page);
    check('H3', 'the timeout is shown as a normal failure banner with the old numbers kept', afterTimeout.includes('10%') && afterTimeout.includes('读取用量报告失败'), afterTimeout.replace(/\s+/g, ' ').slice(0, 160));

    hang = false; // the server recovers; a subsequent read (manual or automatic) gets a real answer
    await page.locator('.usage-mode-select select').first().selectOption('interval');
    const before = log.usage.length;
    await page.clock.runFor(120000);
    observe('H3', 'automatic interval ticks after an ordinary (already-settled) timeout', { newRequests: log.usage.length - before });
    check('H3', 'auto-refresh is free to try again once the earlier attempt has genuinely settled (nothing left unconfirmed)', log.usage.length > before, log.usage.length - before);
  } finally {
    await closeApp(app);
  }
}
