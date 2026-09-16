// QB-FB-REVIEW-METADATA2 found that the review-target lock (store.test.js's "review ancestry protection")
// only reached a review's own declared parent: an ancestor two or more links away could still be cleared or
// reparented, and any ancestor's kind could still be laundered into or out of 'review', letting the very
// author reviewer_coded_parent exists to refuse back in. These tests reproduce every one of those probe
// cases (B/C/D/E in the review report) directly against the fix in metadataUpdate.js/store.js.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { QuestStore } from '../../src/core/store.js';
import { appendJsonLine, readJsonLines } from '../../src/core/jsonl.js';
import { canDispatch } from '../../src/core/rules.js';
import { findReviewAncestorLock } from '../../src/core/metadataUpdate.js';
import { makeProject, card } from '../helpers.js';

let project;
let store;
const events = () => readJsonLines(project.config.paths.events);
const luna = card('codex-luna');
const mimo = card('oc-mimo');

beforeEach(() => {
  project = makeProject();
  store = new QuestStore(project.config);
});

// RUN-2 <- RUN-3 <- RUN-4 <- RUN-5 (review): three links between the review and the ancestor it must still
// protect, so a fix that only walks one hop past the review's own parents cannot pass this by accident.
function setupDeepChain() {
  store.post({ package: 'RUN-2', brief: 'docs/briefs/RUN-2-x.md' });
  store.assign('RUN-2', { adventurer: luna, name: 'w2' });
  store.setStatus('RUN-2', 'delivered', { detail: 'd' });
  store.post({ package: 'RUN-3', brief: 'docs/briefs/RUN-3-x.md', parents: 'RUN-2' });
  store.assign('RUN-3', { adventurer: mimo, name: 'w3' });
  store.setStatus('RUN-3', 'delivered', { detail: 'd' });
  store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md', parents: 'RUN-3' });
  store.assign('RUN-4', { adventurer: mimo, name: 'w4' });
  store.setStatus('RUN-4', 'delivered', { detail: 'd' });
  store.post({ package: 'RUN-5', brief: 'docs/briefs/RUN-5-x.md', kind: 'review', parents: 'RUN-4' });
}
const mayReview = (adventurer = luna) => canDispatch({
  quest: store.get('RUN-5'), adventurer, quests: store.list(), policy: {}, env: { laneIds: new Set(['codex', 'agy', 'opencode']) },
});

describe('review lineage lock: ancestors two or more links away', () => {
  it('refuses to give a grandparent ancestor a new parent through updateMetadata, naming the protecting review', () => {
    setupDeepChain();
    store.post({ package: 'RUN-6', brief: 'docs/briefs/RUN-6-x.md' });
    const before = store.get('RUN-2');
    const beforeEvents = events().length;
    const reparented = store.updateMetadata('RUN-2', { parents: 'RUN-6' }, { by: 'owner' });
    assert.match(reparented.errors.parents, /RUN-2 is locked/);
    assert.match(reparented.errors.parents, /RUN-5 is a posted review/);
    assert.match(reparented.errors.parents, /does not unlock RUN-2/, 'must never claim cancelling the review frees this ancestor');
    assert.match(reparented.errors.parents, /new package id/, 'must say a new package id is needed to correct the lineage');
    assert.deepEqual(store.get('RUN-2'), before, 'a refused request changes nothing');
    assert.equal(events().length, beforeEvents, 'a refused request emits no event');
    assert.equal(mayReview(luna).ok, false, 'luna authored RUN-2; RUN-5 must still refuse her');
  });

  it('refuses the same grandparent reparent through the re-post upsert path, not only updateMetadata', () => {
    setupDeepChain();
    store.post({ package: 'RUN-6', brief: 'docs/briefs/RUN-6-x.md' });
    const reparented = store.post({ package: 'RUN-2', brief: 'docs/briefs/RUN-2-x.md', parents: 'RUN-6' });
    assert.match(reparented.errors.parents, /RUN-2 is locked/);
    assert.deepEqual(store.get('RUN-2').parents, []);
    assert.equal(mayReview(luna).ok, false);
  });

  it('refuses clearing the middle link (RUN-3), not only the two ends of the chain', () => {
    setupDeepChain();
    const cleared = store.updateMetadata('RUN-3', { parents: '' }, { by: 'owner' });
    assert.match(cleared.errors.parents, /RUN-3 is locked/);
    assert.match(cleared.errors.parents, /RUN-5 is a posted review/);
    assert.deepEqual(store.get('RUN-3').parents, ['RUN-2']);
  });

  it('still allows resending the exact same parent on a locked ancestor as a true no-op', () => {
    setupDeepChain();
    const revision = store.get('RUN-3').revision;
    const same = store.updateMetadata('RUN-3', { parents: 'RUN-2' }, { by: 'owner' });
    assert.deepEqual(same.quest.parents, ['RUN-2']);
    assert.equal(same.quest.revision, revision, 'a true no-op never bumps the revision, even on a locked ancestor');
    const samePost = store.post({ package: 'RUN-3', brief: 'docs/briefs/RUN-3-x.md', parents: 'RUN-2' });
    assert.deepEqual(samePost.quest.parents, ['RUN-2']);
  });

  it('leaves an ordinary quest outside every review chain freely repairable, even in a project that has reviews', () => {
    setupDeepChain();
    appendJsonLine(path.join(project.config.paths.data, 'quests.jsonl'), {
      id: 'FIX-9', kind: 'code', status: 'posted', brief: 'docs/briefs/FIX-9-x.md', title: 'old',
      parents: ['GHOST-1'], conflicts: [], allowedLanes: [], needsOwner: '', assignee: null, dispatches: [],
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', revision: 1,
    });
    const reopened = new QuestStore(project.config);
    const repaired = reopened.updateMetadata('FIX-9', { parents: 'RUN-2' }, { by: 'owner' });
    assert.equal(repaired.errors, undefined, 'FIX-9 is not reached by any review, so it stays freely repairable');
    assert.deepEqual(repaired.quest.parents, ['RUN-2']);
  });
});

