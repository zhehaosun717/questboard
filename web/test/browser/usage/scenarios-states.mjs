import path from 'node:path';
import { check, iso, NOW, observe, OUT, sleep } from './context.mjs';
import { prov, report, rich } from './fixtures.mjs';
import { btnState, card, cardText, closeApp, openApp, waitCards } from './page.mjs';

// ---------------------------------------------------------------- U1/U2/U3 states, trust boundary, layout
export async function s1(browser) {
  const genAt = '2020-01-01T03:04:00Z';
  const providers = [
    prov('pfresh', { name: 'Prov Fresh', state: 'fresh', fresh: true, windows: [{ label: '5h', usedPercent: 0, resetsAt: null }, { label: 'weekly', usedPercent: null, resetsAt: null }], balances: [{ currency: 'CNY', amount: 0 }], asOf: iso(NOW - 60000), lastSuccessAt: iso(NOW - 60000) }),
    prov('pstale', { name: 'Prov Stale', ok: false, state: 'stale', stale: true, error: '缓存已过期，正在后台重新读取', windows: [{ label: '月度', usedPercent: 77, resetsAt: null }], lastSuccessAt: iso(NOW - 3600e3), attemptedAt: iso(NOW - 60e3) }),
    prov('ppend', { name: 'Prov Waiting', ok: false, configured: null, state: 'pending', error: '还没有读过，正在读取' }),
    prov('pnoerr', { name: 'Prov Quiet', ok: false, configured: null, state: 'pending' }),
    prov('punconf', { name: 'Prov Nokey', ok: false, configured: false, state: 'unconfigured', error: '没有找到 key：EXAMPLE_API_KEY' }),
    prov('punavail', { name: 'Prov Manual', ok: false, configured: false, state: 'unavailable', error: '还没有可自动读取的来源，只能手动核对' }),
    prov('pexp', { name: 'Prov Expired', ok: false, configured: true, state: 'expired', error: '请先登录对应的账号' }),
    prov('pfail', { name: 'Prov Broken', ok: false, configured: true, state: 'failed' }),
    prov('pnull', { name: 'Prov Nullcfg', ok: false, configured: null }),
    prov('pcool', { name: 'Prov Cooling', state: 'fresh', cooling: true, windows: [{ label: '5h', usedPercent: 12, resetsAt: null }] }),
    prov('plong', { name: '超长名称服务商 Extremely Long Provider Display Name For Wrapping Checks In Narrow Grids', state: 'fresh', windows: [{ label: 'AVeryLongUnbrokenWindowLabelWithoutAnySpacesThatCouldOverflowTheCard_1234567890', usedPercent: 150, resetsAt: iso(NOW + 86400e3) }], balances: [{ currency: 'USD', amount: 123456789.123 }], note: 'n'.repeat(200) }),
  ];
  const app = await openApp(browser, { clock: true, usageFn: () => report(providers, genAt) });
  const { page, log } = app;
  try {
    await waitCards(page);
    // The initial mount load itself counts as an attempt (U8's own load-on-mount also consumes the shared
    // refresh-all cooldown), so every card shows a genuine client-side "冷却中 Ns" for the first 15s after
    // mount regardless of any server `cooling` field -- advance past that window first so the U9 check
    // below actually isolates the server boolean's effect instead of being confounded by it.
    await page.clock.runFor(16000);
    observe('U1U2', 'usage requests during first load (projectId arrives with snapshot)', log.usage);
    const t = {};
    for (const n of ['Prov Fresh', 'Prov Stale', 'Prov Waiting', 'Prov Quiet', 'Prov Nokey', 'Prov Manual', 'Prov Expired', 'Prov Broken', 'Prov Nullcfg', 'Prov Cooling']) t[n] = await cardText(page, n);
    observe('U1U2', 'card texts', t);
    check('U2', 'pending with server text is not called 未接入', !t['Prov Waiting'].includes('未接入'));
    check('U2', 'pending WITHOUT error text is not called 未接入/未配置 (configured:null)', !t['Prov Quiet'].includes('未接入'), t['Prov Quiet']);
    check('U2', 'failed WITHOUT error text gives no false setup instruction', !t['Prov Broken'].includes('未接入'), t['Prov Broken']);
    check('U2', 'configured:null without state (partial/legacy) is not called 未接入', !t['Prov Nullcfg'].includes('未接入'), t['Prov Nullcfg']);
    check('U1U2', 'fresh shows true 0% and 未知 separately', t['Prov Fresh'].includes('0%') && t['Prov Fresh'].includes('未知'));
    check('U1', 'fresh shows asOf and lastSuccess', t['Prov Fresh'].includes('数据截至') && t['Prov Fresh'].includes('上次成功'));
    // U1 already stopped trusting `provider.error` verbatim (that raw string could carry a sentinel or a
    // stray Referer -- see providerGuidanceText in lib/usage.ts), so a stale card shows this page's own
    // fixed "may be out of date" copy instead of echoing '缓存已过期，正在后台重新读取' from the mock. Checking
    // for the raw string here would be checking for a regression of the fix, not the fix itself.
    check('U1', 'stale ok:false keeps numbers + a fixed (non-echoed) reason + lastSuccess', t['Prov Stale'].includes('77%') && t['Prov Stale'].includes('数据可能已过期') && t['Prov Stale'].includes('上次成功'));
    check('U1', 'unavailable card has no refresh button', (await card(page, 'Prov Manual').locator('.usage-refresh-btn').count()) === 0);
    check('U9', 'server cooling:true boolean does not produce a fake countdown', !/冷却中 \d+s/.test(t['Prov Cooling']), t['Prov Cooling']);
    observe('U9', 'cooling:true card refresh button state', await btnState(card(page, 'Prov Cooling').locator('.usage-refresh-btn')));
    const header = await page.locator('.usage-controls-row').innerText();
    const genLabel = await page.evaluate((g) => {
      const d = new Date(g);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }, genAt);
    observe('U1', 'header text vs report generatedAt clock label', { header, generatedAtLabel: genLabel });
    check('U1', 'header time is not taken from report.generatedAt', !header.includes(genLabel));
    const links = await page.$$eval('.usage-view-container a[href]', (as) => as.map((a) => a.getAttribute('href')));
    observe('U1', 'links / setup destinations in usage view', links);
    observe('U10', 'aria-live regions / aria-busy cards', await page.evaluate(() => ({ live: document.querySelectorAll('.usage-view-container [aria-live]').length, busy: document.querySelectorAll('.usage-card[aria-busy="true"]').length })));
    for (const vp of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
      await page.setViewportSize(vp);
      await sleep(300);
      const ov = await page.evaluate(() => ({
        docOverflow: document.documentElement.scrollWidth - window.innerWidth,
        cardsOverflowing: [...document.querySelectorAll('.usage-card')].filter((c) => c.scrollWidth > c.clientWidth + 1).map((c) => c.querySelector('h3')?.textContent?.slice(0, 20)),
        gridCols: getComputedStyle(document.querySelector('.usage-grid')).gridTemplateColumns.split(' ').length,
        longBar: document.querySelector('.usage-card:last-child .usage-bar-fill')?.style.width,
      }));
      observe('U1', `layout ${vp.width}`, ov);
      check('U1', `no page horizontal overflow at ${vp.width}`, ov.docOverflow <= 0, ov.docOverflow);
      check('U1', `no card content overflow at ${vp.width}`, ov.cardsOverflowing.length === 0, ov.cardsOverflowing);
      await page.screenshot({ path: path.join(OUT, `s1-states-${vp.width}.png`), fullPage: true });
    }
    const cardBg = () => page.evaluate(() => getComputedStyle(document.querySelector('.usage-card')).backgroundImage + '|' + getComputedStyle(document.body).backgroundColor);
    const light = await cardBg();
    await page.emulateMedia({ colorScheme: 'dark' });
    const dark = await cardBg();
    await page.screenshot({ path: path.join(OUT, 's1-states-1024-prefers-dark.png'), fullPage: true });
    observe('U1', 'one palette: light vs prefers-dark computed backgrounds identical', { same: light === dark });
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    const reduced = await page.evaluate(() => getComputedStyle(document.querySelector('.usage-bar-fill')).transitionDuration);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const normal = await page.evaluate(() => getComputedStyle(document.querySelector('.usage-bar-fill')).transitionDuration);
    check('U1', 'reduced motion removes bar transition', reduced === '0s' && normal !== '0s', { reduced, normal });
    observe('U1', 'external hosts aborted (fonts offline)', [...new Set(log.external)]);
    observe('U1', 'fonts actually used for provider name', await page.evaluate(() => getComputedStyle(document.querySelector('.usage-provider-name')).fontFamily));
    check('U1', 'no page errors', log.pageErrors.length === 0, log.pageErrors);
  } finally {
    await closeApp(app);
  }
}

