import { check, deferred, observe, SENT, sleep, until } from './context.mjs';
import { legacyProviders, prov, report, rich, snapshot, three } from './fixtures.mjs';
import { card, cardText, closeApp, openApp, storageDump, toggleTab, viewText, waitCards } from './page.mjs';

// ---------------------------------------------------------------- U7 load dedupe, missing id, remount
export async function s2(browser) {
  {
    const gate = deferred();
    const app = await openApp(browser, { snapshotFn: async (n) => { if (n === 1) await gate.p; return snapshot('proj-a'); }, usageFn: () => report(three()) });
    try {
      await sleep(1500);
      observe('U7', 'usage requests while snapshot (project id) still pending', { requests: [...app.log.usage], viewShown: await app.page.locator('.usage-view-container').count() });
      gate.resolve();
      await waitCards(app.page);
      await sleep(1500);
      check('U7', 'first load issues one usage request (no unscoped fetch before id is known)', app.log.usage.length === 1, app.log.usage);
    } finally {
      await closeApp(app);
    }
  }
  {
    let server = 'Server One';
    const app = await openApp(browser, { snapshotFn: () => snapshot(null), usageFn: () => report([rich('x', server, 40)]) });
    try {
      await waitCards(app.page);
      const before = app.log.usage.length;
      server = 'Server Two';
      await toggleTab(app.page, 1);
      await sleep(1500);
      observe('U7', 'no project id: same-origin server swapped then tab remount', { shows: (await viewText(app.page)).slice(0, 200), newRequests: app.log.usage.length - before });
    } finally {
      await closeApp(app);
    }
  }
  {
    let gate = null;
    const app = await openApp(browser, { clock: true, usageFn: async () => { if (gate) await gate.p; return report(three()); } });
    try {
      await waitCards(app.page);
      await app.page.clock.runFor(16000);
      gate = deferred();
      const before = app.log.usage.length;
      await app.page.locator('.usage-refresh-all-btn').click({ force: true });
      await sleep(200);
      await toggleTab(app.page, 3);
      gate.resolve();
      gate = null;
      await sleep(800);
      check('StrictMode', 'remounts during pending refresh-all add no duplicate request', app.log.usage.length - before === 1, app.log.usage.slice(before));
      check('StrictMode', 'no page errors', app.log.pageErrors.length === 0, app.log.pageErrors);
    } finally {
      await closeApp(app);
    }
  }
}

// ---------------------------------------------------------------- source identity change + late completion
export async function s3(browser) {
  let project = 'proj-a';
  let gate = null;
  const app = await openApp(browser, {
    clock: true,
    snapshotFn: () => snapshot(project),
    usageFn: async (u) => {
      if (gate && u.searchParams.get('refresh') === '1') { await gate.p; return report([rich('a', 'Old Project Late', 91)]); }
      return report([rich(project === 'proj-a' ? 'a' : 'b', project === 'proj-a' ? 'Old Project' : 'New Project', project === 'proj-a' ? 50 : 60)]);
    },
  });
  const { page, log } = app;
  try {
    await waitCards(page);
    await page.clock.runFor(16000);
    await sleep(300);
    gate = deferred();
    await page.locator('.usage-refresh-all-btn').click({ force: true });
    await sleep(200);
    project = 'proj-b';
    await page.clock.runFor(10500);
    const switched = await until(async () => (await viewText(page)).includes('New Project'));
    check('U6', 'mid-session project id change shows the new project, not the old', switched && !(await viewText(page)).includes('Old Project'), (await viewText(page)).slice(0, 160));
    gate.resolve();
    gate = null;
    await sleep(800);
    const after = await viewText(page);
    check('U6', 'late completion for old scope never appears under new scope', after.includes('New Project') && !after.includes('Old Project Late'), after.slice(0, 160));
    project = 'proj-a';
    await page.clock.runFor(10500);
    await sleep(800);
    observe('U6', 'switch back to proj-a shows its own cached late result', { text: (await viewText(page)).slice(0, 160), requests: log.usage });
    check('U6', 'no page errors', log.pageErrors.length === 0, log.pageErrors);
  } finally {
    await closeApp(app);
  }
}