describe('review lineage lock: kind switches on dispatched, stalled or delivered ancestors', () => {
  it('refuses turning a delivered, authored parent into a review (the code->review launder)', () => {
    setupDeepChain();
    const r = store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md', kind: 'review' });
    assert.match(r.errors.kind, /RUN-4 has dispatch history or an assignee/);
    assert.equal(store.get('RUN-4').kind, 'code');
    assert.equal(mayReview(luna).ok, false);
  });

  it('refuses the same switch on the deeper, grandparent ancestor', () => {
    setupDeepChain();
    const r = store.post({ package: 'RUN-2', brief: 'docs/briefs/RUN-2-x.md', kind: 'review' });
    assert.match(r.errors.kind, /RUN-2 has dispatch history or an assignee/);
    assert.equal(store.get('RUN-2').kind, 'code');
  });

  it('refuses any re-post at all while actually dispatched (pre-existing "running" guard), and locks kind once stalled or delivered', () => {
    for (const status of ['dispatched', 'stalled', 'delivered']) {
      project = makeProject();
      store = new QuestStore(project.config);
      store.post({ package: 'RUN-9', brief: 'docs/briefs/RUN-9-x.md' });
      store.assign('RUN-9', { adventurer: luna, name: 'w9' });
      if (status !== 'dispatched') store.setStatus('RUN-9', status, { detail: 'd' });
      const r = store.post({ package: 'RUN-9', brief: 'docs/briefs/RUN-9-x.md', kind: 'review' });
      if (status === 'dispatched') assert.match(r.errors.package, /running; cancel it before re-posting/, status);
      else assert.match(r.errors.kind, /dispatch history or an assignee/, status);
      assert.equal(store.get('RUN-9').kind, 'code', status);
    }
  });

  it('locks kind on an ancestor an existing review reaches even though it was never dispatched or assigned', () => {
    store.post({ package: 'RUN-10', brief: 'docs/briefs/RUN-10-x.md' });
    store.post({ package: 'RUN-11', brief: 'docs/briefs/RUN-11-x.md', kind: 'review', parents: 'RUN-10' });
    const r = store.post({ package: 'RUN-10', brief: 'docs/briefs/RUN-10-x.md', kind: 'tool' });
    assert.match(r.errors.kind, /RUN-10 is reached by posted review RUN-11/);
    assert.match(r.errors.kind, /new package id/, 'must say a new package id is needed, not a same-id repost');
    assert.match(r.errors.kind, /cancelling RUN-10 does not unlock it/, 'must say cancelling does not unlock, never an instruction to cancel first');
    assert.equal(store.get('RUN-10').kind, 'code');
  });

  it('leaves an untouched, unreached quest free to correct its own kind, exactly as before', () => {
    store.post({ package: 'RUN-12', brief: 'docs/briefs/RUN-12-x.md', kind: 'code' });
    const r = store.post({ package: 'RUN-12', brief: 'docs/briefs/RUN-12-x.md', kind: 'tool' });
    assert.equal(r.errors, undefined, r.errors && JSON.stringify(r.errors));
    assert.equal(store.get('RUN-12').kind, 'tool');
  });
});

