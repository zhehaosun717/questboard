import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { tmpDir } from '../helpers.js';
import { createUsageService } from '../../src/usage/service.js';
import { KIMI_BASE_URL, codex, cursor, deepseek, kimi, openrouter, siliconflow, volcano } from '../../src/usage/providers.js';
import { childEnvironment, isoOrNull, parseJsonDocuments, runCommand, windowLabel } from '../../src/usage/common.js';
import { createUsageRoutes } from '../../src/server/usageRoutes.js';
import { routeParts } from '../../src/server/http.js';

const SECRET = 'sk-test-secret-0123456789abcdef0123456789abcdef';

function fakeHome({ auth, codexLines } = {}) {
  const homedir = tmpDir('qb-usage-home-');
  if (auth) {
    fs.mkdirSync(path.join(homedir, '.local', 'share', 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(homedir, '.local', 'share', 'opencode', 'auth.json'), JSON.stringify(auth));
  }
  if (codexLines) {
    const dir = path.join(homedir, '.codex', 'sessions', '2026', '09', '13');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'rollout-2026-09-13-a.jsonl'), codexLines.map((l) => JSON.stringify(l)).join('\n'));
  }
  return homedir;
}

const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

describe('usage providers', () => {
  it('reads Codex windows from the newest rate_limits record', async () => {
    const homedir = fakeHome({
      codexLines: [
        { timestamp: '2026-09-13T08:00:00Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 1, window_minutes: 300, resets_at: 1789300000 } } } },
        { timestamp: '2026-09-13T09:00:00Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 2, window_minutes: 300, resets_at: 2000000000 }, secondary: { used_percent: 34, window_minutes: 10080, resets_at: 2000500000 } } } },
      ],
    });
    const usage = createUsageService({ homedir, env: {}, providers: [codex] });
    const [entry] = (await usage.report()).providers;
    assert.equal(entry.ok, true);
    assert.deepEqual(entry.windows.map((w) => [w.label, w.usedPercent]), [['5 小时', 2], ['7 天', 34]]);
    assert.equal(entry.windows[0].resetsAt, new Date(2000000000 * 1000).toISOString());
    assert.equal(entry.asOf, '2026-09-13T09:00:00.000Z');
  });

  it('guards huge resets_at in Codex session log without throwing RangeError or failing card', async () => {
    assert.equal(isoOrNull(1e20), null);
    assert.equal(isoOrNull(-1e20), null);
    assert.equal(isoOrNull(Infinity), null);
    assert.equal(isoOrNull(NaN), null);

    const homedir = fakeHome({
      codexLines: [
        { timestamp: '2026-09-13T09:00:00Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 15, window_minutes: 300, resets_at: 1e20 } } } },
      ],
    });
    const usage = createUsageService({ homedir, env: {}, providers: [codex] });
    const [entry] = (await usage.report()).providers;
    assert.equal(entry.ok, true);
    assert.equal(entry.windows[0].usedPercent, 15);
    assert.equal(entry.windows[0].resetsAt, null);
    assert.equal(entry.windows[0].label, '5 小时');
  });

  it('finds keys in OpenCode auth, prefers the environment, and never returns the key', async () => {
    const homedir = fakeHome({ auth: { 'kimi-for-coding': { type: 'api', key: SECRET }, deepseek: { type: 'api', key: 'from-auth' } } });
    const seen = [];
    const fetchImpl = async (url, options) => {
      seen.push([new URL(url).host, options.headers.authorization]);
      if (url.includes('kimi')) return json(200, { usage: { limit: '100', used: '25', resetTime: '2030-09-20T00:00:00Z' }, limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '50', remaining: '40', resetTime: '2030-09-13T12:00:00Z' } }] });
      return json(200, { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.50' }] });
    };
    const usage = createUsageService({ homedir, env: { DEEPSEEK_API_KEY: 'from-env' }, fetchImpl, providers: [kimi, deepseek] });
    const report = await usage.report();
    const [k, d] = report.providers;
    assert.deepEqual(k.windows.map((w) => [w.label, w.usedPercent]), [['5 小时', 20], ['本期总额度', 25]]);
    assert.equal(k.keyFrom, 'OpenCode 登录（kimi-for-coding）');
    assert.deepEqual(d.balances, [{ currency: 'CNY', amount: 12.5 }]);
    assert.equal(d.keyFrom, '环境变量 DEEPSEEK_API_KEY');
    assert.deepEqual(seen, [['api.kimi.com', `Bearer ${SECRET}`], ['api.deepseek.com', 'Bearer from-env']]);
    assert.ok(!JSON.stringify(report).includes(SECRET));
  });

  it('says where it looked when there is no key, and keeps thrown errors free of secrets', async () => {
    const homedir = fakeHome({ auth: { openrouter: { type: 'api', key: SECRET } } });
    const fetchImpl = async () => { throw new Error(`socket hang up for Bearer ${SECRET}`); };
    const usage = createUsageService({ homedir, env: {}, fetchImpl, providers: [kimi, openrouter, siliconflow] });
    const report = await usage.report();
    const [k, o, s] = report.providers;
    assert.equal(k.configured, false);
    assert.match(k.error, /KIMI_API_KEY/);
    assert.equal(o.ok, false);
    assert.equal(o.error, '连不上 openrouter.ai');
    assert.match(s.error, /下线/);
    assert.ok(!JSON.stringify(report).includes(SECRET));
  });

  it('reports HTTP refusals and computes OpenRouter credit left', async () => {
    const homedir = fakeHome({ auth: { openrouter: { type: 'api', key: 'k' }, deepseek: { type: 'api', key: 'k' } } });
    const fetchImpl = async (url) => (url.includes('openrouter') ? json(200, { data: { total_credits: 20, total_usage: 7.255 } }) : json(401, {}));
    const [o, d] = (await createUsageService({ homedir, env: {}, fetchImpl, providers: [openrouter, deepseek] }).report()).providers;
    assert.deepEqual(o.balances, [{ currency: 'USD', amount: 12.75 }]);
    assert.match(d.error, /HTTP 401/);
  });

  it('keeps only the plan from arkcli, not the account document', async () => {
    const output = '{"viewer":{"user_id":"2104","user_name":"secret-name"}}\n{"items":[{"product":"coding-plan","edition":"Lite","subscribed":true,"error":""}]}';
    const [v] = (await createUsageService({ homedir: fakeHome(), env: {}, exec: async () => output, providers: [volcano] }).report()).providers;
    assert.equal(v.plan, 'Lite · 已订阅');
    assert.ok(!JSON.stringify(v).includes('secret-name'));
  });

  it('turns an arkcli error into what to do, not a false "not subscribed" — and never echoes arkcli\'s own login name', async () => {
    const output = '{"items":[{"product":"coding-plan","edition":"personal","subscribed":false,"error":"GetCodingPlanUsage requires Volcengine Ark SSO STS, please run `arkcli auth login volc-sso`: identity"}]}';
    const [v] = (await createUsageService({ homedir: fakeHome(), env: {}, exec: async () => output, providers: [volcano] }).report()).providers;
    assert.equal(v.ok, false);
    assert.equal(v.plan, '');
    assert.equal(v.error, '请先登录对应的账号');
    assert.ok(!JSON.stringify(v).includes('volc-sso'), 'the SSO name arkcli reported is never copied into the displayed text');
  });

  it('falls back to the query-failed message when arkcli\'s error text does not look like a login prompt', async () => {
    const output = '{"items":[{"product":"coding-plan","edition":"personal","subscribed":false,"error":"internal error, retry later"}]}';
    const [v] = (await createUsageService({ homedir: fakeHome(), env: {}, exec: async () => output, providers: [volcano] }).report()).providers;
    assert.equal(v.ok, false);
    assert.equal(v.error, 'arkcli 没能查到套餐（运行 arkcli usage plan 看原因）');
  });

  it('caches for a minute unless asked to refresh', async () => {
    let calls = 0;
    const provider = { id: 'x', name: 'X', source: 'api', fetch: async () => { calls += 1; return { balances: [] }; } };
    let clock = 0;
    const usage = createUsageService({ homedir: fakeHome(), env: {}, providers: [provider], now: () => clock });
    await usage.report();
    await usage.report();
    assert.equal(calls, 1);
    await usage.report({ refresh: true });
    assert.equal(calls, 2);
    clock = 61000;
    await usage.report();
    assert.equal(calls, 3);
  });

  it('reads Cursor with the OpenCode oauth token, and reports an expired login', async () => {
    const good = fakeHome({ auth: { cursor: { type: 'oauth', access: SECRET, refresh: 'r', expires: Date.now() + 3600000 } } });
    const fetchImpl = async (url, options) => {
      assert.equal(new URL(url).host, 'api2.cursor.sh');
      assert.equal(options.headers.authorization, `Bearer ${SECRET}`);
      return json(200, { 'gpt-4': { numRequests: 30, maxRequestUsage: 120 }, 'no-cap': { numRequests: 5 }, startOfMonth: '2026-09-01T00:00:00Z' });
    };
    const [c] = (await createUsageService({ homedir: good, env: {}, fetchImpl, providers: [cursor] }).report()).providers;
    assert.deepEqual(c.windows, [{ label: 'gpt-4（本月请求）', usedPercent: 25, resetsAt: null }]);
    assert.equal(c.keyFrom, 'OpenCode 登录（cursor）');
    assert.match(c.note, /2026-09-01/);

    const expired = fakeHome({ auth: { cursor: { type: 'oauth', access: SECRET, expires: Date.now() - 1000 } } });
    const [e] = (await createUsageService({ homedir: expired, env: {}, fetchImpl: async () => json(200, {}), providers: [cursor] }).report()).providers;
    assert.equal(e.ok, false);
    assert.equal(e.configured, true);
    assert.match(e.error, /登录已过期/);

    const none = (await createUsageService({ homedir: fakeHome(), env: {}, fetchImpl: async () => json(200, {}), providers: [cursor] }).report()).providers[0];
    assert.equal(none.configured, false);
  });

  it('shows a usage-based Cursor plan as a request count, not an error', async () => {
    const homedir = fakeHome({ auth: { cursor: { type: 'oauth', access: SECRET, expires: Date.now() + 3600000 } } });
    const fetchImpl = async () => json(200, { 'gpt-4': { numRequests: 12, maxRequestUsage: null }, startOfMonth: '2026-09-01T00:00:00Z' });
    const [c] = (await createUsageService({ homedir, env: {}, fetchImpl, providers: [cursor] }).report()).providers;
    assert.equal(c.ok, true);
    assert.deepEqual(c.windows, []);
    assert.match(c.note, /12 次请求/);
  });

  it('drops response strings that do not look like what they claim to be', async () => {
    const homedir = fakeHome({ auth: { deepseek: { type: 'api', key: 'k' }, cursor: { type: 'oauth', access: SECRET, expires: Date.now() + 3600000 } } });
    const fetchImpl = async (url) => (url.includes('deepseek')
      ? json(200, { balance_infos: [{ currency: `Bearer ${SECRET}`, total_balance: '1' }, { currency: 'CNY', total_balance: '2' }] })
      : json(200, { [`Bearer ${SECRET}`]: { numRequests: 1, maxRequestUsage: 10 }, 'gpt-4': { numRequests: 1, maxRequestUsage: 10 } }));
    const report = await createUsageService({ homedir, env: {}, fetchImpl, providers: [deepseek, cursor] }).report();
    assert.deepEqual(report.providers[0].balances, [{ currency: 'CNY', amount: 2 }]);
    assert.deepEqual(report.providers[1].windows.map((w) => w.label), ['gpt-4（本月请求）']);
    assert.ok(!JSON.stringify(report).includes(SECRET));
    const output = `{"items":[{"product":"coding-plan","edition":"x ${SECRET} y","subscribed":true,"error":""}]}`;
    const [v] = (await createUsageService({ homedir: fakeHome(), env: {}, exec: async () => output, providers: [volcano] }).report()).providers;
    assert.equal(v.plan, '未知版本 · 已订阅');
  });

  it('runs CLIs with a minimal environment and trusts nothing from a failed run', async () => {
    assert.deepEqual(Object.keys(childEnvironment({ PATH: 'p', Path: 'p', OPENAI_API_KEY: 'x', DEEPSEEK_API_KEY: 'y', HOME: 'h' })).sort(), ['HOME', 'PATH', 'Path']);
    const env = { ...process.env, QB_CANARY_SECRET: SECRET };
    const printed = await runCommand('node', ['-e', '"process.stdout.write(JSON.stringify(Object.keys(process.env)))"'], { env });
    assert.ok(!printed.includes('QB_CANARY_SECRET'));
    await assert.rejects(runCommand('node', ['-e', '"process.stdout.write(\'partial\');process.exit(2)"']), /退出码 2/);
  });

  it('labels windows and splits concatenated JSON documents', () => {
    assert.deepEqual([windowLabel(300), windowLabel(10080), windowLabel(90), windowLabel(null)], ['5 小时', '7 天', '90 分钟', '额度窗口']);
    assert.deepEqual(parseJsonDocuments('noise {"a":"}"} text [1,2]'), [{ a: '}' }, [1, 2]]);
  });

  it('shows expired Codex window as reset with no used percent, never its old percent', async () => {
    const homedir = fakeHome({
      codexLines: [
        { timestamp: '2026-09-13T09:00:00Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 50, window_minutes: 300, resets_at: 1000000000 } } } },
      ],
    });
    const usage = createUsageService({ homedir, env: {}, providers: [codex] });
    const [entry] = (await usage.report()).providers;
    assert.equal(entry.ok, true);
    assert.equal(entry.windows[0].usedPercent, null);
    assert.equal(entry.windows[0].resetsAt, new Date(1000000000 * 1000).toISOString());
  });

  it('parses Kimi usages synthetic fixture following Report 885 rules', async () => {
    const fixturePath = path.join(import.meta.dirname, 'fixtures', 'kimi-usages.synthetic.json');
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    let requestedUrl = null;
    const fetchImpl = async (url) => {
      requestedUrl = url;
      return json(200, fixture);
    };

    assert.equal(KIMI_BASE_URL, 'https://api.kimi.com/coding/v1');
    const result = await kimi.fetch({ fetchImpl, key: 'test-key', now: 1500000000000 });
    assert.equal(requestedUrl, `${KIMI_BASE_URL}/usages`);

    assert.equal(result.windows[0].label, '5 小时');
    assert.equal(result.windows[0].usedPercent, null);
    assert.equal(result.windows[0].state, 'reset');

    assert.equal(result.windows[1].label, 'placeholder-named-limit');
    assert.equal(result.windows[1].usedPercent, 20);
    assert.equal(result.windows[1].resetDerived, true);

    assert.equal(result.windows[2].label, '7 天');
    assert.equal(result.windows[2].usedPercent, null);

    assert.equal(result.windows[3].label, '本期总额度');
    assert.equal(result.windows[3].usedPercent, null);

    const serialized = JSON.stringify(result);
    assert.ok(!serialized.toLowerCase().includes('tokens'));
    assert.ok(!serialized.toLowerCase().includes('requests'));
  });

  it('falls back to Chinese label 额度 n when a Kimi limit has no name or window', async () => {
    const fetchImpl = async () => json(200, {
      limits: [
        { detail: { limit: '100', used: '30' } },
        { detail: { limit: '200', used: '50' } },
      ],
    });
    const result = await kimi.fetch({ fetchImpl, key: 'test-key' });
    assert.equal(result.windows[0].label, '额度 1');
    assert.equal(result.windows[0].usedPercent, 30);
    assert.equal(result.windows[1].label, '额度 2');
    assert.equal(result.windows[1].usedPercent, 25);
  });

  it('parses Volcano Coding Plan synthetic fixture and drops viewer/seat_id entirely', async () => {
    const fixturePath = path.join(import.meta.dirname, 'fixtures', 'arkcli-usage-plan-coding.synthetic.json');
    const fixtureText = fs.readFileSync(fixturePath, 'utf8');

    const result = await volcano.fetch({ exec: async () => fixtureText, now: 946656000000 });
    assert.equal(result.plan, 'personal · 已订阅');
    assert.equal(result.asOf, '1999-12-31T16:00:00.000Z');

    assert.deepEqual(result.windows.map((w) => [w.label, w.usedPercent]), [
      ['5 小时', 1],
      ['每周', 2],
      ['每月', 3],
    ]);

    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('viewer'), 'viewer must never appear in result');
    assert.ok(!serialized.includes('seat_id'), 'seat_id must never appear in result');
    assert.ok(!serialized.includes('SYNTHETIC-USER'), 'viewer identifiers must be dropped');
    assert.ok(!serialized.includes('SYNTHETIC-ACCOUNT'), 'viewer identifiers must be dropped');
    assert.ok(!serialized.includes('SYNTHETIC-SEAT'), 'seat_id must be dropped');
    assert.ok(!serialized.includes('arkcli 只给订阅状态，不给用量数字'));
  });

  it('marks Volcano periods whose reset time has passed as state reset with null usedPercent', async () => {
    const fixturePath = path.join(import.meta.dirname, 'fixtures', 'arkcli-usage-plan-coding.synthetic.json');
    const fixtureText = fs.readFileSync(fixturePath, 'utf8');

    // With now past the reset timestamps, session and weekly should be reset
    const result = await volcano.fetch({ exec: async () => fixtureText, now: Date.parse('2026-09-16T12:00:00.000Z') });
    assert.equal(result.plan, 'personal · 已订阅');
    assert.equal(result.windows[0].label, '5 小时');
    assert.equal(result.windows[0].usedPercent, null);
    assert.equal(result.windows[0].state, 'reset');

    assert.equal(result.windows[1].label, '每周');
    assert.equal(result.windows[1].usedPercent, null);
    assert.equal(result.windows[1].state, 'reset');

    // monthly has no reset_at, so usedPercent remains
    assert.equal(result.windows[2].label, '每月');
    assert.equal(result.windows[2].usedPercent, 3);
    assert.equal(result.windows[2].state, undefined);
  });

  it('handles Volcano subscribed:false and empty periods as not_subscribed and unknown', async () => {
    const notSubscribedOutput = JSON.stringify({
      items: [{ product: 'coding-plan', edition: 'personal', subscribed: false }],
    });
    const notSubRes = await volcano.fetch({ exec: async () => notSubscribedOutput, now: 1000 });
    assert.equal(notSubRes.state, 'not_subscribed');
    assert.equal(notSubRes.plan, 'personal · 未订阅');
    assert.deepEqual(notSubRes.windows, []);

    const emptyPeriodsOutput = JSON.stringify({
      items: [{ product: 'coding-plan', edition: 'personal', subscribed: true, periods: [] }],
    });
    const emptyRes = await volcano.fetch({ exec: async () => emptyPeriodsOutput, now: 1000 });
    assert.equal(emptyRes.state, 'unknown');
    assert.equal(emptyRes.plan, 'personal · 已订阅');
    assert.deepEqual(emptyRes.windows, []);

    // B2: missing, null, and string values for subscribed yield state 'unknown' and '<edition> · 订阅状态未知'
    const missingSubOutput = JSON.stringify({
      items: [{ product: 'coding-plan', edition: 'personal' }],
    });
    const missingRes = await volcano.fetch({ exec: async () => missingSubOutput, now: 1000 });
    assert.equal(missingRes.state, 'unknown');
    assert.equal(missingRes.plan, 'personal · 订阅状态未知');
    assert.deepEqual(missingRes.windows, []);

    const nullSubOutput = JSON.stringify({
      items: [{ product: 'coding-plan', edition: 'personal', subscribed: null }],
    });
    const nullRes = await volcano.fetch({ exec: async () => nullSubOutput, now: 1000 });
    assert.equal(nullRes.state, 'unknown');
    assert.equal(nullRes.plan, 'personal · 订阅状态未知');
    assert.deepEqual(nullRes.windows, []);

    const strTrueOutput = JSON.stringify({
      items: [{ product: 'coding-plan', edition: 'personal', subscribed: 'true', periods: [{ label: 'session', percent: '5' }] }],
    });
    const strTrueRes = await volcano.fetch({ exec: async () => strTrueOutput, now: 1000 });
    assert.equal(strTrueRes.state, 'unknown');
    assert.equal(strTrueRes.plan, 'personal · 订阅状态未知');
    assert.deepEqual(strTrueRes.windows, []);

    const strFalseOutput = JSON.stringify({
      items: [{ product: 'coding-plan', edition: 'personal', subscribed: 'false' }],
    });
    const strFalseRes = await volcano.fetch({ exec: async () => strFalseOutput, now: 1000 });
    assert.equal(strFalseRes.state, 'unknown');
    assert.equal(strFalseRes.plan, 'personal · 订阅状态未知');
    assert.deepEqual(strFalseRes.windows, []);
  });

  it('preserves DeepSeek available-balance truth and splits granted versus topped-up balances', async () => {
    const balanceData = {
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '100.00', granted_balance: '20.00', topped_up_balance: '80.00' },
      ],
    };
    const fetchImpl = async () => json(200, balanceData);
    const result = await deepseek.fetch({ fetchImpl, key: 'test-key' });
    assert.equal(result.isAvailable, true);
    assert.equal(result.balances.length, 1);
    assert.equal(result.balances[0].currency, 'CNY');
    assert.equal(result.balances[0].amount, 100);
    assert.equal(result.balances[0].granted, 20);
    assert.equal(result.balances[0].toppedUp, 80);

    const unavailableFetch = async () => json(200, { is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '0.00' }] });
    const unavailResult = await deepseek.fetch({ fetchImpl: unavailableFetch, key: 'test-key' });
    assert.equal(unavailResult.isAvailable, false);
    assert.match(unavailResult.note, /余额不足/);

    // N5: no total_balance means no amount, absent is_available means null, never invented sums
    const noTotalFetch = async () => json(200, {
      balance_infos: [
        { currency: 'CNY', granted_balance: '2.50' },
      ],
    });
    const noTotalResult = await deepseek.fetch({ fetchImpl: noTotalFetch, key: 'test-key' });
    assert.equal(noTotalResult.isAvailable, null);
    assert.equal(noTotalResult.balances[0].amount, undefined);
    assert.equal(noTotalResult.balances[0].granted, 2.5);
    assert.equal(noTotalResult.note, '');
  });

  it('ensures Kimi never leaks API key echoed inside name, title, or scope in service report', async () => {
    const testKey = 'sk-kimi-service-probe-key-0123456789abcdef';
    const fetchImpl = async () => json(200, {
      usage: { limit: '100', used: '25', name: `Echoed ${testKey}` },
      limits: [
        { name: `x ${testKey}`, limit: '50', used: '10' },
        { title: `Prefix Bearer ${testKey}`, limit: '60', used: '20' },
        { scope: testKey, limit: '70', used: '30' },
        { name: '0123456789abcdef0123456789', limit: '80', used: '40' },
      ],
    });
    const homedir = fakeHome();
    const usage = createUsageService({
      homedir,
      env: { KIMI_API_KEY: testKey },
      fetchImpl,
      providers: [kimi],
    });
    const report = await usage.report();
    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes(testKey), 'Key must never appear in report JSON');
    assert.ok(!serialized.toLowerCase().includes('sk-kimi-service-probe-key'));
    const [k] = report.providers;
    assert.equal(k.ok, true);
    assert.equal(k.windows[0].label, '额度 1');
    assert.equal(k.windows[1].label, '额度 2');
    assert.equal(k.windows[2].label, '额度 3');
    assert.equal(k.windows[3].label, '额度 4');
    assert.equal(k.windows[4].label, '本期总额度');
  });

  it('drops resets on huge relative resets or updated_at values instead of throwing RangeError', async () => {
    const fetchImpl = async () => json(200, {
      limits: [
        { name: 'normal-row', limit: '100', used: '10', reset_in: 1e20 },
      ],
    });
    const kimiRes = await kimi.fetch({ fetchImpl, key: 'test-key', now: 1000 });
    assert.equal(kimiRes.windows[0].label, 'normal-row');
    assert.equal(kimiRes.windows[0].resetsAt, null);

    const volcOutput = JSON.stringify({
      items: [{
        product: 'coding-plan',
        edition: 'personal',
        subscribed: true,
        updated_at: 1e20,
        periods: [{ label: 'session', percent: '10', reset_at: 1e20 }],
      }],
    });
    const volcRes = await volcano.fetch({ exec: async () => volcOutput, now: 1000 });
    assert.equal(volcRes.state, 'ok');
    assert.equal(volcRes.windows[0].resetsAt, null);
    assert.equal(volcRes.asOfDerived, true);
  });
});

describe('usage route', () => {
  async function request(pathname, headers = {}) {
    const routes = createUsageRoutes({ usage: { report: async ({ refresh }) => ({ refresh, providers: [] }) } });
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (!(await routes.handle(req, res, url, routeParts(url.pathname)))) { res.writeHead(599); res.end(); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const body = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: pathname, headers }, (res) => {
        let text = '';
        res.on('data', (c) => (text += c)).on('end', () => resolve({ status: res.statusCode, text }));
      }).on('error', reject);
    });
    await new Promise((resolve) => server.close(resolve));
    return body;
  }

  it('answers local hosts, passes refresh, and refuses other host names', async () => {
    const ok = await request('/api/usage?refresh=1');
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.text).refresh, true);
    assert.equal((await request('/api/usage', { host: 'evil.example:6097' })).status, 403);
  });

  it('refuses every cross-site read: even a plain GET calls providers on a cache miss', async () => {
    const crossSite = { 'sec-fetch-site': 'cross-site', origin: 'http://evil.example' };
    assert.equal((await request('/api/usage', crossSite)).status, 403);
    assert.equal((await request('/api/usage?refresh=1', crossSite)).status, 403);
  });
});
