import { describe, expect, it } from 'vitest';
import type { Card, Quest, Reason, Ruling, Snapshot } from '../api/types';
import {
  getLatestRuling,
  getQuestFlowKey,
  getQuestVerdict,
  hasEligibleCard,
  sharedRefusals,
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
  it('uses the existing column groups for the workflow cues', () => {
    const none = makeSnapshot();
    const takeable = makeSnapshot([], { open: { 'card-1': { ok: true, reasons: [] } } });
    expect(getQuestFlowKey(makeQuest({ id: 'open', status: 'posted' }), takeable)).toBe('open');
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
        none,
      ),
    ).toBe('run');
    expect(getQuestFlowKey(makeQuest({ id: 'check', status: 'delivered' }), none)).toBe('owner');
    expect(getQuestFlowKey(makeQuest({ id: 'ask', status: 'posted', needsOwner: '请选择方案' }), none)).toBe('owner');
    expect(getQuestFlowKey(makeQuest({ id: 'broken-run', status: 'dispatched', assignee: null }), none)).toBe('other');
    expect(getQuestFlowKey(makeQuest({ id: 'done', status: 'done' }), none)).toBe('other');
  });

  it('calls an open quest that no card can take blocked instead of dispatchable', () => {
    const conflict: Reason = { code: 'queue_conflict', message: '排队：ARC-2 正在改同一批文件，一次一个' };
    const snap = makeSnapshot([], { q: { 'card-1': { ok: false, reasons: [conflict] } } });
    expect(getQuestFlowKey(makeQuest({ id: 'q', status: 'posted' }), snap)).toBe('blocked');
    expect(getQuestFlowKey(makeQuest({ id: 'no-verdicts', status: 'posted' }), makeSnapshot())).toBe('blocked');
  });

  it('treats a 你来 quest as the owner\'s until it is archived', () => {
    const snap = makeSnapshot();
    expect(getQuestFlowKey(makeQuest({ id: 'mine', kind: 'owner', status: 'posted' }), snap)).toBe('owner');
    expect(getQuestFlowKey(makeQuest({ id: 'mine-done', kind: 'owner', status: 'done' }), snap)).toBe('other');
  });

  it('keeps only the refusals every card shares', () => {
    const conflict: Reason = { code: 'queue_conflict', message: '排队：ARC-2 正在改同一批文件，一次一个' };
    const paused: Reason = { code: 'adventurer_paused', message: '这个模型被暂停使用' };
    const snap = makeSnapshot([], {
      q: {
        'card-1': { ok: false, reasons: [conflict] },
        'card-2': { ok: false, reasons: [paused, conflict] },
      },
    });
    expect(sharedRefusals(snap, 'q')).toEqual([conflict]);
    expect(sharedRefusals(snap, 'missing')).toEqual([]);
    const mixed = makeSnapshot([], {
      q: { 'card-1': { ok: true, reasons: [] }, 'card-2': { ok: false, reasons: [conflict] } },
    });
    expect(sharedRefusals(mixed, 'q')).toEqual([]);
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
