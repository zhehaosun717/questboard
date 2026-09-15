import { describe, expect, it } from 'vitest';
import type { LanePackage, Verification } from '../api/types';
import type { DispatchEvent } from '../api/historyEvents';
import {
  countInvalidAt,
  emptyHistoryFilters,
  eventKindLabel,
  filterHistoryEvents,
  formatElapsed,
  formatEventClock,
  groupEventsByTask,
  hasInvalidAt,
  historyFilterOptions,
  parseEventInstant,
  parseStrictTimestamp,
  parseTimeBounds,
  splitStale,
  summarizeProjectTests,
} from './history';

/** One real-shaped event line as /api/events returns it (src/core/store.js emitEvent). */
function ev(partial: Partial<DispatchEvent> & { seq: number; event: string }): DispatchEvent {
  return {
    at: '2026-09-12T10:00:00.000Z',
    package: 'RUN-1',
    lane: 'codex',
    model: 'gpt-5.6-luna',
    variant: 'high',
    name: 'codex-run-1',
    by: 'owner',
    detail: '',
    ...partial,
  };
}

describe('history helpers', () => {
  it('formats elapsed time at 59 s, 60 s, 59 min, 60 min', () => {
    expect(formatElapsed(59 * 1000)).toBe('59s');
    expect(formatElapsed(60 * 1000)).toBe('1m');
    expect(formatElapsed(59 * 60 * 1000)).toBe('59m');
    expect(formatElapsed(60 * 60 * 1000)).toBe('1.0h');
  });

  it('formats the timeline clock with day and time', () => {
    expect(formatEventClock('2026-09-12T10:05:00.000Z')).toMatch(/09-12 \d{2}:05/);
  });

  it('splits packages into active and stale', () => {
    const base: LanePackage = {
      package: 'pkg-1',
      lane: 'codex',
      model: 'gpt-4',
      variant: '',
      name: 'worker-1',
      session: null,
      dispatchedAt: '2026-09-12T10:00:00.000Z',
      elapsed: 1000,
      state: 'running',
      reason: '',
      stale: false,
      edits: 2,
      tokens: null,
      lastText: 'working',
      bounceUntil: null,
      history: [],
    };
    const { active, stale } = splitStale([base, { ...base, package: 'pkg-2', stale: true }]);
    expect(active.map((p) => p.package)).toEqual(['pkg-1']);
    expect(stale.map((p) => p.package)).toEqual(['pkg-2']);
  });
});

describe('event labels', () => {
  it('names contract events in plain Chinese', () => {
    expect(eventKindLabel('posted')).toBe('发布委托');
    expect(eventKindLabel('review_posted')).toBe('发布复核委托');
    expect(eventKindLabel('assigned')).toBe('指派冒险者');
    expect(eventKindLabel('dispatched')).toBe('派出开工');
    expect(eventKindLabel('delivered')).toBe('交差了，待验收');
    expect(eventKindLabel('failed')).toBe('任务失败了');
    expect(eventKindLabel('bounced')).toBe('限额退回');
    expect(eventKindLabel('stalled')).toBe('失联了');
    expect(eventKindLabel('released')).toBe('释放了冒险者');
    expect(eventKindLabel('cancelled')).toBe('取消了委托');
    expect(eventKindLabel('owner_ruling')).toBe('老板裁决了');
    expect(eventKindLabel('delivery_write_failed')).toBe('交差文件没写成');
  });

  it('maps every real status_<QUEST_STATUS> line to quest vocabulary (src/core/store.js QUEST_STATUSES)', () => {
    expect(eventKindLabel('status_done')).toBe('委托状态：已完成');
    expect(eventKindLabel('status_needs_owner')).toBe('委托状态：等裁决');
    expect(eventKindLabel('status_owner_playtest')).toBe('委托状态：等你试玩');
    expect(eventKindLabel('status_reviewing')).toBe('委托状态：复核中');
    expect(eventKindLabel('status_superseded')).toBe('委托状态：已取代');
    expect(eventKindLabel('status_lane_limited')).toBe('委托状态：接入方式受限');
  });

  it('shows an unrecognised status_* suffix and a wholly unknown event verbatim, never guessing', () => {
    // 'limited' is a CARD status (src/core/status.js STATUSES), never a QUEST_STATUS the events file
    // can carry (store.js only ever writes status_<QUEST_STATUS>). A card status has no event of its
    // own, so an unrecognised suffix must show verbatim rather than borrow the card vocabulary
    // (review 7caf4034: the old CARD_STATUS branch and its status_limited fixture were not real-shaped).
    expect(eventKindLabel('status_limited')).toBe('状态记录：limited');
    expect(eventKindLabel('status_weird')).toBe('状态记录：weird');
    expect(eventKindLabel('mystery_event')).toBe('mystery_event');
  });
});