// ---------------------------------------------------------------- U1/U4 legacy backend (pre-revision route)
export async function s4(browser) {
  let reads = 0;
  const app = await openApp(browser, { clock: true, usageFn: (u) => { if (u.searchParams.get('refresh') === '1') reads += 4; return report(legacyProviders()); } });
  const { page, log } = app;
  try {
    await waitCards(page);
    const text = await viewText(page);
    check('U1', 'legacy raw adapter error text (sentinel/URL userinfo/query) is not displayed verbatim', !text.includes(SENT), (await cardText(page, 'Legacy Openrouter')).slice(0, 200));
    await page.clock.runFor(16000);
    await card(page, 'Legacy Codex').locator('.usage-refresh-btn').click({ force: true });
    await sleep(300);
    observe('U4', 'legacy: card states while a provider= refresh (ignored by legacy) runs', { request: log.usage.at(-1), readsSoFar: reads, busy: await page.$$eval('.usage-card[aria-busy="true"] h3', (h) => h.map((x) => x.textContent)) });
    for (const n of ['Legacy Kimi', 'Legacy Deepseek', 'Legacy Openrouter']) {
      await card(page, n).locator('.usage-refresh-btn').click({ force: true });
      await sleep(250);
    }
    await sleep(500);
    observe('U4', 'legacy: four per-card clicks in ~1s', { requests: log.usage, providerReadsOnLegacyServer: reads });
    check('U4', 'legacy: per-card refresh does not multiply into full re-reads (no storm)', reads <= 4, reads);
    // The honest-fallback hint is a `title` attribute (a hover tooltip on the refresh button), not visible
    // body text -- innerText() never contains it, so it has to be read as an attribute.
    const hintTitle = await card(page, 'Legacy Kimi').locator('.usage-refresh-btn').getAttribute('title');
    check('U4', 'legacy: per-card refresh button honestly hints that it actually refreshes everything', Boolean(hintTitle) && /全部|不支持/.test(hintTitle), hintTitle);
    const store = await storageDump(page);
    observe('U1', 'storage after legacy sentinel load', store);
    check('U1', 'no sentinel / usage numbers persisted in browser storage', !JSON.stringify(store).includes(SENT) && !JSON.stringify(store).includes('42'));
  } finally {
    await closeApp(app);
  }
}

