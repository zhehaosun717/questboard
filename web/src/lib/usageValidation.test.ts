import { describe, expect, it } from 'vitest';
import type { UsageProvider } from '../api/types';
import { validateUsageReport } from './usageValidation';

// Raw wire shapes under test are deliberately untyped (`Record<string, unknown>`), not `Partial<UsageProvider>`:
// the whole point of this suite is feeding shapes that do NOT conform to UsageProvider and checking that
// validateUsageReport still produces a safe, well-typed result.
function goodProvider(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'codex',
    name: 'OpenAI Codex',
    source: 'cli',
    ok: true,
    configured: true,
    windows: [],
    balances: [],
    plan: '',
    note: '',
    asOf: null,
    fetchedAt: '2026-09-15T00:00:00Z',
    ...overrides,
  };
}

describe('validateUsageReport — whole-body failure', () => {
  it('rejects null, a non-object, and a body with no providers array', () => {
    expect(validateUsageReport(null, [])).toBeNull();
    expect(validateUsageReport('a string', [])).toBeNull();
    expect(validateUsageReport(42, [])).toBeNull();
    expect(validateUsageReport({}, [])).toBeNull();
    expect(validateUsageReport({ providers: 'not-an-array' }, [])).toBeNull();
    expect(validateUsageReport({ providers: {} }, [])).toBeNull();
  });

  it('accepts an empty providers array as a valid (if empty) report', () => {
    const result = validateUsageReport({ generatedAt: 't1', providers: [] }, []);
    expect(result).toEqual({ generatedAt: 't1', providers: [], rawProviderCount: 0, hadMalformedEntries: false });
  });

  // `rawProviderCount` lets a caller (usageCache.ts applySuccess) tell a legitimately empty report apart
  // from a non-empty array that degenerated to zero usable entries -- the per-entry semantics here are
  // unchanged (still drop-and-continue, see the "per-provider entries" suite below), only the extra count
  // is new. `hadMalformedEntries` is the same signal a caller needs to decide whether an untargeted merge
  // may treat this response as the authoritative full set (see usageCache.ts applyValidatedReport).
  it('reports how many raw entries came in, distinct from how many survived sanitization, and flags the drop', () => {
    const result = validateUsageReport({ providers: [null, { name: 'no id here' }, {}] }, []);
    expect(result?.providers).toEqual([]);
    expect(result?.rawProviderCount).toBe(3);
    expect(result?.hadMalformedEntries).toBe(true);
  });

  it('does not flag a report as malformed when every entry is fully well-formed', () => {
    const result = validateUsageReport({ providers: [goodProvider()] }, []);
    expect(result?.hadMalformedEntries).toBe(false);
  });

  it('defaults a missing/non-string generatedAt to an empty string rather than failing the whole report', () => {
    expect(validateUsageReport({ providers: [] }, [])?.generatedAt).toBe('');
    expect(validateUsageReport({ generatedAt: 123, providers: [] }, [])?.generatedAt).toBe('');
  });
});

