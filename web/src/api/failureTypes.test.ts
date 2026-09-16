import { describe, expect, it } from 'vitest';
import type { Card, Quest, Snapshot } from './types';
import {
  failureForCard,
  failureQuestExists,
  recentFailuresOf,
  type RecentFailure,
  type SnapshotFailureFields,
} from './failureTypes';

// Covers the additive recent-failure field the server may or may not send: an old snapshot must mean
// "no context at all", a loaded snapshot must answer for exactly one card id, and nothing may be shared
// between two snapshots (no cross-project cache).

function card(id: string): Card {
  return {
    id,
    name: id,
    provider: 'openai',
    lane: 'oc',
    model: 'm',
    family: 'f',
    status: 'available',
    statusSince: null,
    statusReason: '',
    statusSetBy: null,
  };
}

function quest(id: string): Quest {
  return {
    id,
    kind: 'code',
    status: 'failed',
    title: 't',
    brief: 'b',
    priority: 2,
    parents: [],
    conflicts: [],
    allowedLanes: [],
    needsOwner: '',
    reviewPage: '',
    assignee: null,
    dispatches: [],
    rulings: [],
    files: [],
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:05:00.000Z',
  };
}

function snapshot(roster: Card[], quests: Quest[] = []): Snapshot {
  return {
    generatedAt: new Date().toISOString(),
    project: { name: 'P', id: 'proj-1', lanes: [] },
    quests,
    roster,
    eligibility: {},
    env: { treeLocked: false },
    live: {},
    threads: {},
    reviewPages: [],
    unpostedBriefs: [],
    verification: null,
    laneLimits: {},
    openQuestions: 0,
  };
}

function withFailures(
  snap: Snapshot,
  recentFailures: Record<string, RecentFailure>,
): Snapshot & SnapshotFailureFields {
  return { ...snap, recentFailures };
}

const failure: RecentFailure = {
  questId: 'RUN-1',
  at: '2026-09-16T08:30:00.000Z',
  summary: 'worker exited 1',
};

describe('recentFailuresOf / failureForCard / failureQuestExists', () => {
  it('treats a snapshot without the field (old server) as no failure context at all', () => {
    const snap = snapshot([card('card-a')]);
    expect(recentFailuresOf(snap)).toEqual({});
    expect(recentFailuresOf(null)).toEqual({});
    expect(recentFailuresOf(undefined)).toEqual({});
    expect(failureForCard(snap, 'card-a')).toBeNull();
  });

  it('answers for the exact card id and never leaks context from another project snapshot', () => {
    const loaded = withFailures(snapshot([card('card-a'), card('card-b')]), { 'card-a': failure });
    expect(failureForCard(loaded, 'card-a')).toEqual(failure);
    expect(failureForCard(loaded, 'card-b')).toBeNull();

    // Same card id, but a later snapshot for another project carries no failures: nothing is cached.
    const otherProject = snapshot([card('card-a')]);
    expect(recentFailuresOf(otherProject)).toEqual({});
    expect(failureForCard(otherProject, 'card-a')).toBeNull();
  });

  it('ignores a malformed entry instead of rendering it', () => {
    const loaded = withFailures(snapshot([card('card-a')]), {
      'card-a': { questId: '', at: failure.at, summary: 'x' },
      'card-b': { questId: 'RUN-2', at: '', summary: 'x' },
      'card-c': { at: failure.at, summary: 'x' } as unknown as RecentFailure,
    });
    expect(failureForCard(loaded, 'card-a')).toBeNull();
    expect(failureForCard(loaded, 'card-b')).toBeNull();
    expect(failureForCard(loaded, 'card-c')).toBeNull();
  });

  it('treats a non-object recentFailures value as absent', () => {
    const snap = snapshot([card('card-a')]);
    const broken = { ...snap, recentFailures: 'nope' } as unknown as Snapshot;
    expect(recentFailuresOf(broken)).toEqual({});
  });

  it('only offers the drawer link when the failed quest is part of this project', () => {
    const snap = snapshot([card('card-a')], [quest('RUN-1')]);
    expect(failureQuestExists(snap, failure)).toBe(true);
    const foreign = snapshot([card('card-a')], [quest('RUN-9')]);
    expect(failureQuestExists(foreign, failure)).toBe(false);
    expect(failureQuestExists(snap, null)).toBe(false);
  });
});
