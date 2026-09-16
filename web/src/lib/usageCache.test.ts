import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageReport } from '../api/types';
import { USAGE_ERROR_TEXT } from './usageClient';
import {
  USAGE_MAX_AGE_MS,
  buildUsageScopeKey,
  clearUsageScopes,
  cooldownRemainingMs,
  ensureUsageLoaded,
  getUsageSnapshot,
  isFresh,
  isRefreshingProvider,
  refreshUsage,
  subscribeUsage,
} from './usageCache';

const report = (generatedAt: string): UsageReport => ({ generatedAt, providers: [] });

const SCOPE = buildUsageScopeKey('http://127.0.0.1:6097', 'proj-1');

beforeEach(() => {
  clearUsageScopes();
});

describe('buildUsageScopeKey', () => {
  it('combines origin and project id so two servers on the same origin never collide by accident', () => {
    expect(buildUsageScopeKey('http://x:1', 'a')).not.toBe(buildUsageScopeKey('http://x:1', 'b'));
    expect(buildUsageScopeKey('http://x:1', 'a')).not.toBe(buildUsageScopeKey('http://x:2', 'a'));
  });

  it('marks a missing project id as unscoped rather than silently matching on origin alone', () => {
    expect(buildUsageScopeKey('http://x:1', null)).toBe('http://x:1::(unscoped)');
    expect(buildUsageScopeKey('http://x:1', undefined)).toBe(buildUsageScopeKey('http://x:1', null));
  });
});

describe('isFresh', () => {
  it('counts a result fresh until the max age, so switching back does not refetch', () => {
    expect(isFresh(0, 0)).toBe(true);
    expect(isFresh(0, USAGE_MAX_AGE_MS - 1)).toBe(true);
  });

  it('counts a result at or past the max age as stale', () => {
    expect(isFresh(0, USAGE_MAX_AGE_MS)).toBe(false);
    expect(isFresh(0, USAGE_MAX_AGE_MS + 1)).toBe(false);
  });

  it('treats a backwards clock as stale instead of fresh forever', () => {
    expect(isFresh(5000, 1000)).toBe(false);
  });

  it('treats "never fetched" (null) as stale', () => {
    expect(isFresh(null, 0)).toBe(false);
  });
});

