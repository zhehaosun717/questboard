import { describe, expect, it } from 'vitest';
import type { Card, Quest, Snapshot } from '../api/types';
import { buildGraph } from './graphLayout';

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

function makeSnapshot(quests: Quest[] = [], roster: Card[] = []): Snapshot {
  return {
    generatedAt: '2026-09-13T00:00:00.000Z',
    project: { name: 'Test', lanes: ['default'] },
    quests,
    roster,
    eligibility: {},
    reviewEligibility: {},
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

describe('graphLayout buildGraph', () => {
  it('parents are left of children (x increases)', () => {
    const parent = makeQuest({ id: 'P1' });
    const child = makeQuest({ id: 'C1', parents: ['P1'] });
    const snap = makeSnapshot([parent, child]);

    const { nodes, edges } = buildGraph(snap, ['P1', 'C1']);

    const parentNode = nodes.find((n) => n.id === 'P1');
    const childNode = nodes.find((n) => n.id === 'C1');

    expect(parentNode).toBeDefined();
    expect(childNode).toBeDefined();
    expect(parentNode!.position.x).toBeLessThan(childNode!.position.x);

    const parentChildEdge = edges.find((e) => e.source === 'P1' && e.target === 'C1');
    expect(parentChildEdge).toBeDefined();
    expect(parentChildEdge?.style?.stroke).toBe('#2b2118');
    expect(parentChildEdge?.style?.strokeDasharray).toBe('6 5');
  });

  it('card nodes exist for dispatched cards', () => {
    const q = makeQuest({
      id: 'Q1',
      dispatches: [
        {
          adventurerId: 'card-1',
          family: null,
          lane: 'default',
          model: 'm1',
          variant: '',
          name: 'w1',
          at: '',
          by: '',
        },
      ],
    });
    const card: Card = {
      id: 'card-1',
      name: 'Agent 1',
      provider: 'test',
      lane: 'default',
      model: 'test',
      family: 'test',
      status: 'available',
      statusSince: null,
      statusReason: '',
      statusSetBy: null,
    };
    const snap = makeSnapshot([q], [card]);

    const { nodes } = buildGraph(snap, ['Q1']);

    const cardNode = nodes.find((n) => n.id === 'card-1');
    const questNode = nodes.find((n) => n.id === 'Q1');

    expect(cardNode).toBeDefined();
    expect(cardNode?.type).toBe('card');
    expect(questNode).toBeDefined();
    expect(questNode?.type).toBe('quest');
    expect(cardNode!.position.x).toBeLessThan(questNode!.position.x);
  });

  it('running vs past dispatch edge colours', () => {
    const qRunning = makeQuest({
      id: 'Q_run',
      status: 'dispatched',
      assignee: {
        adventurerId: 'card-run',
        family: null,
        lane: 'default',
        model: 'm1',
        variant: '',
        name: 'w1',
        at: '',
        by: '',
      },
      dispatches: [
        {
          adventurerId: 'card-run',
          family: null,
          lane: 'default',
          model: 'm1',
          variant: '',
          name: 'w1',
          at: '',
          by: '',
        },
      ],
    });

    const qPast = makeQuest({
      id: 'Q_past',
      status: 'posted',
      assignee: null,
      dispatches: [
        {
          adventurerId: 'card-past',
          family: null,
          lane: 'default',
          model: 'm2',
          variant: '',
          name: 'w2',
          at: '',
          by: '',
        },
      ],
    });

    const snap = makeSnapshot([qRunning, qPast]);
    const { edges } = buildGraph(snap, ['Q_run', 'Q_past']);

    const runningEdge = edges.find((e) => e.source === 'card-run' && e.target === 'Q_run');
    const pastEdge = edges.find((e) => e.source === 'card-past' && e.target === 'Q_past');

    expect(runningEdge).toBeDefined();
    expect(runningEdge?.style?.stroke).toBe('#3f6f9e');

    expect(pastEdge).toBeDefined();
    expect(pastEdge?.style?.stroke).toBe('#9cc2e8');
  });

  it('conflict edges', () => {
    const q1 = makeQuest({ id: 'Q1', conflicts: ['Q2'] });
    const q2 = makeQuest({ id: 'Q2' });
    const snap = makeSnapshot([q1, q2]);

    const { edges } = buildGraph(snap, ['Q1', 'Q2']);

    const conflictEdge = edges.find(
      (e) => (e.source === 'Q1' && e.target === 'Q2') || (e.source === 'Q2' && e.target === 'Q1'),
    );

    expect(conflictEdge).toBeDefined();
    expect(conflictEdge?.data?.kind).toBe('conflict');
    expect(conflictEdge?.style?.stroke).toBe('#a8322a');
    expect(conflictEdge?.style?.strokeDasharray).toBe('2 5');
  });

  it('a cycle in parents does not hang', () => {
    const q1 = makeQuest({ id: 'Q1', parents: ['Q2'] });
    const q2 = makeQuest({ id: 'Q2', parents: ['Q1'] });
    const snap = makeSnapshot([q1, q2]);

    const result = buildGraph(snap, ['Q1', 'Q2']);

    expect(result.nodes.length).toBe(2);
    expect(result.edges.length).toBe(2);
  });
});
