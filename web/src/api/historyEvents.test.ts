import { describe, expect, it } from 'vitest';
import {
  HISTORY_PAGE_SIZE,
  HistoryProtocolError,
  fetchEventsPage,
  mergeEventsBySeq,
  parseDispatchEvent,
} from './historyEvents';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
}

const raw = {
  seq: 7,
  at: '2026-09-12T10:00:00.000Z',
  event: 'dispatched',
  package: 'RUN-1',
  lane: 'codex',
  model: 'gpt-5.6-luna',
  variant: null,
  name: 'codex-run-1',
  by: 'owner',
  detail: 'x',
};

describe('parseDispatchEvent (boundary validation)', () => {
  it('accepts a real-shaped record and keeps nulls as null', () => {
    const parsed = parseDispatchEvent(raw);
    expect(parsed.seq).toBe(7);
    expect(parsed.variant).toBeNull();
    expect(parsed.by).toBe('owner');
  });

  it('refuses records without seq / at / event, naming the problem', () => {
    expect(() => parseDispatchEvent({ ...raw, seq: undefined })).toThrow(/seq/);
    expect(() => parseDispatchEvent({ ...raw, at: '' })).toThrow(/at/);
    expect(() => parseDispatchEvent({ ...raw, event: null })).toThrow(/event/);
    expect(() => parseDispatchEvent('nope')).toThrow(/对象/);
  });

  // Revision 6 privacy fix: a bad record can carry anything (secrets, long tokens) in its other fields —
  // the refusal must classify the fixed reason (a type name) and never echo the raw record content back
  // into a user-facing error.
  it('never echoes the raw record body into the missing-seq error (privacy)', () => {
    const secret = { ...raw, seq: 'not-a-number', detail: 'token=super-secret-value' };
    try {
      parseDispatchEvent(secret);
      throw new Error('expected parseDispatchEvent to throw');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toMatch(/seq/);
      expect(message).not.toContain('super-secret-value');
      expect(message).not.toContain(raw.package);
    }
  });
});

