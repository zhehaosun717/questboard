import { describe, expect, it } from 'vitest';
import { findReviewAncestorLock, missingParentIds, parentLock, questTitle } from './metadataLock';
import { makeQuest } from './testFixtures';

describe('findReviewAncestorLock', () => {
  it('finds a direct posted-review parent', () => {
    const quests = [
      makeQuest({ id: 'CODE-1' }),
      makeQuest({ id: 'REV-1', kind: 'review', parents: ['CODE-1'] }),
    ];
    expect(findReviewAncestorLock('CODE-1', quests)).toBe('REV-1');
    expect(findReviewAncestorLock('REV-1', quests)).toBeNull();
  });

  it('walks multiple hops through ordinary quests to find the protecting review', () => {
    const quests = [
      makeQuest({ id: 'A' }),
      makeQuest({ id: 'B', parents: ['A'] }),
      makeQuest({ id: 'C', parents: ['B'] }),
      makeQuest({ id: 'REV', kind: 'review', parents: ['C'] }),
    ];
    expect(findReviewAncestorLock('A', quests)).toBe('REV');
  });

  it('is cycle-safe and does not loop forever on a corrupt legacy chain', () => {
    const quests = [
      makeQuest({ id: 'X', parents: ['Y'] }),
      makeQuest({ id: 'Y', parents: ['X'] }),
      makeQuest({ id: 'REV', kind: 'review', parents: ['X'] }),
    ];
    expect(findReviewAncestorLock('X', quests)).toBe('REV');
    expect(findReviewAncestorLock('Z', quests)).toBeNull();
  });

  it('does not stop reaching an ancestor merely because the review itself is cancelled', () => {
    const quests = [
      makeQuest({ id: 'A' }),
      makeQuest({ id: 'REV', kind: 'review', status: 'cancelled', parents: ['A'] }),
    ];
    expect(findReviewAncestorLock('A', quests)).toBe('REV');
  });
});

describe('parentLock', () => {
  it('locks a quest that is itself a posted review, naming its own id', () => {
    const review = makeQuest({ id: 'REV-1', kind: 'review', parents: ['CODE-1'] });
    const lock = parentLock(review, [review, makeQuest({ id: 'CODE-1' })]);
    expect(lock?.ownReview).toBe(true);
    expect(lock?.reviewId).toBe('REV-1');
    expect(lock?.message).toMatch(/取消 REV-1 也不会解锁它/);
  });

  it('locks an ordinary quest reached by a posted review as an ancestor, naming the protecting review', () => {
    const quests = [
      makeQuest({ id: 'A' }),
      makeQuest({ id: 'REV', kind: 'review', parents: ['A'] }),
    ];
    const lock = parentLock(quests[0]!, quests);
    expect(lock?.ownReview).toBe(false);
    expect(lock?.reviewId).toBe('REV');
    expect(lock?.message).toMatch(/REV/);
  });

  it('returns null for an ordinary quest outside every review chain', () => {
    const quests = [makeQuest({ id: 'A' }), makeQuest({ id: 'B', parents: ['A'] })];
    expect(parentLock(quests[1]!, quests)).toBeNull();
  });
});

describe('missingParentIds / questTitle', () => {
  it('flags a legacy parent id the snapshot has no quest for', () => {
    const quests = [makeQuest({ id: 'A', parents: ['GHOST-1', 'B'] }), makeQuest({ id: 'B' })];
    expect(missingParentIds(['GHOST-1', 'B'], quests)).toEqual(['GHOST-1']);
  });

  it('looks up a known quest title, and is undefined for an unknown id', () => {
    const quests = [makeQuest({ id: 'A', title: '修好登录页' })];
    expect(questTitle('A', quests)).toBe('修好登录页');
    expect(questTitle('GHOST-1', quests)).toBeUndefined();
  });
});