describe('review lineage lock survives cancelling the protecting review', () => {
  it('keeps an unassigned ancestor locked, in both parents and kind, after its review is cancelled', () => {
    store.post({ package: 'RUN-13', brief: 'docs/briefs/RUN-13-x.md' });
    store.post({ package: 'RUN-15', brief: 'docs/briefs/RUN-15-x.md' });
    store.post({ package: 'RUN-14', brief: 'docs/briefs/RUN-14-x.md', kind: 'review', parents: 'RUN-13' });
    store.setStatus('RUN-14', 'cancelled', { detail: 'wrong reviewer' });

    const reparented = store.updateMetadata('RUN-13', { parents: 'RUN-15' }, { by: 'owner' });
    assert.match(reparented.errors.parents, /RUN-13 is locked/);
    assert.match(reparented.errors.parents, /RUN-14 is a posted review/);
    assert.match(reparented.errors.parents, /does not unlock RUN-13/);
    assert.match(reparented.errors.parents, /new package id/, 'must say a new package id is needed even though the protecting review is cancelled');
    assert.deepEqual(store.get('RUN-13').parents, []);

    const kindChange = store.post({ package: 'RUN-13', brief: 'docs/briefs/RUN-13-x.md', kind: 'tool' });
    assert.match(kindChange.errors.kind, /RUN-13 is reached by posted review RUN-14/);
    assert.match(kindChange.errors.kind, /new package id/, 'must say a new package id is needed even though the protecting review is cancelled');
    assert.match(kindChange.errors.kind, /cancelling RUN-13 does not unlock it/, 'must say cancelling does not unlock, never an instruction to cancel first');
  });
});

describe('legacy missing and cyclic ancestors: readable and lock-checkable without looping', () => {
  const dataFile = () => path.join(project.config.paths.data, 'quests.jsonl');
  const base = {
    status: 'posted', conflicts: [], allowedLanes: [], needsOwner: '', assignee: null, dispatches: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', revision: 1,
  };

  it('does not loop on a cycle among legacy quests, and still finds the protecting review', () => {
    appendJsonLine(dataFile(), { ...base, id: 'LEG-A', kind: 'code', brief: 'docs/briefs/LEG-A-x.md', parents: ['LEG-B'] });
    appendJsonLine(dataFile(), { ...base, id: 'LEG-B', kind: 'code', brief: 'docs/briefs/LEG-B-x.md', parents: ['LEG-A'] });
    appendJsonLine(dataFile(), { ...base, id: 'LEG-REVIEW', kind: 'review', brief: 'docs/briefs/LEG-REVIEW-x.md', parents: ['LEG-A'] });
    const reopened = new QuestStore(project.config);
    assert.deepEqual(reopened.get('LEG-A').parents, ['LEG-B'], 'the legacy cyclic pair is still readable');
    const cleared = reopened.updateMetadata('LEG-B', { parents: '' }, { by: 'owner' });
    assert.match(cleared.errors.parents, /LEG-B is locked/);
    assert.match(cleared.errors.parents, /LEG-REVIEW is a posted review/);
  });

  it('tolerates a legacy missing ancestor, walking past it (never throwing) to find the lock further up the chain', () => {
    appendJsonLine(dataFile(), { ...base, id: 'LEG-C', kind: 'code', brief: 'docs/briefs/LEG-C-x.md', parents: ['GHOST-9'] });
    appendJsonLine(dataFile(), { ...base, id: 'LEG-D', kind: 'code', brief: 'docs/briefs/LEG-D-x.md', parents: ['LEG-C'] });
    appendJsonLine(dataFile(), { ...base, id: 'LEG-REVIEW-2', kind: 'review', brief: 'docs/briefs/LEG-REVIEW-2-x.md', parents: ['LEG-D'] });
    // An ordinary quest with no relation at all to the LEG-D/LEG-C/LEG-REVIEW-2 chain must never be reported
    // as locked — the missing GHOST-9 id must not somehow leak into matching an unrelated quest.
    appendJsonLine(dataFile(), { ...base, id: 'LEG-E', kind: 'code', brief: 'docs/briefs/LEG-E-x.md', parents: [] });
    const reopened = new QuestStore(project.config);
    assert.equal(findReviewAncestorLock('LEG-E', reopened.list()), null, 'unrelated quest is never reported as locked');
    assert.equal(findReviewAncestorLock('LEG-C', reopened.list()), 'LEG-REVIEW-2', 'the walk passes straight through the missing GHOST-9 branch to keep finding LEG-C');
    const cleared = reopened.updateMetadata('LEG-C', { parents: '' }, { by: 'owner' });
    assert.match(cleared.errors.parents, /LEG-C is locked/);
  });
});

