import { describe, expect, it } from 'vitest';
import {
  diffDraft, draftFromQuest, hasChanges, isQuestOccupied, occupiedReason,
} from './metadataForm';
import { makeAssignee, makeQuest } from './testFixtures';

describe('draftFromQuest / diffDraft', () => {
  it('round-trips a quest into a draft with independent array copies', () => {
    const quest = makeQuest({ id: 'A-1', parents: ['P-1'], conflicts: ['C-1'], allowedLanes: ['codex'] });
    const draft = draftFromQuest(quest);
    draft.parents.push('P-2');
    expect(quest.parents).toEqual(['P-1']); // the quest's own array is untouched
  });

  it('produces an empty payload for an untouched draft', () => {
    const quest = makeQuest({ id: 'A-1' });
    const draft = draftFromQuest(quest);
    expect(diffDraft(draft, draft)).toEqual({});
    expect(hasChanges(diffDraft(draft, draft))).toBe(false);
  });

  it('includes only the fields that actually changed', () => {
    const quest = makeQuest({ id: 'A-1', title: 'old', needsOwner: 'pick one' });
    const baseline = draftFromQuest(quest);
    const draft = { ...baseline, title: 'new' };
    const payload = diffDraft(baseline, draft);
    expect(payload).toEqual({ title: 'new' });
  });

  it('sends a deliberately cleared field (blank counts as changed)', () => {
    const quest = makeQuest({ id: 'A-1', needsOwner: 'pick one' });
    const baseline = draftFromQuest(quest);
    const draft = { ...baseline, needsOwner: '' };
    expect(diffDraft(baseline, draft)).toEqual({ needsOwner: '' });
  });

  it('treats a same-content, same-order list as unchanged, but any reorder/add/remove as changed', () => {
    const quest = makeQuest({ id: 'A-1', parents: ['P-1', 'P-2'] });
    const baseline = draftFromQuest(quest);
    expect(diffDraft(baseline, { ...baseline, parents: ['P-1', 'P-2'] })).toEqual({});
    expect(diffDraft(baseline, { ...baseline, parents: ['P-2', 'P-1'] })).toEqual({ parents: ['P-2', 'P-1'] });
    expect(diffDraft(baseline, { ...baseline, parents: ['P-1'] })).toEqual({ parents: ['P-1'] });
    expect(diffDraft(baseline, { ...baseline, parents: ['P-1', 'P-2', 'P-3'] })).toEqual({ parents: ['P-1', 'P-2', 'P-3'] });
  });

  it('reports every changed field together', () => {
    const quest = makeQuest({ id: 'A-1', title: 'old', brief: 'docs/briefs/a.md' });
    const baseline = draftFromQuest(quest);
    const draft = { ...baseline, title: 'new', brief: 'docs/briefs/b.md', conflicts: ['C-9'] };
    expect(diffDraft(baseline, draft)).toEqual({ title: 'new', brief: 'docs/briefs/b.md', conflicts: ['C-9'] });
  });
});

describe('isQuestOccupied / occupiedReason', () => {
  it('is false for a posted quest with no assignee', () => {
    expect(isQuestOccupied(makeQuest({ id: 'A-1', status: 'posted' }))).toBe(false);
  });

  it('is true while dispatched with an assignee, false for a delivered/done quest', () => {
    const dispatched = makeQuest({ id: 'A-1', status: 'dispatched', assignee: makeAssignee('card-1') });
    expect(isQuestOccupied(dispatched)).toBe(true);
    expect(occupiedReason(dispatched)).toMatch(/先别改/);
    expect(isQuestOccupied(makeQuest({ id: 'A-2', status: 'delivered', assignee: makeAssignee('card-1') }))).toBe(false);
    expect(isQuestOccupied(makeQuest({ id: 'A-3', status: 'done' }))).toBe(false);
  });

  it('is true while stalled with an assignee still attached (unconfirmed worker) — same as a running quest', () => {
    const stalled = makeQuest({ id: 'A-1', status: 'stalled', assignee: makeAssignee('card-1') });
    expect(isQuestOccupied(stalled)).toBe(true);
    expect(occupiedReason(stalled)).toMatch(/失联/);
  });

  it('a stalled quest with no assignee (already released) is not occupied', () => {
    expect(isQuestOccupied(makeQuest({ id: 'A-1', status: 'stalled', assignee: null }))).toBe(false);
  });
});