describe('filters', () => {
  const events: DispatchEvent[] = [
    ev({ seq: 1, at: '2026-09-10T08:00:00.000Z', event: 'posted', package: 'RUN-9', lane: null, model: null, variant: null, name: null }),
    ev({ seq: 2, at: '2026-09-10T08:01:00.000Z', event: 'dispatched', package: 'RUN-9', lane: 'codex', model: 'gpt-5.6-luna' }),
    ev({ seq: 3, at: '2026-09-11T09:00:00.000Z', event: 'dispatched', package: 'RUN-10', lane: 'agy', model: 'gemini-3' }),
    ev({ seq: 4, at: '2026-09-11T09:30:00.000Z', event: 'delivered', package: 'RUN-10', lane: 'agy', model: 'gemini-3' }),
    // 'failed' is the store's own event for a failure (store.js STATUS_EVENTS); it never writes
    // status_failed. status_needs_owner is a real status_* line (review 25756a14 Q8).
    ev({ seq: 5, at: '2026-09-11T10:00:00.000Z', event: 'status_needs_owner', package: 'RUN-9', lane: null, model: null, variant: null, name: null, detail: '钱用完了' }),
  ];

  it('combines package text, lane, model, kind and time (AND)', () => {
    const range = parseTimeBounds('2026-09-11T00:00:00', '');
    expect(range.error).toBeNull();
    const got = filterHistoryEvents(
      events,
      { ...emptyHistoryFilters, packageText: 'run-1', lane: 'agy', eventKind: 'dispatched' },
      range,
    );
    expect(got.map((e) => e.seq)).toEqual([3]);
  });

  it('package text is case-insensitive substring; empty filters pass everything', () => {
    expect(filterHistoryEvents(events, { ...emptyHistoryFilters, packageText: 'RuN-9' }, null).length).toBe(3);
    expect(filterHistoryEvents(events, emptyHistoryFilters, null).length).toBe(5);
  });

  it('the status kind choice selects only status lines', () => {
    const got = filterHistoryEvents(events, { ...emptyHistoryFilters, eventKind: 'status_*' }, null);
    expect(got.map((e) => e.seq)).toEqual([5]);
  });

  it('refuses invalid and inverted time windows by name', () => {
    expect(parseTimeBounds('not-a-date', '').error).toBe('开始时间不是有效时间');
    expect(parseTimeBounds('', 'garbage').error).toBe('结束时间不是有效时间');
    expect(parseTimeBounds('2026-13-45', '').error).toBe('开始时间不是有效时间');
    expect(parseTimeBounds('2026-09-11T10:00', '2026-09-11T09:00').error).toBe('开始时间晚于结束时间');
    expect(parseTimeBounds('', '').error).toBeNull();
  });

  it('a refused time window does not hide anything (error shown, range unapplied)', () => {
    const bad = parseTimeBounds('garbage', '2026-09-11T10:00');
    const got = filterHistoryEvents(events, emptyHistoryFilters, bad);
    expect(got.length).toBe(5);
  });

  it('options only offer what was loaded, grouping status lines into one choice', () => {
    const options = historyFilterOptions(events);
    expect(options.lanes).toEqual(['agy', 'codex']);
    expect(options.models).toEqual(['gemini-3', 'gpt-5.6-luna']);
    expect(options.kinds).toContain('status_*');
    expect(options.kinds).not.toContain('status_failed');
    expect(options.kinds.indexOf('posted')).toBeLessThan(options.kinds.indexOf('delivered'));
  });

  it('an unknown kind sorts after every known kind, never first (Q9: not indexOf(-1) first)', () => {
    const withUnknown = [...events, ev({ seq: 6, event: 'legacy_note', package: 'RUN-9' })];
    const options = historyFilterOptions(withUnknown);
    expect(options.kinds.at(-1)).toBe('legacy_note');
    expect(options.kinds.indexOf('legacy_note')).toBeGreaterThan(options.kinds.indexOf('posted'));
  });
});