describe('unsupported-key validator hole: __proto__, constructor, toString', () => {
  it('rejects a JSON-parsed __proto__ key atomically alongside an otherwise-valid field, with no partial update', () => {
    store.post({ package: 'RUN-20', brief: 'docs/briefs/RUN-20-x.md', title: 'kept' });
    const before = store.get('RUN-20');
    const beforeEvents = events().length;
    const body = JSON.parse('{"__proto__":{"status":"done"},"title":"hacked"}');
    assert.equal(Object.getPrototypeOf(body), Object.prototype, 'JSON.parse never actually changes the body\'s own prototype');
    const r = store.updateMetadata('RUN-20', body, { by: 'owner' });
    assert.ok(r.errors, '__proto__ must be rejected, not silently ignored into a 200');
    assert.match(r.errors.__proto__, /unknown field/);
    assert.deepEqual(store.get('RUN-20'), before, 'no partial update — the otherwise-valid title is not applied either');
    assert.equal(events().length, beforeEvents, 'a refused request emits no event');
  });

  it('rejects constructor and toString the same way, and the refusal still serializes as ordinary JSON', () => {
    store.post({ package: 'RUN-21', brief: 'docs/briefs/RUN-21-x.md' });
    const titleBefore = store.get('RUN-21').title;
    const body = JSON.parse('{"__proto__":"str","constructor":1,"toString":2,"title":"hacked"}');
    const r = store.updateMetadata('RUN-21', body, { by: 'owner' });
    assert.ok(r.errors);
    assert.match(r.errors.__proto__, /unknown field/);
    assert.match(r.errors.constructor, /unknown field/);
    assert.match(r.errors.toString, /unknown field/);
    assert.equal(store.get('RUN-21').title, titleBefore, 'title never applied while any unsupported key is present');
    assert.equal(Object.getPrototypeOf(r.errors), Object.prototype, 'errors is handed back as an ordinary object, not the null-prototype one used internally to catch __proto__');
    // The HTTP layer sends `{ fields: result.errors }` straight through JSON.stringify (questRoutes.js) —
    // __proto__ must still come through as a literal key, exactly like every other rejected field.
    const wire = JSON.parse(JSON.stringify({ fields: r.errors }));
    assert.match(wire.fields.__proto__, /unknown field/);
    assert.equal(Object.getPrototypeOf(wire), Object.prototype, 'JSON.parse always hands back an ordinary object');
  });
});

describe('held-slot repost keeps an existing custom title when title is omitted', () => {
  it('keeps a custom title through a needsOwner-only repost while stalled; an explicit different title is still refused', () => {
    store.post({ package: 'RUN-30', brief: 'docs/briefs/RUN-30-x.md', title: 'Custom owner title' });
    store.assign('RUN-30', { adventurer: luna, name: 'w30' });
    store.setStatus('RUN-30', 'stalled', { detail: 'quiet' });

    const r = store.post({ package: 'RUN-30', brief: 'docs/briefs/RUN-30-x.md', needsOwner: 'switch model?' });
    assert.equal(r.errors, undefined, r.errors && JSON.stringify(r.errors));
    assert.equal(r.quest.title, 'Custom owner title', 'an omitted title must not fall back to titleFromBrief while the slot is held');
    assert.equal(r.quest.assignee.name, 'w30');
    assert.equal(r.quest.status, 'stalled');
    assert.equal(r.quest.needsOwner, 'switch model?');

    const r2 = store.post({ package: 'RUN-30', brief: 'docs/briefs/RUN-30-x.md', title: 'Different' });
    assert.match(r2.errors.title, /先释放再改/);
    assert.equal(store.get('RUN-30').title, 'Custom owner title', 'the refused explicit title change never applies');
  });

  it('keeps a default, brief-derived title stable through the same needsOwner-only repost', () => {
    store.post({ package: 'RUN-31', brief: 'docs/briefs/RUN-31-x.md' });
    const defaultTitle = store.get('RUN-31').title;
    store.assign('RUN-31', { adventurer: luna, name: 'w31' });
    store.setStatus('RUN-31', 'stalled', { detail: 'quiet' });
    const r = store.post({ package: 'RUN-31', brief: 'docs/briefs/RUN-31-x.md', needsOwner: 'q' });
    assert.equal(r.quest.title, defaultTitle);
  });
});

