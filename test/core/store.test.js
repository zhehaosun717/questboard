import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { QuestStore, sameAttempt } from '../../src/core/store.js';
import { appendJsonLine, readJsonLines } from '../../src/core/jsonl.js';
import { eventsAfter, readEvents } from '../../src/core/events.js';
import { makeProject, card } from '../helpers.js';

let project;
let store;
const events = () => readJsonLines(project.config.paths.events);

beforeEach(() => {
  project = makeProject();
  store = new QuestStore(project.config);
});

describe('QuestStore', () => {
  it('posts with a title from the brief and emits posted', () => {
    const { quest } = store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-the-way-back.md', conflicts: 'RUN-3', allowedLanes: 'codex,agy' });
    assert.equal(quest.title, 'the way back');
    assert.deepEqual(quest.conflicts, ['RUN-3']);
    assert.deepEqual(quest.allowedLanes, ['codex', 'agy']);
    assert.equal(events()[0].event, 'posted');
  });

  it('rejects bad fields, naming the project lanes and brief dirs', () => {
    const { errors } = store.post({ package: 'run4', brief: '../x.md', kind: 'poem', allowedLanes: 'ftp', priority: 9, parents: 'nope' });
    assert.ok(errors.package && errors.kind && errors.priority && errors.parents);
    assert.match(errors.allowedLanes, /this project defines codex, claude, agy, dsh, opencode/);
    assert.match(store.post({ package: 'RUN-4', brief: '../x.md' }).errors.brief, /docs\/briefs/);
  });

  it('accepts dispatchable briefs only in dispatchDirs, owner briefs also in ownerDirs', () => {
    for (const brief of ['.env', 'docs/briefs/../../.env', 'docs/briefs/sub/x.md', 'docs/design/RUN-7.md']) {
      assert.ok(store.post({ package: 'RUN-7', brief }).errors.brief, brief);
    }
    assert.equal(store.post({ package: 'ARC-3', kind: 'owner', brief: 'docs/design/ARC-3.md' }).quest.brief, 'docs/design/ARC-3.md');
  });

  it('holds a quest for a ruling and releases it on the ruling', () => {
    const { quest } = store.post({ package: 'ARC-3', brief: 'docs/briefs/ARC-3-x.md', needsOwner: '三个点选哪个' });
    assert.equal(quest.status, 'needs_owner');
    const ruled = store.rule('ARC-3', { text: '选第二个' });
    assert.equal(ruled.status, 'posted');
    assert.equal(ruled.rulings[0].question, '三个点选哪个');
    assert.equal(quest.status, 'needs_owner', 'earlier snapshot is not mutated');
  });

  it('assigns with an assigned event, adopts with dispatched, and refuses a re-post while running', () => {
    store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
    const running = store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4' });
    assert.equal(running.assignee.family, 'gpt-5.6-luna');
    assert.equal(events().at(-1).event, 'assigned');
    assert.ok(store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' }).errors.package);
    store.post({ package: 'RUN-3', brief: 'docs/briefs/RUN-3-x.md' });
    const adopted = store.assign('RUN-3', { adventurer: card('codex-luna'), name: 'run3', event: 'dispatched', adopted: true });
    assert.equal(adopted.assignee.adopted, true);
    assert.equal(events().at(-1).event, 'dispatched');
  });

  it('numbers events and bumps the revision on every change, continuing after a restart', () => {
    const { quest } = store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
    assert.equal(quest.revision, 1);
    const running = store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4', requestKey: 'k1' });
    assert.equal(running.revision, 2);
    assert.equal(running.assignee.requestKey, 'k1');
    assert.equal(store.setStatus('RUN-4', 'delivered').revision, 3);
    assert.deepEqual(events().map((e) => e.seq), [1, 2, 3]);
    const reopened = new QuestStore(project.config);
    assert.equal(reopened.get('RUN-4').revision, 3);
    reopened.setStatus('RUN-4', 'done');
    assert.equal(events().at(-1).seq, 4);
  });

  it('numbers legacy event lines by position so cursors stay lossless', () => {
    fs.mkdirSync(path.dirname(project.config.paths.events), { recursive: true });
    fs.writeFileSync(project.config.paths.events, '{"at":"2026-09-01T00:00:00Z","event":"posted","package":"OLD-1"}\n{"at":"2026-09-01T00:00:01Z","event":"done","package":"OLD-1"}\n');
    const fresh = new QuestStore(project.config);
    fresh.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
    assert.deepEqual(readEvents(project.config.paths.events).map((e) => e.seq), [1, 2, 3]);
    assert.deepEqual(eventsAfter(project.config.paths.events, { after: 2 }).map((e) => e.package), ['RUN-4']);
    assert.deepEqual(eventsAfter(project.config.paths.events, { after: 0, limit: 1, pkg: 'OLD-1' }).map((e) => e.event), ['posted']);
  });

  it('keeps the worker through a stall and frees it only on release', () => {
    store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
    store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4' });
    assert.throws(() => store.release('RUN-4', {}), /running/);
    assert.equal(store.setStatus('RUN-4', 'stalled', { detail: 'no output' }).assignee.name, 'run4');
    const freed = store.release('RUN-4', { by: 'owner', detail: 'process gone' });
    assert.deepEqual([freed.assignee, freed.status], [null, 'stalled']);
    assert.deepEqual([events().at(-1).event, events().at(-1).name, events().at(-1).detail], ['released', 'run4', 'process gone']);
    assert.throws(() => store.release('RUN-4', {}), /no worker/);
    assert.equal(store.setStatus('RUN-4', 'failed', { detail: 'exit 3' }).assignee, null, 'an exit still clears the worker');
  });

  it('keeps the assignee in the event when a status clears it, and replays after restart', () => {
    store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
    store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4' });
    assert.equal(store.setStatus('RUN-4', 'failed', { detail: 'exit 3' }).assignee, null);
    assert.equal(events().at(-1).model, 'gpt-5.6-luna');
    assert.throws(() => store.setStatus('RUN-4', 'exploded'));
    assert.equal(new QuestStore(project.config).get('RUN-4').status, 'failed');
  });

  it('mints a fresh attemptId on every assign/adopt, distinct even for a same-named re-adopt', () => {
    store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
    const first = store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4' });
    assert.equal(typeof first.assignee.attemptId, 'string');
    assert.ok(first.assignee.attemptId.length > 0);
    assert.equal(events().at(-1).attemptId, first.assignee.attemptId, 'the event carries the same attempt identity');
    assert.equal(first.dispatches.at(-1).attemptId, first.assignee.attemptId, 'and so does the dispatch history');
    // A same-named re-adopt (the worker restarted under the same name) still gets its own identity.
    const readopted = store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4', event: 'dispatched', adopted: true });
    assert.notEqual(readopted.assignee.attemptId, first.assignee.attemptId);
  });

  it('assign() starts an attempt at phase "queued"; adopt() starts one at "launching" since it is already running by hand', () => {
    store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
    const assigned = store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4' });
    assert.equal(assigned.assignee.phase, 'queued');
    const adopted = store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4', event: 'dispatched', adopted: true });
    assert.equal(adopted.assignee.phase, 'launching', 'an adopted worker was never queued by this board at all');
  });

  it('recordPhase durably persists phase/session onto the current attempt, and refuses once a different attempt is current', () => {
    store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
    const assigned = store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4' });
    const attempt = { attemptId: assigned.assignee.attemptId, name: 'run4', lane: 'codex', at: assigned.assignee.at };
    const withPhase = store.recordPhase('RUN-4', attempt, { phase: 'launching' });
    assert.equal(withPhase.assignee.phase, 'launching');
    const withSession = store.recordPhase('RUN-4', attempt, { session: { id: 'ses_1', saveTo: 'x', unknown: false } });
    assert.equal(withSession.assignee.phase, 'launching', 'setting session alone does not clobber the already-recorded phase');
    assert.deepEqual(withSession.assignee.session, { id: 'ses_1', saveTo: 'x', unknown: false });
    // Durable, not just in-memory: a fresh store reading the same quests.jsonl from scratch sees it too.
    assert.deepEqual(new QuestStore(project.config).get('RUN-4').assignee, withSession.assignee);
    // Once a new attempt replaces this one, the old attempt's phase can no longer be written — the caller
    // (executePlan via dispatcher.js) must treat this refusal exactly like a real persistence failure and
    // not spawn the step it would have announced.
    store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4_2' });
    assert.throws(() => store.recordPhase('RUN-4', attempt, { phase: 'launching' }), /不是当前记录/);
  });

  it('does not re-emit a repeated terminal transition, but keeps a differing repeat as a note, and a new attempt delivers independently', () => {
    store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
    store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4' });
    const first = store.setStatus('RUN-4', 'delivered', { detail: 'report A' });
    const countAfterFirst = events().length;
    const exactRepeat = store.setStatus('RUN-4', 'delivered', { detail: 'report A' });
    assert.equal(events().length, countAfterFirst, 'an identical repeat is a full no-op, not a second event');
    assert.equal(exactRepeat.revision, first.revision);

    const noted = store.setStatus('RUN-4', 'delivered', { detail: 'a later duplicate poll saw slightly different text' });
    assert.equal(events().at(-1).event, 'status_note', 'new information from a repeat is kept, but not as a second delivered');
    assert.equal(noted.lastDetail, 'report A', 'the first terminal evidence is preserved untouched');
    assert.equal(events().filter((e) => e.event === 'delivered').length, 1, 'still only one delivered event so far');

    // A genuinely new attempt (a fresh assign) delivers its own, independent event once it completes.
    store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4_2' });
    store.setStatus('RUN-4', 'delivered', { detail: 'report B' });
    assert.equal(events().filter((e) => e.event === 'delivered').length, 2, 'the second attempt emits its own delivered, independently');
  });

  it('applies the same dedup to a repeated failed/bounced, each independently of the others', () => {
    store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
    store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4' });
    store.setStatus('RUN-4', 'failed', { detail: 'exit 3' });
    const before = events().length;
    store.setStatus('RUN-4', 'failed', { detail: 'exit 3' });
    assert.equal(events().length, before, 'an identical repeated failed is a no-op');
    assert.equal(events().filter((e) => e.event === 'failed').length, 1);
  });

  it('keeps a stalled-and-owned attempt through a re-post that also raises a question', () => {
    store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
    store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4' });
    store.setStatus('RUN-4', 'stalled', { detail: 'no output' });
    const reposted = store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md', needsOwner: '要不要换个模型' }).quest;
    assert.equal(reposted.status, 'stalled', 'a stalled-but-owned attempt keeps holding its slot through a re-post');
    assert.equal(reposted.assignee.name, 'run4', 'its worker is not silently dropped');
    assert.equal(reposted.needsOwner, '要不要换个模型', 'the question is still recorded for the owner to see');
  });

  it('keeps a legacy assignee (no attemptId) readable on replay, without inventing one', () => {
    const legacyAssignee = { adventurerId: 'codex-luna', lane: 'codex', model: 'gpt-5.6-luna', variant: 'high', name: 'old2', at: '2026-09-01T00:00:00.000Z', by: 'owner' };
    appendJsonLine(path.join(project.config.paths.data, 'quests.jsonl'), {
      id: 'OLD-2', status: 'dispatched', dispatches: [legacyAssignee], rulings: [], createdAt: legacyAssignee.at, updatedAt: legacyAssignee.at, revision: 1, assignee: legacyAssignee,
    });
    const replayed = new QuestStore(project.config);
    assert.equal(replayed.get('OLD-2').assignee.attemptId, undefined, 'replay must not fabricate an attemptId for a row that never had one');
    assert.equal(sameAttempt(legacyAssignee, { name: 'old2', at: legacyAssignee.at }), true, 'name+at is the conservative fallback identity');
    assert.equal(sameAttempt(legacyAssignee, { name: 'old2', at: '2026-09-02T00:00:00.000Z' }), false, 'a different at is a different attempt even with no attemptId to compare');
    assert.equal(sameAttempt(legacyAssignee, { name: 'different', at: legacyAssignee.at }), false, 'adopted or not, a different name is never the same attempt');
  });

  it('compares lane too in the legacy name+at fallback, when both sides carry one', () => {
    const legacyAssignee = { adventurerId: 'codex-luna', lane: 'codex', name: 'old2', at: '2026-09-01T00:00:00.000Z' };
    assert.equal(sameAttempt(legacyAssignee, { name: 'old2', lane: 'codex', at: legacyAssignee.at }), true, 'matching lane, name and at is still the same attempt');
    assert.equal(sameAttempt(legacyAssignee, { name: 'old2', lane: 'agy', at: legacyAssignee.at }), false, 'a different lane is never the same attempt, even with the same name and at');
    // Neither side (or only one) supplying a lane falls back to the original name+at comparison — the
    // stricter check only ever narrows identity, it never invents a mismatch from data that isn't there.
    assert.equal(sameAttempt(legacyAssignee, { name: 'old2', at: legacyAssignee.at }), true, 'no lane supplied on the other side does not manufacture a mismatch');
    assert.equal(sameAttempt({ name: 'old2', at: legacyAssignee.at }, { name: 'old2', lane: 'agy', at: legacyAssignee.at }), true, 'no lane on this side either does not manufacture a mismatch');
    // attemptId, when both sides have one, still wins outright — lane is only consulted in the fallback.
    assert.equal(sameAttempt({ ...legacyAssignee, lane: 'agy', attemptId: 'a1' }, { name: 'old2', lane: 'codex', at: legacyAssignee.at, attemptId: 'a1' }), true, 'a matching attemptId is identity regardless of lane');
  });

  it('never treats a bare name match as proof of identity when either side has no `at` to compare — too weak to gate a mutation', () => {
    const legacyAssignee = { adventurerId: 'codex-luna', lane: 'codex', name: 'old2', at: '2026-09-01T00:00:00.000Z' };
    assert.equal(sameAttempt(legacyAssignee, { name: 'old2' }), false, 'the other side never recorded an `at` at all — name alone is not enough');
    assert.equal(sameAttempt({ name: 'old2' }, { name: 'old2', at: legacyAssignee.at }), false, 'same, with the missing `at` on this side instead');
    assert.equal(sameAttempt({ name: 'old2' }, { name: 'old2' }), false, 'neither side has one');
  });

  it('writes to disk before touching in-memory state, so a failed save leaves memory exactly where disk still is', () => {
    store.post({ package: 'RUN-9', brief: 'docs/briefs/RUN-9-x.md' });
    store.assign('RUN-9', { adventurer: card('codex-luna'), name: 'run9' });
    const before = store.get('RUN-9');
    const questsPath = path.join(project.config.paths.data, 'quests.jsonl');
    const backup = fs.readFileSync(questsPath);
    fs.rmSync(questsPath);
    fs.mkdirSync(questsPath); // appendJsonLine now throws EISDIR on the write-ahead
    assert.throws(() => store.setStatus('RUN-9', 'failed', { detail: 'boom' }), /EISDIR/);
    assert.deepEqual(store.get('RUN-9'), before, 'in-memory state must not have moved ahead of what was actually persisted');
    fs.rmdirSync(questsPath);
    fs.writeFileSync(questsPath, backup);
    // A fresh reload from disk agrees with the untouched in-memory state — nothing was silently lost either.
    assert.deepEqual(new QuestStore(project.config).get('RUN-9'), before);
  });
});
