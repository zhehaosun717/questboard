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
  it('a backward system-clock jump does not freeze the cooldown until the wall clock catches back up', async () => {
    const clock = fakeClock(10000);
    const spy = spyProvider('x', async () => ({ plan: 'p' }));
    const usage = createUsageService({ homedir: home(), env: {}, providers: [spy.provider], now: clock.now, cooldownMs: 5000, cacheMs: 1000, timeoutMs: 2000 });
    await usage.report({ refresh: true });
    assert.equal(spy.calls.length, 1);
    // The wall clock rolls back an hour, well before the cooldown a normal forward clock would ever wait out.
    clock.set(10000 - 3600000);
    const rolledBack = (await usage.report({ refresh: true })).providers[0];
    assert.equal(spy.calls.length, 2, 'the cooldown does not freeze for an hour just because the clock moved backward');
    assert.equal(rolledBack.cooling, false);
  });

  it('P5: poisoned nested fields (getters, toJSON, non-plain items) are dropped before caching, never crash the response, and never poison later reads', async () => {
    const clock = fakeClock(0);
    const poisoned = {
      id: 'x', name: 'X', source: 'api',
      fetch: async () => ({
        windows: [
          Object.defineProperty({ usedPercent: 10 }, 'label', { enumerable: true, get() { throw new Error(`nested getter ${SECRET}`); } }),
          { label: '5 小时', usedPercent: 10, resetsAt: null },
          'not an object',
          null,
        ],
        balances: [
          Object.defineProperty({ amount: 1 }, 'currency', { enumerable: true, get() { throw new Error(`nested getter ${SECRET}`); } }),
          { currency: 'CNY', amount: 1, toJSON() { return SECRET; } },
          { currency: 'USD' },
        ],
        plan: { toJSON() { throw new Error(`plan toJSON ${SECRET}`); } },
        note: { toJSON() { throw new Error(`note toJSON ${SECRET}`); } },
        asOf: { toJSON() { return SECRET; } },
      }),
    };
    const usage = createUsageService({ homedir: home(), env: {}, providers: [poisoned], now: clock.now, timeoutMs: 2000 });
    const first = (await usage.report()).providers[0];
    assert.equal(first.ok, true, 'sanitizing the payload is not the same as failing the read');
    assert.deepEqual(first.windows, [{ label: '5 小时', usedPercent: 10, resetsAt: null }], 'the poisoned and malformed window items are dropped, the clean one survives');
    assert.deepEqual(first.balances, [{ currency: 'CNY', amount: 1 }], 'the getter-poisoned item is dropped; a valid item with a spurious toJSON is copied by field, so its toJSON never survives into the rebuilt object; the item missing amount is dropped');
    assert.equal(first.plan, '', 'a non-string plan (even one with a throwing toJSON) is dropped rather than rendered');
    assert.equal(first.note, '', 'a non-string note is dropped, never serialized as-is');
    assert.equal(first.asOf, null);
    const text = JSON.stringify(first);
    assert.ok(!text.includes(SECRET), 'nothing the provider returned reaches JSON.stringify unsanitized');
    // The cache now holds the sanitized copy, not the poisoned objects: a second read must be just as safe.
    clock.set(1);
    const second = (await usage.report()).providers[0];
    assert.equal(second.ok, true);
    assert.ok(!JSON.stringify(second).includes(SECRET));
  });

  it('defaults the read deadline to 20 seconds, not 30', async () => {
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const delays = [];
    globalThis.setTimeout = (fn, ms, ...args) => { delays.push(ms); return realSet(fn, ms, ...args); };
    globalThis.clearTimeout = (id) => realClear(id);
    let release;
    // A fake, frozen clock: begin() and waitWithin() must read the identical timestamp, or a real clock
    // ticking a millisecond between the two calls flakes the exact 20000 to 19999.
    const clock = fakeClock(0);
    const hung = { id: 'x', name: 'X', source: 'api', fetch: () => new Promise((resolve) => { release = resolve; }) };
    try {
      const usage = createUsageService({ homedir: home(), env: {}, providers: [hung], now: clock.now });
      const pending = usage.report();
      assert.equal(delays[0], 20000, 'the deadline actually used by waitWithin is 20 seconds');
      release({ plan: 'done' });
      await pending;
    } finally {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    }
  });

  it('a targeted refresh does not read or wait on an expired, untargeted provider', async () => {
    const clock = fakeClock(0);
    const a = spyProvider('a', async () => ({ plan: 'A' }));
    const b = spyProvider('b', async () => ({ plan: 'B' }));
    const usage = createUsageService({ homedir: home(), env: {}, providers: [a.provider, b.provider], now: clock.now, cooldownMs: 0, cacheMs: 1000, timeoutMs: 2000 });
    await usage.report();
    assert.equal(a.calls.length, 1);
    assert.equal(b.calls.length, 1);
    clock.set(2000);
    const started = Date.now();
    const result = await usage.report({ refresh: true, provider: 'a' });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 500, `should not wait on the untargeted, expired provider (${elapsed}ms)`);
    assert.equal(a.calls.length, 2, 'the targeted provider read again');
    assert.equal(b.calls.length, 1, 'the expired but untargeted provider was not read');
    const bEntry = result.providers.find((e) => e.id === 'b');
    assert.equal(bEntry.stale, true, 'the untargeted provider still shows its true, expired state');
  });

  it('a targeted refresh does not wait on a hung, untargeted provider', async () => {
    const clock = fakeClock(0);
    const a = spyProvider('a', async () => ({ plan: 'A' }));
    let releaseB;
    let bCalls = 0;
    const b = { id: 'b', name: 'B', source: 'api', fetch: () => { bCalls += 1; return new Promise((resolve) => { releaseB = resolve; }); } };
    const usage = createUsageService({ homedir: home(), env: {}, providers: [a.provider, b], now: clock.now, cooldownMs: 0, timeoutMs: 3000 });
    const firstPromise = usage.report();
    assert.equal(bCalls, 1, 'b started reading on the untargeted, cold first call');
    const started = Date.now();
    await usage.report({ refresh: true, provider: 'a' });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 500, `targeted refresh should not wait on the hung provider (${elapsed}ms)`);
    assert.equal(bCalls, 1, 'the hung, untargeted provider was never read again nor joined');
    releaseB({ plan: 'late' });
    await firstPromise;
  });

  it('a targeted refresh shows a never-read, untargeted provider as truthfully pending, with no call', async () => {
    const clock = fakeClock(0);
    const a = spyProvider('a', async () => ({ plan: 'A' }));
    const b = spyProvider('b', async () => ({ plan: 'B' }));
    const usage = createUsageService({ homedir: home(), env: {}, providers: [a.provider, b.provider], now: clock.now, cooldownMs: 0, timeoutMs: 2000 });
    const result = await usage.report({ refresh: true, provider: 'a' });
    assert.equal(a.calls.length, 1);
    assert.equal(b.calls.length, 0, 'the never-read, untargeted provider was not read');
    const bEntry = result.providers.find((e) => e.id === 'b');
    assert.equal(bEntry.state, 'pending');
    assert.equal(bEntry.configured, null, 'unknown, not a false "not configured"');
    assert.equal(bEntry.refreshing, false);
    assert.match(bEntry.error, /还没有读取过/);
  });

  it('cooldown blocks a plain GET right after a manual refresh started, not only another manual refresh', async () => {
    const clock = fakeClock(0);
    const spy = spyProvider('x', async () => ({ plan: 'p' }));
    const usage = createUsageService({ homedir: home(), env: {}, providers: [spy.provider], now: clock.now, cooldownMs: 5000, cacheMs: 1000, timeoutMs: 2000 });
    await usage.report({ refresh: true });
    assert.equal(spy.calls.length, 1);
    clock.set(1050);
    const plain = (await usage.report()).providers[0];
    assert.equal(spy.calls.length, 1, 'a plain GET must not bypass the cooldown a manual refresh just started');
    assert.equal(plain.cooling, true);
    clock.set(5100);
    await usage.report();
    assert.equal(spy.calls.length, 2, 'once the cooldown elapses, the plain GET reads again');
  });

  it('B1n: a non-ordinary prototype is never trusted, however real the inherited field looks', async () => {
    const clock = fakeClock(0);
    const inheritedWindows = { id: 'proto', name: 'Proto', source: 'api', fetch: async () => Object.create({ windows: [{ label: 'w', usedPercent: 10, resetsAt: null }] }) };
    class ProviderResult { constructor() { this.windows = [{ label: 'w', usedPercent: 10, resetsAt: null }]; } }
    const classInstance = { id: 'class', name: 'Class', source: 'api', fetch: async () => new ProviderResult() };
    const getterProto = {};
    Object.defineProperty(getterProto, 'windows', { enumerable: true, get() { return [{ label: 'w', usedPercent: 10, resetsAt: null }]; } });
    const protoGetter = { id: 'protogetter', name: 'ProtoGetter', source: 'api', fetch: async () => Object.create(getterProto) };
    const dateWithWindows = { id: 'date', name: 'Date', source: 'api', fetch: async () => { const d = new Date(); d.windows = [{ label: 'w', usedPercent: 10, resetsAt: null }]; return d; } };
    const usage = createUsageService({
      homedir: home(), env: {}, now: clock.now, timeoutMs: 2000,
      providers: [inheritedWindows, classInstance, protoGetter, dateWithWindows],
    });
    const entries = (await usage.report()).providers;
    for (const entry of entries) {
      assert.equal(entry.ok, false, `${entry.id}: a real-looking field inherited from a non-ordinary prototype must never be trusted`);
      assert.equal(entry.state, 'failed');
      assert.deepEqual(entry.windows, [], `${entry.id} must report no numbers, not the inherited ones`);
    }
  });

  it('B7: an own accessor is never invoked to see what it would return, even once', async () => {
    const clock = fakeClock(0);
    let calls = 0;
    const provider = { id: 'x', name: 'X', source: 'api', fetch: async () => {
      const result = {};
      Object.defineProperty(result, 'windows', { enumerable: true, get() { calls += 1; return [{ label: 'w', usedPercent: 10, resetsAt: null }]; } });
      return result;
    } };
    const usage = createUsageService({ homedir: home(), env: {}, now: clock.now, timeoutMs: 2000, providers: [provider] });
    const entry = (await usage.report()).providers[0];
    assert.equal(calls, 0, 'an own accessor on the result must never be invoked, not even to check what it holds');
    assert.equal(entry.ok, false);
    assert.equal(entry.state, 'failed');
  });

  it('B7: the list cap is enforced against what is actually iterated, not a separately-read, possibly-lying length', async () => {
    const clock = fakeClock(0);
    const real = Array.from({ length: 5000 }, (_, i) => ({ label: `w${i}`, usedPercent: 1, resetsAt: null }));
    // .length lies (0), but the iterator is trapped separately to yield every real item regardless — proving
    // the cap comes from counting what sanitizeList actually pulls out of the iterator, not from trusting
    // .length first and only sanitizing up to that (false, small) count.
    const lyingLength = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'length') return 0;
        if (prop === Symbol.iterator) return function* iterate() { yield* target; };
        return Reflect.get(target, prop, receiver);
      },
    });
    const provider = { id: 'x', name: 'X', source: 'api', fetch: async () => ({ windows: lyingLength }) };
    const usage = createUsageService({ homedir: home(), env: {}, now: clock.now, timeoutMs: 2000, providers: [provider] });
    const entry = (await usage.report()).providers[0];
    assert.equal(entry.ok, false, 'a list whose real entries exceed the cap must fail even when .length lies about being small');
    assert.equal(entry.state, 'failed');
    assert.match(entry.error, /超出了正常范围/);
  });

  it('B1/B2n: entries that are all invalid still fail even with a valid asOf or a non-empty note — neither counts as numeric data', async () => {
    const clock = fakeClock(0);
    const wipedWithAsOf = { id: 'wa', name: 'WA', source: 'api', fetch: async () => ({ windows: [{ label: 5 }], asOf: '2026-09-15T00:00:00Z' }) };
    const wipedWithNote = { id: 'wn', name: 'WN', source: 'api', fetch: async () => ({ windows: [{ label: 5 }], note: '说明文字' }) };
    const usage = createUsageService({ homedir: home(), env: {}, now: clock.now, timeoutMs: 2000, providers: [wipedWithAsOf, wipedWithNote] });
    const entries = (await usage.report()).providers;
    for (const entry of entries) {
      assert.equal(entry.ok, false, `${entry.id}: a wiped-out list must fail even when asOf/note is present, since neither is numeric data`);
      assert.equal(entry.state, 'failed');
      assert.deepEqual(entry.windows, []);
    }
  });

  it('B6b: an oversized label or currency drops the whole item rather than being silently truncated', async () => {
    const clock = fakeClock(0);
    const longLabel = { id: 'll', name: 'LL', source: 'api', fetch: async () => ({ windows: [{ label: 'x'.repeat(501), usedPercent: 1, resetsAt: null }, { label: 'ok', usedPercent: 2, resetsAt: null }] }) };
    const longCurrency = { id: 'lc', name: 'LC', source: 'api', fetch: async () => ({ balances: [{ currency: 'x'.repeat(501), amount: 1 }, { currency: 'CNY', amount: 2 }] }) };
    const usage = createUsageService({ homedir: home(), env: {}, now: clock.now, timeoutMs: 2000, providers: [longLabel, longCurrency] });
    const [ll, lc] = (await usage.report()).providers;
    assert.equal(ll.ok, true, 'the surviving valid window still makes this a real, if partial, success');
    assert.deepEqual(ll.windows, [{ label: 'ok', usedPercent: 2, resetsAt: null }], 'the oversized label drops only that item');
    assert.equal(lc.ok, true);
    assert.deepEqual(lc.balances, [{ currency: 'CNY', amount: 2 }], 'the oversized currency drops only that item');
  });

  it('strict calendar asOf: an out-of-range day (Feb 30) and a bare year-like string are both rejected, not silently rolled over', async () => {
    const clock = fakeClock(0);
    const feb30 = { id: 'feb30', name: 'Feb30', source: 'api', fetch: async () => ({ plan: 'p', asOf: '2026-02-30T00:00:00Z' }) };
    const bareYear = { id: 'bare', name: 'Bare', source: 'api', fetch: async () => ({ plan: 'p', asOf: '1' }) };
    const valid = { id: 'valid', name: 'Valid', source: 'api', fetch: async () => ({ plan: 'p', asOf: '2026-09-15T06:43:50.123Z' }) };
    const usage = createUsageService({ homedir: home(), env: {}, now: clock.now, timeoutMs: 2000, providers: [feb30, bareYear, valid] });
    const [f, b, v] = (await usage.report()).providers;
    assert.equal(f.asOf, null, 'Feb 30 does not exist; new Date() would silently roll it into March, so it is rejected instead');
    assert.equal(b.asOf, null, "a bare '1' is not a calendar date, even though Date.parse('1') would accept it as year 2001");
    assert.equal(v.asOf, '2026-09-15T06:43:50.123Z', 'a genuinely well-formed timestamp is kept as the provider wrote it');
  });

  it('C3b: a backward system-clock jump does not leave stale data reading as fresh until the wall clock catches back up', async () => {
    const clock = fakeClock(100000);
    const x = { id: 'x', name: 'X', source: 'api', fetch: async () => ({ plan: 'p' }) };
    const y = { id: 'y', name: 'Y', source: 'api', fetch: async () => ({ plan: 'q' }) };
    const usage = createUsageService({ homedir: home(), env: {}, providers: [x, y], now: clock.now, cacheMs: 60000, cooldownMs: 0, timeoutMs: 2000 });
    const first = (await usage.report()).providers.find((e) => e.id === 'x');
    assert.equal(first.state, 'fresh');
    // The clock jumps far back in time — without a clamp, freshUntil (set at 100000 + 60000) would keep
    // reading as fresh for the entire time it takes the wall clock to climb back past it. A targeted refresh
    // of the other provider leaves x purely display-only (no new attempt), so this reads the clamp itself,
    // not a fresh auto-refresh triggered by the jump.
    clock.set(-1000000);
    const afterJump = (await usage.report({ refresh: true, provider: 'y' })).providers.find((e) => e.id === 'x');
    assert.equal(afterJump.state, 'stale', 'a backward clock jump must not extend freshness far beyond cacheMs');
  });

  it('B01: an own accessor `windows` alongside a genuinely valid `note`: the getter is never invoked and the result is not a fabricated fresh (partial) success', async () => {
    const clock = fakeClock(0);
    let calls = 0;
    const provider = {
      id: 'x', name: 'X', source: 'api',
      fetch: async () => {
        const r = { note: 'manual' };
        Object.defineProperty(r, 'windows', { enumerable: true, get() { calls += 1; return [{ label: 'w', usedPercent: 10, resetsAt: null }, { label: 'w2', usedPercent: 20, resetsAt: null }]; } });
        return r;
      },
    };
    const usage = createUsageService({ homedir: home(), env: {}, providers: [provider], now: clock.now, timeoutMs: 2000 });
    const entry = (await usage.report()).providers[0];
    assert.equal(calls, 0, 'the windows getter must never be invoked, not even to decide the result is unreadable');
    assert.ok(!(entry.ok === true && entry.state === 'fresh'), 'an unreadable windows field must not let a valid note alone produce a fresh (partial) success');
  });

  it('B04: a getter planted on an array index is never invoked, and the whole list is rejected rather than trusted around it', async () => {
    const clock = fakeClock(0);
    let calls = 0;
    const arr = [{ label: 'w', usedPercent: 10, resetsAt: null }];
    Object.defineProperty(arr, 1, { enumerable: true, configurable: true, get() { calls += 1; return { label: 'from-getter', usedPercent: 99, resetsAt: null }; } });
    const provider = { id: 'x', name: 'X', source: 'api', fetch: async () => ({ windows: arr }) };
    const usage = createUsageService({ homedir: home(), env: {}, providers: [provider], now: clock.now, timeoutMs: 2000 });
    const entry = (await usage.report()).providers[0];
    assert.equal(calls, 0, 'an index-level accessor must never be invoked');
    assert.equal(entry.ok, false, 'a list with a tampered (accessor) index must fail entirely, not silently keep the other real index');
  });

  it('B05: an own Symbol.iterator planted on an array is never called, and its mere presence rejects the whole list', async () => {
    const clock = fakeClock(0);
    let calls = 0;
    const arr = [];
    arr[Symbol.iterator] = function* generator() { calls += 1; yield { label: 'it1', usedPercent: 1, resetsAt: null }; yield { label: 'it2', usedPercent: 2, resetsAt: null }; };
    const provider = { id: 'x', name: 'X', source: 'api', fetch: async () => ({ windows: arr }) };
    const usage = createUsageService({ homedir: home(), env: {}, providers: [provider], now: clock.now, timeoutMs: 2000 });
    const entry = (await usage.report()).providers[0];
    assert.equal(calls, 0, 'the planted iterator must never actually run');
    assert.ok(!(entry.ok === true && entry.windows.length === 2), 'a real length of 0 plus a tampered iterator must never yield a 2-item fresh success');
  });

  it('B06: a non-plain Array subclass is rejected outright, not read as an ordinary list', async () => {
    const clock = fakeClock(0);
    class Sub extends Array {}
    const arr = Sub.from([{ label: 'w', usedPercent: 10, resetsAt: null }]);
    const provider = { id: 'x', name: 'X', source: 'api', fetch: async () => ({ windows: arr }) };
    const usage = createUsageService({ homedir: home(), env: {}, providers: [provider], now: clock.now, timeoutMs: 2000 });
    const entry = (await usage.report()).providers[0];
    assert.equal(entry.ok, false, 'an Array subclass must never be trusted as ordinary list data');
  });

  it('B07: a Proxy list whose descriptor trap throws partway through fails entirely, never a fresh partial', async () => {
    const clock = fakeClock(0);
    const base = [
      { label: 'a', usedPercent: 1, resetsAt: null }, { label: 'b', usedPercent: 2, resetsAt: null },
      { label: 'c', usedPercent: 3, resetsAt: null }, { label: 'd', usedPercent: 4, resetsAt: null },
    ];
    const px = new Proxy(base, {
      getOwnPropertyDescriptor(target, key) {
        if (key === '2') throw new Error('poisoned descriptor trap');
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const provider = { id: 'x', name: 'X', source: 'api', fetch: async () => ({ windows: px }) };
    const usage = createUsageService({ homedir: home(), env: {}, providers: [provider], now: clock.now, timeoutMs: 2000 });
    const entry = (await usage.report()).providers[0];
    assert.equal(entry.ok, false, 'a descriptor trap throwing mid-list must fail the whole result, never return the 2 items read before the throw');
    assert.deepEqual(entry.windows, []);
  });

  it('B08: a Proxy result whose descriptor trap throws for `windows` fails even alongside a genuinely valid note', async () => {
    const clock = fakeClock(0);
    const target = { note: 'manual' };
    const px = new Proxy(target, {
      getOwnPropertyDescriptor(t, key) {
        if (key === 'windows') throw new Error('poisoned descriptor trap');
        return Reflect.getOwnPropertyDescriptor(t, key);
      },
    });
    const provider = { id: 'x', name: 'X', source: 'api', fetch: async () => px };
    const usage = createUsageService({ homedir: home(), env: {}, providers: [provider], now: clock.now, timeoutMs: 2000 });
    const entry = (await usage.report()).providers[0];
    assert.equal(entry.ok, false, 'a top-level descriptor trap throwing for windows must fail the whole result, even though note is genuinely readable');
  });

  it('B22: year 0000 is a leap year under proleptic Gregorian rules, so Feb 29 that year is kept, not rejected', async () => {
    const clock = fakeClock(0);
    const provider = { id: 'x', name: 'X', source: 'api', fetch: async () => ({ plan: 'p', asOf: '0000-02-29T00:00:00Z' }) };
    const usage = createUsageService({ homedir: home(), env: {}, providers: [provider], now: clock.now, timeoutMs: 2000 });
    const entry = (await usage.report()).providers[0];
    assert.equal(entry.asOf, '0000-02-29T00:00:00Z', "year 0000 is divisible by 400 so Feb 29 is real; Date.UTC's legacy 0-99 -> 1900+year remap must not reject it as if it were non-leap 1900");
  });

  it('B29: a clock rollback while a provider is hung does not grow the wait past timeoutMs', async () => {
    const clock = fakeClock(50_000_000);
    const hung = { id: 'hung', name: 'Hung', source: 'api', fetch: () => new Promise(() => {}) };
    const usage = createUsageService({ homedir: home(), env: {}, providers: [hung], now: clock.now, timeoutMs: 50 });
    await usage.report();
    clock.set(50_000_000 - 3000);
    const t0 = Date.now();
    await usage.report();
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 1000, `a 3s clock rollback must not inflate a 50ms timeout into a multi-second wait (elapsed ${elapsed}ms)`);
  });
});
