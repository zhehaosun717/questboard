import { beforeAll, afterAll, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium, resolveChromium } from '../threads/regressionPlaywrightResolver.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '../../..');
const VITE_ENTRY = path.join(WEB_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const ORIGIN = 'http://roster-bulk-regression.test';
let DIST = null;
let browserSetup = { available: false, reason: 'Playwright driver or Chromium is unavailable' };

try {
  const chromium = await resolveChromium();
  if (process.env.PLAYWRIGHT_CHROME && !fs.existsSync(process.env.PLAYWRIGHT_CHROME)) {
    throw new Error(`PLAYWRIGHT_CHROME does not exist: ${process.env.PLAYWRIGHT_CHROME}`);
  }
  const probe = await launchChromium(chromium);
  await probe.close();
  browserSetup = { available: true, chromium };
} catch (error) {
  browserSetup = { available: false, reason: error instanceof Error ? error.message : String(error) };
}

const BROWSER_AVAILABLE = browserSetup.available;
if (!BROWSER_AVAILABLE) console.info(`Skipping roster bulk browser regressions: ${browserSetup.reason}`);

function buildFreshDist() {
  DIST = fs.mkdtempSync(path.join(os.tmpdir(), 'questboard-roster-bulk-dist-'));
  execFileSync(process.execPath, [VITE_ENTRY, 'build', '--configLoader', 'native', '--base', './', '--outDir', DIST], {
    cwd: WEB_ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}
const MIME = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForQueued(queue, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (queue.length) return queue[0];
    await wait(25);
  }
  throw new Error('timed out waiting for an intercepted request');
}

async function waitForRequest(state, pathName, minimum = 1, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (state.requests.filter((request) => request.path === pathName).length >= minimum) return;
    await wait(25);
  }
  throw new Error(`timed out waiting for ${minimum} intercepted ${pathName} requests`);
}

function card(id, provider) {
  return {
    id,
    name: id,
    provider,
    lane: 'test',
    model: `model-${id}`,
    family: 'fixture',
    status: 'available',
    statusSince: null,
    statusReason: '',
    statusSetBy: null,
    maxParallel: 1,
  };
}

const ROSTER = [card('a1', 'alpha'), card('a2', 'alpha'), card('b1', 'beta'), card('b2', 'beta')];

function snapshot(mode) {
  const roster = ROSTER.map((item) => ({ ...item }));
  if (mode === 'postApply') roster[0] = { ...roster[0], status: 'paused', statusReason: 'fixture apply' };
  return {
    generatedAt: `2026-09-16T00:00:0${mode === 'a' ? '0' : '1'}Z`,
    project: { name: mode === 'b' ? 'Project B' : 'Project A', id: mode === 'b' ? 'project-b' : 'project-a', lanes: [] },
    quests: [],
    roster,
    eligibility: {},
    reviewEligibility: {},
    env: { treeLocked: false },
    live: {},
    threads: {},
    reviewPages: [],
    unpostedBriefs: [],
    verification: null,
    laneLimits: {},
    openQuestions: 0,
  };
}

const previewResponse = {
  ok: true,
  applied: false,
  ids: ['a1', 'a2', 'b1', 'b2'],
  action: 'update',
  actor: 'owner',
  revision: '1',
  fingerprint: 'fixture-fingerprint',
  changedFields: ['status'],
  preservedFields: [],
  deniedActiveCards: [],
  statusNote: 'fixture preview',
  results: ROSTER.map((item) => ({ id: item.id, ok: true, ready: true, denied: false, changedFields: ['status'], preservedFields: [] })),
  counts: { requested: 4, ready: 4, changed: 0, unchanged: 0, denied: 0, failed: 0, partial: 0 },
};

const applyResponse = {
  ok: true,
  applied: true,
  ids: ['a1', 'a2', 'b1', 'b2'],
  action: 'update',
  actor: 'owner',
  revision: '2',
  fingerprint: 'fixture-fingerprint',
  changedFields: ['status'],
  preservedFields: [],
  deniedActiveCards: [],
  statusNote: 'fixture applied',
  results: [
    { id: 'a1', ok: true, ready: true, denied: false, changedFields: ['status'], preservedFields: [] },
    { id: 'a2', ok: true, ready: true, denied: false, changedFields: [], preservedFields: ['status'] },
    { id: 'denied-beta', ok: false, ready: false, denied: true, changedFields: [], preservedFields: [], reasons: [{ code: 'holds_slot', message: 'fixture denied' }] },
    { id: 'failed-gamma', ok: false, ready: false, denied: false, changedFields: [], preservedFields: [], error: 'fixture failed' },
    { id: 'partial-ghost', ok: false, ready: true, denied: false, changedFields: [], preservedFields: [], partial: true, appliedFields: ['env'], reasons: [{ code: 'write_failed', message: 'fixture partial' }] },
  ],
  counts: { requested: 5, ready: 5, changed: 1, unchanged: 2, denied: 3, failed: 4, partial: 5 },
};

function makeScenario({ holdPreview = false, holdApply = false, holdStream = false } = {}) {
  const state = {
    mode: 'a',
    holdPreview,
    holdApply,
    holdStream,
    requests: [],
    queues: { preview: [], apply: [], stream: [] },
    pageErrors: [],
    blocked: [],
  };

  async function fulfillJson(route, body, status = 200) {
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  }

  async function routeRequest(route) {
    const request = route.request();
    const url = new URL(request.url());
    state.requests.push({ method: request.method(), path: url.pathname, url: url.href });
    if (url.origin !== ORIGIN) {
      state.blocked.push(url.href);
      return route.abort('blockedbyclient');
    }

    if (url.pathname === '/api/quests') return fulfillJson(route, snapshot(state.mode));
    if (url.pathname === '/api/quests/stream') {
      if (state.holdStream) {
        state.queues.stream.push(route);
        return;
      }
      return route.fulfill({ status: 204, body: '' });
    }
    if (url.pathname === '/api/omo') {
      return fulfillJson(route, { available: false, file: '', agents: [], categories: [] });
    }
    if (url.pathname === '/api/roster/bulk/preview') {
      if (state.holdPreview) {
        state.queues.preview.push(route);
        return;
      }
      return fulfillJson(route, previewResponse);
    }
    if (url.pathname === '/api/roster/bulk/apply') {
      if (state.holdApply) {
        state.queues.apply.push(route);
        return;
      }
      state.mode = 'postApply';
      return fulfillJson(route, applyResponse);
    }
    if (url.pathname.startsWith('/api/')) return fulfillJson(route, { error: 'unexpected fixture API' }, 404);

    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const distRoot = path.resolve(DIST);
    const file = path.resolve(distRoot, relative);
    if (!(file === distRoot || file.startsWith(`${distRoot}${path.sep}`)) || !fs.existsSync(file)) {
      return route.fulfill({ status: 404, body: '' });
    }
    return route.fulfill({ status: 200, contentType: MIME[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
  }

  async function changeSource(page) {
    state.mode = 'b';
    const stream = await waitForQueued(state.queues.stream);
    state.queues.stream.shift();
    await stream.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: hello\ndata: {}\n\n' });
    await page.waitForFunction(() => document.title.startsWith('Project B'), null, { timeout: 5000 });
    await page.waitForFunction(() => document.querySelector('.roster-bulk-count')?.textContent?.includes('0'), null, { timeout: 5000 });
  }

  async function release(key, response) {
    const route = await waitForQueued(state.queues[key]);
    state.queues[key].shift();
    await fulfillJson(route, response);
  }

  return { state, routeRequest, changeSource, release };
}

async function openScenario(browser, scenario) {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => scenario.state.pageErrors.push(String(error)));
  await context.route('**/*', scenario.routeRequest);
  await page.goto(`${ORIGIN}/#/roster`);
  await page.waitForSelector('.roster-view-container', { timeout: 8000 });
  await page.waitForFunction(() => document.querySelectorAll('.roster-bulk-card-check input').length === 4, null, { timeout: 8000 });
  return { context, page };
}

async function assertIntercepted(page, scenario) {
  await wait(100);
  expect(scenario.state.pageErrors).toEqual([]);
  expect(scenario.state.blocked.every((url) => !url.startsWith(ORIGIN))).toBe(true);
  expect(scenario.state.requests.every((request) => request.url.startsWith(ORIGIN) || scenario.state.blocked.includes(request.url))).toBe(true);
  expect(await page.locator('.roster-bulk-card-check input').count()).toBe(4);
}

async function chooseUpdate(page) {
  await page.locator('.roster-bulk-fields select').first().selectOption('paused');
}

const rosterBulkSuite = BROWSER_AVAILABLE ? describe : describe.skip;

rosterBulkSuite('roster bulk Round 5 browser regressions', () => {
  let browser;

  beforeAll(async () => {
    buildFreshDist();
    browser = await launchChromium(browserSetup.chromium);
  }, 60000);

  afterAll(async () => {
    await browser?.close();
    if (DIST) fs.rmSync(DIST, { recursive: true, force: true });
  });

  test('R1: an apply result survives the changed snapshot refresh and keeps partial and denied rows', { skip: !BROWSER_AVAILABLE, timeout: 30000 }, async () => {
    expect(fs.existsSync(path.join(DIST, 'index.html'))).toBe(true);
    const scenario = makeScenario();
    const { context, page } = await openScenario(browser, scenario);
    try {
      await page.locator('.roster-bulk-select-buttons button').nth(1).click();
      await chooseUpdate(page);
      await page.locator('.roster-bulk-buttons button').first().click();
      await page.locator('.roster-bulk-preview').waitFor({ state: 'visible' });
      await page.locator('.roster-bulk-preview button.btn.primary').click();
      await page.waitForFunction(() => document.querySelector('#bulkResultTitle') !== null, null, { timeout: 5000 });
      await waitForRequest(scenario.state, '/api/quests', 2);
      await wait(600);
      const result = page.locator('#bulkResultTitle');
      expect(await result.isVisible()).toBe(true);
      const dialogText = await page.locator('[aria-labelledby="bulkResultTitle"]').textContent();
      expect(dialogText).toContain('partial-ghost');
      expect(dialogText).toContain('denied-beta');
      expect(dialogText).toContain('failed-gamma');
      expect(dialogText).toMatch(/1[\s\S]*2[\s\S]*3[\s\S]*4[\s\S]*5/);
      expect(scenario.state.requests.filter((request) => request.path === '/api/quests').length).toBeGreaterThanOrEqual(2);
      await assertIntercepted(page, scenario);
    } finally {
      await context.close();
    }
  });

  test('source race: a held apply reports every server count after the source changes and shows no old dialog', { skip: !BROWSER_AVAILABLE, timeout: 30000 }, async () => {
    const scenario = makeScenario({ holdApply: true, holdStream: true });
    const { context, page } = await openScenario(browser, scenario);
    try {
      await page.locator('.roster-bulk-select-buttons button').nth(1).click();
      await chooseUpdate(page);
      await page.locator('.roster-bulk-buttons button').first().click();
      await page.locator('.roster-bulk-preview').waitFor({ state: 'visible' });
      await page.locator('.roster-bulk-preview button.btn.primary').click();
      await waitForQueued(scenario.state.queues.apply);
      await scenario.changeSource(page);
      await scenario.release('apply', applyResponse);
      await page.waitForSelector('.toast', { timeout: 5000 });
      const toast = await page.locator('.toast').last().textContent();
      expect(toast).toMatch(/1[\s\S]*2[\s\S]*3[\s\S]*4[\s\S]*5/);
      expect(await page.locator('[aria-labelledby="bulkResultTitle"]').count()).toBe(0);
      expect(await page.locator('.roster-bulk-preview').count()).toBe(0);
      await assertIntercepted(page, scenario);
    } finally {
      await context.close();
    }
  });

  test('source race: a held preview is discarded after the source changes and cannot open a dialog', { skip: !BROWSER_AVAILABLE, timeout: 30000 }, async () => {
    const scenario = makeScenario({ holdPreview: true, holdStream: true });
    const { context, page } = await openScenario(browser, scenario);
    try {
      await page.locator('.roster-bulk-select-buttons button').nth(1).click();
      await chooseUpdate(page);
      await page.locator('.roster-bulk-buttons button').first().click();
      await waitForQueued(scenario.state.queues.preview);
      await scenario.changeSource(page);
      await scenario.release('preview', previewResponse);
      await wait(300);
      expect(await page.locator('.roster-bulk-preview').count()).toBe(0);
      expect(await page.locator('[aria-labelledby="bulkResultTitle"]').count()).toBe(0);
      expect(await page.locator('.roster-bulk-count').textContent()).toContain('0');
      await assertIntercepted(page, scenario);
    } finally {
      await context.close();
    }
  });

  test('R2: mouse and keyboard folds update the visible count, fold note and folded-selection warning', { skip: !BROWSER_AVAILABLE, timeout: 30000 }, async () => {
    const scenario = makeScenario();
    const { context, page } = await openScenario(browser, scenario);
    try {
      const beta = page.locator('.provider-toggle').filter({ hasText: 'beta' });
      await beta.click();
      await page.waitForFunction(() => document.querySelector('.roster-bulk-fold-note')?.textContent?.includes('2'), null, { timeout: 3000 });
      let state = await page.evaluate(() => ({
        rows: document.querySelectorAll('tbody.provider-group tr:not(.provider-row)').length,
        note: document.querySelector('.roster-bulk-fold-note')?.textContent || '',
        label: document.querySelector('.roster-bulk-select-buttons button')?.textContent || '',
      }));
      expect(state.rows).toBe(2);
      expect(state.note).toContain('2');
      expect(state.label).toContain('2');

      await page.locator('.roster-bulk-select-buttons button').nth(1).click();
      await page.waitForFunction(() => document.querySelectorAll('.roster-bulk-warning').length > 0, null, { timeout: 3000 });
      expect((await page.locator('.roster-bulk-warning').allTextContents()).join(' ')).toContain('2');

      const alpha = page.locator('.provider-toggle').filter({ hasText: 'alpha' });
      await alpha.focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.roster-bulk-fold-note')?.textContent?.includes('4'), null, { timeout: 3000 });
      state = await page.evaluate(() => ({
        rows: document.querySelectorAll('tbody.provider-group tr:not(.provider-row)').length,
        note: document.querySelector('.roster-bulk-fold-note')?.textContent || '',
        label: document.querySelector('.roster-bulk-select-buttons button')?.textContent || '',
        warning: [...document.querySelectorAll('.roster-bulk-warning')].map((item) => item.textContent).join(' '),
      }));
      expect(state.rows).toBe(0);
      expect(state.note).toContain('4');
      expect(state.label).toContain('0');
      expect(state.warning).toContain('4');
      await assertIntercepted(page, scenario);
    } finally {
      await context.close();
    }
  });
});
