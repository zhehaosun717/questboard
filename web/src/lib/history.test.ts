import { describe, expect, it } from 'vitest';
import type { LanePackage } from '../api/types';
import { formatElapsed, recentEvents, splitStale } from './history';

describe('history helpers', () => {
  it('formats elapsed time at 59 s, 60 s, 59 min, 60 min', () => {
    // 59 seconds
    expect(formatElapsed(59 * 1000)).toBe('59s');
    // 60 seconds
    expect(formatElapsed(60 * 1000)).toBe('1m');
    // 59 minutes
    expect(formatElapsed(59 * 60 * 1000)).toBe('59m');
    // 60 minutes
    expect(formatElapsed(60 * 60 * 1000)).toBe('1.0h');
  });

  it('splits packages into active and stale', () => {
    const packages: LanePackage[] = [
      {
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
      },
      {
        package: 'pkg-2',
        lane: 'agy',
        model: 'gemini-1.5-pro',
        variant: '',
        name: 'worker-2',
        session: null,
        dispatchedAt: '2026-09-08T10:00:00.000Z',
        elapsed: 50000,
        state: 'delivered',
        reason: '',
        stale: true,
        edits: 5,
        tokens: null,
        lastText: 'done',
        bounceUntil: null,
        history: [],
      },
      {
        package: 'pkg-3',
        lane: 'opencode',
        model: 'claude-3.5-sonnet',
        variant: '',
        name: 'worker-3',
        session: null,
        dispatchedAt: '2026-09-12T11:00:00.000Z',
        elapsed: 2000,
        state: 'running',
        reason: '',
        stale: false,
        edits: 1,
        tokens: null,
        lastText: 'working',
        bounceUntil: null,
        history: [],
      },
    ];

    const { active, stale } = splitStale(packages);
    expect(active.map((p) => p.package)).toEqual(['pkg-1', 'pkg-3']);
    expect(stale.map((p) => p.package)).toEqual(['pkg-2']);
  });

  it('orders recent events newest-first and respects limit', () => {
    const packages: LanePackage[] = [
      {
        package: 'pkg-a',
        lane: 'codex',
        model: 'gpt-4',
        variant: '',
        name: 'worker-a',
        session: null,
        dispatchedAt: '2026-09-12T10:00:00.000Z',
        elapsed: 1000,
        state: 'running',
        reason: '',
        stale: false,
        edits: 0,
        tokens: null,
        lastText: '',
        bounceUntil: null,
        history: [
          {
            at: '2026-09-12T10:00:00.000Z',
            event: 'dispatch',
            lane: 'codex',
            model: 'gpt-4',
          },
          {
            at: '2026-09-12T10:05:00.000Z',
            event: 'note',
            text: 'note 1',
          },
        ],
      },
      {
        package: 'pkg-b',
        lane: 'agy',
        model: 'gemini',
        variant: '',
        name: 'worker-b',
        session: null,
        dispatchedAt: '2026-09-12T10:02:00.000Z',
        elapsed: 1000,
        state: 'running',
        reason: '',
        stale: false,
        edits: 0,
        tokens: null,
        lastText: '',
        bounceUntil: null,
        history: [
          {
            at: '2026-09-12T10:02:00.000Z',
            event: 'dispatch',
            lane: 'agy',
            model: 'gemini',
          },
          {
            at: '2026-09-12T10:08:00.000Z',
            event: 'note',
            text: 'note 2',
          },
        ],
      },
    ];

    const events = recentEvents(packages, 3);
    expect(events.length).toBe(3);
    // Newest first
    expect(events[0]?.at).toBe('2026-09-12T10:08:00.000Z');
    expect(events[0]?.package).toBe('pkg-b');
    expect(events[1]?.at).toBe('2026-09-12T10:05:00.000Z');
    expect(events[1]?.package).toBe('pkg-a');
    expect(events[2]?.at).toBe('2026-09-12T10:02:00.000Z');
    expect(events[2]?.package).toBe('pkg-b');
  });
});
