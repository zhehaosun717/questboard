// Resolves and launches a Playwright `chromium` for threadsAsyncRegression.browser.mjs without ever
// guessing a machine-specific path: PLAYWRIGHT_DRIVER points straight at an install's driver entry point,
// or Node's own module resolution finds an installed `playwright`/`playwright-core` package instead.
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

function chromiumFrom(mod) {
  return mod.chromium ?? mod.default?.chromium ?? null;
}

export async function resolveChromium() {
  const driver = process.env.PLAYWRIGHT_DRIVER;
  if (driver) {
    if (!fs.existsSync(driver)) {
      throw new Error(`PLAYWRIGHT_DRIVER is set to ${driver}, but nothing exists there.`);
    }
    const chromium = chromiumFrom(await import(pathToFileURL(driver).href));
    if (!chromium) throw new Error(`${driver} does not export a \`chromium\` launcher.`);
    return chromium;
  }
  for (const name of ['playwright', 'playwright-core']) {
    let entry;
    try {
      entry = require.resolve(name);
    } catch {
      continue;
    }
    const chromium = chromiumFrom(await import(pathToFileURL(entry).href));
    if (chromium) return chromium;
  }
  throw new Error(
    "No Playwright driver found. Set PLAYWRIGHT_DRIVER to an existing install's driver entry point " +
      "(e.g. `.../playwright/driver/package/index.mjs`), or make `playwright`/`playwright-core` " +
      'resolvable from here (installed globally, or as a project dependency) — this script never ' +
      'installs anything itself.',
  );
}

export async function launchChromium(chromium) {
  const executablePath = process.env.PLAYWRIGHT_CHROME;
  if (executablePath && !fs.existsSync(executablePath)) {
    throw new Error(`PLAYWRIGHT_CHROME is set to ${executablePath}, but nothing exists there.`);
  }
  try {
    return await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  } catch (err) {
    throw new Error(
      `Failed to launch Chromium (${err.message}). Set PLAYWRIGHT_CHROME to an existing Chromium ` +
        'executable, or install one where the resolved Playwright driver can find it ' +
        '(e.g. `npx playwright install chromium`).',
    );
  }
}
