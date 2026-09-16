import { check, deferred, observe, sleep } from './context.mjs';
import { report, rich, snapshot } from './fixtures.mjs';
import { closeApp, openApp, toggleTab, viewText, waitCards } from './page.mjs';

// ---------------------------------------------------------------- H5: unscoped scope hidden until confirmed
export async function h5UnscopedProvenance(browser) {
  let server = 'Server One';
  let gate = null;
  const app = await openApp(browser, {
    clock: true,
    snapshotFn: () => snapshot(null), // no project id ever -- always the "(unscoped)" bucket
    usageFn: async (u) => {
      if (gate) { await gate.p; return report([rich('x', server, 40)]); }
      return report([rich('x', server, 40)]);
    },
  });
  const { page } = app;
  try {
    await waitCards(page);
    await page.clock.runFor(16000);
    check('H5', 'first mount of an unscoped scope shows its own confirmed data once loaded', (await viewText(page)).includes('Server One'));

    server = 'Server Two';
    gate = deferred();
    // remount the view (tab away and back) while a different server's data would be cached under the same
    // unscoped bucket key -- the revalidation for THIS mount is gated open, so it has not confirmed yet
    await page.evaluate(() => { window.location.hash = '#/'; });
    await sleep(150);
    await page.evaluate(() => { window.location.hash = '#/usage'; });
    await sleep(200);
    const whileUnconfirmed = await viewText(page);
    observe('H5', 'remount before this mount´s own revalidation has answered', whileUnconfirmed.replace(/\s+/g, ' ').slice(0, 200));
    check('H5', 'stale cross-server data is hidden (not just captioned) until this mount confirms it', !whileUnconfirmed.includes('Server One') && !whileUnconfirmed.includes('40%'), whileUnconfirmed.replace(/\s+/g, ' ').slice(0, 200));

    gate.resolve();
    gate = null;
    await sleep(500);
    const confirmed = await viewText(page);
    check('H5', 'once confirmed, the new (current-server) data is shown', confirmed.includes('Server Two'), confirmed.replace(/\s+/g, ' ').slice(0, 200));
  } finally {
    await closeApp(app);
  }
}

// ---------------------------------------------------------------- unscoped scope: a skipped revalidation never proves it
//
// h5UnscopedProvenance above only covers the "still in flight, not yet answered" case. The repository
// harness previously stopped there, which is why a remount that skips its own request entirely (cooldown
// still running from a very recent prior mount) was never actually exercised end to end: `ensureUsageLoaded`
// returning `undefined` (nothing new even attempted) was being treated the same as "confirmed" by the view.
export async function h5CooldownSkip(browser) {
  const app = await openApp(browser, { clock: true, snapshotFn: () => snapshot(null), usageFn: () => report([rich('x', 'Server One', 40)]) });
  const { page } = app;
  try {
    await waitCards(page);
    check('H5-skip', 'first mount of an unscoped scope confirms and shows its own data', (await viewText(page)).includes('Server One'));

    // Remount immediately, well inside the 15s revalidation cooldown the first mount's own load already
    // started -- this mount's own request is skipped entirely (see ensureUsageLoaded), so nothing has
    // proven the cached data still belongs here, even though it happens to be the same server's data.
    await page.evaluate(() => { window.location.hash = '#/'; });
    await sleep(100);
    await page.evaluate(() => { window.location.hash = '#/usage'; });
    await sleep(200);
    const afterSkippedRemount = await viewText(page);
    observe('H5-skip', 'remount inside the cooldown window (no new request even attempted)', afterSkippedRemount.replace(/\s+/g, ' ').slice(0, 200));
    check('H5-skip', 'a cooldown-skipped remount shows an actionable cannot-verify state, not the cached data it never re-proved', !afterSkippedRemount.includes('Server One') && /无法核实/.test(afterSkippedRemount));
  } finally {
    await closeApp(app);
  }
}