describe('validateUsageReport — per-provider entries', () => {
  it('drops an entry with no usable id (nothing to key a card, or a stale fallback, on)', () => {
    const result = validateUsageReport({ providers: [{ name: 'no id here' }] }, []);
    expect(result?.providers).toEqual([]);
  });

  it('drops a non-object entry in the array outright', () => {
    const result = validateUsageReport({ providers: [null, 'x', 42, goodProvider()] }, []);
    expect(result?.providers).toHaveLength(1);
  });

  it('passes through a fully well-formed entry unchanged', () => {
    const result = validateUsageReport({ providers: [goodProvider({ state: 'fresh' })] }, []);
    expect(result?.providers[0]).toMatchObject({ id: 'codex', name: 'OpenAI Codex', ok: true, state: 'fresh' });
  });

  it('never copies the raw `error` field through, even when present on an otherwise-valid entry', () => {
    const result = validateUsageReport(
      { providers: [goodProvider({ error: 'upstream 403, Referer: https://internal.example/secret' })] },
      [],
    );
    expect(result?.providers[0]).not.toHaveProperty('error');
  });

  it('drops an unrecognized `state` value instead of trusting arbitrary backend text', () => {
    const result = validateUsageReport({ providers: [goodProvider({ state: 'made_up_state' })] }, []);
    expect(result?.providers[0]?.state).toBeUndefined();
  });

  it('keeps a recognized `state` value', () => {
    const result = validateUsageReport({ providers: [goodProvider({ state: 'unavailable' })] }, []);
    expect(result?.providers[0]?.state).toBe('unavailable');
  });

  it('treats `configured: null` as "not known yet", distinct from `false`', () => {
    const result = validateUsageReport({ providers: [goodProvider({ configured: null })] }, []);
    expect(result?.providers[0]?.configured).toBeNull();
  });

  describe('malformed provider entries — with and without a previous good reading', () => {
    it('falls back to a minimal failed placeholder when a required field is missing and no previous reading exists', () => {
      const result = validateUsageReport({ providers: [{ id: 'codex', name: 'OpenAI Codex' }] }, []);
      expect(result?.providers[0]).toMatchObject({
        id: 'codex',
        name: 'OpenAI Codex',
        ok: false,
        state: 'failed',
        windows: [],
        balances: [],
      });
    });

    it('synthesizes an id-derived name when even `name` is missing, so the card still renders something', () => {
      const result = validateUsageReport({ providers: [{ id: 'codex' }] }, []);
      expect(result?.providers[0]?.name).toBe('codex');
    });

    it('retains the previous good reading, marked stale, instead of showing partial/garbage numbers', () => {
      const previous: UsageProvider = {
        id: 'codex',
        name: 'OpenAI Codex',
        source: 'cli',
        ok: true,
        configured: true,
        windows: [{ label: '5h', usedPercent: 42, resetsAt: null }],
        balances: [],
        plan: 'Pro',
        note: '',
        asOf: '2026-09-15T00:00:00Z',
        fetchedAt: '2026-09-15T00:00:00Z',
        state: 'fresh',
      };
      const result = validateUsageReport({ providers: [{ id: 'codex', ok: 'not-a-boolean' }] }, [previous]);
      expect(result?.providers[0]).toMatchObject({ ...previous, state: 'stale' });
    });

    it('never lets configured=false (a wrong type on the wire) mask a still-usable previous reading as unconfigured', () => {
      // Same case as above: the previous entry's `configured: true` must survive through the stale
      // fallback, not collapse to false just because this response's field was malformed.
      const previous: UsageProvider = {
        id: 'kimi',
        name: 'Kimi',
        source: 'api',
        ok: true,
        configured: true,
        windows: [],
        balances: [{ currency: 'CNY', amount: 10 }],
        plan: '',
        note: '',
        asOf: null,
        fetchedAt: '2026-09-15T00:00:00Z',
      };
      const result = validateUsageReport({ providers: [{ id: 'kimi', configured: 'yes' }] }, [previous]);
      expect(result?.providers[0]?.configured).toBe(true);
      expect(result?.providers[0]?.state).toBe('stale');
    });
  });

  // A present-but-empty (or wrong-typed) windows/balances array is still an honest "nothing to show"
  // reading and stays valid (see the sanitization suites below); an entirely *missing* key is a different
  // thing -- a malformed entry masquerading as a normal one -- and must not be accepted as fresh.
  describe('missing required arrays', () => {
    it('treats an entry missing `windows` entirely as malformed, not as "no windows"', () => {
      const { windows: _windows, ...withoutWindows } = goodProvider();
      const result = validateUsageReport({ providers: [withoutWindows] }, []);
      expect(result?.providers[0]).toMatchObject({ id: 'codex', state: 'failed' });
    });

    it('treats an entry missing `balances` entirely as malformed, not as "no balances"', () => {
      const { balances: _balances, ...withoutBalances } = goodProvider();
      const result = validateUsageReport({ providers: [withoutBalances] }, []);
      expect(result?.providers[0]).toMatchObject({ id: 'codex', state: 'failed' });
    });

    it('still accepts an explicit empty windows/balances array as a valid "nothing to show" reading', () => {
      const result = validateUsageReport({ providers: [goodProvider({ state: 'fresh' })] }, []);
      expect(result?.providers[0]).toMatchObject({ id: 'codex', state: 'fresh', windows: [], balances: [] });
    });
  });

  describe('windows sanitization', () => {
    it('drops a non-array windows field to an empty array rather than failing the whole entry', () => {
      const result = validateUsageReport({ providers: [goodProvider({ windows: 'nope' })] }, []);
      expect(result?.providers[0]?.windows).toEqual([]);
    });

    it('drops individual malformed window items but keeps the well-formed ones', () => {
      const result = validateUsageReport(
        {
          providers: [
            goodProvider({
              windows: [
                { label: '5h', usedPercent: 42, resetsAt: null },
                { usedPercent: 10 }, // no label — dropped
                'not-an-object', // dropped
                { label: 'weekly', usedPercent: null, resetsAt: '2026-09-16T00:00:00Z' },
              ],
            }),
          ],
        },
        [],
      );
      expect(result?.providers[0]?.windows).toEqual([
        { label: '5h', usedPercent: 42, resetsAt: null },
        { label: 'weekly', usedPercent: null, resetsAt: '2026-09-16T00:00:00Z' },
      ]);
    });

    it('keeps usedPercent=0 distinct from a missing/non-numeric percent (both must not collapse to the same value)', () => {
      const result = validateUsageReport(
        { providers: [goodProvider({ windows: [{ label: 'a', usedPercent: 0 }, { label: 'b', usedPercent: 'unknown' }] })] },
        [],
      );
      expect(result?.providers[0]?.windows[0]?.usedPercent).toBe(0);
      expect(result?.providers[0]?.windows[1]?.usedPercent).toBeNull();
    });
  });

  describe('balances sanitization', () => {
    it('drops a non-array balances field to an empty array', () => {
      const result = validateUsageReport({ providers: [goodProvider({ balances: {} })] }, []);
      expect(result?.providers[0]?.balances).toEqual([]);
    });

    it('drops a balance entry missing currency or a finite amount', () => {
      const result = validateUsageReport(
        {
          providers: [
            goodProvider({
              balances: [
                { currency: 'CNY', amount: 10 },
                { currency: 'USD' },
                { amount: 5 },
                { currency: 'EUR', amount: 'lots' },
              ],
            }),
          ],
        },
        [],
      );
      expect(result?.providers[0]?.balances).toEqual([{ currency: 'CNY', amount: 10 }]);
    });
  });

  // The accepted backend (src/usage/service.js, c90311f) sends this exact shape while a provider's first
  // read has not settled yet — it deliberately reports `fetchedAt: null` rather than inventing a time. See
  // backend-pending-report.json (generated from the real createUsageService with two stub providers).
  describe('backend-shaped pending entry (fetchedAt: null)', () => {
    const backendPending = {
      id: 'slow',
      name: 'Slow',
      source: 'api',
      refreshing: true,
      cooling: false,
      lastRefreshAt: null,
      windows: [],
      balances: [],
      plan: '',
      note: '',
      asOf: null,
      ok: false,
      configured: null,
      state: 'pending',
      fresh: false,
      stale: false,
      error: '等待超过 1 秒仍未返回：后台可能仍在继续，看板不会重复发起',
      fetchedAt: null,
      attemptedAt: null,
      lastSuccessAt: null,
    };

    it('accepts fetchedAt: null as a genuine reading, not a malformed entry, when state is pending', () => {
      const result = validateUsageReport({ providers: [backendPending] }, []);
      expect(result?.hadMalformedEntries).toBe(false);
      expect(result?.providers[0]).toMatchObject({ id: 'slow', state: 'pending', configured: null, fetchedAt: null });
    });

    it('a fresh sibling in the same report is unaffected', () => {
      const quick = {
        id: 'quick', name: 'Quick', source: 'api', refreshing: false, cooling: false, lastRefreshAt: null,
        windows: [{ label: '5h', usedPercent: 12, resetsAt: null }], balances: [], plan: 'p', note: '',
        asOf: null, ok: true, configured: true, state: 'fresh', fresh: true, stale: false,
        fetchedAt: '2026-09-16T09:55:08.381Z', attemptedAt: '2026-09-16T09:55:08.381Z',
        lastSuccessAt: '2026-09-16T09:55:08.382Z',
      };
      const result = validateUsageReport({ providers: [backendPending, quick] }, []);
      expect(result?.hadMalformedEntries).toBe(false);
      expect(result?.providers[1]).toMatchObject({ id: 'quick', state: 'fresh', fetchedAt: '2026-09-16T09:55:08.381Z' });
    });

    it('does not accept a null fetchedAt for a state the backend cannot produce it for', () => {
      const result = validateUsageReport({ providers: [{ ...backendPending, state: 'fresh' }] }, []);
      expect(result?.hadMalformedEntries).toBe(true);
      expect(result?.providers[0]?.state).toBe('failed');
    });

    it('does not accept a null fetchedAt with no state at all', () => {
      const { state: _state, ...withoutState } = backendPending;
      const result = validateUsageReport({ providers: [withoutState] }, []);
      expect(result?.hadMalformedEntries).toBe(true);
      expect(result?.providers[0]?.state).toBe('failed');
    });

    it('a report that is only a pending entry is still flagged as fully well-formed, so a caller may trust it as the authoritative full set (see usageCache.ts applyValidatedReport)', () => {
      const previous: UsageProvider = {
        id: 'gone', name: 'Gone', source: 'api', ok: true, configured: true, windows: [], balances: [],
        plan: '', note: '', asOf: null, fetchedAt: '2026-09-01T00:00:00Z', state: 'fresh',
      };
      const result = validateUsageReport({ providers: [backendPending] }, [previous]);
      expect(result?.hadMalformedEntries).toBe(false);
      expect(result?.providers.map((p) => p.id)).toEqual(['slow']);
    });
  });
});
