import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createUsageService } from '../../src/usage/service.js';
import { resolveConfig } from '../../src/core/config.js';
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
    assert.equal(manual.state, 'fresh', 'the cache state vocabulary remains independent');
    assert.deepEqual(manual.windows, []);
    assert.equal(manual.note, '请到控制台查看');
    assert.equal(manual.error, '请到控制台查看');

    const unsubscribed = report.providers[1];
    assert.equal(unsubscribed.providerState, 'not_subscribed');
    assert.equal(unsubscribed.ok, false);
    assert.equal(unsubscribed.error, '当前账号未订阅');
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
      docsUrl: 'https://platform.deepseek.com/api-docs',
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
});
