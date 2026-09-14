import { describe, expect, it } from 'vitest';
import type { Card, Quest, Snapshot, Verdict } from '../api/types';
import {
  busyQuests,
  cardLabel,
  groupRefusals,
  isQueueOnly,
  isSafeReviewUrl,
  questsInColumn,
  relatedQuestIds,
} from './board';
import type { Column } from './labels';

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

describe('board pure helpers', () => {
  it('columns sort and limit', () => {
    const q1 = makeQuest({ id: 'q1', priority: 2, updatedAt: '2026-09-10T10:00:00.000Z', status: 'posted' });
    const q2 = makeQuest({ id: 'q2', priority: 1, updatedAt: '2026-09-10T08:00:00.000Z', status: 'posted' });
    const q3 = makeQuest({ id: 'q3', priority: 2, updatedAt: '2026-09-10T12:00:00.000Z', status: 'posted' });
    const q4 = makeQuest({ id: 'q4', priority: 3, updatedAt: '2026-09-10T15:00:00.000Z', status: 'posted' });
    const other = makeQuest({ id: 'other', status: 'done', updatedAt: '2026-09-10T20:00:00.000Z' });

    const snap = makeSnapshot([q1, q2, q3, q4, other]);

    const openCol: Column = {
      key: 'open',
      num: '01',
      title: '委托板',
      sub: 'OPEN',
      statuses: ['posted'],
    };

    const openItems = questsInColumn(snap, openCol);
    expect(openItems.map((q) => q.id)).toEqual(['q2', 'q3', 'q1', 'q4']);

    const d1 = makeQuest({ id: 'd1', status: 'done', updatedAt: '2026-09-10T01:00:00.000Z' });
    const d2 = makeQuest({ id: 'd2', status: 'done', updatedAt: '2026-09-10T03:00:00.000Z' });
    const d3 = makeQuest({ id: 'd3', status: 'done', updatedAt: '2026-09-10T02:00:00.000Z' });

    const snapDone = makeSnapshot([d1, d2, d3]);
    const doneCol: Column = {
      key: 'done',
      num: '05',
      title: '卷宗室',
      sub: 'ARCHIVED',
      statuses: ['done'],
      limit: 2,
    };

    const doneItems = questsInColumn(snapDone, doneCol);
    expect(doneItems.map((q) => q.id)).toEqual(['d2', 'd3']);
  });

  it('groupRefusals groups one message across cards', () => {
    const verdicts: Record<string, Verdict> = {
      c1: { ok: true, reasons: [] },
      c2: { ok: false, reasons: [{ code: 'lane_limit', message: '通道限额' }] },
      c3: { ok: false, reasons: [{ code: 'lane_limit', message: '通道限额' }] },
      c4: { ok: false, reasons: [{ code: 'stalled', message: '卡住了' }] },
    };

    const result = groupRefusals(verdicts);
    expect(result.canTake).toEqual(['c1']);

    const laneLimitGroup = result.refused.find((r) => r.message === '通道限额');
    expect(laneLimitGroup).toBeDefined();
    expect(laneLimitGroup?.cards).toEqual(['c2', 'c3']);

    const stalledGroup = result.refused.find((r) => r.message === '卡住了');
    expect(stalledGroup).toBeDefined();
    expect(stalledGroup?.cards).toEqual(['c4']);
  });

  it('isQueueOnly true only when every reason is a conflict and false for no reasons', () => {
    expect(isQueueOnly({ ok: false, reasons: [{ code: 'conflict_running', message: 'wait' }] })).toBe(true);
    expect(
      isQueueOnly({
        ok: false,
        reasons: [
          { code: 'conflict_running', message: 'w1' },
          { code: 'conflict_running', message: 'w2' },
        ],
      }),
    ).toBe(true);
    expect(
      isQueueOnly({
        ok: false,
        reasons: [
          { code: 'conflict_running', message: 'w1' },
          { code: 'lane_limit', message: 'limit' },
        ],
      }),
    ).toBe(false);
    expect(isQueueOnly({ ok: false, reasons: [] })).toBe(false);
    expect(isQueueOnly({ ok: true, reasons: [] })).toBe(false);
    expect(isQueueOnly({ ok: true, reasons: [{ code: 'conflict_running', message: 'wait' }] })).toBe(false);
    expect(isQueueOnly(null)).toBe(false);
    expect(isQueueOnly(undefined)).toBe(false);
  });

  it('relatedQuestIds walks ancestors, descendants and conflicts and terminates on a parent cycle', () => {
    const qA = makeQuest({ id: 'A', parents: ['B'], conflicts: ['E'] });
    const qB = makeQuest({ id: 'B', parents: ['C'] });
    const qC = makeQuest({ id: 'C' });
    const qD = makeQuest({ id: 'D', parents: ['A'] });
    const qE = makeQuest({ id: 'E' });
    const qF = makeQuest({ id: 'F', conflicts: ['A'] });

    const snap = makeSnapshot([qA, qB, qC, qD, qE, qF]);
    const relatedA = relatedQuestIds(snap, 'A');

    expect(new Set(relatedA)).toEqual(new Set(['A', 'B', 'C', 'D', 'E', 'F']));

    const cycle1 = makeQuest({ id: 'cyc1', parents: ['cyc2'] });
    const cycle2 = makeQuest({ id: 'cyc2', parents: ['cyc1'] });
    const snapCycle = makeSnapshot([cycle1, cycle2]);

    const relatedCycle = relatedQuestIds(snapCycle, 'cyc1');
    expect(new Set(relatedCycle)).toEqual(new Set(['cyc1', 'cyc2']));
  });

  it('busyQuests and cardLabel', () => {
    const q1 = makeQuest({
      id: 'q1',
      status: 'dispatched',
      assignee: {
        adventurerId: 'card-1',
        family: null,
        lane: 'default',
        model: 'm1',
        variant: '',
        name: 'w1',
        at: '',
        by: '',
      },
    });
    const q2 = makeQuest({ id: 'q2', status: 'posted' });
    const snap = makeSnapshot([q1, q2]);

    expect(busyQuests(snap, 'card-1').map((q) => q.id)).toEqual(['q1']);
    expect(busyQuests(snap, 'card-2')).toEqual([]);

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
      maxParallel: 2,
    };

    expect(cardLabel(card, 0)).toBe('空闲 0/2');
    expect(cardLabel(card, 1)).toBe('空闲 1/2');
    expect(cardLabel(card, 2)).toBe('满员 2/2');

    const pausedCard = { ...card, status: 'paused' as const };
    expect(cardLabel(pausedCard, 0)).toBe('暂停');
  });

  describe('isSafeReviewUrl', () => {
    it('accepts valid /review/... paths', () => {
      expect(isSafeReviewUrl('/review/look-3')).toBe(true);
      expect(isSafeReviewUrl('/review/sub/path/123')).toBe(true);
      expect(isSafeReviewUrl('/review/arc-1?status=done')).toBe(true);
    });

    it('rejects URLs not starting with /review/', () => {
      expect(isSafeReviewUrl('javascript:alert(1)')).toBe(false);
      expect(isSafeReviewUrl('https://evil.com/review/1')).toBe(false);
      expect(isSafeReviewUrl('http://evil.com/review/1')).toBe(false);
      expect(isSafeReviewUrl('/review')).toBe(false);
      expect(isSafeReviewUrl('/other/review/1')).toBe(false);
      expect(isSafeReviewUrl('')).toBe(false);
      expect(isSafeReviewUrl(null)).toBe(false);
      expect(isSafeReviewUrl(undefined)).toBe(false);
    });

    it('rejects URLs containing .. path traversal segments', () => {
      expect(isSafeReviewUrl('/review/..')).toBe(false);
      expect(isSafeReviewUrl('/review/../etc/passwd')).toBe(false);
      expect(isSafeReviewUrl('/review/sub/..')).toBe(false);
      expect(isSafeReviewUrl('/review/a/../b')).toBe(false);
      expect(isSafeReviewUrl('/review/%2e%2e/secret')).toBe(false);
      expect(isSafeReviewUrl('/review/test?page=..')).toBe(false);
      expect(isSafeReviewUrl('/review/test#..')).toBe(false);
    });
  });
});

