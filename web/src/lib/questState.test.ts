import { describe, expect, it } from 'vitest';
import type { Reason, Ruling } from '../api/types';
import {
  getDropVerdict,
  getLatestRuling,
  getQuestVerdict,
  hasEligibleCard,
  isAwaitingSignOff,
  reviewsOf,
  sharedRefusals,
} from './questState';
import { makeQuest, makeSnapshot } from './testFixtures';

describe('quest state helpers', () => {
  it('returns the last real ruling and handles an empty ruling list', () => {
    expect(getLatestRuling(makeQuest({ id: 'empty' }))).toBeUndefined();
    const ruling: Ruling = { at: '2026-09-13T01:00:00.000Z', by: 'owner', text: '先保留现状', question: '是否继续' };
    expect(getLatestRuling(makeQuest({ id: 'ruled', rulings: [ruling] }))).toEqual(ruling);
  });

  it('reads eligibility by real quest and card ids, including a missing quest entry', () => {
    const snap = makeSnapshot({ eligibility: { 'q-1': { 'card-1': { ok: true, reasons: [] } } } });
    expect(getQuestVerdict(snap, 'q-1', 'card-1')?.ok).toBe(true);
    expect(hasEligibleCard(snap, 'q-1')).toBe(true);
    expect(getQuestVerdict(snap, 'missing', 'card-1')).toBeUndefined();
    expect(hasEligibleCard(snap, 'missing')).toBe(false);
  });

  it('keeps only the refusals every card shares', () => {
    const conflict: Reason = { code: 'queue_conflict', message: '排队：ARC-2 正在改同一批文件，一次一个' };
    const paused: Reason = { code: 'adventurer_paused', message: '这个模型被暂停使用' };
    const snap = makeSnapshot({
      eligibility: { q: { 'card-1': { ok: false, reasons: [conflict] }, 'card-2': { ok: false, reasons: [paused, conflict] } } },
    });
    expect(sharedRefusals(snap, 'q')).toEqual([conflict]);
    expect(sharedRefusals(snap, 'missing')).toEqual([]);
    const mixed = makeSnapshot({
      eligibility: { q: { 'card-1': { ok: true, reasons: [] }, 'card-2': { ok: false, reasons: [conflict] } } },
    });
    expect(sharedRefusals(mixed, 'q')).toEqual([]);
  });

  it('asks for sign-off only on returned work — not a 你来 quest, a review, or an open quest', () => {
    expect(isAwaitingSignOff(makeQuest({ id: 'd', status: 'delivered' }))).toBe(true);
    expect(isAwaitingSignOff(makeQuest({ id: 'r', status: 'reviewing' }))).toBe(true);
    expect(isAwaitingSignOff(makeQuest({ id: 'p', status: 'posted' }))).toBe(false);
    expect(isAwaitingSignOff(makeQuest({ id: 'x', status: 'done' }))).toBe(false);
    expect(isAwaitingSignOff(makeQuest({ id: 'o', kind: 'owner', status: 'delivered' }))).toBe(false);
    expect(isAwaitingSignOff(makeQuest({ id: 'rv', kind: 'review', status: 'delivered' }))).toBe(false);
  });

  it('lists only the review quests of this quest, oldest first', () => {
    const snap = makeSnapshot({
      quests: [
        makeQuest({ id: 'REVIEW-ARC-2B', kind: 'review', parents: ['ARC-2'], createdAt: '2026-09-13T02:00:00.000Z' }),
        makeQuest({ id: 'REVIEW-ARC-2', kind: 'review', parents: ['ARC-2'], createdAt: '2026-09-13T01:00:00.000Z' }),
        makeQuest({ id: 'REVIEW-GEN-2', kind: 'review', parents: ['GEN-2'] }),
        makeQuest({ id: 'FIX-ARC-2', kind: 'code', parents: ['ARC-2'] }),
      ],
    });
    expect(reviewsOf(snap, 'ARC-2').map((q) => q.id)).toEqual(['REVIEW-ARC-2', 'REVIEW-ARC-2B']);
    expect(reviewsOf(snap, 'NONE')).toEqual([]);
  });

  it('judges a drop on returned work as a review of it, and any other drop as the work itself', () => {
    const delivered = makeQuest({ id: 'd', status: 'delivered' });
    const posted = makeQuest({ id: 'p', status: 'posted' });
    const authorRefused: Reason = { code: 'reviewer_coded_parent', message: '同一模型写过被审核的 d，不能自己审自己' };
    const snap = makeSnapshot({
      quests: [delivered, posted],
      eligibility: {
        d: { 'card-1': { ok: false, reasons: [{ code: 'quest_not_open', message: '任务状态是「delivered」，不能接' }] } },
        p: { 'card-1': { ok: true, reasons: [] } },
      },
      reviewEligibility: { d: { 'card-1': { ok: false, reasons: [authorRefused] } } },
    });
    expect(getDropVerdict(snap, delivered, 'card-1')?.reasons).toEqual([authorRefused]);
    expect(getDropVerdict(snap, posted, 'card-1')?.ok).toBe(true);
    expect(getDropVerdict(snap, delivered, 'card-9')).toBeUndefined();
    expect(getDropVerdict(makeSnapshot({ reviewEligibility: undefined }), delivered, 'card-1')).toBeUndefined();
  });
});
