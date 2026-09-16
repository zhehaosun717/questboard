// Dedicated tests for GET /api/usage: who may ask, which parameters are accepted, and that a refused or
// invalid request never reaches the usage service (a provider read costs quota and reveals balances).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { tmpDir } from '../helpers.js';
import { createUsageRoutes } from '../../src/server/usageRoutes.js';
import { createUsageService } from '../../src/usage/service.js';
import { routeParts } from '../../src/server/http.js';
import { startFixture } from './fixture.js';

function fakeUsage() {
  const calls = [];
  return {
    calls,
    listProviderIds: () => ['codex', 'kimi'],
    report(options) { calls.push(options); return Promise.resolve({ generatedAt: '2026-09-15T00:00:00.000Z', providers: [{ id: 'codex' }] }); },
  };
}

async function withRoutes(usage, run) {
  const routes = createUsageRoutes({ usage });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!(await routes.handle(req, res, url, routeParts(url.pathname)))) { res.writeHead(599); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function get(port, path, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c)).on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('usage routes', () => {
  it('serves simple same-origin board requests and passes refresh and provider through', async () => {
    const usage = fakeUsage();
    await withRoutes(usage, async (port) => {
      const plain = await get(port, '/api/usage', { host: `127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' });
      assert.equal(plain.status, 200);
      assert.deepEqual(usage.calls[0], { refresh: false, provider: null });
      const refreshed = await get(port, '/api/usage?refresh=1', { host: `127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' });
      assert.equal(refreshed.status, 200);
      assert.deepEqual(usage.calls[1], { refresh: true, provider: null });
      const one = await get(port, '/api/usage?provider=kimi', { host: `127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' });
      assert.equal(one.status, 200);
      assert.deepEqual(usage.calls[2], { refresh: false, provider: 'kimi' }, 'provider= alone narrows, it never forces a refresh');
      const both = await get(port, '/api/usage?refresh=1&provider=kimi', { host: `127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' });
      assert.equal(both.status, 200);
      assert.deepEqual(usage.calls[3], { refresh: true, provider: 'kimi' }, 'refresh=1 together with provider= does force it');
    });
  });

  it('refuses foreign origins for every request shape, and the service is never called', async () => {
    const usage = fakeUsage();
    await withRoutes(usage, async (port) => {
      const crossSite = { host: `127.0.0.1:${port}`, 'sec-fetch-site': 'cross-site', origin: 'http://evil.example' };
      assert.equal((await get(port, '/api/usage', crossSite)).status, 403);
      assert.equal((await get(port, '/api/usage?refresh=1', crossSite)).status, 403);
      assert.equal((await get(port, '/api/usage?provider=codex', crossSite)).status, 403);
      assert.equal((await get(port, '/api/usage', { origin: 'http://evil.example' })).status, 403);
      assert.deepEqual(usage.calls, []);
    });
  });

  it('the refusal body is fixed text, never the caller\'s own Origin echoed back', async () => {
    const usage = fakeUsage();
    await withRoutes(usage, async (port) => {
      const res = await get(port, '/api/usage', { host: `127.0.0.1:${port}`, origin: 'http://evil.example/<script>alert(1)</script>' });
      assert.equal(res.status, 403);
      assert.deepEqual(JSON.parse(res.text), { error: 'origin refused' }, 'nothing the caller sent is reflected into the response body');
    });
  });

  it('refuses a cross-site Referer even with no Origin or Sec-Fetch-Site header', async () => {
    const usage = fakeUsage();
    await withRoutes(usage, async (port) => {
      const crossSiteReferer = { host: `127.0.0.1:${port}`, referer: 'http://evil.example/page' };
      assert.equal((await get(port, '/api/usage', crossSiteReferer)).status, 403);
      const sameOriginReferer = { host: `127.0.0.1:${port}`, referer: `http://127.0.0.1:${port}/board` };
      assert.equal((await get(port, '/api/usage', sameOriginReferer)).status, 200);
      assert.deepEqual(usage.calls, [{ refresh: false, provider: null }]);
    });
  });

  it('answers cleanly, not with a crash, when the usage object has no listProviderIds', async () => {
    const incomplete = { report: async ({ refresh, provider }) => ({ refresh, provider, providers: [] }) };
    await withRoutes(incomplete, async (port) => {
      const res = await get(port, '/api/usage?provider=codex', { host: `127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' });
      assert.equal(res.status, 400);
      assert.match(JSON.parse(res.text).error, /未知的用量来源/);
      const plain = await get(port, '/api/usage', { host: `127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' });
      assert.equal(plain.status, 200, 'a request with no provider= never needs listProviderIds at all');
    });
  });

  it('rejects non-local hosts and non-GET methods', async () => {
    const usage = fakeUsage();
    await withRoutes(usage, async (port) => {
      assert.equal((await get(port, '/api/usage', { host: 'evil.example:6097' })).status, 403);
      assert.equal((await get(port, '/api/usage', { host: `127.0.0.1:${port}` }, 'POST')).status, 405);
      assert.deepEqual(usage.calls, []);
    });
  });

  it('answers unknown or malformed provider ids with 400 and no side effects', async () => {
    const usage = fakeUsage();
    const local = (port) => ({ host: `127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' });
    await withRoutes(usage, async (port) => {
      const unknown = await get(port, '/api/usage?refresh=1&provider=nope', local(port));
      assert.equal(unknown.status, 400);
      assert.match(JSON.parse(unknown.text).error, /未知的用量来源：nope/);
      const injected = await get(port, `/api/usage?provider=${encodeURIComponent('../../etc/passwd')}`, local(port));
      assert.equal(injected.status, 400);
      assert.match(JSON.parse(injected.text).error, /provider id/);
      const long = await get(port, `/api/usage?provider=${'a'.repeat(40)}`, local(port));
      assert.equal(long.status, 400);
      assert.deepEqual(usage.calls, []);
    });
  });

  it('never reaches a provider for a foreign request or a bad id, even when nothing is cached', async () => {
    let reads = 0;
    const provider = { id: 'spy', name: 'Spy', source: 'api', fetch: async () => { reads += 1; return { plan: 'p' }; } };
    const usage = createUsageService({ homedir: tmpDir('qb-usage-route-home-'), env: {}, providers: [provider] });
    await withRoutes(usage, async (port) => {
      const crossSite = await get(port, '/api/usage', { host: `127.0.0.1:${port}`, 'sec-fetch-site': 'cross-site', origin: 'http://evil.example' });
      assert.equal(crossSite.status, 403);
      const bad = await get(port, '/api/usage?refresh=1&provider=ghost', { host: `127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' });
      assert.equal(bad.status, 400);
      assert.equal(reads, 0);
      const ok = await get(port, '/api/usage', { host: `127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' });
      assert.equal(ok.status, 200);
      assert.equal(reads, 1);
      assert.equal(JSON.parse(ok.text).providers[0].id, 'spy');
    });
  });

  it('rejects an uppercase provider id at the real route, the exact same rule the service enforces at construction', async () => {
    const provider = { id: 'spy', name: 'Spy', source: 'api', fetch: async () => ({ plan: 'p' }) };
    const usage = createUsageService({ homedir: tmpDir('qb-usage-route-home-'), env: {}, providers: [provider] });
    await withRoutes(usage, async (port) => {
      const res = await get(port, '/api/usage?provider=Spy', { host: `127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' });
      assert.equal(res.status, 400);
    });
    assert.throws(() => createUsageService({ providers: [{ id: 'Spy', name: 'Spy', source: 'api' }] }), /provider id/);
  });

  it('a malicious provider never leaks through the real route (200, not 500), and recovers on the next request', async () => {
    const SECRET = 'sk-route-secret-0123456789abcdef0123456789abcdef';
    let nameCalls = 0;
    const evilName = {
      id: 'evilname', name: 'EvilName', source: 'api',
      fetch: async () => {
        nameCalls += 1;
        if (nameCalls === 1) {
          const err = {};
          Object.defineProperty(err, 'name', { get() { throw new Error(`leak ${SECRET}`); } });
          throw err;
        }
        return { plan: 'recovered' };
      },
    };
    const evilError = {
      id: 'evilerror', name: 'EvilError', source: 'api',
      fetch: async () => {
        const result = { ok: false, configured: true };
        Object.defineProperty(result, 'error', { get() { throw new Error(`leak ${SECRET}`); } });
        return result;
      },
    };
    const usage = createUsageService({ homedir: tmpDir('qb-usage-route-sentinel-'), env: {}, providers: [evilName, evilError], cooldownMs: 0, timeoutMs: 2000 });
    await withRoutes(usage, async (port) => {
      const headers = { host: `127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' };
      const first = await get(port, '/api/usage', headers);
      assert.equal(first.status, 200, 'a thrown getter must never turn into a 500 with error.message echoed');
      assert.ok(!first.text.includes(SECRET));
      const firstBody = JSON.parse(first.text);
      assert.equal(firstBody.providers.find((e) => e.id === 'evilname').error, '读取失败（Error）');
      assert.match(firstBody.providers.find((e) => e.id === 'evilerror').error, /没有给出可显示的失败原因/);
      // A targeted manual refresh forces a genuinely new attempt without waiting on cache expiry.
      const second = await get(port, '/api/usage?refresh=1&provider=evilname', headers);
      assert.equal(second.status, 200);
      assert.ok(!second.text.includes(SECRET));
      const secondEntry = JSON.parse(second.text).providers.find((e) => e.id === 'evilname');
      assert.equal(nameCalls, 2, 'the slot was not stuck: a genuinely new attempt ran');
      assert.equal(secondEntry.plan, 'recovered', 'it recovered once the first attempt actually settled');
    });
  });

  it('a short, plain-ASCII result.error is still never displayed at the real route', async () => {
    const SENTINEL = 'QBSENTINELsecret0123456789abcdef';
    const provider = { id: 'plain', name: 'Plain', source: 'api', fetch: async () => ({ ok: false, configured: true, error: SENTINEL }) };
    const usage = createUsageService({ homedir: tmpDir('qb-usage-route-sentinel2-'), env: {}, providers: [provider] });
    await withRoutes(usage, async (port) => {
      const res = await get(port, '/api/usage', { host: `127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' });
      assert.equal(res.status, 200);
      assert.ok(!res.text.includes(SENTINEL), 'a plain, short, well-formed error string is still not a display boundary');
      const entry = JSON.parse(res.text).providers[0];
      assert.match(entry.error, /没有给出可显示的失败原因/);
    });
  });

  // Everything above wires createUsageRoutes to a hand-rolled http.createServer, which never exercises the
  // real project server's own routing, background-collector wiring, or its outer try/catch around every
  // route (src/server/server.js:34-40) that would echo error.message on an actual 500. These run against the
  // genuine createServer over a synthetic project (test/server/fixture.js), with a usage service injected —
  // no hand-written outer catch standing in for it.
  describe('usage routes through the real project server (actual createServer, injected usage)', () => {
    it('a toxic nested toJSON never leaks and the read stays a 200 across two real requests', async () => {
      const SECRET = 'QBSENTINELrealserver0123456789abcdef';
      const poisoned = {
        id: 'toxic', name: 'Toxic', source: 'api',
        fetch: async () => ({
          windows: [{ label: 'w', usedPercent: 10, resetsAt: null, toJSON() { return SECRET; } }],
          balances: [],
          plan: { toJSON() { throw new Error(`plan leak ${SECRET}`); } },
          note: '',
          asOf: { toJSON() { return SECRET; } },
        }),
      };
      const usage = createUsageService({ homedir: tmpDir('qb-usage-fixture-home-'), env: {}, providers: [poisoned], cooldownMs: 0 });
      const fixture = await startFixture({ usage });
      try {
        const first = await fixture.api('/api/usage');
        assert.equal(first.status, 200);
        assert.ok(!first.text.includes(SECRET), 'the first real response never echoes the poisoned toJSON');
        const entry = first.body.providers.find((e) => e.id === 'toxic');
        assert.equal(entry.ok, true);
        assert.equal(entry.plan, '', 'a non-string plan with a throwing toJSON is dropped, not rendered');
        const second = await fixture.api('/api/usage');
        assert.equal(second.status, 200, 'the sanitized cache entry is just as safe on a second real request');
        assert.ok(!second.text.includes(SECRET));
      } finally {
        await fixture.close();
      }
    });

    it('a genuine previous success stays visible and marked stale after a later real read returns nothing usable', async () => {
      const clock = { t: 0 };
      let call = 0;
      const provider = {
        id: 'flaky', name: 'Flaky', source: 'api',
        fetch: async () => {
          call += 1;
          if (call === 1) return { windows: [{ label: '5 小时', usedPercent: 20, resetsAt: null }], plan: 'Pro' };
          return {};
        },
      };
      const usage = createUsageService({ homedir: tmpDir('qb-usage-fixture-home-'), env: {}, providers: [provider], now: () => clock.t, cacheMs: 1000, cooldownMs: 0 });
      const fixture = await startFixture({ usage });
      try {
        const first = await fixture.api('/api/usage');
        assert.equal(first.status, 200);
        assert.equal(first.body.providers.find((e) => e.id === 'flaky').state, 'fresh');
        clock.t = 5000;
        const second = await fixture.api('/api/usage?refresh=1');
        assert.equal(second.status, 200);
        const entry = second.body.providers.find((e) => e.id === 'flaky');
        assert.equal(entry.state, 'stale', 'an empty {} result from a real second read never overwrites a real previous success');
        assert.equal(entry.ok, false);
        assert.deepEqual(entry.windows, [{ label: '5 小时', usedPercent: 20, resetsAt: null }]);
        assert.equal(entry.plan, 'Pro');
      } finally {
        await fixture.close();
      }
    });

    it('a malformed provider id is a clean 400 at the real server, even with a stub usage missing listProviderIds', async () => {
      const incomplete = { report: async ({ refresh, provider }) => ({ generatedAt: new Date().toISOString(), refresh, provider, providers: [] }) };
      const fixture = await startFixture({ usage: incomplete });
      try {
        const traversal = await fixture.api(`/api/usage?provider=${encodeURIComponent('../../etc/passwd')}`);
        assert.equal(traversal.status, 400);
        const long = await fixture.api(`/api/usage?provider=${'x'.repeat(40)}`);
        assert.equal(long.status, 400);
        const plain = await fixture.api('/api/usage');
        assert.equal(plain.status, 200, 'a request with no provider= never needs listProviderIds at all');
      } finally {
        await fixture.close();
      }
    });
  });
});
