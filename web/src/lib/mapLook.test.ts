import { describe, expect, it } from 'vitest';
import type { Quest } from '../api/types';
import { pinColor, questStatusLine } from './mapLook';

function makeQuest(partial: Partial<Quest> = {}): Quest {
  return {
    id: 'Q-1',
    kind: 'code',
    status: 'posted',
    title: 'Test Quest',
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

describe('mapLook', () => {
  describe('pinColor', () => {
    it('returns green for ready and open statuses', () => {
      expect(pinColor('posted')).toBe('#4f8a4b');
      expect(pinColor('bounced')).toBe('#4f8a4b');
      expect(pinColor('lane_limited')).toBe('#4f8a4b');
    });

    it('returns blue for dispatched status', () => {
      expect(pinColor('dispatched')).toBe('#3f6f9e');
    });

    it('returns wax red for statuses waiting on owner', () => {
      expect(pinColor('delivered')).toBe('#a8322a');
      expect(pinColor('reviewing')).toBe('#a8322a');
      expect(pinColor('needs_owner')).toBe('#a8322a');
      expect(pinColor('owner_playtest')).toBe('#a8322a');
    });

    it('returns dark red for failed and stalled statuses', () => {
      expect(pinColor('failed')).toBe('#7a221b');
      expect(pinColor('stalled')).toBe('#7a221b');
    });

    it('returns grey for done, cancelled, superseded, and unknown', () => {
      expect(pinColor('done')).toBe('#9a8b72');
      expect(pinColor('cancelled')).toBe('#9a8b72');
      expect(pinColor('superseded')).toBe('#9a8b72');
      expect(pinColor(undefined)).toBe('#9a8b72');
    });
  });

  describe('questStatusLine', () => {
    const working = makeQuest({
      status: 'dispatched',
      assignee: { adventurerId: 'card-1', name: 'run4', model: 'gpt-4o', lane: 'default', family: null, variant: '', at: '', by: '' },
    });

    it('names the adventurer from the roster, never the dispatch run name', () => {
      expect(questStatusLine(working, 'Codex')).toBe('Codex 在做');
      expect(questStatusLine(working, 'Codex')).not.toContain('run4');
    });

    it('falls back to the model when the adventurer is not on the roster', () => {
      expect(questStatusLine(working)).toBe('gpt-4o 在做');
    });

    it('shows Chinese label for non-dispatched status', () => {
      const q = makeQuest({ status: 'posted' });
      expect(questStatusLine(q)).toBe('待接');

      const qDelivered = makeQuest({ status: 'delivered' });
      expect(questStatusLine(qDelivered)).toBe('待验收');
    });
  });
});
