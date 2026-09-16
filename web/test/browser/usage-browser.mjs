// Checked-in browser harness for the usage page (web/src/components/UsageView.tsx and friends). Runs against
// the built `web/dist` on a synthetic origin: every request is intercepted, `/api/*` answered with scripted
// JSON, every other host aborted (fonts included -- the offline fallback is a check, not a workaround). No
// Vite dev server or preview process is ever started; this only reads static files off disk. Adapted from an
// earlier one-off acceptance probe; the U1..U10 scenario numbering below matches that review's findings so
// this harness keeps covering them as a regression suite, plus new scenarios for later fixes layered on top.
// Split across web/test/browser/usage/ (context, fixtures, page helpers, and one module per scenario group)
// to stay under the repo's line-count ceiling -- this file just wires the runner up.
//
// Runtime paths are never hardcoded -- both come from environment variables the caller must set:
//   QB_PW_DRIVER    path to the Playwright driver package's index.mjs
//   QB_PW_CHROMIUM  path to a Chromium executable compatible with that driver
//   QB_DIST         path to a built `web/dist` (or equivalent) directory to serve
//   QB_OUT          directory to write results.json and screenshots into
//
// Example (adjust paths to wherever Playwright is actually installed on the machine running this):
//   QB_PW_DRIVER=/path/to/playwright/driver/package/index.mjs \
//   QB_PW_CHROMIUM=/path/to/chromium/chrome \
//   QB_DIST=./web/dist QB_OUT=./out \
//   node web/test/browser/usage-browser.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, DIST, DRIVER, CHROME, OUT, results } from './usage/context.mjs';
import { s1, s1b } from './usage/scenarios-states.mjs';
import { s2, s3, s4, s4m, s5 } from './usage/scenarios-lifecycle.mjs';
import { s6, s7, s8, s9, s10 } from './usage/scenarios-resilience.mjs';
import { h1Cooldown, h2Malformed, h3Abandoned } from './usage/scenarios-hardening.mjs';
import {
  h5CooldownSkip,
  h5NeverConfirmsOnFailure,
  h5UnscopedProvenance,
  h6RetryAfterCooldownSkip,
  h6RetryAfterHttp500,
  h6RetryAfterIgnoredAbort,
} from './usage/scenarios-unscoped.mjs';

async function main() {
  const { chromium } = await import(pathToFileURL(DRIVER).href);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const scenarios = {
    s1, s1b, s2, s3, s4, s4m, s5, s6, s7, s8, s9, s10,
    h1Cooldown, h2Malformed, h3Abandoned, h5UnscopedProvenance, h5CooldownSkip, h5NeverConfirmsOnFailure,
    h6RetrySkip1024: (b) => h6RetryAfterCooldownSkip(b, 1024),
    h6RetrySkip1440: (b) => h6RetryAfterCooldownSkip(b, 1440),
    h6Retry500_1024: (b) => h6RetryAfterHttp500(b, 1024),
    h6Retry500_1440: (b) => h6RetryAfterHttp500(b, 1440),
    h6RetryHang1024: (b) => h6RetryAfterIgnoredAbort(b, 1024),
    h6RetryHang1440: (b) => h6RetryAfterIgnoredAbort(b, 1440),
  };
  const only = (process.env.QB_ONLY || '').split(',').filter(Boolean);
  try {
    for (const [name, fn] of Object.entries(scenarios).filter(([n]) => only.length === 0 || only.includes(n))) {
      try {
        await fn(browser);
      } catch (err) {
        check(name.toUpperCase(), 'scenario ran to completion', false, String(err?.stack || err).slice(0, 400));
      }
    }
  } finally {
    await browser.close();
  }
  const checks = results.filter((r) => r.kind === 'check');
  const passed = checks.filter((r) => r.ok).length;
  fs.writeFileSync(
    path.join(OUT, only.length ? `results-${only.join('-')}.json` : 'results.json'),
    JSON.stringify({ dist: DIST, at: new Date().toISOString(), passed, total: checks.length, results }, null, 2),
  );
  console.log(`\n${passed}/${checks.length} checks passed; ${results.length - checks.length} observations.`);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
