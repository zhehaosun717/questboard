import { describe, expect, it } from 'vitest';
import type { Assignee, Card, Quest, Snapshot } from '../api/types';
import { cardActivity } from './cardActivity';

function makeAssignee(partial: Partial<Assignee> & { adventurerId: string }): Assignee {
  return { family: null, lane: 'default', model: 'm1', variant: '', name: 'run1', at: '', by: '', ...partial };
}

function makeQuest(partial: Partial<Quest> & { id: string }): Quest {
  return {
    kind: 'code',
    status: 'posted',
    title: 'Test quest',
    brief: 'brief',
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
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    ...partial,
  };
}

function makeSnapshot(quests: Quest[], live: Snapshot['live'] = {}, roster: Card[] = []): Snapshot {
  return {
    generatedAt: '2026-09-13T00:00:00.000Z',
    project: { name: 'Test', lanes: ['default'] },
    quests,
    roster,
    eligibility: {},
    reviewEligibility: {},
    env: { treeLocked: false },
    live,
    threads: {},
    reviewPages: [],
    unpostedBriefs: [],
    verification: null,
    laneLimits: {},
    openQuestions: 0,
  };
}

describe('cardActivity', () => {
  it('is empty for a card that has never been dispatched', () => {
    const snap = makeSnapshot([makeQuest({ id: 'Q1' })]);
    expect(cardActivity(snap, 'card-1')).toEqual({ current: [], history: [] });
  });

  it('is empty for a blank card id, without scanning the snapshot', () => {
    const snap = makeSnapshot([makeQuest({ id: 'Q1' })]);
    expect(cardActivity(snap, '')).toEqual({ current: [], history: [] });
  });

  it('lists a quest the card is dispatched on right now as current, with the live report tied to it', () => {
    const assignee = makeAssignee({ adventurerId: 'card-1', name: 'run4' });
    const q = makeQuest({ id: 'Q1', status: 'dispatched', assignee, dispatches: [assignee] });
    const live = { run4: { state: 'coding', elapsed: 1200, edits: 3, lastText: '', tokens: null } };
    const snap = makeSnapshot([q], live);

    const activity = cardActivity(snap, 'card-1');
    expect(activity.current).toEqual([
      { questId: 'Q1', title: 'Test quest', kind: 'code', status: 'dispatched', live: live.run4 },
    ]);
    expect(activity.history).toEqual([]);
  });

  it('keeps a stalled quest current, not past: silence does not free it until release', () => {
    const assignee = makeAssignee({ adventurerId: 'card-1', name: 'run4' });
    const q = makeQuest({ id: 'Q1', status: 'stalled', assignee, dispatches: [assignee] });
    const snap = makeSnapshot([q]);

    const activity = cardActivity(snap, 'card-1');
    expect(activity.current.map((a) => a.questId)).toEqual(['Q1']);
    expect(activity.history).toEqual([]);
  });

  it('lists a quest the card is the live assignee of even when the dispatch record has not caught up', () => {
    const assignee = makeAssignee({ adventurerId: 'card-1', name: 'run4' });
    const q = makeQuest({ id: 'Q1', status: 'dispatched', assignee, dispatches: [] });
    const snap = makeSnapshot([q]);

    expect(cardActivity(snap, 'card-1').current.map((a) => a.questId)).toEqual(['Q1']);
  });

  it('lists a quest the card dispatched before, but is no longer the assignee of, as history, with no live report', () => {
    const assignee = makeAssignee({ adventurerId: 'card-1', name: 'run4' });
    const q = makeQuest({ id: 'Q1', status: 'done', assignee: null, dispatches: [assignee] });
    const snap = makeSnapshot([q]);

    const activity = cardActivity(snap, 'card-1');
    expect(activity.current).toEqual([]);
    expect(activity.history).toEqual([
      { questId: 'Q1', title: 'Test quest', kind: 'code', status: 'done', live: null },
    ]);
  });

  it('never fabricates a live report when the lane has not sent one for this run', () => {
    const assignee = makeAssignee({ adventurerId: 'card-1', name: 'run4' });
    const q = makeQuest({ id: 'Q1', status: 'dispatched', assignee, dispatches: [assignee] });
    const snap = makeSnapshot([q], {});

    expect(cardActivity(snap, 'card-1').current[0]?.live).toBeNull();
  });

  it('ties each current quest to its own live report, never mixing two runs together', () => {
    const a1 = makeAssignee({ adventurerId: 'card-1', name: 'run-a' });
    const q1 = makeQuest({ id: 'Q1', status: 'dispatched', assignee: a1, dispatches: [a1] });
    const a2 = makeAssignee({ adventurerId: 'card-1', name: 'run-b' });
    const q2 = makeQuest({ id: 'Q2', status: 'stalled', assignee: a2, dispatches: [a2] });
    const live = {
      'run-a': { state: 'coding', elapsed: 10, edits: 1, lastText: '', tokens: null },
      'run-b': { state: 'stalled', elapsed: 999, edits: 4, lastText: '', tokens: null },
    };
    const snap = makeSnapshot([q1, q2], live);

    const activity = cardActivity(snap, 'card-1');
    expect(activity.current.find((a) => a.questId === 'Q1')?.live).toEqual(live['run-a']);
    expect(activity.current.find((a) => a.questId === 'Q2')?.live).toEqual(live['run-b']);
  });

  it('flags a history entry whose quest is now held by a different card, so its status does not read as current', () => {
    const before = makeAssignee({ adventurerId: 'card-1', name: 'run-before' });
    const now = makeAssignee({ adventurerId: 'card-2', name: 'run-now' });
    const q = makeQuest({ id: 'Q1', status: 'dispatched', assignee: now, dispatches: [before, now] });
    const snap = makeSnapshot([q]);

    const activity = cardActivity(snap, 'card-1');
    expect(activity.current).toEqual([]);
    expect(activity.history).toEqual([
      { questId: 'Q1', title: 'Test quest', kind: 'code', status: 'dispatched', live: null, heldByOther: true },
    ]);
  });

  it('does not flag a history entry whose quest genuinely finished (no current holder)', () => {
    const assignee = makeAssignee({ adventurerId: 'card-1', name: 'run4' });
    const q = makeQuest({ id: 'Q1', status: 'done', assignee: null, dispatches: [assignee] });
    const snap = makeSnapshot([q]);

    const activity = cardActivity(snap, 'card-1');
    expect(activity.history[0]).not.toHaveProperty('heldByOther');
  });

  it('separates current and history across several quests, without double-counting', () => {
    const runningAssignee = makeAssignee({ adventurerId: 'card-1', name: 'run-now' });
    const running = makeQuest({ id: 'RUN', status: 'dispatched', assignee: runningAssignee, dispatches: [runningAssignee] });

    const pastAssignee = makeAssignee({ adventurerId: 'card-1', name: 'run-past' });
    const past = makeQuest({ id: 'PAST', status: 'delivered', assignee: null, dispatches: [pastAssignee] });

    const other = makeQuest({ id: 'OTHER', status: 'posted' });

    const snap = makeSnapshot([running, past, other]);
    const activity = cardActivity(snap, 'card-1');

    expect(activity.current.map((a) => a.questId)).toEqual(['RUN']);
    expect(activity.history.map((a) => a.questId)).toEqual(['PAST']);
  });
});