describe('ensureUsageLoaded', () => {
  it('fetches once on a fresh scope and updates the snapshot', async () => {
    const fetcher = vi.fn().mockResolvedValue(report('t1'));
    await ensureUsageLoaded(SCOPE, fetcher, 1000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith({ refresh: false, providerId: undefined, signal: expect.any(AbortSignal) });
    expect(getUsageSnapshot(SCOPE).report?.generatedAt).toBe('t1');
  });

  it('does not fetch twice for a StrictMode-style double mount while the first call is still pending', () => {
    const fetcher = vi.fn().mockReturnValue(new Promise(() => {}));
    ensureUsageLoaded(SCOPE, fetcher, 1000);
    ensureUsageLoaded(SCOPE, fetcher, 1001);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not refetch a remount while cached data is still fresh', async () => {
    const fetcher = vi.fn().mockResolvedValue(report('t1'));
    await ensureUsageLoaded(SCOPE, fetcher, 1000);
    ensureUsageLoaded(SCOPE, fetcher, 1000 + USAGE_MAX_AGE_MS - 1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does refetch once the cached data has expired', async () => {
    const fetcher = vi.fn().mockResolvedValue(report('t1'));
    await ensureUsageLoaded(SCOPE, fetcher, 1000);
    await ensureUsageLoaded(SCOPE, fetcher, 1000 + USAGE_MAX_AGE_MS + 1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('refreshUsage', () => {
  it('keeps the previous report and only sets globalError when the fetch fails', async () => {
    const good = vi.fn().mockResolvedValue(report('good'));
    await refreshUsage(SCOPE, good, { now: 1000 });
    expect(getUsageSnapshot(SCOPE).report?.generatedAt).toBe('good');

    // The rejection's own message is never surfaced (it could carry a URL or other untrusted detail — see
    // usageClient.ts classifyFetchFailure); only this module's own fixed text.
    const bad = vi.fn().mockRejectedValue(new Error('network down'));
    await refreshUsage(SCOPE, bad, { now: 2000 });
    const snap = getUsageSnapshot(SCOPE);
    expect(snap.report?.generatedAt).toBe('good');
    expect(snap.globalError).toBe(USAGE_ERROR_TEXT.network);
  });

  it('resolves true only for a clean success, and false for an HTTP-style failure — a caller must not treat this as confirmation on a failure', async () => {
    await expect(refreshUsage(SCOPE, vi.fn().mockResolvedValue(report('good')), { now: 1000 })).resolves.toBe(true);
    await expect(refreshUsage(SCOPE, vi.fn().mockRejectedValue(new Error('boom')), { now: 2000 })).resolves.toBe(false);
  });

  it('clears globalError once a later refresh succeeds', async () => {
    await refreshUsage(SCOPE, vi.fn().mockRejectedValue(new Error('x')), { now: 1000 });
    expect(getUsageSnapshot(SCOPE).globalError).toBe(USAGE_ERROR_TEXT.network);
    await refreshUsage(SCOPE, vi.fn().mockResolvedValue(report('r2')), { now: 2000 });
    expect(getUsageSnapshot(SCOPE).globalError).toBeNull();
  });

  it('dedupes a whole-report refresh already in flight', () => {
    const fetcher = vi.fn().mockReturnValue(new Promise(() => {}));
    void refreshUsage(SCOPE, fetcher, { now: 1000 });
    void refreshUsage(SCOPE, fetcher, { now: 1001 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('dedupes a second click on the same provider while its refresh is in flight, independent of refresh-all', () => {
    const fetcher = vi.fn().mockReturnValue(new Promise(() => {}));
    void refreshUsage(SCOPE, fetcher, { providerId: 'codex', now: 1000 });
    void refreshUsage(SCOPE, fetcher, { providerId: 'codex', now: 1001 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(isRefreshingProvider(SCOPE, 'codex')).toBe(true);
    expect(getUsageSnapshot(SCOPE).refreshingAll).toBe(false);
  });

  it('lets a different provider refresh independently while one is already in flight', () => {
    const fetcher = vi.fn().mockReturnValue(new Promise(() => {}));
    void refreshUsage(SCOPE, fetcher, { providerId: 'codex', now: 1000 });
    void refreshUsage(SCOPE, fetcher, { providerId: 'kimi', now: 1000 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('notifies subscribers on start and on settle, so a hook using this store re-renders', async () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeUsage(SCOPE, () => seen.push(getUsageSnapshot(SCOPE).refreshingAll));
    await refreshUsage(SCOPE, vi.fn().mockResolvedValue(report('r')), { now: 1000 });
    unsubscribe();
    expect(seen).toEqual([true, false]);
  });
});

// At the cache layer: `validateUsageReport` returning a non-null result with an empty `providers` array
// must not always be treated as an authoritative "you now have zero providers" full-report replacement --
// only when the server actually sent an empty array. A non-empty raw array that degenerated to zero usable
// entries has to behave like a failed read instead.
describe('refreshUsage — malformed provider payloads never silently empty a good cache', () => {
  const goodProvider = {
    id: 'codex',
    name: 'Codex',
    source: 'cli' as const,
    ok: true,
    configured: true,
    windows: [{ label: '5h', usedPercent: 42, resetsAt: null }],
    balances: [],
    plan: '',
    note: '',
    asOf: null,
    fetchedAt: 't1',
    state: 'fresh' as const,
  };

  it('keeps the previous good numbers when a 200 body is {providers:[null]}', async () => {
    await refreshUsage(SCOPE, vi.fn().mockResolvedValue({ generatedAt: 'g1', providers: [goodProvider] }), { now: 1000 });
    expect(getUsageSnapshot(SCOPE).report?.providers).toHaveLength(1);

    await refreshUsage(SCOPE, vi.fn().mockResolvedValue({ generatedAt: 'g2', providers: [null] }), { now: 2000 });
    const snap = getUsageSnapshot(SCOPE);
    expect(snap.report?.providers).toHaveLength(1);
    expect(snap.report?.providers[0]?.windows[0]?.usedPercent).toBe(42);
    expect(snap.globalError).toBe(USAGE_ERROR_TEXT.malformed);
  });

  it('keeps the previous good numbers when every entry is missing an id', async () => {
    await refreshUsage(SCOPE, vi.fn().mockResolvedValue({ generatedAt: 'g1', providers: [goodProvider] }), { now: 1000 });
    await refreshUsage(
      SCOPE,
      vi.fn().mockResolvedValue({ generatedAt: 'g2', providers: [{ name: 'no id' }, { name: 'also no id' }] }),
      { now: 2000 },
    );
    const snap = getUsageSnapshot(SCOPE);
    expect(snap.report?.providers).toHaveLength(1);
    expect(snap.globalError).toBe(USAGE_ERROR_TEXT.malformed);
  });

  it('still accepts a genuinely empty providers array as a real "no providers" snapshot', async () => {
    await refreshUsage(SCOPE, vi.fn().mockResolvedValue({ generatedAt: 'g1', providers: [goodProvider] }), { now: 1000 });
    await refreshUsage(SCOPE, vi.fn().mockResolvedValue({ generatedAt: 'g2', providers: [] }), { now: 2000 });
    const snap = getUsageSnapshot(SCOPE);
    expect(snap.report?.providers).toEqual([]);
    expect(snap.globalError).toBeNull();
  });

  it('a targeted refresh degenerating to zero usable entries leaves the other cards untouched (no wipe)', async () => {
    await refreshUsage(SCOPE, vi.fn().mockResolvedValue({ generatedAt: 'g1', providers: [goodProvider] }), { now: 1000 });
    await refreshUsage(SCOPE, vi.fn().mockResolvedValue({ generatedAt: 'g2', providers: [null] }), {
      now: 2000,
      providerId: 'codex',
    });
    expect(getUsageSnapshot(SCOPE).report?.providers).toHaveLength(1);
  });

  // The regression this whole describe block exists to catch: a 200 body carrying one malformed entry
  // whose id has never been seen before (so it renders as its own new "read failed" placeholder, not a
  // stale fallback) must still be treated as malformed for the purposes of an untargeted merge -- it must
  // not be read as "the backend now authoritatively reports exactly this one provider", which would delete
  // every other good, previously cached card.
  it('does not delete other good cards when the response also carries one brand-new malformed entry', async () => {
    const provider = (id: string, name: string) => ({
      id,
      name,
      source: 'cli' as const,
      ok: true,
      configured: true,
      windows: [{ label: '5h', usedPercent: 10, resetsAt: null }],
      balances: [],
      plan: '',
      note: '',
      asOf: null,
      fetchedAt: 't1',
      state: 'fresh' as const,
    });
    await refreshUsage(
      SCOPE,
      vi.fn().mockResolvedValue({
        generatedAt: 'g1',
        providers: [provider('codex', 'Codex'), provider('kimi', 'Kimi'), provider('glm', 'GLM'), provider('qwen', 'Qwen')],
      }),
      { now: 1000 },
    );
    expect(getUsageSnapshot(SCOPE).report?.providers).toHaveLength(4);

    // A malformed entry for an id this scope has never cached before (missing required fields, e.g. an
    // adapter reporting a new provider that failed its first read).
    await refreshUsage(SCOPE, vi.fn().mockResolvedValue({ generatedAt: 'g2', providers: [{ id: 'x', name: 'Mal X', ok: true, configured: true }] }), {
      now: 2000,
    });
    const snap = getUsageSnapshot(SCOPE);
    expect(snap.report?.providers.map((p) => p.id).sort()).toEqual(['codex', 'glm', 'kimi', 'qwen', 'x']);
    expect(snap.globalError).toBe(USAGE_ERROR_TEXT.malformed);
  });

  it('still replaces the whole set when a single clean entry is the legitimate, wholly-valid new snapshot', async () => {
    const provider = (id: string, name: string) => ({
      id,
      name,
      source: 'cli' as const,
      ok: true,
      configured: true,
      windows: [{ label: '5h', usedPercent: 10, resetsAt: null }],
      balances: [],
      plan: '',
      note: '',
      asOf: null,
      fetchedAt: 't1',
      state: 'fresh' as const,
    });
    await refreshUsage(SCOPE, vi.fn().mockResolvedValue({ generatedAt: 'g1', providers: [provider('codex', 'Codex'), provider('kimi', 'Kimi')] }), {
      now: 1000,
    });
    await refreshUsage(SCOPE, vi.fn().mockResolvedValue({ generatedAt: 'g2', providers: [provider('codex', 'Codex')] }), { now: 2000 });
    const snap = getUsageSnapshot(SCOPE);
    expect(snap.report?.providers.map((p) => p.id)).toEqual(['codex']);
    expect(snap.globalError).toBeNull();
  });

  it('drops two null entries out of three without deleting the one good, unrelated card', async () => {
    await refreshUsage(SCOPE, vi.fn().mockResolvedValue({ generatedAt: 'g1', providers: [goodProvider] }), { now: 1000 });
    await refreshUsage(SCOPE, vi.fn().mockResolvedValue({ generatedAt: 'g2', providers: [goodProvider, null, null] }), { now: 2000 });
    const snap = getUsageSnapshot(SCOPE);
    expect(snap.report?.providers).toHaveLength(1);
    expect(snap.globalError).toBe(USAGE_ERROR_TEXT.malformed);
  });
});

// forceRelease (fired by the timeout watchdog when a fetcher ignores its
// AbortSignal and never settles) must invalidate more than just the busy flag. A late, "confirmed but
// ignored the abort" completion must never be allowed to silently override the timeout error the owner was
// already shown, and the automatic interval timer must not quietly stack a fresh attempt on top of one
// whose real fate is still unknown — only an explicit manual retry, or that abandoned attempt itself
// actually confirming it finished, may resume normal operation.
describe('forceRelease / abandoned attempts', () => {
  const codexReport = (percent: number) => ({
    generatedAt: 'g1',
    providers: [
      {
        id: 'codex',
        name: 'Codex',
        source: 'cli',
        ok: true,
        configured: true,
        windows: [{ label: '5h', usedPercent: percent, resetsAt: null }],
        balances: [],
        plan: '',
        note: '',
        asOf: null,
        fetchedAt: 't1',
        state: 'fresh',
      },
    ],
  });

  it('an ignored-abort late completion cannot override the timeout error or the kept-old numbers', async () => {
    await refreshUsage(SCOPE, vi.fn().mockResolvedValue(codexReport(42)), { now: 1000 });
    expect(getUsageSnapshot(SCOPE).report?.providers[0]?.windows[0]?.usedPercent).toBe(42);

    let resolveFetch: (value: unknown) => void = () => {};
    const hangingFetcher = vi.fn().mockReturnValue(new Promise((resolve) => { resolveFetch = resolve; }));
    const attempt = refreshUsage(SCOPE, hangingFetcher, { now: 2000, timeoutMs: 5, graceMs: 5 });
    await new Promise((r) => setTimeout(r, 40)); // let the abort timer and the watchdog both fire

    const released = getUsageSnapshot(SCOPE);
    expect(released.refreshingAll).toBe(false);
    expect(released.globalError).toBe(USAGE_ERROR_TEXT.timeout);

    // the abandoned fetch (still ignoring the abort) now resolves with fresh-looking, later data
    resolveFetch(codexReport(99));
    await attempt;
    const afterLate = getUsageSnapshot(SCOPE);
    expect(afterLate.report?.providers[0]?.windows[0]?.usedPercent).toBe(42); // old good number, unchanged
    expect(afterLate.globalError).toBe(USAGE_ERROR_TEXT.timeout); // still the shown failure, not silently cleared
  });

  it('an automatic (interval) refresh is a no-op while a key is blocked, and resumes once the abandoned attempt confirms settling', async () => {
    await refreshUsage(SCOPE, vi.fn().mockResolvedValue(codexReport(10)), { now: 1000 });
    let resolveFetch: (value: unknown) => void = () => {};
    const hangingFetcher = vi.fn().mockReturnValue(new Promise((resolve) => { resolveFetch = resolve; }));
    const attempt = refreshUsage(SCOPE, hangingFetcher, { now: 2000, timeoutMs: 5, graceMs: 5 });
    await new Promise((r) => setTimeout(r, 40));
    expect(getUsageSnapshot(SCOPE).globalError).toBe(USAGE_ERROR_TEXT.timeout);

    const autoFetcher = vi.fn().mockResolvedValue(codexReport(10));
    await refreshUsage(SCOPE, autoFetcher, { refresh: false, countsAsAttempt: false });
    expect(autoFetcher).not.toHaveBeenCalled(); // blocked: the abandoned attempt's fate is still unknown

    resolveFetch(codexReport(55)); // the abandoned attempt finally confirms it finished (ignored, per above)
    await attempt;

    const autoFetcher2 = vi.fn().mockResolvedValue(codexReport(10));
    await refreshUsage(SCOPE, autoFetcher2, { refresh: false, countsAsAttempt: false });
    expect(autoFetcher2).toHaveBeenCalledTimes(1); // unblocked now that the old attempt is confirmed done
  });

  it('a manual retry is let through immediately even while a key is still blocked, and its own result applies', async () => {
    await refreshUsage(SCOPE, vi.fn().mockResolvedValue(codexReport(10)), { now: 1000 });
    const hangingFetcher = vi.fn().mockReturnValue(new Promise(() => {})); // never settles at all
    void refreshUsage(SCOPE, hangingFetcher, { now: 2000, timeoutMs: 5, graceMs: 5 });
    await new Promise((r) => setTimeout(r, 40));
    expect(getUsageSnapshot(SCOPE).globalError).toBe(USAGE_ERROR_TEXT.timeout);

    await refreshUsage(SCOPE, vi.fn().mockResolvedValue(codexReport(77)), { now: 3000 });
    const snap = getUsageSnapshot(SCOPE);
    expect(snap.report?.providers[0]?.windows[0]?.usedPercent).toBe(77);
    expect(snap.globalError).toBeNull();
  });

  it('bounds outstanding requests: repeated auto ticks while blocked never call the fetcher again', async () => {
    await refreshUsage(SCOPE, vi.fn().mockResolvedValue(codexReport(10)), { now: 1000 });
    void refreshUsage(SCOPE, vi.fn().mockReturnValue(new Promise(() => {})), { now: 2000, timeoutMs: 5, graceMs: 5 });
    await new Promise((r) => setTimeout(r, 40));

    const autoFetcher = vi.fn().mockResolvedValue(codexReport(10));
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await refreshUsage(SCOPE, autoFetcher, { refresh: false, countsAsAttempt: false });
    }
    expect(autoFetcher).not.toHaveBeenCalled();
  });

  it('settles the promise it hands back once the watchdog releases, even though the transport ignores its abort signal forever', async () => {
    const neverSettles = vi.fn().mockReturnValue(new Promise(() => {})); // no resolve, no reject, ever
    const attempt = refreshUsage(SCOPE, neverSettles, { now: 1000, timeoutMs: 5, graceMs: 5 });
    // If the watchdog's release did not also settle this promise, awaiting it here would hang the test
    // (vitest's own timeout would eventually fail it) instead of resolving within the watchdog window.
    const result = await attempt;
    expect(result).toBe(false);
    expect(getUsageSnapshot(SCOPE).globalError).toBe(USAGE_ERROR_TEXT.timeout);
    expect(getUsageSnapshot(SCOPE).refreshingAll).toBe(false);
  });

  it('never rejects, even for a watchdog release, so a caller can await it without its own try/catch', async () => {
    const neverSettles = vi.fn().mockReturnValue(new Promise(() => {}));
    await expect(refreshUsage(SCOPE, neverSettles, { now: 1000, timeoutMs: 5, graceMs: 5 })).resolves.toBe(false);
  });
});

// Verified directly against the cache's merge logic by calling refreshUsage with `providerId` set, exactly
// as a real supported-targeted-refresh backend would drive it -- WITHOUT flipping
// USAGE_TARGETED_REFRESH_SUPPORTED (that constant stays `false`; see usageCache.ts — the UI still never
// sends a real targeted request until the backend declares a capability signal). This is purely a
// lower-level contract test of the merge/tombstone semantics a future supported backend would exercise.
describe('applyValidatedReport merge ordering / tombstones (targeted responses, cache-level)', () => {
  const prov = (id: string, name: string, percent: number) => ({
    id,
    name,
    source: 'cli' as const,
    ok: true,
    configured: true,
    windows: [{ label: '5h', usedPercent: percent, resetsAt: null }],
    balances: [],
    plan: '',
    note: '',
    asOf: null,
    fetchedAt: 't1',
    state: 'fresh' as const,
  });

  it('a late-arriving targeted response for an id already deleted by a newer full refresh cannot resurrect it', async () => {
    await refreshUsage(SCOPE, vi.fn().mockResolvedValue({ generatedAt: 'g1', providers: [prov('codex', 'Codex', 10), prov('kimi', 'Kimi', 20)] }), { now: 1000 });

    let resolveKimi: (value: unknown) => void = () => {};
    const targetedKimi = vi.fn().mockReturnValue(new Promise((resolve) => { resolveKimi = resolve; }));
    const pending = refreshUsage(SCOPE, targetedKimi, { providerId: 'kimi', now: 1100 });

    // a newer full refresh lands first and drops kimi entirely (the backend no longer reports it)
    await refreshUsage(SCOPE, vi.fn().mockResolvedValue({ generatedAt: 'g2', providers: [prov('codex', 'Codex', 15)] }), { now: 2000 });
    expect(getUsageSnapshot(SCOPE).report?.providers.map((p) => p.id)).toEqual(['codex']);

    // the older, now-stale targeted response for kimi finally resolves
    resolveKimi({ generatedAt: 'g1b', providers: [prov('kimi', 'Kimi', 20)] });
    await pending;
    const snap = getUsageSnapshot(SCOPE);
    expect(snap.report?.providers.map((p) => p.id)).toEqual(['codex']); // kimi stays gone, not resurrected
    expect(snap.report?.providers[0]?.windows[0]?.usedPercent).toBe(15);
  });

  it('a targeted response that echoes an unrequested extra id cannot overwrite a newer result already applied for that id', async () => {
    await refreshUsage(SCOPE, vi.fn().mockResolvedValue({ generatedAt: 'g1', providers: [prov('codex', 'Codex', 10), prov('kimi', 'Kimi', 20)] }), { now: 1000 });

    let resolveKimi: (value: unknown) => void = () => {};
    // Backend anomaly: asked only for kimi, but the response also includes codex (arbitrary extra id).
    const targetedKimi = vi.fn().mockReturnValue(new Promise((resolve) => { resolveKimi = resolve; }));
    const pending = refreshUsage(SCOPE, targetedKimi, { providerId: 'kimi', now: 1100 });

    // a faster, newer, independent update for codex lands first
    await refreshUsage(SCOPE, vi.fn().mockResolvedValue({ generatedAt: 'g2', providers: [prov('codex', 'Codex', 77)] }), { now: 2000, providerId: 'codex' });
    expect(getUsageSnapshot(SCOPE).report?.providers.find((p) => p.id === 'codex')?.windows[0]?.usedPercent).toBe(77);

    resolveKimi({ generatedAt: 'g1b', providers: [prov('kimi', 'Kimi', 33), prov('codex', 'Codex', 10)] });
    await pending;
    const snap = getUsageSnapshot(SCOPE);
    expect(snap.report?.providers.find((p) => p.id === 'kimi')?.windows[0]?.usedPercent).toBe(33); // its own update applies
    expect(snap.report?.providers.find((p) => p.id === 'codex')?.windows[0]?.usedPercent).toBe(77); // stale echo ignored
  });
});

describe('getUsageSnapshot referential stability', () => {
  it('returns the same object reference across reads when nothing has changed (useSyncExternalStore requirement)', async () => {
    await refreshUsage(SCOPE, vi.fn().mockResolvedValue(report('r1')), { now: 1000 });
    const a = getUsageSnapshot(SCOPE);
    const b = getUsageSnapshot(SCOPE);
    expect(a).toBe(b);
  });

  it('returns a new reference only once the data actually changes', async () => {
    await refreshUsage(SCOPE, vi.fn().mockResolvedValue(report('r1')), { now: 1000 });
    const before = getUsageSnapshot(SCOPE);
    await refreshUsage(SCOPE, vi.fn().mockResolvedValue(report('r2')), { now: 2000 });
    const after = getUsageSnapshot(SCOPE);
    expect(after).not.toBe(before);
    expect(after.report?.generatedAt).toBe('r2');
  });

  it('returns the same empty reference for an unloaded scope every time', () => {
    const other = buildUsageScopeKey('http://x:1', 'never-loaded');
    expect(getUsageSnapshot(other)).toBe(getUsageSnapshot(other));
  });
});

describe('cooldownRemainingMs', () => {
  it('is zero before any attempt', () => {
    expect(cooldownRemainingMs(SCOPE, '', 1000)).toBe(0);
  });

  it('counts down from the cooldown window after a manual attempt', () => {
    void refreshUsage(SCOPE, vi.fn().mockReturnValue(new Promise(() => {})), { now: 1000 });
    expect(cooldownRemainingMs(SCOPE, '', 1000, 15000)).toBe(15000);
    expect(cooldownRemainingMs(SCOPE, '', 6000, 15000)).toBe(10000);
    expect(cooldownRemainingMs(SCOPE, '', 16000, 15000)).toBe(0);
  });

  it('tracks a provider-scoped cooldown separately from the all-providers one', () => {
    void refreshUsage(SCOPE, vi.fn().mockReturnValue(new Promise(() => {})), { providerId: 'codex', now: 1000 });
    expect(cooldownRemainingMs(SCOPE, 'codex', 1000, 15000)).toBe(15000);
    expect(cooldownRemainingMs(SCOPE, '', 1000, 15000)).toBe(0);
  });

  // Clamping alone (`Math.min(cooldownMs, ...)`) still recomputes the same
  // full-window value on every read for as long as `now` stays behind `last` -- an hour-long backward clock
  // jump would hold the button at "full cooldown" for the whole hour instead of counting down. The fix
  // rebases `last` to the first `now` seen after the jump, so the cooldown actually counts down from there.
  it('rebases the deadline on a backward clock jump instead of freezing at the full cooldown forever', () => {
    void refreshUsage(SCOPE, vi.fn().mockReturnValue(new Promise(() => {})), { now: 1_000_000 });
    // system clock jumps back by roughly an hour
    expect(cooldownRemainingMs(SCOPE, '', 1_000_000 - 3_600_000, 15000)).toBe(15000);
    // even long after the jump (on the rolled-back timeline), a frozen implementation would still report
    // the full 15s here since `now` is still far behind the original `last`; the rebased one must not
    expect(cooldownRemainingMs(SCOPE, '', 1_000_000 - 3_600_000 + 20_000, 15000)).toBe(0);
  });

  it('rebases a provider-scoped cooldown independently of the all-providers one', () => {
    void refreshUsage(SCOPE, vi.fn().mockReturnValue(new Promise(() => {})), { providerId: 'codex', now: 1_000_000 });
    expect(cooldownRemainingMs(SCOPE, 'codex', 1_000_000 - 3_600_000, 15000)).toBe(15000);
    expect(cooldownRemainingMs(SCOPE, 'codex', 1_000_000 - 3_600_000 + 20_000, 15000)).toBe(0);
  });
});

describe('scope isolation', () => {
  it('gives an unloaded scope an empty snapshot instead of another scope\'s data', async () => {
    await refreshUsage(SCOPE, vi.fn().mockResolvedValue(report('project-a')), { now: 1000 });
    const otherScope = buildUsageScopeKey('http://127.0.0.1:6097', 'proj-2');
    const snap = getUsageSnapshot(otherScope);
    expect(snap.report).toBeNull();
    expect(snap.fetchedAt).toBeNull();
  });

  it('does not let a late completion for one scope leak into another scope\'s snapshot', async () => {
    let resolveFirst: (value: UsageReport) => void = () => {};
    const slow = vi.fn().mockReturnValue(new Promise<UsageReport>((resolve) => { resolveFirst = resolve; }));
    const otherScope = buildUsageScopeKey('http://127.0.0.1:6097', 'proj-2');
    const promise = refreshUsage(SCOPE, slow, { now: 1000 });
    await refreshUsage(otherScope, vi.fn().mockResolvedValue(report('project-b')), { now: 1000 });
    resolveFirst(report('project-a'));
    await promise;
    expect(getUsageSnapshot(SCOPE).report?.generatedAt).toBe('project-a');
    expect(getUsageSnapshot(otherScope).report?.generatedAt).toBe('project-b');
  });
});