// datetime-local always reads back as LOCAL wall-clock time, whatever the test runner's own timezone
// is (review 25756a14's own probe ran Asia/Shanghai; this suite may run anywhere) — so a fixture must
// build the input string from the same instant, not assume local time equals UTC.
function localInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

describe('time bounds: minute granularity and invalid `at` (review 25756a14 Q6/Q7)', () => {
  it('an end time covers the whole selected minute, not just its first instant (Q6)', () => {
    const bounds = parseTimeBounds('', localInput('2026-09-11T09:00:00.000Z'));
    expect(bounds.error).toBeNull();
    const events: DispatchEvent[] = [
      ev({ seq: 1, at: '2026-09-11T09:00:00.000Z', event: 'dispatched' }),
      ev({ seq: 2, at: '2026-09-11T09:00:30.000Z', event: 'dispatched' }), // inside the same minute
      ev({ seq: 3, at: '2026-09-11T09:01:00.000Z', event: 'dispatched' }), // the next minute: excluded
    ];
    const got = filterHistoryEvents(events, emptyHistoryFilters, bounds);
    expect(got.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('an end minute equal to the start minute is a valid (non-inverted) one-minute window', () => {
    expect(parseTimeBounds('2026-09-11T09:00', '2026-09-11T09:00').error).toBeNull();
  });

  it('flags which records have an unparseable `at` (used by the filter bar note, never a fabricated date)', () => {
    const events: DispatchEvent[] = [
      ev({ seq: 1, at: '2026-09-11T09:00:00.000Z', event: 'dispatched' }),
      ev({ seq: 2, at: 'not-a-date', event: 'dispatched' }),
    ];
    expect(hasInvalidAt(events[1]!)).toBe(true);
    expect(hasInvalidAt(events[0]!)).toBe(false);
    expect(countInvalidAt(events)).toBe(1);
  });

  it('a record with an unparseable `at` is never silently dropped by an active time window (Q7)', () => {
    const bounds = parseTimeBounds(
      localInput('2026-09-11T09:00:00.000Z'),
      localInput('2026-09-11T09:30:00.000Z'),
    );
    expect(bounds.error).toBeNull();
    const events: DispatchEvent[] = [
      ev({ seq: 1, at: '2026-09-11T09:15:00.000Z', event: 'dispatched' }),
      ev({ seq: 2, at: 'not-a-date', event: 'dispatched' }),
      ev({ seq: 3, at: '2026-09-11T10:00:00.000Z', event: 'dispatched' }), // outside the window: excluded
    ];
    const got = filterHistoryEvents(events, emptyHistoryFilters, bounds);
    expect(got.map((e) => e.seq)).toEqual([1, 2]);
  });
});

describe('no status-line folding: every real state change is a main line (review 25756a14 B3/Q1)', () => {
  // Both status_dispatched and status_posted looked like echoes of an already-visible main line, but
  // their only real producers are a stall recovery (sync.js via dispatcher.js) and a manual reopen
  // (questRoutes.js) respectively — neither repeats anything already on the board. With no genuine
  // noise kind left, there is no folding concept any more: groupEventsByTask just returns every record.
  const events = [
    ev({ seq: 1, event: 'dispatched', package: 'A' }),
    ev({ seq: 2, event: 'status_dispatched', package: 'A' }), // stall recovery: a real state change
    ev({ seq: 3, event: 'status_done', package: 'A' }),
  ];

  it('filters never drop status records, and grouping keeps every one of them as a visible line', () => {
    const got = filterHistoryEvents(events, emptyHistoryFilters, null);
    expect(got.map((e) => e.seq)).toEqual([1, 2, 3]);
    const [group] = groupEventsByTask(got);
    if (!group) throw new Error('expected one task group');
    expect(group.events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('a stall recovery (status_dispatched) is a real record: a stalled task keeps its own line', () => {
    const [group] = groupEventsByTask([
      ev({ seq: 1, event: 'dispatched', package: 'A' }),
      ev({ seq: 2, event: 'stalled', package: 'A' }),
      ev({ seq: 3, event: 'status_dispatched', package: 'A' }), // the worker came back
    ]);
    if (!group) throw new Error('expected one task group');
    expect(group.events.map((e) => e.event)).toEqual(['dispatched', 'stalled', 'status_dispatched']);
  });

  it('a manual reopen (status_posted) is also a real record, not an echo of the original posted line', () => {
    const [group] = groupEventsByTask([
      ev({ seq: 1, event: 'posted', package: 'A' }),
      ev({ seq: 2, event: 'failed', package: 'A' }),
      ev({ seq: 3, event: 'status_posted', package: 'A' }), // reopened after failure
    ]);
    if (!group) throw new Error('expected one task group');
    expect(group.events.map((e) => e.event)).toEqual(['posted', 'failed', 'status_posted']);
  });

  it('a model filter keeps matching status records visible in the count', () => {
    const withLane = [...events, ev({ seq: 9, event: 'status_needs_owner', package: 'B', model: 'gpt-5.6-luna', lane: 'codex' })];
    const got = filterHistoryEvents(withLane, { ...emptyHistoryFilters, model: 'gpt-5.6-luna' }, null);
    expect(got.map((e) => e.seq)).toEqual([1, 2, 3, 9]);
  });

  it('a package filter narrowed to a single card returns every one of its records', () => {
    const events2: DispatchEvent[] = [
      ev({ seq: 1, event: 'posted', package: 'RUN-9', lane: null, model: null, variant: null, name: null }),
      ev({ seq: 2, event: 'dispatched', package: 'RUN-9' }),
      ev({ seq: 3, event: 'status_dispatched', package: 'RUN-9' }),
      ev({ seq: 4, event: 'status_reviewing', package: 'RUN-9' }),
      ev({ seq: 5, event: 'delivered', package: 'RUN-9' }),
      ev({ seq: 6, event: 'posted', package: 'RUN-10' }),
    ];
    const got = filterHistoryEvents(events2, { ...emptyHistoryFilters, packageText: 'RUN-9' }, null);
    expect(got.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('grouping', () => {
  it('groups by task, newest task first, story order inside', () => {
    const groups = groupEventsByTask([
      ev({ seq: 1, event: 'posted', package: 'A' }),
      ev({ seq: 2, event: 'dispatched', package: 'B' }),
      ev({ seq: 3, event: 'delivered', package: 'A' }),
      ev({ seq: 5, event: 'released', package: 'A' }),
      ev({ seq: 4, event: 'failed', package: 'B' }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(['A', 'B']);
    const [groupA, groupB] = groups;
    if (!groupA || !groupB) throw new Error('expected two task groups');
    expect(groupA.events.map((e) => e.seq)).toEqual([1, 3, 5]);
    expect(groupB.events.map((e) => e.seq)).toEqual([2, 4]);
  });

  it('keeps interleaved main and status lines in real seq order regardless of input order (B1)', () => {
    // The events file may arrive in any order; a status_reviewing line that happened between two main
    // events must stay between them in `events`, never be pushed after later main lines just because
    // it is a status_* kind (review 7caf4034 B1: no "main lines then all status lines" reordering).
    const [group] = groupEventsByTask([
      ev({ seq: 5, event: 'delivered', package: 'A' }),
      ev({ seq: 1, event: 'posted', package: 'A' }),
      ev({ seq: 3, event: 'status_dispatched', package: 'A' }),
      ev({ seq: 2, event: 'dispatched', package: 'A' }),
      ev({ seq: 4, event: 'status_reviewing', package: 'A' }),
    ]);
    if (!group) throw new Error('expected one task group');
    expect(group.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(group.events.map((e) => e.event)).toEqual([
      'posted', 'dispatched', 'status_dispatched', 'status_reviewing', 'delivered',
    ]);
  });
});

describe('parseStrictTimestamp: never delegates to Date.parse (review 73f4bd71 B2)', () => {
  it('accepts a full ISO instant with Z, matching what store.js now() actually writes', () => {
    expect(parseStrictTimestamp('2026-09-12T10:00:00.000Z')).toBe(Date.UTC(2026, 8, 12, 10, 0, 0, 0));
  });

  it('accepts a numeric offset and converts it to the same UTC instant as Z would', () => {
    expect(parseStrictTimestamp('2026-09-12T18:00:00+08:00')).toBe(Date.UTC(2026, 8, 12, 10, 0, 0, 0));
  });

  it('accepts the naive, no-offset shape a datetime-local input supplies (the supported legacy shape)', () => {
    const ms = parseStrictTimestamp('2026-09-11T09:00');
    expect(ms).toBe(new Date(2026, 8, 11, 9, 0, 0, 0).getTime());
  });

  it('rejects a calendar-impossible date instead of rolling it into a different real one', () => {
    // Date.parse('2026-02-31T10:00:00Z') silently becomes 2026-03-03 in V8; this must not.
    expect(parseStrictTimestamp('2026-02-31T10:00:00.000Z')).toBeNull();
    expect(parseStrictTimestamp('2026-13-01T10:00:00.000Z')).toBeNull(); // month 13
    expect(parseStrictTimestamp('2026-01-01T24:00:00.000Z')).toBeNull(); // hour 24
    expect(parseStrictTimestamp('2026-01-01T10:60:00.000Z')).toBeNull(); // minute 60
  });

  it('honours real leap years and rejects Feb 29 on a non-leap year', () => {
    expect(parseStrictTimestamp('2024-02-29T00:00:00.000Z')).not.toBeNull(); // 2024 is a leap year
    expect(parseStrictTimestamp('2026-02-29T00:00:00.000Z')).toBeNull(); // 2026 is not
  });

  it('rejects a wholly non-date string instead of coercing it into a plausible-looking one', () => {
    // Date.parse('legacy 5') becomes 2001-05-01 in V8 because it contains a lone digit; a strict
    // parser must not treat this shape as a date at all.
    expect(parseStrictTimestamp('legacy 5')).toBeNull();
    expect(parseStrictTimestamp('not a date 5')).toBeNull();
    expect(parseStrictTimestamp('')).toBeNull();
    expect(parseStrictTimestamp('乱')).toBeNull();
  });

  it('years 0000-0099 are their own real years, never fabricated into 1900-1999 (revision 5 date note 6)', () => {
    // The multi-arg `new Date(44, ...)` / `Date.UTC(44, ...)` legacy remap silently turns year 44 into
    // 1944 (`getUTCFullYear()` reveals the true stored year regardless of how it was constructed, so
    // this checks what actually got stored rather than repeating the buggy construction in the test).
    const utc = parseStrictTimestamp('0044-03-01T00:00:00.000Z');
    expect(utc).not.toBeNull();
    const utcDate = new Date(utc!);
    expect(utcDate.getUTCFullYear()).toBe(44);
    expect(utcDate.getUTCMonth()).toBe(2); // March
    expect(utcDate.getUTCDate()).toBe(1);

    // Same fix for the naive/local branch (datetime-local's own shape).
    const local = parseStrictTimestamp('0099-01-01T00:00');
    expect(local).not.toBeNull();
    const localDate = new Date(local!);
    expect(localDate.getFullYear()).toBe(99);
  });

  it('year 0000 itself is valid and a leap year (divisible by 400)', () => {
    const ms = parseStrictTimestamp('0000-02-29T00:00:00.000Z');
    expect(ms).not.toBeNull();
    expect(new Date(ms!).getUTCFullYear()).toBe(0);
  });
});

describe('parseEventInstant: event `at` values require the documented offset shape (revision 5 date note 6)', () => {
  it('accepts the same offset-bearing instants parseStrictTimestamp does', () => {
    expect(parseEventInstant('2026-09-12T10:00:00.000Z')).toBe(Date.UTC(2026, 8, 12, 10, 0, 0, 0));
    expect(parseEventInstant('2026-09-12T18:00:00+08:00')).toBe(Date.UTC(2026, 8, 12, 10, 0, 0, 0));
  });

  it('rejects the naive, no-offset shape instead of silently guessing a timezone for the log', () => {
    // store.js now() always writes Z; a naive `at` is not that documented shape, so unlike a filter
    // bound (parseStrictTimestamp), it does not get interpreted as local time here — it stays unknown.
    expect(parseEventInstant('2026-09-11T09:00')).toBeNull();
    expect(parseStrictTimestamp('2026-09-11T09:00')).not.toBeNull(); // still fine for filter bounds
  });

  it('still rejects calendar-impossible and non-date strings, same as parseStrictTimestamp', () => {
    expect(parseEventInstant('2026-02-31T10:00:00.000Z')).toBeNull();
    expect(parseEventInstant('legacy 5')).toBeNull();
  });

  it('formatEventClock and hasInvalidAt now use this, so a naive `at` shows raw and counts as invalid', () => {
    const naive = ev({ seq: 1, at: '2026-09-11T09:00', event: 'dispatched' });
    expect(hasInvalidAt(naive)).toBe(true);
    expect(formatEventClock(naive.at)).toBe('2026-09-11T09:00'); // shown verbatim, never fabricated
  });
});

describe('filters: onlyInvalidAt inspects the records a time window could not judge', () => {
  const events: DispatchEvent[] = [
    ev({ seq: 1, at: '2026-09-11T09:00:00.000Z', event: 'dispatched' }),
    ev({ seq: 2, at: 'not-a-date', event: 'dispatched' }),
    ev({ seq: 3, at: '2026-02-31T10:00:00.000Z', event: 'failed' }), // impossible date, also invalid
  ];

  it('narrows to exactly the records with an unparseable at, combining with other filters (AND)', () => {
    const got = filterHistoryEvents(events, { ...emptyHistoryFilters, onlyInvalidAt: true }, null);
    expect(got.map((e) => e.seq)).toEqual([2, 3]);
  });

  it('combines with an event-kind filter', () => {
    const got = filterHistoryEvents(
      events,
      { ...emptyHistoryFilters, onlyInvalidAt: true, eventKind: 'failed' },
      null,
    );
    expect(got.map((e) => e.seq)).toEqual([3]);
  });
});

describe('project tests summary', () => {
  const verification: Verification = {
    steps: [
      { name: 'build', kind: 'exit', value: '0' },
      { name: 'build', kind: 'exit', value: '1' },
      { name: 'test', kind: 'errorCS', value: '2' },
      { name: 'test', kind: 'errorCS', value: '0' },
      { name: 'DONE', kind: 'done', value: '' },
    ],
    done: true,
    editXml: { total: 12, passed: 11, failed: 1 },
    playXml: null,
  };

  it('keeps only the latest verdict per step name', () => {
    const s = summarizeProjectTests(verification);
    expect(s.lines).toEqual([
      { name: 'build', verdict: 'fail', value: '退出码 1' },
      { name: 'test', verdict: 'pass', value: '无错误' },
      { name: 'DONE', verdict: 'done', value: '完成' },
    ]);
  });

  it('is 有失败 when any step or suite fails, even if the log says DONE', () => {
    const s = summarizeProjectTests(verification);
    expect(s.overall).toBe('fail');
    expect(s.suites).toEqual([{ label: 'Edit 场景', passed: 11, total: 12 }]);
  });

  it('reports 通过 only when every line and suite passes, and 进行中 while not done', () => {
    expect(
      summarizeProjectTests({ steps: [{ name: 'test', kind: 'exit', value: '0' }], done: true, editXml: null, playXml: null }).overall,
    ).toBe('pass');
    expect(
      summarizeProjectTests({ steps: [], done: false, editXml: null, playXml: null }).overall,
    ).toBe('running');
  });
});
