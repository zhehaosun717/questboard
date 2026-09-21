import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findParentCycle, validateParents, validateMetadataUpdate } from '../../src/core/metadataUpdate.js';
import { makeProject, quest } from '../helpers.js';

const { config } = makeProject();
const byId = (list) => new Map(list.map((q) => [q.id, q]));

describe('findParentCycle', () => {
  it('finds a cycle through already-saved ancestors, and ignores an ancestor that is not on the board', () => {
    const quests = [quest({ id: 'A', parents: ['B'] }), quest({ id: 'B', parents: ['C'] }), quest({ id: 'C', parents: [] })];
    assert.equal(findParentCycle('C', ['A'], byId(quests)), true, 'A -> B -> C loops back to C');
    assert.equal(findParentCycle('A', ['B'], byId(quests)), false, 'B -> C does not reach A');
    assert.equal(findParentCycle('X', ['GHOST-1'], byId(quests)), false, 'an ancestor id not on the board just ends the walk');
  });
});

describe('validateParents', () => {
  it('rejects self, a nonexistent parent before persisting, and a cycle; accepts a real, acyclic chain', () => {
    const quests = [quest({ id: 'RUN-3', parents: [] })];
    assert.match(validateParents('RUN-4', ['RUN-4'], byId(quests)), /cannot be its own parent/);
    assert.match(validateParents('RUN-4', ['RUN-9'], byId(quests)), /RUN-9 not found; post it first/);
    assert.equal(validateParents('RUN-4', ['RUN-3'], byId(quests)), null);
    // RUN-5 already depends on RUN-4; making RUN-5 a parent of RUN-4 would close that loop.
    const cyclic = [quest({ id: 'RUN-4', parents: [] }), quest({ id: 'RUN-5', parents: ['RUN-4'] })];
    assert.match(validateParents('RUN-4', ['RUN-5'], byId(cyclic)), /would create a cycle back to RUN-4/);
  });
});

