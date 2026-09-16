// Shared harness context for the usage-page browser suite (split out of the single-file harness so each
// scenario module stays under the repo's line-count ceiling). A plain ES module singleton: every file that
// imports from here sees the same DRIVER/CHROME/DIST/OUT/results/NOW, exactly as the original single file's
// top-level module state did.
//
// Runtime paths are never hardcoded -- both come from environment variables the caller must set:
//   QB_PW_DRIVER    path to the Playwright driver package's index.mjs
//   QB_PW_CHROMIUM  path to a Chromium executable compatible with that driver
//   QB_DIST         path to a built `web/dist` (or equivalent) directory to serve
//   QB_OUT          directory to write results.json and screenshots into
import fs from 'node:fs';
import path from 'node:path';

export const DRIVER = process.env.QB_PW_DRIVER;
export const CHROME = process.env.QB_PW_CHROMIUM;
export const DIST = path.resolve(process.env.QB_DIST || '');
export const OUT = path.resolve(process.env.QB_OUT || '');
if (!DRIVER || !CHROME || !process.env.QB_DIST || !process.env.QB_OUT) {
  throw new Error('QB_PW_DRIVER, QB_PW_CHROMIUM, QB_DIST, QB_OUT are all required');
}
fs.mkdirSync(OUT, { recursive: true });

export const ORIGIN = 'http://questboard.test';
export const SENT = 'QBSENTINEL0123456789abcdefSYNTH';
export const results = [];
export function check(id, name, ok, detail) {
  results.push({ id, name, kind: 'check', ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`);
}
export function observe(id, name, detail) {
  results.push({ id, name, kind: 'observe', ok: null, detail });
  console.log(`OBS  ${id} ${name} :: ${JSON.stringify(detail)}`);
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function deferred() {
  let resolve;
  const p = new Promise((r) => {
    resolve = r;
  });
  return { p, resolve };
}
export async function until(fn, ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      if (await fn()) return true;
    } catch {
      /* retry */
    }
    await sleep(50);
  }
  return false;
}
export const MIME = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};
export const iso = (ms) => new Date(ms).toISOString();
export const NOW = Date.now();