describe('fetchEventsPage: end of log is proven only by an empty, cursor-unchanged page (B5)', () => {
  it('requests the cursor window and marks a non-empty page as not-at-end', async () => {
    const seen: string[] = [];
    const page = await fetchEventsPage(7, {
      limit: 2,
      fetchImpl: (url: string) => {
        seen.push(url);
        return jsonResponse({ events: [raw, { ...raw, seq: 8 }], nextAfter: 8 });
      },
    });
    expect(seen[0]).toBe('/api/events?after=7&limit=2');
    expect(page.events.map((e) => e.seq)).toEqual([7, 8]);
    expect(page.nextAfter).toBe(8);
    expect(page.atEnd).toBe(false);
  });

  it('a short but non-empty page is never atEnd by itself, however far short of the requested limit', async () => {
    // The real contract only ever returns records with seq > after (src/core/events.js eventsAfter);
    // a fixture where the lone event's own seq equals the cursor would never happen for real.
    const page = await fetchEventsPage(6, {
      limit: 500,
      fetchImpl: () => jsonResponse({ events: [raw], nextAfter: 7 }),
    });
    expect(page.atEnd).toBe(false);
  });

  it('an empty page whose cursor did not move is the one and only proof of the end', async () => {
    const page = await fetchEventsPage(500, {
      limit: 500,
      fetchImpl: () => jsonResponse({ events: [], nextAfter: 500 }),
    });
    expect(page.events).toEqual([]);
    expect(page.atEnd).toBe(true);
    expect(page.nextAfter).toBe(500);
  });

  it('never claims atEnd off a requested limit the server would clamp below (N3)', async () => {
    // The server clamps limit to its own cap (questRoutes.js EVENTS_MAX = 500 today) no matter what
    // the client asks for. A full page at that real cap must not be misread as "the log ended here"
    // just because it fell short of a larger requested limit.
    const full = Array.from({ length: HISTORY_PAGE_SIZE }, (_, i) => ({ ...raw, seq: i + 1 }));
    const page = await fetchEventsPage(0, {
      limit: 5000,
      fetchImpl: () => jsonResponse({ events: full, nextAfter: HISTORY_PAGE_SIZE }),
    });
    expect(page.events.length).toBe(HISTORY_PAGE_SIZE);
    expect(page.atEnd).toBe(false);
  });

  it('a server clamped to a smaller cap than today\'s 500 still never ends the log on a short page alone', async () => {
    // B5: the client must never hardcode 500 (or any number) as "the" server cap. A server that caps
    // at 200 returns a full page of exactly its own size; that alone proves nothing about the end.
    const clamped = Array.from({ length: 200 }, (_, i) => ({ ...raw, seq: i + 1 }));
    const page = await fetchEventsPage(0, {
      limit: 500,
      fetchImpl: () => jsonResponse({ events: clamped, nextAfter: 200 }),
    });
    expect(page.events.length).toBe(200);
    expect(page.atEnd).toBe(false);
  });

  it('an exact multiple of the page size still needs its own empty-page confirmation', async () => {
    const full = Array.from({ length: HISTORY_PAGE_SIZE }, (_, i) => ({ ...raw, seq: i + 1 }));
    const page = await fetchEventsPage(0, {
      limit: HISTORY_PAGE_SIZE,
      fetchImpl: () => jsonResponse({ events: full, nextAfter: HISTORY_PAGE_SIZE }),
    });
    expect(page.atEnd).toBe(false); // the caller must ask again; only an empty page proves the end
  });

  it('refuses a cursor that fails to advance despite receiving events (stalled cursor guard)', async () => {
    await expect(
      fetchEventsPage(10, {
        limit: 500,
        fetchImpl: () => jsonResponse({ events: [{ ...raw, seq: 11 }], nextAfter: 10 }),
      }),
    ).rejects.toThrow(HistoryProtocolError);
  });

  it('refuses an empty page whose cursor moved anyway — that page proves nothing, honestly (B5)', async () => {
    await expect(
      fetchEventsPage(500, {
        limit: 500,
        fetchImpl: () => jsonResponse({ events: [], nextAfter: 600 }),
      }),
    ).rejects.toThrow(HistoryProtocolError);
  });

  it('refuses a missing nextAfter as a protocol error, never inventing one from the last event\'s own seq', async () => {
    // The project rule is that missing data fails loudly; a client-side guess would hide a real
    // server-side contract break behind a plausible-looking number (review 73f4bd71 non-blocking #4).
    // It classifies as HistoryProtocolError (revision 5 D1): retrying at the same cursor cannot recover,
    // so the caller must offer "从头重新读取", not a same-cursor 重试.
    const call = fetchEventsPage(7, {
      limit: 500,
      fetchImpl: () => jsonResponse({ events: [{ ...raw, seq: 9 }] }),
    });
    await expect(call).rejects.toThrow(HistoryProtocolError);
    await expect(call).rejects.toThrow(/nextAfter/);
  });

  it('refuses a non-integer nextAfter as a protocol error (revision 5 D1)', async () => {
    const call = fetchEventsPage(7, {
      limit: 500,
      fetchImpl: () => jsonResponse({ events: [{ ...raw, seq: 9 }], nextAfter: 'nine' }),
    });
    await expect(call).rejects.toThrow(HistoryProtocolError);
    await expect(call).rejects.toThrow(/nextAfter/);
  });

  // Revision 6 same-action copy + privacy: the message must point at the button that is actually
  // visible during an error (从头重新读取), never the toolbar's own 全部重新读取 (hidden while erroring
  // — HistoryView.tsx only shows it when `!hist.error`), and must never echo the raw bad value back.
  it('protocol errors name the visible retry button, not the hidden toolbar one, and omit the raw value', async () => {
    const call = fetchEventsPage(7, {
      limit: 500,
      fetchImpl: () => jsonResponse({ events: [{ ...raw, seq: 9 }], nextAfter: 'nine' }),
    });
    try {
      await call;
      throw new Error('expected fetchEventsPage to throw');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain('从头重新读取');
      expect(message).not.toContain('全部重新读取');
      expect(message).not.toContain('nine');
    }
  });

  it('surfaces HTTP refusals with the server reason', async () => {
    await expect(
      fetchEventsPage(7, {
        fetchImpl: () => jsonResponse({ error: 'after must be a non-negative integer' }, false, 400),
      }),
    ).rejects.toThrow('事件接口返回 400：after must be a non-negative integer');
  });

  it('refuses a body without an events array', async () => {
    await expect(fetchEventsPage(7, { fetchImpl: () => jsonResponse({}) })).rejects.toThrow(/events 数组/);
  });
});

describe('mergeEventsBySeq', () => {
  it('same seq once, distinct seqs both kept even when identical', () => {
    const a = parseDispatchEvent(raw);
    const b = parseDispatchEvent({ ...raw, seq: 8 });
    const merged = mergeEventsBySeq([a, b], [b, parseDispatchEvent({ ...raw, seq: 9 })]);
    expect(merged.map((e) => e.seq)).toEqual([7, 8, 9]);
  });
});