// ---------------------------------------------------------------- layout control: realistic data
export async function s1b(browser) {
  const variants = {
    'realistic (7 short names)': ['codex', 'kimi', 'deepseek', 'openrouter', 'cursor', 'agy', 'volcano'].map((id, i) => rich(id, `Provider ${id}`, i * 15)),
    'long spaced name only': [rich('l1', '超长名称服务商 Extremely Long Provider Display Name For Wrapping Checks In Narrow Grids', 20), rich('l2', 'Short', 5)],
    'long unbroken window label only': [rich('l3', 'Short', 20, { windows: [{ label: 'AVeryLongUnbrokenWindowLabelWithoutAnySpacesThatCouldOverflowTheCard_1234567890', usedPercent: 20, resetsAt: null }] })],
  };
  for (const [label, providers] of Object.entries(variants)) {
    const app = await openApp(browser, { usageFn: () => report(providers) });
    try {
      await waitCards(app.page);
      for (const vp of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
        await app.page.setViewportSize(vp);
        await sleep(300);
        const m = await app.page.evaluate(() => {
          const w = window.innerWidth;
          const wide = [...document.querySelectorAll('body *')]
            .filter((e) => e.getBoundingClientRect().right > w + 1)
            .map((e) => `${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]}`);
          return { docOverflow: document.documentElement.scrollWidth - w, firstOffenders: [...new Set(wide)].slice(0, 6) };
        });
        observe('U1', `layout control ${label} @${vp.width}`, m);
        check('U1', `layout control ${label} @${vp.width}: no page horizontal overflow`, m.docOverflow <= 0, m);
        await app.page.screenshot({ path: path.join(OUT, `s1b-${label.split(' ')[0]}-${label.includes('label') ? 'label' : 'x'}-${vp.width}.png`), fullPage: true });
      }
    } finally {
      await closeApp(app);
    }
  }
}