// ---------------------------------------------------------------- unscoped scope: a failed or hung revalidation never proves it either
//
// Same gap as h5CooldownSkip, for the other three ways a THIS-mount revalidation can fail to prove
// anything: an HTTP error, a malformed body, and a request that never comes back in time. All three must
// land the view on the same actionable "cannot verify" state as a skipped attempt -- never a silent
// fall-through to whatever the shared unscoped bucket happened to be holding.
export async function h5NeverConfirmsOnFailure(browser) {
  const failureBodies = {
    'http-500': () => ({ status: 500, body: { error: '服务暂时不可用' } }),
    'malformed-body': () => ({ status: 200, body: { generatedAt: 'x' } }), // no `providers` array at all
  };
  for (const [label, badResponse] of Object.entries(failureBodies)) {
    let mode = 'good';
    const app = await openApp(browser, {
      clock: true,
      snapshotFn: () => snapshot(null),
      usageFn: () => (mode === 'bad' ? badResponse() : report([rich('x', 'Server One', 40)])),
    });
    const { page } = app;
    try {
      await waitCards(page);
      await page.clock.runFor(16000); // clears the load-on-mount cooldown so the remount's own request actually fires
      mode = 'bad';
      await page.evaluate(() => { window.location.hash = '#/'; });
      await sleep(100);
      await page.evaluate(() => { window.location.hash = '#/usage'; });
      await sleep(500);
      const text = await viewText(page);
      observe('H5-fail', `${label}: unscoped remount whose own revalidation ran and failed`, text.replace(/\s+/g, ' ').slice(0, 200));
      check('H5-fail', `${label}: a failed revalidation never reveals the unproven cached data, and shows an actionable cannot-verify state`, !text.includes('Server One') && /无法核实/.test(text));
    } finally {
      await closeApp(app);
    }
  }

  // A hanging transport (one that does not come back within the request timeout) must also settle this
  // mount's verification one way or the other, not leave the page stuck on "checking" forever. A real
  // fetch() always eventually rejects with AbortError once its own AbortSignal fires (see the note above
  // h3Abandoned for why the deeper ignored-abort/watchdog path is exercised against the cache module
  // directly instead), so this proves the ordinary timeout path is actually wired into this specific gate.
  {
    let hang = false;
    const app = await openApp(browser, {
      clock: true,
      snapshotFn: () => snapshot(null),
      usageFn: async () => {
        if (hang) await new Promise(() => {});
        return report([rich('x', 'Server One', 40)]);
      },
    });
    const { page } = app;
    try {
      await waitCards(page);
      await page.clock.runFor(16000);
      hang = true;
      await page.evaluate(() => { window.location.hash = '#/'; });
      await sleep(100);
      await page.evaluate(() => { window.location.hash = '#/usage'; });
      await sleep(200);
      const stillChecking = await viewText(page);
      check('H5-fail', 'hanging: page stays on the checking state while its own revalidation is still outstanding', /正在核实/.test(stillChecking));
      await page.clock.runFor(30000); // past the 20s abort timeout (and the 5s grace watchdog, if that fires instead)
      const afterHang = await viewText(page);
      observe('H5-fail', 'hanging: unscoped remount after its own revalidation request times out', afterHang.replace(/\s+/g, ' ').slice(0, 200));
      check('H5-fail', 'hanging: a timed-out revalidation settles to an actionable cannot-verify state, not the unproven data, and the wait does not hang forever', !afterHang.includes('Server One') && /无法核实/.test(afterHang));
    } finally {
      await closeApp(app);
    }
  }
}