export async function s4m(browser) {
  // `keepsOld42: true` variants are malformed at the body/entry-shape level (whole-body unusable, or every
  // entry unusable) -- the client must keep the previous good report untouched (U3, deepened by H2).
  // `error-object-in-provider-200` is deliberately NOT one of those: it is a *structurally valid* single-
  // provider entry (a real id, a real shape, just an `error` object nobody reads) reporting `ok:false` with
  // no state -- an untargeted merge legitimately replaces the old 'codex' card with this new, valid "failed,
  // no numbers" reading. That is correct replacement, not data loss, so it only needs the sentinel-isolation
  // and no-crash guarantees, not "keeps the old 42%".
  const variants = [
    { id: 'nonarray-200', r: { status: 200, body: { generatedAt: 'x', providers: {} } }, keepsOld42: true },
    { id: 'empty-object-200', r: { status: 200, body: {} }, keepsOld42: true },
    { id: 'null-200', r: { status: 200, raw: 'null' }, keepsOld42: true },
    { id: 'null-entry-200', r: { status: 200, body: { generatedAt: 'x', providers: [null, null] } }, keepsOld42: true },
    // A single new, malformed entry (missing windows/balances/etc.) is NOT a legitimate authoritative
    // "you now have exactly this one provider" full report. It still renders as its own placeholder card
    // (it has a usable id, so it is not dropped outright the way `null` is), which is exactly what let this
    // regress before: an untargeted merge that only checked "did every entry drop to nothing" missed this
    // case and deleted every other already-good card. Must keep all of them, plus show the malformed
    // banner (unlike the other whole-body-unusable variants above, this one previously showed no banner at
    // all — the merge silently "succeeded" with a small-but-wrong result instead of failing loudly).
    { id: 'missing-arrays-200', r: { status: 200, body: { generatedAt: 'x', providers: [{ id: 'x', name: 'Mal X', ok: true, configured: true }] } }, keepsOld42: true, requiresBanner: true },
    { id: 'error-object-in-provider-200', r: { status: 200, body: { providers: [prov('codex', { name: 'Legacy Codex', ok: false, error: { detail: SENT } })] } }, keepsOld42: false },
    { id: 'string-500', r: { status: 500, body: { error: `raw upstream body token=${SENT}` } }, keepsOld42: true },
    { id: 'object-500', r: { status: 500, body: { error: { detail: SENT } } }, keepsOld42: true },
    { id: 'html-502', r: { status: 502, contentType: 'text/html', raw: `<html>${SENT}</html>` }, keepsOld42: true },
    { id: 'referer-403', r: { status: 403, body: { error: `referer http://localhost:5173/#/usage?t=${SENT} refused` } }, keepsOld42: true },
    { id: 'long-500', r: { status: 500, body: { error: 'A'.repeat(5000) } }, keepsOld42: true },
  ];
  for (const v of variants) {
    let bad = false;
    const app = await openApp(browser, { clock: true, usageFn: () => (bad ? v.r : report(legacyProviders())) });
    try {
      await waitCards(app.page);
      await app.page.clock.runFor(16000);
      bad = true;
      await app.page.locator('.usage-refresh-all-btn').click({ force: true, timeout: 3000 }).catch(() => {});
      await sleep(1200);
      const text = await viewText(app.page);
      const alive = (await app.page.locator('.usage-view-container').count()) > 0;
      const banner = await app.page.locator('.usage-global-error').innerText({ timeout: 500 }).catch(() => null);
      observe('U3', `malformed ${v.id}`, { alive, keptOld42: text.includes('42%'), banner: banner && banner.slice(0, 160), bannerLength: banner?.length, pageErrors: app.log.pageErrors.slice(0, 2) });
      const dataOk = v.keepsOld42 ? text.includes('42%') : true;
      check('U3', `${v.id}: page survives, ${v.keepsOld42 ? 'old numbers kept' : 'valid replacement applied'}, no sentinel`, alive && dataOk && !text.includes(SENT) && app.log.pageErrors.length === 0);
      if (v.id === 'missing-arrays-200') {
        // The regression this variant exists to catch: a brand-new malformed entry must not be read as an
        // authoritative "these are now the only providers" replacement -- every other previously-good card
        // (not just the one carrying "42%") must survive, and this must not pass silently without a banner.
        check('U3', `${v.id}: every other previously-good card survives (not deleted by the new malformed one)`, text.includes('Legacy Kimi') && text.includes('Legacy Deepseek') && text.includes('Legacy Openrouter'));
      }
      if (v.requiresBanner) {
        check('U3', `${v.id}: a malformed-but-nonempty response shows the malformed-response banner, not silence`, Boolean(banner), banner);
      }
    } finally {
      await closeApp(app);
    }
  }
}

// ---------------------------------------------------------------- U4/S5: per-card click, honest fallback
//
// USAGE_TARGETED_REFRESH_SUPPORTED stays false in this build (no backend capability signal exists yet -- see
// usageCache.ts), so a per-card click never actually sends `provider=`; it always degrades to a full
// "refresh all". The targeted-merge contract itself (what a *future* supported backend's response would be
// merged like -- arbitrary extra ids, tombstones, out-of-order arrival) is exercised directly against the
// cache module, bypassing the UI flag entirely: see usageCache.test.ts's "applyValidatedReport merge
// ordering / tombstones" suite.
export async function s5(browser) {
  const app = await openApp(browser, { clock: true, usageFn: (u) => report(three(u.searchParams.get('provider') ? -1 : 11)) });
  const { page, log } = app;
  try {
    await waitCards(page);
    await page.clock.runFor(16000);
    await card(page, 'T One').locator('.usage-refresh-btn').click({ force: true });
    await sleep(900);
    const lastRequest = log.usage.at(-1) ?? '';
    check('U4', 'a per-card click never actually sends a provider-scoped request (honest, not just labeled)', !lastRequest.includes('provider='), lastRequest);
    const text = await viewText(page);
    check('U4', 'a per-card click updates every card (it really is a full refresh, all cards agree)', text.includes('11%') && !text.includes('-1%'), text.replace(/\s+/g, ' ').slice(0, 200));
  } finally {
    await closeApp(app);
  }
}
