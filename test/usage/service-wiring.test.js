import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createUsageService, ALIBABA_PLAN_TEXT } from '../../src/usage/service.js';
import { resolveConfig } from '../../src/core/config.js';
import { claudeSubscription } from '../../src/usage/providers.js';
import { getClaudeSnapshotPath, readClaudeSnapshot } from '../../src/usage/claudeStatusline.js';
import { tmpDir } from '../helpers.js';

function provider(id, result, extra = {}) {
  return {
    id,
    name: id,
    source: 'official-api',
    async fetch() {
      return result;
    },
    ...extra,
  };
}

function reportFor(providers) {
  return createUsageService({ providers, env: {}, homedir: tmpDir('qb-usage-wiring-') }).report();
}

function writeClaudeSnapshot(homedir, snapshot) {
  const filePath = getClaudeSnapshotPath({ homedir, env: {} });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(snapshot));
}

describe('usage service wiring', () => {
  it('keeps reset window metadata and provider result metadata at separate boundaries', async () => {
    const report = await reportFor([provider('resettable', {
      windows: [{ label: 'quota', usedPercent: 84, resetsAt: '2026-09-15T00:00:00Z', state: 'reset', resetDerived: true, extra: 'drop' }],
      balances: [],
      plan: '',
      note: 'snapshot',
      asOf: '2026-09-16T00:00:00Z',
      state: 'ok',
      asOfDerived: true,
    })]);
    const [entry] = report.providers;
    assert.deepEqual(entry.windows, [{
      label: 'quota',
      usedPercent: null,
      resetsAt: '2026-09-15T00:00:00Z',
      state: 'reset',
      resetDerived: true,
    }]);
    assert.equal(entry.providerState, 'ok');
    assert.equal(entry.asOfDerived, true);
    assert.equal(entry.state, 'fresh');
  });

  it('does not present manual-only or not-subscribed results as successful readings', async () => {
    const report = await reportFor([
      provider('manual-card', {
        windows: [{ label: 'must-hide', usedPercent: 10, resetsAt: null }],
        balances: [],
        plan: '',
        note: '请到控制台查看',
        state: 'manual_only',
        manual_only: true,
        asOf: null,
      }, { manual_only: true }),
      provider('unsubscribed', {
        windows: [],
        balances: [],
        plan: '未订阅',
        note: '当前账号未订阅',
        state: 'not_subscribed',
        asOf: null,
      }),
    ]);
    const manual = report.providers[0];
    assert.equal(manual.providerState, 'manual_only');
    assert.equal(manual.ok, false);
    assert.equal(manual.state, 'unconfigured', 'a manual card has no automatic reading to call fresh');
    assert.equal(manual.fresh, false);
    assert.deepEqual(manual.windows, []);
    assert.equal(manual.note, '请到控制台查看');
    assert.equal(manual.error, '请到控制台查看');

    const unsubscribed = report.providers[1];
    assert.equal(unsubscribed.providerState, 'not_subscribed');
    assert.equal(unsubscribed.ok, false);
    assert.equal(unsubscribed.error, '当前账号未订阅');
  });

  it('uses the injected service clock when one Claude snapshot is fresh versus stale', async () => {
    const capturedAt = '2026-09-16T12:00:00.000Z';
    const capturedMs = Date.parse(capturedAt);
    const homedir = tmpDir('qb-usage-claude-clock-');
    writeClaudeSnapshot(homedir, {
      schema: 1,
      capturedAt,
      rate_limits: {
        five_hour: { used_percentage: 42, resets_at: 2100000000 },
      },
    });

    const freshNow = capturedMs + 60 * 60 * 1000;
    const staleNow = capturedMs + 25 * 60 * 60 * 1000;
    const readerFresh = readClaudeSnapshot({ homedir, env: {}, now: freshNow });
    const readerStale = readClaudeSnapshot({ homedir, env: {}, now: staleNow });
    const realDateNow = Date.now;
    Date.now = () => { throw new Error('real clock must not be consulted'); };
    try {
      const freshService = createUsageService({ providers: [claudeSubscription], env: {}, homedir, now: () => freshNow });
      const [fresh] = (await freshService.report()).providers;
      assert.equal(readerFresh.stale, undefined);
      assert.equal(fresh.ok, true);
      assert.equal(fresh.state, 'fresh');
      assert.equal(fresh.fresh, true);
      assert.equal(fresh.stale, false);
      assert.equal(fresh.asOf, capturedAt);
      assert.deepEqual(fresh.windows, readerFresh.windows);
      assert.equal(fresh.error, undefined);

      const staleService = createUsageService({ providers: [claudeSubscription], env: {}, homedir, now: () => staleNow });
      const [stale] = (await staleService.report()).providers;
      assert.equal(readerStale.stale, true);
      assert.equal(stale.ok, false);
      assert.equal(stale.state, 'stale');
      assert.equal(stale.fresh, false);
      assert.equal(stale.stale, true);
      assert.equal(stale.asOf, capturedAt);
      assert.deepEqual(stale.windows, readerStale.windows, 'last known Claude numbers stay visible');
      assert.equal(stale.note, readerStale.note);
      assert.equal(stale.error, readerStale.note);
    } finally {
      Date.now = realDateNow;
    }
  });

  it('does not present an unknown provider state with no numbers as a fresh reading', async () => {
    const report = await reportFor([
      provider('volcano-unknown', { windows: [], balances: [], plan: '订阅状态未知', note: '', asOf: null, state: 'unknown' }),
      provider('unknown-with-numbers', { windows: [{ label: 'quota', usedPercent: 12, resetsAt: null }], balances: [], plan: '', note: '', asOf: null, state: 'unknown' }),
      provider('unknown-silent', { windows: [], balances: [], plan: '', note: '', asOf: null, state: 'unknown' }),
    ]);
    const [unknown, withNumbers, silent] = report.providers;
    assert.equal(unknown.providerState, 'unknown');
    assert.equal(unknown.ok, false, 'no windows and no balances is not a real reading');
    assert.equal(unknown.state, 'fresh', 'the cache state vocabulary remains independent');
    assert.equal(unknown.error, '订阅状态未知', 'the provider plan text is the visible text');
    assert.equal(silent.ok, false);
    assert.equal(silent.error, '状态未知', 'a fixed Chinese sentence when the provider gave neither plan nor note');
    assert.equal(withNumbers.ok, true, 'a real numeric reading stays a success');
    assert.equal(withNumbers.state, 'fresh');
  });

  it('shows a not-configured account as failed and carries a safe stale source override', async () => {
    const report = await reportFor([
      provider('not-configured', {
        windows: [],
        balances: [],
        plan: '',
        note: 'Codex 没有使用 ChatGPT 登录；API key 登录没有订阅额度。',
        asOf: null,
        state: 'not_configured',
      }),
      provider('codex-app-server', {
        source: 'local-log',
        stale: true,
        state: 'stale',
        windows: [],
        balances: [],
        plan: '',
        note: '本次由 local-log 路径回答，数据可能过期。',
        asOf: null,
      }),
      provider('invalid-source', {
        source: 'not-a-catalog-access',
        windows: [{ label: 'quota', usedPercent: 12, resetsAt: null }],
        balances: [],
        plan: '',
        note: '',
        asOf: null,
      }),
    ]);
    const [notConfigured, fallback, invalidSource] = report.providers;
    assert.equal(notConfigured.providerState, 'not_configured');
    assert.equal(notConfigured.ok, false);
    assert.equal(notConfigured.error, notConfigured.note);
    assert.equal(fallback.source, 'local-log');
    assert.equal(fallback.state, 'stale');
    assert.equal(fallback.ok, false);
    assert.equal(fallback.stale, true);
    assert.equal(fallback.note.includes('local-log'), true);
    assert.equal(invalidSource.source, 'official-api');
  });

  it('keeps DeepSeek balance components without fabricating amount', async () => {
    const report = await reportFor([provider('deepseek', {
      windows: [],
      balances: [{ currency: 'CNY', isAvailable: null, granted: 2.5, toppedUp: 7.5 }],
      plan: '',
      note: '',
      asOf: null,
      isAvailable: false,
    })]);
    const [entry] = report.providers;
    assert.equal(entry.isAvailable, false);
    assert.deepEqual(entry.balances, [{ currency: 'CNY', isAvailable: null, granted: 2.5, toppedUp: 7.5 }]);
    assert.equal('amount' in entry.balances[0], false);
  });

  it('adds catalog metadata only for a validated catalog entry', async () => {
    const report = await reportFor([
      provider('deepseek', { windows: [], balances: [], plan: 'ok', note: '', asOf: null }),
      provider('codex', { windows: [], balances: [], plan: 'ok', note: '', asOf: null }),
      provider('custom-source', { windows: [], balances: [], plan: 'ok', note: '', asOf: null }),
    ]);
    const [known, codex, custom] = report.providers;
    assert.deepEqual({ access: known.access, credentialType: known.credentialType, docsUrl: known.docsUrl }, {
      access: 'official-api',
      credentialType: 'deepseek-api-key',
      docsUrl: 'https://api-docs.deepseek.com/api/get-user-balance',
    });
    assert.deepEqual({ access: codex.access, credentialType: codex.credentialType, docsUrl: codex.docsUrl, setupCommand: codex.setupCommand }, {
      access: 'local-log',
      credentialType: 'codex-chatgpt-session',
      docsUrl: 'https://learn.chatgpt.com/docs/app-server',
      setupCommand: 'codex login',
    });
    assert.equal('access' in custom, false);
    assert.equal('credentialType' in custom, false);
    assert.equal('docsUrl' in custom, false);
    assert.equal('setupCommand' in custom, false);
  });

  it('registers only the enabled manual providers from a resolved config', async () => {
    let fetchCalls = 0;
    const config = resolveConfig(tmpDir('qb-usage-config-'), {
      name: 'Usage',
      lanes: { files: { run: ['node', 'worker.js'], outputDir: 'out' } },
      usage: {
        manualProviders: ['alibaba-token-plan', 'nvidia'],
        alibaba: { edition: 'team', region: 'CN-BEIJING' },
      },
    });
    const service = createUsageService({
      providers: [],
      config,
      env: { API_KEY: 'must-not-be-read' },
      fetchImpl: async () => { fetchCalls += 1; throw new Error('manual provider fetched'); },
      exec: async () => { throw new Error('manual provider executed'); },
      homedir: tmpDir('qb-usage-manual-home-'),
    });
    const report = await service.report();
    assert.deepEqual(report.providers.map((entry) => entry.id), ['alibaba-token-plan', 'nvidia']);
    assert.equal(report.providers[0].providerState, 'manual_only');
    assert.equal(report.providers[0].ok, false);
    assert.match(report.providers[0].plan, /team · cn-beijing/);
    assert.equal(fetchCalls, 0);
  });

  it('keeps the app-server opt-in off by default and adds it only from the validated switch', () => {
    const root = tmpDir('qb-usage-experimental-config-');
    const base = {
      name: 'Usage',
      lanes: { files: { run: ['node', 'worker.js'], outputDir: 'out' } },
    };
    const offConfig = resolveConfig(root, base);
    const off = createUsageService({ providers: [], config: offConfig, env: {}, homedir: tmpDir('qb-usage-experimental-off-') });
    assert.deepEqual(off.listProviderIds(), []);

    const onConfig = resolveConfig(root, { ...base, usage: { experimentalProviders: ['codex-app-server'] } });
    const on = createUsageService({ providers: [], config: onConfig, env: {}, homedir: tmpDir('qb-usage-experimental-on-') });
    assert.deepEqual(on.listProviderIds(), ['codex-app-server']);
  });

  it('re-validates a hand-built config at the service boundary and never echoes a rejected choice', async () => {
    // resolveConfig refuses these values at the settings boundary (test/server/usage-service-wiring.test.js
    // proves the route); a hand-built config object bypasses that on purpose, so the service's own boundary
    // must still normalize the choice without echoing it.
    const service = createUsageService({
      providers: [],
      manualProviders: ['alibaba-coding-plan'],
      alibaba: { edition: 'not-a-real-edition', region: 'CN-BEIJING' },
      env: {},
      homedir: tmpDir('qb-usage-manual-home-'),
    });
    const report = await service.report();
    assert.equal(report.providers[0].providerState, 'manual_only');
    assert.equal(report.providers[0].ok, false);
    assert.match(report.providers[0].plan, /cn-beijing/);
    assert.ok(!JSON.stringify(report).includes('not-a-real-edition'));
    assert.throws(() => createUsageService({ providers: [], manualProviders: ['not-enabled'] }), /not-enabled/);
  });

  it('shows a Chinese plan hint for an enabled Alibaba card that has no usage.alibaba yet', async () => {
    // X17b: an enabled card with nothing configured must still say what to configure — the plan line can
    // never be an empty string, and the standard console note stays.
    const service = createUsageService({
      providers: [],
      manualProviders: ['alibaba-token-plan'],
      env: {},
      homedir: tmpDir('qb-usage-alibaba-hint-'),
    });
    const report = await service.report();
    const entry = report.providers[0];
    assert.equal(entry.id, 'alibaba-token-plan');
    assert.equal(entry.providerState, 'manual_only');
    assert.equal(entry.state, 'unconfigured');
    assert.equal(entry.ok, false);
    assert.equal(entry.plan, ALIBABA_PLAN_TEXT);
    assert.match(entry.plan, /usage\.alibaba/);
    assert.match(entry.note, /控制台/);
    assert.equal(entry.error, entry.note);
  });

  it('surfaces a dropped invalid usage.alibaba as the Alibaba card reason', async () => {
    // X17a: the load path drops the block and leaves a Chinese diagnostic on the resolved config; the card
    // must show that reason, and the rejected value must never appear anywhere in the report.
    const config = resolveConfig(
      tmpDir('qb-usage-alibaba-drop-'),
      {
        name: 'Usage',
        lanes: { files: { run: ['node', 'worker.js'], outputDir: 'out' } },
        usage: { manualProviders: ['alibaba-token-plan'], alibaba: { edition: 'hacked-edition', region: 'cn-beijing' } },
      },
      { dropInvalidAlibaba: true },
    );
    assert.equal(config.usage.alibaba, undefined);
    assert.match(config.usage.alibabaIssue, /usage\.alibaba\.edition 不是有效的阿里云版本/);
    const service = createUsageService({ providers: [], config, env: {}, homedir: tmpDir('qb-usage-alibaba-drop-home-') });
    const report = await service.report();
    const entry = report.providers[0];
    assert.equal(entry.state, 'unconfigured');
    assert.equal(entry.error, config.usage.alibabaIssue);
    assert.equal(entry.plan, ALIBABA_PLAN_TEXT);
    assert.ok(!JSON.stringify(report).includes('hacked-edition'));
  });
});