// ---------------------------------------------------------------- H6: manual retry recovers from cannot-verify
//
// The three ways an unscoped mount can land on 'unverifiable' -- a cooldown-skipped revalidation
// (h5CooldownSkip), a failed one (h5NeverConfirmsOnFailure), and one the watchdog force-released because the
// transport ignored its own AbortSignal (h3Abandoned's note) -- must all be recoverable by clicking the same
// "刷新全部" button the on-screen copy already tells the owner to use. Before the fix, startRefreshAll fired
// the retry but never looked at its result, so a successful one never actually left 'unverifiable' until the
// view was unmounted and remounted -- the button's own promise was silently discarded.
export async function h6RetryAfterCooldownSkip(browser, width) {
  let server = 'Server One';
  const app = await openApp(browser, { viewport: { width, height: 900 }, clock: true, snapshotFn: () => snapshot(null), usageFn: () => report([rich('x', server, 40)]) });
  const { page, log } = app;
  try {
    await waitCards(page);
    await toggleTab(page);
    const skipped = await viewText(page);
    check('H6-skip', `@${width} cooldown-skipped remount lands on cannot-verify`, /无法核实/.test(skipped) && !skipped.includes('Server One'), skipped.replace(/\s+/g, ' ').slice(0, 160));

    server = 'Server Two';
    await page.clock.runFor(16000); // past the manual cooldown so the retry click actually fires a request
    const before = log.usage.length;
    await page.locator('.usage-refresh-all-btn').click({ force: true });
    await sleep(400);
    const after = await viewText(page);
    check(
      'H6-skip',
      `@${width} a successful manual retry after a cooldown-skip shows the new data and leaves cannot-verify`,
      after.includes('Server Two') && !/无法核实/.test(after),
      { requests: log.usage.slice(before), text: after.replace(/\s+/g, ' ').slice(0, 200) },
    );
  } finally {
    await closeApp(app);
  }
}

export async function h6RetryAfterHttp500(browser, width) {
  let mode = 'ok';
  let server = 'Server One';
  const app = await openApp(browser, {
    viewport: { width, height: 900 },
    clock: true,
    snapshotFn: () => snapshot(null),
    usageFn: () => (mode === 'bad' ? { status: 500, body: { error: '服务暂时不可用' } } : report([rich('x', server, 40)])),
  });
  const { page, log } = app;
  try {
    await waitCards(page);
    await page.clock.runFor(16000);
    mode = 'bad';
    server = 'Server Two';
    await toggleTab(page);
    await sleep(300);
    const failed = await viewText(page);
    check('H6-500', `@${width} a failed (HTTP 500) revalidation lands on cannot-verify`, /无法核实/.test(failed) && !failed.includes('Server One'), failed.replace(/\s+/g, ' ').slice(0, 160));

    mode = 'ok';
    await page.clock.runFor(16000);
    const before = log.usage.length;
    await page.locator('.usage-refresh-all-btn').click({ force: true });
    await sleep(400);
    const after = await viewText(page);
    check(
      'H6-500',
      `@${width} a successful manual retry after an HTTP 500 shows the new data and leaves cannot-verify`,
      after.includes('Server Two') && !/无法核实/.test(after),
      { requests: log.usage.slice(before), text: after.replace(/\s+/g, ' ').slice(0, 200) },
    );
  } finally {
    await closeApp(app);
  }
}

export async function h6RetryAfterIgnoredAbort(browser, width) {
  const app = await openApp(browser, {
    viewport: { width, height: 900 },
    clock: true,
    hijack: true,
    snapshotFn: () => snapshot(null),
    usageFn: () => report([rich('x', 'Server One', 40)]),
  });
  const { page, log } = app;
  try {
    await waitCards(page);
    await page.clock.runFor(16000);
    await page.evaluate(() => {
      window.__hang = true;
    });
    await toggleTab(page);
    await page.clock.runFor(30000); // past the 20s abort timeout and the 5s grace watchdog
    await sleep(300);
    const hung = await viewText(page);
    check(
      'H6-hang',
      `@${width} a transport that ignores its own AbortSignal is force-released to cannot-verify`,
      /无法核实/.test(hung) && !hung.includes('Server One'),
      hung.replace(/\s+/g, ' ').slice(0, 160),
    );

    await page.evaluate(() => {
      window.__hang = false;
    });
    const before = log.usage.length;
    await page.locator('.usage-refresh-all-btn').click({ force: true });
    await sleep(400);
    const after = await viewText(page);
    check(
      'H6-hang',
      `@${width} a successful manual retry after the watchdog force-release shows the data and leaves cannot-verify`,
      after.includes('Server One') && !/无法核实/.test(after),
      { requests: log.usage.slice(before), text: after.replace(/\s+/g, ' ').slice(0, 200) },
    );
    check('H6-hang', `@${width} no unhandled page errors from the abandoned attempt's late settlement`, app.log.pageErrors.length === 0, app.log.pageErrors);
  } finally {
    await closeApp(app);
  }
}