// QB-FB-REVIEW-METADATA3 found that three of the four lock messages, while correctly refusing every case
// above, still told the coordinator to "cancel X and post a new [review|quest]" without ever saying the
// re-post needs a *different* package id — so following that advice literally (cancel X, then re-post X)
// walked straight back into the same refusal. These tests pin the fixed wording: every message that has a
// protecting review names it, none of them invents one it cannot find, and none of them makes cancelling
// delivered work sound like a required step.
describe('message wording: no cancel-same-id-repost loop, protecting review always named when one exists', () => {
  it('review target lock: a same-id repost after cancelling is still refused, names itself as the protecting review, and changes nothing', () => {
    store.post({ package: 'RUN-40', brief: 'docs/briefs/RUN-40-x.md' });
    store.post({ package: 'RUN-41', brief: 'docs/briefs/RUN-41-x.md' });
    store.post({ package: 'RUN-42', brief: 'docs/briefs/RUN-42-x.md', kind: 'review', parents: 'RUN-40' });
    store.setStatus('RUN-42', 'cancelled', { detail: 'wrong reviewer' });
    const before = store.get('RUN-42');
    const beforeEvents = events().length;

    const reposted = store.post({ package: 'RUN-42', brief: 'docs/briefs/RUN-42-x.md', kind: 'review', parents: 'RUN-41' });
    assert.match(reposted.errors.parents, /RUN-42 is a posted review/);
    assert.match(reposted.errors.parents, /new package id/, 'must say a new package id is needed, not a same-id upsert');
    assert.match(reposted.errors.parents, /cancelling RUN-42 does not unlock RUN-42/, 'must say plainly that cancelling does not free the id');
    assert.match(reposted.errors.parents, /RUN-42 remains the protecting review/, 'must name RUN-42 itself as the protecting review');
    assert.deepEqual(store.get('RUN-42'), before, 'a refused re-post changes nothing, even after cancel');
    assert.equal(events().length, beforeEvents);

    const fresh = store.post({ package: 'RUN-43', brief: 'docs/briefs/RUN-43-x.md', kind: 'review', parents: 'RUN-41' });
    assert.equal(fresh.errors, undefined, 'a genuinely new package id, as the message advises, is not locked');
  });

  it('kind lock on a posted review itself: new-id guidance, no lingering "cancel it and post" directive', () => {
    store.post({ package: 'RUN-44', brief: 'docs/briefs/RUN-44-x.md' });
    store.post({ package: 'RUN-45', brief: 'docs/briefs/RUN-45-x.md', kind: 'review', parents: 'RUN-44' });
    const r = store.post({ package: 'RUN-45', brief: 'docs/briefs/RUN-45-x.md', kind: 'tool' });
    assert.match(r.errors.kind, /RUN-45 is a posted review/);
    assert.match(r.errors.kind, /new package id/);
    assert.match(r.errors.kind, /cancelling RUN-45 does not unlock it/);
    assert.equal(store.get('RUN-45').kind, 'review', 'the fix must never actually flip kind');
  });

  it('kind lock from dispatch history alone: explains the retained lock without inventing a protecting review', () => {
    store.post({ package: 'RUN-46', brief: 'docs/briefs/RUN-46-x.md' });
    store.assign('RUN-46', { adventurer: luna, name: 'w46' });
    store.setStatus('RUN-46', 'delivered', { detail: 'd' });
    const r = store.post({ package: 'RUN-46', brief: 'docs/briefs/RUN-46-x.md', kind: 'tool' });
    assert.match(r.errors.kind, /RUN-46 has dispatch history or an assignee/);
    assert.match(r.errors.kind, /new package id/);
    assert.doesNotMatch(r.errors.kind, /posted review/, 'must not invent a protecting review when none reaches it');
    assert.equal(store.get('RUN-46').kind, 'code');
  });

  it('kind lock from dispatch history inside a review chain: names the protecting review and never directs cancelling delivered work', () => {
    setupDeepChain();
    const r = store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md', kind: 'review' });
    assert.match(r.errors.kind, /RUN-4 has dispatch history or an assignee/);
    assert.match(r.errors.kind, /posted review RUN-5/, 'must name the protecting review even though the history check ran first');
    assert.match(r.errors.kind, /new package id/);
    assert.doesNotMatch(r.errors.kind, /cancel RUN-4 and post/, 'must never tell the coordinator to cancel delivered work as a prerequisite');
    assert.equal(store.get('RUN-4').kind, 'code');
  });
});
