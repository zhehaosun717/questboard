import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { tmpDir } from '../helpers.js';
import { createUsageService } from '../../src/usage/service.js';
import { codex, cursor, deepseek, kimi, openrouter, siliconflow, volcano } from '../../src/usage/providers.js';
import { parseJsonDocuments, windowLabel } from '../../src/usage/common.js';
import { createUsageRoutes } from '../../src/server/usageRoutes.js';
import { routeParts } from '../../src/server/http.js';

const SECRET = 'sk-test-secret-0123456789abcdef';

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
        { timestamp: '2026-09-13T09:00:00Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 2, window_minutes: 300, resets_at: 1789307228 }, secondary: { used_percent: 34, window_minutes: 10080, resets_at: 1789833273 } } } },
      ],
    });
    const usage = createUsageService({ homedir, env: {}, providers: [codex] });
    const [entry] = (await usage.report()).providers;
    assert.equal(entry.ok, true);
    assert.deepEqual(entry.windows.map((w) => [w.label, w.usedPercent]), [['5 小时', 2], ['7 天', 34]]);
    assert.equal(entry.windows[0].resetsAt, new Date(1789307228 * 1000).toISOString());
    assert.equal(entry.asOf, '2026-09-13T09:00:00.000Z');
  });

  it('finds keys in OpenCode auth, prefers the environment, and never returns the key', async () => {
    const homedir = fakeHome({ auth: { 'kimi-for-coding': { type: 'api', key: SECRET }, deepseek: { type: 'api', key: 'from-auth' } } });
    const seen = [];
    const fetchImpl = async (url, options) => {
      seen.push([new URL(url).host, options.headers.authorization]);
      if (url.includes('kimi')) return json(200, { usage: { limit: '100', used: '25', resetTime: '2026-09-20T00:00:00Z' }, limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '50', remaining: '40', resetTime: '2026-09-13T12:00:00Z' } }] });
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

  it('turns an arkcli error into what to do, not a false "not subscribed"', async () => {
    const output = '{"items":[{"product":"coding-plan","edition":"personal","subscribed":false,"error":"GetCodingPlanUsage requires Volcengine Ark SSO STS, please run `arkcli auth login volc-sso`: identity"}]}';
    const [v] = (await createUsageService({ homedir: fakeHome(), env: {}, exec: async () => output, providers: [volcano] }).report()).providers;
    assert.equal(v.ok, false);
    assert.equal(v.plan, '');
    assert.equal(v.error, 'arkcli 需要先登录：在终端运行 arkcli auth login volc-sso');
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

  it('labels windows and splits concatenated JSON documents', () => {
    assert.deepEqual([windowLabel(300), windowLabel(10080), windowLabel(90), windowLabel(null)], ['5 小时', '7 天', '90 分钟', '额度窗口']);
    assert.deepEqual(parseJsonDocuments('noise {"a":"}"} text [1,2]'), [{ a: '}' }, [1, 2]]);
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
});