describe('validateMetadataUpdate', () => {
  it('touches only fields present in the payload, and reports nothing changed when a value repeats itself', () => {
    const q = quest({ title: 'old', needsOwner: 'pick one', parents: [] });
    const { errors, value, changes } = validateMetadataUpdate(config, q, [q], { title: 'new' });
    assert.deepEqual(errors, {});
    assert.deepEqual(value, { title: 'new' });
    assert.deepEqual(changes, { title: { from: 'old', to: 'new' } });
    const same = validateMetadataUpdate(config, q, [q], { title: 'old' });
    assert.deepEqual(same.value, {}, 'no actual change means nothing to save');
  });

  it('rejects a self, nonexistent, or cyclic parent with an actionable id, before touching anything else', () => {
    const q = quest({ id: 'RUN-4', parents: [] });
    const other = quest({ id: 'RUN-5', parents: ['RUN-4'] });
    assert.match(validateMetadataUpdate(config, q, [q], { parents: 'RUN-4' }).errors.parents, /cannot be its own parent/);
    assert.match(validateMetadataUpdate(config, q, [q], { parents: 'RUN-9' }).errors.parents, /RUN-9 not found; post it first/);
    assert.match(validateMetadataUpdate(config, q, [q, other], { parents: 'RUN-5' }).errors.parents, /cycle back to RUN-4/);
  });

  it('leaves a legacy quest\'s already-broken parent untouched by an unrelated field edit, but lets the owner repair it explicitly', () => {
    const legacy = quest({ id: 'FIX-1', parents: ['GHOST-1'], title: 'old title' });
    const untouched = validateMetadataUpdate(config, legacy, [legacy], { title: 'new title' });
    assert.deepEqual(untouched.errors, {}, 'fixing the title never re-validates a field the caller did not send');
    assert.deepEqual(untouched.value, { title: 'new title' });
    const repaired = validateMetadataUpdate(config, legacy, [legacy, quest({ id: 'RUN-1', parents: [] })], { parents: 'RUN-1' });
    assert.deepEqual(repaired.errors, {});
    assert.deepEqual(repaired.value.parents, ['RUN-1']);
    const stillBroken = validateMetadataUpdate(config, legacy, [legacy], { parents: 'GHOST-1' });
    assert.match(stillBroken.errors.parents, /GHOST-1 not found/, 'actively choosing the same missing parent again is still refused');
  });

  it('conflicts must be package ids and cannot name the quest itself', () => {
    const q = quest({ id: 'RUN-4', conflicts: [] });
    assert.match(validateMetadataUpdate(config, q, [q], { conflicts: 'nope!!' }).errors.conflicts, /must be package ids/);
    assert.match(validateMetadataUpdate(config, q, [q], { conflicts: 'RUN-4' }).errors.conflicts, /cannot conflict with itself/);
    assert.deepEqual(validateMetadataUpdate(config, q, [q], { conflicts: 'RUN-5' }).value.conflicts, ['RUN-5']);
  });

  it('rejects an unknown lane and a brief outside the project\'s configured dirs', () => {
    const q = quest({ id: 'RUN-4', kind: 'code' });
    assert.match(validateMetadataUpdate(config, q, [q], { allowedLanes: 'nope' }).errors.allowedLanes, /this project defines/);
    assert.match(validateMetadataUpdate(config, q, [q], { brief: 'docs/design/x.md' }).errors.brief, /docs\/briefs/, 'a dispatchable quest may not move its brief into an owner-only dir');
    assert.equal(validateMetadataUpdate(config, q, [q], { brief: '' }).errors.brief, 'brief is required');
  });

  it('rejects a field outside METADATA_FIELDS with an actionable per-field error, while by and ifRevision pass through untouched', () => {
    const q = quest({ id: 'RUN-4', title: 'old' });
    const r = validateMetadataUpdate(config, q, [q], { title: 'new', status: 'done', kind: 'owner', id: 'HACKED-1', by: 'owner', ifRevision: 3 });
    assert.match(r.errors.status, /unknown field/);
    assert.match(r.errors.kind, /unknown field/);
    assert.match(r.errors.id, /unknown field/);
    assert.equal(r.errors.by, undefined);
    assert.equal(r.errors.ifRevision, undefined);
  });

  it('refuses any actual change to a posted review\'s parents, but allows resending the same one as a no-op', () => {
    const author = quest({ id: 'RUN-4', parents: [] });
    const review = quest({ id: 'RUN-5', kind: 'review', parents: ['RUN-4'] });
    const other = quest({ id: 'RUN-6', parents: [] });
    const cleared = validateMetadataUpdate(config, review, [author, review, other], { parents: '' });
    assert.match(cleared.errors.parents, /RUN-5 is a posted review/);
    assert.match(cleared.errors.parents, /new package id/, 'must say a new package id is needed, not a same-id repost');
    assert.match(cleared.errors.parents, /cancelling RUN-5 does not unlock RUN-5/, 'must say cancelling does not unlock, never an instruction to cancel first');
    const reparented = validateMetadataUpdate(config, review, [author, review, other], { parents: 'RUN-6' });
    assert.match(reparented.errors.parents, /RUN-5 is a posted review/);
    const same = validateMetadataUpdate(config, review, [author, review, other], { parents: 'RUN-4' });
    assert.deepEqual(same.errors, {});
    assert.deepEqual(same.value, {}, 'resending the exact same parent is a true no-op, not a blocked change');
  });

  it('keeps a legacy broken review\'s target locked too — readable, other fields correctable, never silently rewritten', () => {
    const legacyReview = quest({ id: 'REVIEW-1', kind: 'review', parents: ['GHOST-1'], title: 'old' });
    const titled = validateMetadataUpdate(config, legacyReview, [legacyReview], { title: 'new' });
    assert.deepEqual(titled.errors, {});
    assert.equal(titled.value.title, 'new');
    assert.equal(titled.value.parents, undefined, 'an unrelated field edit never re-validates or touches the broken parent');
    const repair = validateMetadataUpdate(config, legacyReview, [legacyReview, quest({ id: 'RUN-1', parents: [] })], { parents: 'RUN-1' });
    assert.match(repair.errors.parents, /REVIEW-1 is a posted review/, 'even a real, valid replacement parent is refused for a review — cancel and repost, never a silent repair');
  });

  it('accepts reviewPage as a metadata field and refuses anything else unknown (FB2-06 item 7)', () => {
    const q = quest({ reviewPage: 'robot8' });
    const { errors, value, changes } = validateMetadataUpdate(config, q, [q], { reviewPage: 'robot9' });
    assert.deepEqual(errors, {});
    assert.deepEqual(value, { reviewPage: 'robot9' });
    assert.deepEqual(changes, { reviewPage: { from: 'robot8', to: 'robot9' } });
    const cleared = validateMetadataUpdate(config, q, [q], { reviewPage: '' });
    assert.deepEqual(cleared.value, { reviewPage: '' }, 'an empty value clears the page');
    const long = validateMetadataUpdate(config, q, [q], { reviewPage: 'x'.repeat(80) });
    assert.deepEqual(long.errors, {});
    assert.equal(long.value.reviewPage.length, 64, 'like the other text fields, the value is capped, not refused');
  });
});
