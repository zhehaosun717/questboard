// Per-provider cache behavior: one read dedupes to one call, cooldown swallows repeated refreshes, a failure
// after a success keeps the real numbers visibly stale, slow providers cannot hold up the report, and late
// completions land in the right state without ever duplicating a hung call. All fakes: fake clock, fake
// providers, temporary home — no real account state is read.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpDir } from '../helpers.js';
import { createUsageService } from '../../src/usage/service.js';
import { UsageError } from '../../src/usage/common.js';

const SECRET = 'sk-cache-secret-0123456789abcdef0123456789abcdef';

function fakeClock(start = 0) {
  const clock = { t: start, now: () => clock.t, set(ms) { clock.t = ms; } };
  return clock;
}

function spyProvider(id, impl) {
  const calls = [];
  return {
    calls,
    provider: { id, name: `P ${id}`, source: 'api', fetch: (options) => { calls.push(options); return impl(calls.length, options); } },
  };
}

const home = () => tmpDir('qb-usage-cache-home-');

describe('usage per-provider cache', () => {
  it('concurrent reports share one read per provider', async () => {
    const clock = fakeClock(0);
    const spy = spyProvider('x', () => new Promise((resolve) => { setTimeout(() => resolve({ plan: 'p' }), 5); }));
    const usage = createUsageService({ homedir: home(), env: {}, providers: [spy.provider], now: clock.now, timeoutMs: 2000 });
    const [a, b] = await Promise.all([usage.report({ refresh: true }), usage.report({ refresh: true })]);
    assert.equal(spy.calls.length, 1);
    assert.equal(a.providers[0].plan, 'p');
    assert.equal(b.providers[0].plan, 'p');
    assert.equal(a.providers[0].state, 'fresh');
    assert.ok(a.generatedAt && a.providers[0].lastSuccessAt);
  });

  it('repeated manual refresh during cooldown makes no external call', async () => {
    const clock = fakeClock(0);
    const spy = spyProvider('x', async () => ({ plan: 'p' }));
    const usage = createUsageService({ homedir: home(), env: {}, providers: [spy.provider], now: clock.now, cooldownMs: 5000, timeoutMs: 2000 });
    await usage.report();
    assert.equal(spy.calls.length, 1);
    clock.set(100);
    await usage.report({ refresh: true });
    assert.equal(spy.calls.length, 2);
    const cooling = (await usage.report({ refresh: true })).providers[0];
    assert.equal(spy.calls.length, 2);
    assert.equal(cooling.cooling, true);
    assert.equal(cooling.state, 'fresh');
    clock.set(6100);
    await usage.report({ refresh: true });
    assert.equal(spy.calls.length, 3);
  });

  it('a failure after a success keeps the real numbers visibly stale', async () => {
    const clock = fakeClock(0);
    const spy = spyProvider('x', async (n) => {
      if (n === 1) return { windows: [{ label: '5 小时', usedPercent: 30, resetsAt: null }], balances: [{ currency: 'CNY', amount: 2 }], plan: 'Pro', note: 'ok', asOf: '2026-09-13T09:00:00.000Z' };
      if (n === 2) throw new Error(`socket hang up carrying ${SECRET} body`);
      throw new UsageError('unreachable', { host: 'api.test' });
    });
    const usage = createUsageService({ homedir: home(), env: {}, providers: [spy.provider], now: clock.now, timeoutMs: 2000 });
    const first = (await usage.report()).providers[0];
    assert.equal(first.state, 'fresh');
    assert.equal(first.ok, true);
    clock.set(61000);
    const second = (await usage.report()).providers[0];
    assert.equal(second.state, 'stale');
    assert.equal(second.ok, false, 'a stale success is never shown as fresh');
    assert.equal(second.stale, true);
    assert.deepEqual(second.windows, [{ label: '5 小时', usedPercent: 30, resetsAt: null }]);
    assert.deepEqual(second.balances, [{ currency: 'CNY', amount: 2 }]);
    assert.equal(second.asOf, '2026-09-13T09:00:00.000Z');
    assert.equal(second.lastSuccessAt, new Date(0).toISOString());
    assert.equal(second.attemptedAt, new Date(61000).toISOString());
    assert.equal(second.error, '读取失败（Error）', 'only the error name leaks, never the raw message');
    const text = JSON.stringify({ generatedAt: second.generatedAt, providers: [second] });
    assert.ok(!text.includes(SECRET) && !text.includes('socket hang up'));
    clock.set(130000);
    const third = (await usage.report()).providers[0];
    assert.equal(third.state, 'stale');
    assert.equal(third.error, '连不上 api.test', 'a UsageError built from a known code with validated params may show');
    assert.deepEqual(third.balances, [{ currency: 'CNY', amount: 2 }], 'numbers survive through repeated failures');
  });

  it('an unconfigured provider is named, not fetched', async () => {
    const spy = spyProvider('keyed', async () => ({ plan: 'never' }));
    spy.provider.keys = { envNames: ['QB_TEST_MISSING_KEY'], openCodeIds: [] };
    const usage = createUsageService({ homedir: home(), env: {}, providers: [spy.provider], now: fakeClock(0).now, timeoutMs: 2000 });
    const entry = (await usage.report()).providers[0];
    assert.equal(spy.calls.length, 0);
    assert.equal(entry.configured, false);
    assert.equal(entry.state, 'unconfigured');
    assert.match(entry.error, /QB_TEST_MISSING_KEY/);
    assert.ok(!JSON.stringify(entry).includes('sk-'));
  });

  it('an unavailable provider says so in words instead of numbers', async () => {
    const offline = { id: 'off', name: 'Off', source: 'api', unavailable: '这个来源 2026-08-14 下线了，新接口还没公布' };
    const usage = createUsageService({ homedir: home(), env: {}, providers: [offline], timeoutMs: 2000 });
    const entry = (await usage.report()).providers[0];
    assert.equal(entry.configured, false);
    assert.equal(entry.state, 'unavailable');
    assert.equal(entry.error, offline.unavailable);
    assert.deepEqual(entry.windows, []);
    assert.deepEqual(entry.balances, []);
  });

  it('a hung provider cannot hold up the report, and is never spawned twice', async () => {
    const clock = fakeClock(0);
    let releaseHang;
    let hangCalls = 0;
    const hung = { id: 'hung', name: 'Hung', source: 'api', fetch: () => { hangCalls += 1; return new Promise((resolve) => { releaseHang = resolve; }); } };
    const quick = spyProvider('quick', async () => ({ plan: 'fast' }));
    const created = new Set();
    const cleared = new Set();
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => { const id = realSet(fn, ms, ...args); created.add(id); return id; };
    globalThis.clearTimeout = (id) => { cleared.add(id); return realClear(id); };
    try {
      const usage = createUsageService({ homedir: home(), env: {}, providers: [hung, quick.provider], now: clock.now, timeoutMs: 60, cooldownMs: 30, cacheMs: 100000 });
      const started = Date.now();
      const report = await usage.report();
      const byId = Object.fromEntries(report.providers.map((e) => [e.id, e]));
      assert.ok(Date.now() - started < 5000, 'the bounded wait returned instead of waiting forever');
      assert.equal(byId.quick.state, 'fresh');
      assert.equal(byId.hung.state, 'pending', 'no data yet, no invented zero');
      assert.equal(byId.hung.ok, false);
      assert.equal(byId.hung.refreshing, true);
      assert.match(byId.hung.error, /等待超过/);
      await usage.report();
      assert.equal(hangCalls, 1, 'the second wait joined the still-running read');
      assert.equal(quick.calls.length, 1);
      releaseHang({ plan: 'late' });
      const after = (await usage.report()).providers.find((e) => e.id === 'hung');
      assert.equal(hangCalls, 1);
      assert.equal(after.state, 'fresh');
      assert.equal(after.plan, 'late', 'the late completion landed in the state it still owns');
      assert.notEqual(after.lastSuccessAt, null);
    } finally {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
      for (const id of created) if (!cleared.has(id)) realClear(id);
      assert.equal([...created].every((id) => cleared.has(id)), true, 'every timer the service started was cleared');
    }
  });

  it('a true zero reads differently from a failure', async () => {
    const clock = fakeClock(0);
    const zero = spyProvider('zero', async () => ({ windows: [{ label: '5 小时', usedPercent: 0, resetsAt: null }] }));
    const broken = spyProvider('broken', async () => { throw new UsageError('unreachable', { host: 'zero.test' }); });
    const usage = createUsageService({ homedir: home(), env: {}, providers: [zero.provider, broken.provider], now: clock.now, timeoutMs: 2000 });
    const [a, b] = (await usage.report()).providers;
    assert.equal(a.ok, true);
    assert.equal(a.state, 'fresh');
    assert.equal(a.windows[0].usedPercent, 0, 'an actual zero is a fresh success');
    assert.equal(b.ok, false);
    assert.equal(b.state, 'failed');
    assert.equal(b.windows.length, 0, 'a failure says nothing, it does not claim zero');
  });

  it('keeps configured order and the legacy entry fields', async () => {
    const usage = createUsageService({
      homedir: home(), env: {}, timeoutMs: 2000,
      providers: [spyProvider('a', async () => ({ plan: 'A' })).provider, spyProvider('b', async () => ({ plan: 'B' })).provider, spyProvider('c', async () => ({ plan: 'C' })).provider],
    });
    const report = await usage.report();
    assert.deepEqual(report.providers.map((e) => e.id), ['a', 'b', 'c']);
    for (const key of ['id', 'name', 'source', 'fetchedAt', 'ok', 'configured', 'windows', 'balances', 'plan', 'note', 'asOf']) {
      assert.ok(key in report.providers[0], `legacy field ${key}`);
    }
    assert.deepEqual(usage.listProviderIds(), ['a', 'b', 'c']);
  });

  it('a targeted refresh only reads that provider', async () => {
    const clock = fakeClock(0);
    const a = spyProvider('a', async () => ({ plan: 'A' }));
    const b = spyProvider('b', async () => ({ plan: 'B' }));
    const usage = createUsageService({ homedir: home(), env: {}, providers: [a.provider, b.provider], now: clock.now, cooldownMs: 5000, timeoutMs: 2000 });
    await usage.report();
    clock.set(200);
    await usage.report({ refresh: true, provider: 'a' });
    assert.equal(a.calls.length, 2);
    assert.equal(b.calls.length, 1, 'the non-targeted provider stayed on its cache');
    await assert.rejects(usage.report({ refresh: true, provider: 'ghost' }), /未知/);
  });

  it('validates its intervals and provider list instead of inventing defaults', () => {
    assert.throws(() => createUsageService({ cacheMs: -5 }), /cacheMs/);
    assert.throws(() => createUsageService({ timeoutMs: 5 }), /timeoutMs/);
    assert.throws(() => createUsageService({ cooldownMs: Number.NaN }), /cooldownMs/);
    assert.throws(() => createUsageService({ providers: [{ id: 'd' }, { id: 'd' }] }), /重复/);
  });

  it('rejects a provider id the route could never reach through ?provider=', () => {
    assert.throws(() => createUsageService({ providers: [{ id: 'Spy', name: 'Spy', source: 'api' }] }), /provider id/);
    assert.throws(() => createUsageService({ providers: [{ id: 'a.b', name: 'AB', source: 'api' }] }), /provider id/);
    assert.throws(() => createUsageService({ providers: [{ id: '', name: 'Empty', source: 'api' }] }));
  });

  it('an arbitrary error.name never reaches the page: only a fixed allowlist of names is echoed', async () => {
    const clock = fakeClock(0);
    const spy = spyProvider('x', async () => { const e = new Error('irrelevant'); e.name = `sk-SENTINEL-${SECRET}`; throw e; });
    const usage = createUsageService({ homedir: home(), env: {}, providers: [spy.provider], now: clock.now, timeoutMs: 2000 });
    const entry = (await usage.report()).providers[0];
    assert.equal(entry.error, '读取失败（Error）', 'an unrecognised name falls back to the generic label');
    assert.ok(!JSON.stringify(entry).includes(SECRET));
  });

  it('a thrown plain object with a crafted name is treated the same as any other unknown error', async () => {
    const clock = fakeClock(0);
    const spy = spyProvider('x', async () => { throw { name: `sk-SENTINEL-${SECRET}`, message: `body sk-SENTINEL-${SECRET}` }; });
    const usage = createUsageService({ homedir: home(), env: {}, providers: [spy.provider], now: clock.now, timeoutMs: 2000 });
    const entry = (await usage.report()).providers[0];
    assert.equal(entry.error, '读取失败（Error）');
    assert.ok(!JSON.stringify(entry).includes(SECRET));
  });

  it('a throwing name getter never rejects report(); inflight clears and the next attempt actually recovers', async () => {
    const clock = fakeClock(0);
    let calls = 0;
    const provider = {
      id: 'x', name: 'X', source: 'api',
      fetch: async () => {
        calls += 1;
        if (calls === 1) {
          const evil = {};
          Object.defineProperty(evil, 'name', { get() { throw new Error(`getter leak ${SECRET}`); } });
          throw evil;
        }
        return { plan: 'recovered' };
      },
    };
    const usage = createUsageService({ homedir: home(), env: {}, providers: [provider], now: clock.now, timeoutMs: 2000, cooldownMs: 0 });
    const first = (await usage.report()).providers[0];
    assert.equal(first.ok, false);
    assert.equal(first.error, '读取失败（Error）');
    assert.ok(!JSON.stringify(first).includes(SECRET));
    assert.equal(first.refreshing, false, 'the getter throw settled the attempt; inflight did not stick');
    clock.set(61000);
    const second = (await usage.report()).providers[0];
    assert.equal(calls, 2, 'a genuinely new attempt was made once the first had actually settled');
    assert.equal(second.ok, true);
    assert.equal(second.plan, 'recovered', 'the slot recovered instead of staying stuck on the first failure');
  });

  it('an ok:false result with a throwing or oversized error field never leaks it, and stays a safe fallback', async () => {
    const clock = fakeClock(0);
    const throwingGetter = {
      id: 'a', name: 'A', source: 'api',
      fetch: async () => {
        const result = { ok: false, configured: true };
        Object.defineProperty(result, 'error', { get() { throw new Error(`nested getter ${SECRET}`); } });
        return result;
      },
    };
    const oversized = { id: 'b', name: 'B', source: 'api', fetch: async () => ({ ok: false, configured: true, error: `${SECRET} `.repeat(20) }) };
    const usage = createUsageService({ homedir: home(), env: {}, providers: [throwingGetter, oversized], now: clock.now, timeoutMs: 2000 });
    const [a, b] = (await usage.report()).providers;
    assert.equal(a.ok, false);
    assert.match(a.error, /没有给出可显示的失败原因/);
    assert.equal(b.ok, false);
    assert.match(b.error, /没有给出可显示的失败原因/);
    assert.ok(!JSON.stringify({ a, b }).includes(SECRET));
  });

  it('a short, plain-ASCII result.error is never shown, even though it looks safe by appearance alone', async () => {
    const clock = fakeClock(0);
    const configuredTrue = { id: 'a', name: 'A', source: 'api', fetch: async () => ({ ok: false, configured: true, error: SECRET }) };
    const configuredFalse = { id: 'b', name: 'B', source: 'api', fetch: async () => ({ ok: false, configured: false, error: `HTTP 401 ${SECRET}` }) };
    const usage = createUsageService({ homedir: home(), env: {}, providers: [configuredTrue, configuredFalse], now: clock.now, timeoutMs: 2000 });
    const [a, b] = (await usage.report()).providers;
    assert.equal(a.state, 'failed');
    assert.match(a.error, /没有给出可显示的失败原因/);
    assert.equal(b.state, 'unconfigured');
    assert.match(b.error, /没有给出可显示的失败原因/);
    assert.ok(!JSON.stringify({ a, b }).includes(SECRET), 'result.error is never read for display, no matter how plausible it looks');
  });

  it('a provider result code renders its fixed Chinese text; an unrecognised code falls back', async () => {
    const clock = fakeClock(0);
    const known = { id: 'a', name: 'Codex-ish', source: 'api', fetch: async () => ({ ok: false, configured: false, code: 'no_sessions_dir' }) };
    const unknown = { id: 'b', name: 'B', source: 'api', fetch: async () => ({ ok: false, configured: true, code: 'not_a_real_code' }) };
    const usage = createUsageService({ homedir: home(), env: {}, providers: [known, unknown], now: clock.now, timeoutMs: 2000 });
    const [a, b] = (await usage.report()).providers;
    assert.equal(a.error, '没有找到 Codex 会话记录（~/.codex/sessions）');
    assert.match(b.error, /没有给出可显示的失败原因/);
  });

  it('a genuinely constructed UsageError with a known code and validated params renders; a forged prototype never does', async () => {
    const clock = fakeClock(0);
    const real = { id: 'real', name: 'Real', source: 'api', fetch: async () => { throw new UsageError('http_status', { host: 'api.example.com', status: 401 }); } };
    const forged = {
      id: 'forged', name: 'Forged', source: 'api',
      fetch: async () => { throw Object.create(UsageError.prototype, { message: { value: SECRET } }); },
    };
    const forgedWithCode = {
      // Even an object that fakes owning `code`/`params` can only ever render the bounded, validated text
      // for that code — never smuggle a different string through, since params are re-validated on read.
      id: 'forgedcode', name: 'ForgedCode', source: 'api',
      fetch: async () => { throw Object.create(UsageError.prototype, { code: { value: 'unreachable' }, params: { value: { host: SECRET } } }); },
    };
    const usage = createUsageService({ homedir: home(), env: {}, providers: [real, forged, forgedWithCode], now: clock.now, timeoutMs: 2000 });
    const [r, f, fc] = (await usage.report()).providers;
    assert.equal(r.error, 'api.example.com 返回 HTTP 401（key 无效或没有权限）', 'a real UsageError with a known code and valid params is trusted');
    assert.equal(f.error, '读取失败（Error）', 'a forged prototype with only a message has no code/params, so it falls back');
    assert.match(fc.error, /读取失败|返回 HTTP|超时|连不上/, 'a forged code+params object never crashes the render path');
    assert.ok(!JSON.stringify({ r, f, fc }).includes(SECRET), 'the forged host has no dot, so it cannot pass the hostname-shaped validator even though it is short and plain-ASCII');
  });

  it('A4: a result code named after an Object.prototype member never resolves to inherited junk', async () => {
    const clock = fakeClock(0);
    const names = ['constructor', 'valueOf', 'toString', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString'];
    const providers = names.map((code) => ({ id: `p-${code.toLowerCase()}`, name: code, source: 'api', fetch: async () => ({ ok: false, configured: true, code }) }));
    const usage = createUsageService({ homedir: home(), env: {}, providers, now: clock.now, timeoutMs: 2000 });
    const entries = (await usage.report()).providers;
    for (const entry of entries) {
      assert.equal(typeof entry.error, 'string', `${entry.name}'s error must be a real string, never {} or false`);
      assert.match(entry.error, /没有给出可显示的失败原因/, `${entry.name} must fall back to the generic label, not resolve to something inherited`);
    }
  });

  it('A4: UsageError built with an Object.prototype member as its code never renders or keeps that code', async () => {
    const clock = fakeClock(0);
    const names = ['constructor', 'valueOf', 'toString', 'hasOwnProperty', 'isPrototypeOf'];
    const providers = names.map((code) => ({ id: `u-${code.toLowerCase()}`, name: code, source: 'api', fetch: async () => { throw new UsageError(code, { host: 'api.example.com' }); } }));
    const usage = createUsageService({ homedir: home(), env: {}, providers, now: clock.now, timeoutMs: 2000 });
    const entries = (await usage.report()).providers;
    for (const entry of entries) {
      assert.equal(typeof entry.error, 'string');
      assert.match(entry.error, /读取失败（Error）/, `${entry.name} must never be treated as a recognised code`);
    }
  });

  it('A6: an out-of-range HTTP status never renders; a real one still does', async () => {
    const clock = fakeClock(0);
    const tooBig = { id: 'a', name: 'A', source: 'api', fetch: async () => { throw new UsageError('http_status', { host: 'api.example.com', status: 1e21 }); } };
    const negative = { id: 'b', name: 'B', source: 'api', fetch: async () => { throw new UsageError('http_status', { host: 'api.example.com', status: -7 }); } };
    const real = { id: 'c', name: 'C', source: 'api', fetch: async () => { throw new UsageError('http_status', { host: 'api.example.com', status: 404 }); } };
    const usage = createUsageService({ homedir: home(), env: {}, providers: [tooBig, negative, real], now: clock.now, timeoutMs: 2000 });
    const [a, b, c] = (await usage.report()).providers;
    assert.equal(a.error, '读取失败（Error）', 'a status outside 100..599 is not a real HTTP status, so the whole code is unrenderable');
    assert.equal(b.error, '读取失败（Error）');
    assert.equal(c.error, 'api.example.com 返回 HTTP 404');
  });

  it('F6: a well-formed empty result is a fresh success, but null, undefined, a non-object, or a throwing ok getter is not', async () => {
    const clock = fakeClock(0);
    const legitEmpty = { id: 'empty', name: 'Empty', source: 'api', fetch: async () => ({ windows: [], note: '这个账户没有按模型的额度信息' }) };
    const nullResult = { id: 'n', name: 'N', source: 'api', fetch: async () => null };
    const undefinedResult = { id: 'u', name: 'U', source: 'api', fetch: async () => undefined };
    const arrayResult = { id: 'arr', name: 'Arr', source: 'api', fetch: async () => ([{ plan: 'x' }]) };
    const stringResult = { id: 'str', name: 'Str', source: 'api', fetch: async () => 'ok' };
    const throwingOk = {
      id: 'gk', name: 'GK', source: 'api',
      fetch: async () => { const r = { plan: 'x' }; Object.defineProperty(r, 'ok', { get() { throw new Error('boom'); } }); return r; },
    };
    const garbageOk = { id: 'go', name: 'GO', source: 'api', fetch: async () => ({ ok: 'yes', plan: 'x' }) };
    const usage = createUsageService({
      homedir: home(), env: {}, now: clock.now, timeoutMs: 2000,
      providers: [legitEmpty, nullResult, undefinedResult, arrayResult, stringResult, throwingOk, garbageOk],
    });
    const [empty1, n, u, arr, str, gk, go] = (await usage.report()).providers;
    assert.equal(empty1.ok, true, 'an object with recognised shape and absent ok is a real success');
    assert.equal(empty1.state, 'fresh');
    assert.deepEqual(empty1.windows, []);
    for (const entry of [n, u, arr, str, gk, go]) {
      assert.equal(entry.ok, false, `${entry.id} must never be a fabricated fresh success`);
      assert.equal(entry.state, 'failed');
      assert.deepEqual(entry.windows, [], `${entry.id} reports no numbers, not an invented zero`);
    }
  });

  it('F6b: an empty or unrecognised-shape object is never a fabricated fresh success, and never wipes a real previous success', async () => {
    const clock = fakeClock(0);
    const bareEmpty = { id: 'bare', name: 'Bare', source: 'api', fetch: async () => ({}) };
    const okTrueOnly = { id: 'oktrue', name: 'OkTrue', source: 'api', fetch: async () => ({ ok: true }) };
    const irrelevant = { id: 'irrelevant', name: 'Irrelevant', source: 'api', fetch: async () => ({ foo: 'bar', count: 3 }) };
    const wrongTypes = { id: 'wrong', name: 'Wrong', source: 'api', fetch: async () => ({ windows: 'nope', balances: 42, plan: 99, note: true }) };
    const allInvalidEntries = { id: 'wiped', name: 'Wiped', source: 'api', fetch: async () => ({ windows: [{ label: 123 }, { nope: true }, 'x', null] }) };
    const inheritedOkFalse = { id: 'inherited', name: 'Inherited', source: 'api', fetch: async () => Object.create({ ok: false }) };
    const nullPrototype = { id: 'nullproto', name: 'NullProto', source: 'api', fetch: async () => Object.create(null) };
    const usage = createUsageService({
      homedir: home(), env: {}, now: clock.now, timeoutMs: 2000,
      providers: [bareEmpty, okTrueOnly, irrelevant, wrongTypes, allInvalidEntries, inheritedOkFalse, nullPrototype],
    });
    const entries = (await usage.report()).providers;
    for (const entry of entries) {
      assert.equal(entry.ok, false, `${entry.id} must never be a fabricated fresh success`);
      assert.equal(entry.state, 'failed', `${entry.id} must fail rather than show an empty "fresh" result`);
      assert.deepEqual(entry.windows, []);
      assert.match(entry.error, /没有给出可显示的失败原因/);
    }
  });

  it('F6c: a genuinely valid empty result (explicit empty array, or a non-empty note/plan alone) is still a fresh success', async () => {
    const clock = fakeClock(0);
    const explicitEmptyArray = { id: 'ee', name: 'EE', source: 'api', fetch: async () => ({ windows: [] }) };
    const planOnly = { id: 'po', name: 'PO', source: 'api', fetch: async () => ({ plan: 'Lite · 已订阅' }) };
    const usage = createUsageService({ homedir: home(), env: {}, now: clock.now, timeoutMs: 2000, providers: [explicitEmptyArray, planOnly] });
    const [ee, po] = (await usage.report()).providers;
    assert.equal(ee.ok, true, 'an explicit, from-the-start empty array is a legitimate "nothing to show", not corrupted data');
    assert.equal(ee.state, 'fresh');
    assert.equal(po.ok, true);
    assert.equal(po.plan, 'Lite · 已订阅');
  });

  it('B3/B4: a real previous success survives an unrecognised-shape or wiped-entries read, marked stale, and a later valid read recovers it', async () => {
    const clock = fakeClock(0);
    let call = 0;
    const provider = {
      id: 'x', name: 'X', source: 'api',
      fetch: async () => {
        call += 1;
        if (call === 1) return { windows: [{ label: '5 小时', usedPercent: 40, resetsAt: null }], balances: [{ currency: 'CNY', amount: 9 }] };
        if (call === 2) return {};
        if (call === 3) return { windows: [{ nope: true }, { also: 1 }] };
        return { windows: [{ label: '5 小时', usedPercent: 10, resetsAt: null }] };
      },
    };
    const usage = createUsageService({ homedir: home(), env: {}, providers: [provider], now: clock.now, cacheMs: 1000, cooldownMs: 0, timeoutMs: 2000 });
    const first = (await usage.report()).providers[0];
    assert.equal(first.state, 'fresh');
    clock.set(2000);
    const second = (await usage.report({ refresh: true })).providers[0];
    assert.equal(second.state, 'stale', 'an empty {} read never wipes CNY 9');
    assert.deepEqual(second.balances, [{ currency: 'CNY', amount: 9 }]);
    clock.set(4000);
    const third = (await usage.report({ refresh: true })).providers[0];
    assert.equal(third.state, 'stale', 'entries that all fail validation never wipe the previous good numbers either');
    assert.deepEqual(third.balances, [{ currency: 'CNY', amount: 9 }]);
    clock.set(6000);
    const fourth = (await usage.report({ refresh: true })).providers[0];
    assert.equal(fourth.state, 'fresh', 'a genuinely valid read recovers');
    assert.deepEqual(fourth.windows, [{ label: '5 小时', usedPercent: 10, resetsAt: null }]);
  });

  it('usage percent is never negative, but a legitimate over-100 burst is preserved as-is', async () => {
    const clock = fakeClock(0);
    const negative = { id: 'neg', name: 'Neg', source: 'api', fetch: async () => ({ windows: [{ label: 'w', usedPercent: -50, resetsAt: null }] }) };
    const over = { id: 'over', name: 'Over', source: 'api', fetch: async () => ({ windows: [{ label: 'w', usedPercent: 150, resetsAt: null }] }) };
    const usage = createUsageService({ homedir: home(), env: {}, now: clock.now, timeoutMs: 2000, providers: [negative, over] });
    const [neg, over1] = (await usage.report()).providers;
    assert.equal(neg.ok, true, 'the window itself is still real data even though its percent is unknown');
    assert.equal(neg.windows[0].usedPercent, null, 'a negative percent is unknown, never a fabricated number');
    assert.equal(over1.windows[0].usedPercent, 150, 'over 100% is a real value the bar clamps for display, not something this layer rejects');
  });

  it('an unparsable asOf becomes unknown rather than being coerced through new Date()', async () => {
    const clock = fakeClock(0);
    const provider = { id: 'x', name: 'X', source: 'api', fetch: async () => ({ plan: 'p', asOf: 'not a real date' }) };
    const usage = createUsageService({ homedir: home(), env: {}, now: clock.now, timeoutMs: 2000, providers: [provider] });
    const entry = (await usage.report()).providers[0];
    assert.equal(entry.ok, true);
    assert.equal(entry.asOf, null);
  });

  it('a result far outside any real adapter shape fails transparently instead of being silently truncated into success', async () => {
    const clock = fakeClock(0);
    const hugeList = { id: 'hl', name: 'HL', source: 'api', fetch: async () => ({ windows: Array.from({ length: 5000 }, (_, i) => ({ label: `w${i}`, usedPercent: 1, resetsAt: null })) }) };
    const hugeText = { id: 'ht', name: 'HT', source: 'api', fetch: async () => ({ plan: 'p', note: 'x'.repeat(100000) }) };
    const usage = createUsageService({ homedir: home(), env: {}, now: clock.now, timeoutMs: 2000, providers: [hugeList, hugeText] });
    const [hl, ht] = (await usage.report()).providers;
    for (const entry of [hl, ht]) {
      assert.equal(entry.ok, false, `${entry.id} must fail rather than silently truncate an absurd payload into success`);
      assert.equal(entry.state, 'failed');
      assert.match(entry.error, /超出了正常范围/);
    }
  });
});
