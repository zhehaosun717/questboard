import { describe, expect, it } from 'vitest';
import { makeAssignee, makeQuest, makeSnapshot } from './testFixtures';
import { rankOf, sealFor } from './questLook';

describe('questLook helpers', () => {
  describe('rankOf', () => {
    it('maps priority 1 to S (wax red)', () => {
      expect(rankOf(1)).toBe('S');
      expect(rankOf(0)).toBe('S');
    });

    it('maps priority 2 and undefined to A', () => {
      expect(rankOf(2)).toBe('A');
      expect(rankOf()).toBe('A');
    });

    it('maps priority 3 to B', () => {
      expect(rankOf(3)).toBe('B');
      expect(rankOf(4)).toBe('B');
    });
  });

  describe('sealFor', () => {
    it('returns null when there are no reviews', () => {
      const quest = makeQuest({ id: 'q1', status: 'delivered' });
      const snap = makeSnapshot({ quests: [quest] });
      expect(sealFor(quest, snap)).toBeNull();
    });

    it('returns null when review is not reported yet (dispatched or posted)', () => {
      const quest = makeQuest({
        id: 'q1',
        status: 'delivered',
        dispatches: [
          {
            at: '2026-09-10T10:00:00.000Z',
            adventurerId: 'a1',
            family: null,
            lane: 'l',
            model: 'm',
            variant: '',
            name: 'w',
            by: 'owner',
          },
        ],
      });
      const review = makeQuest({
        id: 'rev-1',
        kind: 'review',
        parents: ['q1'],
        status: 'dispatched',
        createdAt: '2026-09-10T11:00:00.000Z',
        assignee: makeAssignee('card-1'),
      });
      const snap = makeSnapshot({ quests: [quest, review] });
      expect(sealFor(quest, snap)).toBeNull();
    });

    it('returns null when review verdict is unknown', () => {
      const quest = makeQuest({
        id: 'q1',
        status: 'delivered',
        dispatches: [
          {
            at: '2026-09-10T10:00:00.000Z',
            adventurerId: 'a1',
            family: null,
            lane: 'l',
            model: 'm',
            variant: '',
            name: 'w',
            by: 'owner',
          },
        ],
      });
      const review = makeQuest({
        id: 'rev-1',
        kind: 'review',
        parents: ['q1'],
        status: 'delivered',
        createdAt: '2026-09-10T11:00:00.000Z',
        lastDetail: 'Here is some text without a verdict line.',
      });
      const snap = makeSnapshot({ quests: [quest, review] });
      expect(sealFor(quest, snap)).toBeNull();
    });

    it('returns pass seal when reported review has VERDICT: PASS', () => {
      const quest = makeQuest({
        id: 'q1',
        status: 'delivered',
        dispatches: [
          {
            at: '2026-09-10T10:00:00.000Z',
            adventurerId: 'a1',
            family: null,
            lane: 'l',
            model: 'm',
            variant: '',
            name: 'w',
            by: 'owner',
          },
        ],
      });
      const review = makeQuest({
        id: 'rev-1',
        kind: 'review',
        parents: ['q1'],
        status: 'delivered',
        createdAt: '2026-09-10T11:00:00.000Z',
        lastDetail: 'All tests look clean.\nVERDICT: PASS',
      });
      const snap = makeSnapshot({ quests: [quest, review] });
      expect(sealFor(quest, snap)).toEqual({
        verdict: 'pass',
        text: '复核通过',
        line1: '复核',
        line2: '通过',
      });
    });

    it('returns findings seal when reported review has VERDICT: PASS WITH FINDINGS', () => {
      const quest = makeQuest({
        id: 'q1',
        status: 'delivered',
        dispatches: [
          {
            at: '2026-09-10T10:00:00.000Z',
            adventurerId: 'a1',
            family: null,
            lane: 'l',
            model: 'm',
            variant: '',
            name: 'w',
            by: 'owner',
          },
        ],
      });
      const review = makeQuest({
        id: 'rev-1',
        kind: 'review',
        parents: ['q1'],
        status: 'delivered',
        createdAt: '2026-09-10T11:00:00.000Z',
        lastDetail: 'Minor issues found.\nVERDICT: PASS WITH FINDINGS',
      });
      const snap = makeSnapshot({ quests: [quest, review] });
      expect(sealFor(quest, snap)).toEqual({
        verdict: 'findings',
        text: '复核有问题',
        line1: '复核',
        line2: '有问题',
      });
    });

    it('returns fail seal when reported review has VERDICT: FAIL', () => {
      const quest = makeQuest({
        id: 'q1',
        status: 'delivered',
        dispatches: [
          {
            at: '2026-09-10T10:00:00.000Z',
            adventurerId: 'a1',
            family: null,
            lane: 'l',
            model: 'm',
            variant: '',
            name: 'w',
            by: 'owner',
          },
        ],
      });
      const review = makeQuest({
        id: 'rev-1',
        kind: 'review',
        parents: ['q1'],
        status: 'delivered',
        createdAt: '2026-09-10T11:00:00.000Z',
        lastDetail: 'Tests failed.\nVERDICT: FAIL',
      });
      const snap = makeSnapshot({ quests: [quest, review] });
      expect(sealFor(quest, snap)).toEqual({
        verdict: 'fail',
        text: '复核没过',
        line1: '复核',
        line2: '没过',
      });
    });

    it('ignores reviews from prior dispatches before the latest dispatch', () => {
      const quest = makeQuest({
        id: 'q1',
        status: 'delivered',
        dispatches: [
          {
            at: '2026-09-10T15:00:00.000Z',
            adventurerId: 'a1',
            family: null,
            lane: 'l',
            model: 'm',
            variant: '',
            name: 'w',
            by: 'owner',
          },
        ],
      });
      const oldReview = makeQuest({
        id: 'rev-old',
        kind: 'review',
        parents: ['q1'],
        status: 'delivered',
        createdAt: '2026-09-10T12:00:00.000Z',
        lastDetail: 'VERDICT: FAIL',
      });
      const snap = makeSnapshot({ quests: [quest, oldReview] });
      expect(sealFor(quest, snap)).toBeNull();
    });
  });
});
