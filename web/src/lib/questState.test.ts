import { describe, expect, it } from 'vitest';
import type { Card, Quest, Ruling, Snapshot } from '../api/types';
import {
  getLatestRuling,
  getQuestFlowKey,
  getQuestVerdict,
  hasEligibleCard,
} from './questState';

function makeQuest(partial: Partial<Quest> & { id: string }): Quest {
  return {
    kind: 'code',
    status: 'posted',
    title: '测试委托',
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
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
    ...partial,
  };
}

function makeCard(id: string): Card {
  return {
    id,
    name: '测试工牌',
    provider: '测试提供方',
    lane: '测试通道',
    model: '测试模型',
    family: '测试系列',
    status: 'available',
    statusSince: null,
    statusReason: '',
    statusSetBy: null,
  };
}

function makeSnapshot(
  quests: Quest[] = [],
  eligibility: Snapshot['eligibility'] = {},
): Snapshot {
  return {
    generatedAt: '2026-09-13T00:00:00.000Z',
    project: { name: '测试项目', lanes: ['测试通道'] },
    quests,
    roster: [makeCard('card-1')],
    eligibility,
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

describe('quest state helpers', () => {
  it('uses the existing column groups for the three workflow cues', () => {
    expect(getQuestFlowKey(makeQuest({ id: 'open', status: 'posted' }))).toBe('open');
    expect(
      getQuestFlowKey(
        makeQuest({
          id: 'run',
          status: 'dispatched',
          assignee: {
            adventurerId: 'card-1',
            family: null,
            lane: '测试通道',
            model: '测试模型',
            variant: '',
            name: 'worker-1',
            at: '2026-09-13T00:00:00.000Z',
            by: 'owner',
          },
        }),
      ),
    ).toBe('run');
    expect(getQuestFlowKey(makeQuest({ id: 'check', status: 'delivered' }))).toBe('owner');
    expect(getQuestFlowKey(makeQuest({ id: 'ask', status: 'posted', needsOwner: '请选择方案' }))).toBe('owner');
    expect(getQuestFlowKey(makeQuest({ id: 'broken-run', status: 'dispatched', assignee: null }))).toBe('other');
    expect(getQuestFlowKey(makeQuest({ id: 'done', status: 'done' }))).toBe('other');
  });

  it('returns the last real ruling and handles an empty ruling list', () => {
    const empty = makeQuest({ id: 'empty' });
    expect(getLatestRuling(empty)).toBeUndefined();

    const ruling: Ruling = {
      at: '2026-09-13T01:00:00.000Z',
      by: 'owner',
      text: '先保留现状',
      question: '是否继续',
    };
    expect(getLatestRuling(makeQuest({ id: 'ruled', rulings: [ruling] }))).toEqual(ruling);
  });

  it('reads eligibility by real quest and card ids, including a missing quest entry', () => {
    const quest = makeQuest({ id: 'q-1' });
    const snap = makeSnapshot([quest], {
      'q-1': {
        'card-1': { ok: true, reasons: [] },
      },
    });

    expect(getQuestVerdict(snap, 'q-1', 'card-1')?.ok).toBe(true);
    expect(hasEligibleCard(snap, 'q-1')).toBe(true);
    expect(getQuestVerdict(snap, 'missing', 'card-1')).toBeUndefined();
    expect(hasEligibleCard(snap, 'missing')).toBe(false);
  });
});
