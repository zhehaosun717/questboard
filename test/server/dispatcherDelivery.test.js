// Unit tests for createDispatcher's API-lane delivery path: deliverFromApi/applyLanes, against a fake
// store so timing (a write that resolves after the quest moved on) is fully controllable and deterministic.
// Split out of the former dispatcher.test.js (830 lines, over the file-size guideline) — this file owns
// only the deliverFromApi/applyLanes describe block; see dispatcherRecheckEnv.test.js,
// dispatcherAmbiguous.test.js and dispatcherAdoptPhase.test.js for the rest, and
// dispatcherFaultRecovery.test.js for the new F1-F4 + requirement-5 regression tests.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDispatcher } from '../../src/server/dispatcher.js';
import { QuestStore } from '../../src/core/store.js';
import { readJsonLines } from '../../src/core/jsonl.js';
import { makeProject, card } from '../helpers.js';

const transientError = (message, code = 'STILL_RUNNING') => { const error = new Error(message); error.code = code; return error; };

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeStore(initial) {
  const quests = new Map(initial.map((q) => [q.id, { ...q }]));
  const events = [];
  return {
    get(id) { const q = quests.get(id); return q ? { ...q } : null; },
    list() { return [...quests.values()].map((q) => ({ ...q })); },
    setStatus(id, status, { detail = '', by = 'coordinator' } = {}) {
      const q = quests.get(id);
      if (!q) return null;
      const stillAssigned = ['dispatched', 'delivered', 'reviewing', 'stalled'].includes(status);
      const next = { ...q, status, assignee: stillAssigned ? q.assignee : null, lastDetail: detail };
      quests.set(id, next);
      events.push({ event: status === 'delivered' ? 'delivered' : status === 'failed' ? 'failed' : `status_${status}`, package: id, detail, by });
      return { ...next };
    },
    emitEvent(quest, event, fields = {}) {
      events.push({ event, package: quest.id, detail: fields.detail || '', by: fields.by || 'board' });
    },
    // Test-only escape hatch to simulate the quest changing underneath an in-flight delivery (a
    // reassignment, a release, a cancellation) — real callers only ever get there through store.assign
    // / store.setStatus / store.release, which is exactly what stillOurs must stay safe against.
    _set(id, patch) { quests.set(id, { ...quests.get(id), ...patch }); },
    events,
  };
}

const assignee = { name: 'mod1', lane: 'opencode', model: 'x', at: '2026-09-14T00:00:00.000Z' };
const baseQuest = (overrides = {}) => ({ id: 'MOD-1', status: 'dispatched', assignee, ...overrides });
const config = { root: '/proj', lanes: { opencode: { api: 'http://oc.test', deliveryDir: '.work/oc' } } };
const deliveredRow = { name: 'mod1', package: 'MOD-1', lane: 'opencode', model: 'x', state: 'delivered', dispatchedAt: '2026-09-14T00:00:01.000Z' };
const wait = () => new Promise((r) => setTimeout(r, 10));

describe('dispatcher deliverFromApi', () => {
  it('never marks delivered when the write fails, and reports why through a failed status', async () => {
    const store = makeStore([baseQuest()]);
    const calls = [];
    const d = deferred();
    const dispatcher = createDispatcher({ config, store, writeDelivery: (...args) => { calls.push(args); return d.promise; } });
    dispatcher.applyLanes({ packages: [deliveredRow] });
    d.reject(new Error('session ses_1 has no final assistant text'));
    await wait();
    assert.deepEqual(calls, [[config, 'opencode', 'mod1']]);
    assert.equal(store.get('MOD-1').status, 'failed');
    assert.ok(store.events.some((e) => e.event === 'delivery_write_failed' && /no final assistant text/.test(e.detail)), JSON.stringify(store.events));
    assert.equal(store.events.filter((e) => e.event === 'delivered').length, 0, 'a failed write is never a delivery');
  });

  it('emits delivered once per attempt: a repeated poll while the write is in flight starts no second write', async () => {
    const store = makeStore([baseQuest()]);
    let calls = 0;
    const d = deferred();
    const dispatcher = createDispatcher({ config, store, writeDelivery: () => { calls++; return d.promise; } });
    const snapshot = { packages: [deliveredRow] };
    dispatcher.applyLanes(snapshot);
    dispatcher.applyLanes(snapshot); // a second poll lands before the first write settles
    d.resolve('/proj/.work/oc/mod1.md');
    await wait();
    assert.equal(calls, 1, 'one write attempt for one delivery');
    assert.equal(store.events.filter((e) => e.event === 'delivered').length, 1);
    dispatcher.applyLanes(snapshot); // the quest is delivered now, not dispatched — a third identical snapshot is a no-op
    assert.equal(store.events.filter((e) => e.event === 'delivered').length, 1);
  });

  it('drops a stale write that resolves after the quest was reassigned to a new attempt', async () => {
    const store = makeStore([baseQuest()]);
    const d = deferred();
    const dispatcher = createDispatcher({ config, store, writeDelivery: () => d.promise });
    dispatcher.applyLanes({ packages: [deliveredRow] });
    // Same worker name, but a fresh assignment (a later `at`) — the delivery in flight belongs to the old one.
    store._set('MOD-1', { assignee: { ...assignee, at: '2026-09-14T01:00:00.000Z' } });
    d.resolve('/proj/.work/oc/mod1.md');
    await wait();
    assert.notEqual(store.get('MOD-1').status, 'delivered', 'a stale attempt must not overwrite a newer assignment');
    assert.equal(store.events.filter((e) => e.event === 'delivered').length, 0);
  });

  it('drops a stale write even when the new attempt shares the old one\'s name and timestamp (attemptId, not name+at, is identity)', async () => {
    const at = '2026-09-14T00:00:00.000Z';
    const store = makeStore([baseQuest({ assignee: { ...assignee, at, attemptId: 'attempt-A' } })]);
    const d = deferred();
    const dispatcher = createDispatcher({ config, store, writeDelivery: () => d.promise });
    dispatcher.applyLanes({ packages: [{ ...deliveredRow, dispatchedAt: at }] });
    // Same name, same `at` (coarse clocks, two quick drops) — only attemptId tells these two attempts apart.
    store._set('MOD-1', { assignee: { ...assignee, at, attemptId: 'attempt-B' } });
    d.resolve('/proj/.work/oc/mod1.md');
    await wait();
    assert.notEqual(store.get('MOD-1').status, 'delivered', 'attempt A\'s stale write must not land on attempt B');
    assert.equal(store.events.filter((e) => e.event === 'delivered').length, 0);
  });

  it('drops a stale write that resolves after the quest was cancelled', async () => {
    const store = makeStore([baseQuest()]);
    const d = deferred();
    const dispatcher = createDispatcher({ config, store, writeDelivery: () => d.promise });
    dispatcher.applyLanes({ packages: [deliveredRow] });
    store._set('MOD-1', { status: 'cancelled', assignee: null });
    d.resolve('/proj/.work/oc/mod1.md');
    await wait();
    assert.equal(store.get('MOD-1').status, 'cancelled', 'a stale attempt must not overwrite a cancellation');
    assert.equal(store.events.filter((e) => e.event === 'delivered').length, 0);
  });

  it('lets a new attempt\'s delivery write proceed while an old attempt\'s write is still hung, and drops the old one\'s late completion', async () => {
    const store = makeStore([baseQuest({ assignee: { ...assignee, attemptId: 'att-old' } })]);
    const oldWrite = deferred();
    const newWrite = deferred();
    let calls = 0;
    const dispatcher = createDispatcher({ config, store, writeDelivery: () => { calls += 1; return calls === 1 ? oldWrite.promise : newWrite.promise; } });

    dispatcher.applyLanes({ packages: [deliveredRow] }); // starts the old attempt's write; it will hang forever
    await wait();
    assert.equal(calls, 1);

    // A reassignment (a re-adopt after the old one was abandoned) supersedes the old attempt while its
    // write is still in flight. Keyed by quest id alone, the old attempt's still-pending entry would block
    // this poll from ever starting the new attempt's own write.
    store._set('MOD-1', { status: 'dispatched', assignee: { ...assignee, attemptId: 'att-new' } });
    dispatcher.applyLanes({ packages: [deliveredRow] });
    await wait();
    assert.equal(calls, 2, 'the new attempt\'s write must start even while the old attempt\'s write is still hung');

    newWrite.resolve('/proj/.work/oc/mod1_new.md');
    await wait();
    assert.equal(store.get('MOD-1').status, 'delivered');
    assert.equal(store.get('MOD-1').assignee.attemptId, 'att-new');

    // The old attempt's write finally settles long after the new attempt already delivered — its own
    // .finally must only ever clear its own entry, never touch the new attempt's bookkeeping or state.
    oldWrite.resolve('/proj/.work/oc/mod1_old_late.md');
    await wait();
    assert.equal(store.get('MOD-1').status, 'delivered', 'a stale late completion must not overwrite the new attempt\'s already-delivered state');
    assert.equal(store.events.filter((e) => e.event === 'delivered').length, 1, 'only the new attempt\'s delivery ever counted');
  });

  it('recovers from writeDelivery throwing synchronously instead of rejecting, and still releases the pending slot', async () => {
    const store = makeStore([baseQuest()]);
    let impl = () => { throw new Error('boom'); };
    const dispatcher = createDispatcher({ config, store, writeDelivery: (...args) => impl(...args) });
    dispatcher.applyLanes({ packages: [deliveredRow] });
    await wait();
    assert.equal(store.get('MOD-1').status, 'failed', 'a synchronous throw is still caught as a write failure');
    assert.ok(store.events.some((e) => e.event === 'delivery_write_failed' && /boom/.test(e.detail)));
    // Same dispatcher instance (same pendingDeliveries set): if the sync throw had bypassed the .finally
    // that frees the slot, this re-dispatch's delivery would be silently skipped forever.
    impl = async () => '/proj/.work/oc/mod1.md';
    store._set('MOD-1', { status: 'dispatched', assignee: { ...assignee, at: '2026-09-14T02:00:00.000Z' } });
    dispatcher.applyLanes({ packages: [{ ...deliveredRow, dispatchedAt: '2026-09-14T02:00:01.000Z' }] });
    await wait();
    assert.equal(store.get('MOD-1').status, 'delivered');
  });

  it('still delivers a stalled quest, since a stall keeps the worker until release', async () => {
    const store = makeStore([baseQuest({ status: 'stalled' })]);
    const dispatcher = createDispatcher({ config, store, writeDelivery: async () => '/proj/.work/oc/mod1.md' });
    dispatcher.applyLanes({ packages: [deliveredRow] });
    await wait();
    assert.equal(store.get('MOD-1').status, 'delivered');
  });

  it('keeps the assignee through a transient write error (still running, a bad response, an unreachable api) and retries', async () => {
    for (const error of [
      transientError('session ses_1 is still running, no completed final turn yet', 'STILL_RUNNING'),
      transientError('opencode answered 502 for session ses_1', 'BAD_RESPONSE'),
      transientError('opencode unreachable for session ses_1: fetch failed', 'FETCH_FAILED'),
    ]) {
      const store = makeStore([baseQuest()]);
      const dispatcher = createDispatcher({ config, store, writeDelivery: () => Promise.reject(error) });
      dispatcher.applyLanes({ packages: [deliveredRow] });
      await wait();
      assert.equal(store.get('MOD-1').status, 'dispatched', `${error.code} must not free the worker's slot`);
      assert.ok(store.get('MOD-1').assignee, `${error.code} must keep the assignee so the next poll can retry`);
      assert.ok(store.events.some((e) => e.event === 'delivery_write_failed'), `${error.code} is still reported, just not as a terminal failure`);
      assert.equal(store.events.filter((e) => e.event === 'failed').length, 0);
    }
  });

  it('dedupes a repeated transient notice per attempt, but reports again when the reason changes or a new attempt starts', async () => {
    const store = makeStore([baseQuest()]);
    const errors = [
      transientError('session ses_1 is still running, no completed final turn yet', 'STILL_RUNNING'),
      transientError('session ses_1 is still running, no completed final turn yet', 'STILL_RUNNING'),
      transientError('opencode answered 502 for session ses_1', 'BAD_RESPONSE'),
      transientError('session ses_1 is still running, no completed final turn yet', 'STILL_RUNNING'),
    ];
    let i = 0;
    const dispatcher = createDispatcher({ config, store, writeDelivery: () => Promise.reject(errors[i++]) });
    for (let n = 0; n < 3; n++) { dispatcher.applyLanes({ packages: [deliveredRow] }); await wait(); }
    assert.equal(store.get('MOD-1').status, 'dispatched');
    assert.equal(store.events.filter((e) => e.event === 'delivery_write_failed').length, 2, 'an identical repeated reason is folded, a changed one is reported again');

    // A fresh attempt (a new assignee.at, e.g. after a reassignment) resets the dedup — its first transient
    // failure is reported even if the message text happens to repeat the previous attempt's.
    store._set('MOD-1', { assignee: { ...assignee, at: '2026-09-15T00:00:00.000Z' } });
    dispatcher.applyLanes({ packages: [{ ...deliveredRow, dispatchedAt: '2026-09-15T00:00:01.000Z' }] });
    await wait();
    assert.equal(store.events.filter((e) => e.event === 'delivery_write_failed').length, 3);
  });

  it('a stale attempt\'s late-settling write never clears a newer attempt\'s own transient-notice de-dup entry', async () => {
    const store = makeStore([baseQuest({ assignee: { ...assignee, attemptId: 'att-old' } })]);
    const oldWrite = deferred();
    const newError = transientError('session ses_2 is still running, no completed final turn yet', 'STILL_RUNNING');
    let calls = 0;
    const dispatcher = createDispatcher({ config, store, writeDelivery: () => { calls += 1; return calls === 1 ? oldWrite.promise : Promise.reject(newError); } });

    dispatcher.applyLanes({ packages: [deliveredRow] }); // starts the old attempt's write; it hangs
    await wait();
    store._set('MOD-1', { status: 'dispatched', assignee: { ...assignee, attemptId: 'att-new' } });
    dispatcher.applyLanes({ packages: [deliveredRow] }); // the new attempt's own write starts and fails transiently
    await wait();
    assert.equal(store.events.filter((e) => e.event === 'delivery_write_failed').length, 1, 'the new attempt\'s first transient failure is reported once');

    // The old attempt's hung write finally settles (successfully) — it must not touch the new attempt's own
    // notice entry just because both happen to share the same quest id.
    oldWrite.resolve('/proj/.work/oc/mod1_old_late.md');
    await wait();
    assert.notEqual(store.get('MOD-1').status, 'delivered', 'the stale write must not deliver on the new attempt\'s behalf');

    // A repeated, identical transient failure from the still-current new attempt must still be folded — it
    // would not be if the old attempt's late settlement had cleared the new attempt's de-dup entry.
    dispatcher.applyLanes({ packages: [deliveredRow] });
    await wait();
    assert.equal(store.events.filter((e) => e.event === 'delivery_write_failed').length, 1, 'the repeat is folded — the stale write never cleared the new attempt\'s de-dup entry');
  });

  it('keeps the assignee on a transient error and delivers on the next poll, against the real store\'s own setStatus/assign semantics', async () => {
    const { config: realConfig } = makeProject();
    const store = new QuestStore(realConfig);
    const { quest } = store.post({ package: 'MOD-2', kind: 'code', brief: 'docs/briefs/MOD-2-x.md', by: 'owner' });
    const dispatched = store.assign(quest.id, { adventurer: card('oc-mimo'), name: 'mod2', by: 'owner' });
    const row = { name: 'mod2', package: 'MOD-2', lane: 'opencode', model: 'x', state: 'delivered', dispatchedAt: dispatched.assignee.at };
    let attempt = 0;
    const dispatcher = createDispatcher({
      config: realConfig,
      store,
      writeDelivery: async () => {
        attempt += 1;
        if (attempt === 1) throw transientError('session ses_2 is still running, no completed final turn yet');
        return path.join(realConfig.root, '.work', 'oc', 'mod2.md');
      },
    });
    dispatcher.applyLanes({ packages: [row] });
    await wait();
    const afterFirst = store.get('MOD-2');
    assert.equal(afterFirst.status, 'dispatched', 'a transient error must not clear the assignee via the real store');
    assert.deepEqual(afterFirst.assignee.name, 'mod2', 'the worker keeps its slot');
    dispatcher.applyLanes({ packages: [row] });
    await wait();
    assert.equal(store.get('MOD-2').status, 'delivered', 'the next poll retries the write and succeeds');
    assert.ok(store.get('MOD-2').assignee, 'delivered quests still keep their assignee (per QUEST_STATUSES stillAssigned)');
  });

  // F4 (native disk faults, requirement: "both simultaneously must settle without slot loss or server
  // crash"): the non-transient failure branch writes delivery_write_failed then setStatus('failed') — if
  // BOTH the events file and quests.jsonl are unwritable at once, both guarded writes fail, and the whole
  // chain must still settle (no unhandled rejection) with the reservation exactly as it was.
  it('settles without an unhandled rejection or slot loss when quests.jsonl and the events file are both unwritable during a non-transient delivery failure (F4)', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/FRFOUR-1-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'FRFOUR-1', brief: 'docs/briefs/FRFOUR-1-x.md', by: 'owner' });
    const dispatched = store.assign('FRFOUR-1', { adventurer: card('oc-mimo'), name: 'f4one', by: 'owner' });
    const row = { name: 'f4one', package: 'FRFOUR-1', lane: 'opencode', model: 'x', state: 'delivered', dispatchedAt: dispatched.assignee.at };
    const dispatcher = createDispatcher({ config: realConfig, store, writeDelivery: async () => { throw new Error('session ses_x has no final assistant text'); } });

    const qp = path.join(realConfig.paths.data, 'quests.jsonl');
    const ef = realConfig.paths.events;
    const qBackup = fs.readFileSync(qp); fs.rmSync(qp); fs.mkdirSync(qp);
    const eBackup = fs.readFileSync(ef); fs.rmSync(ef); fs.mkdirSync(ef);
    const rejections = [];
    const onRejection = (error) => rejections.push(error);
    process.on('unhandledRejection', onRejection);
    try {
      dispatcher.applyLanes({ packages: [row] });
      await wait();
    } finally {
      process.off('unhandledRejection', onRejection);
      fs.rmdirSync(qp); fs.writeFileSync(qp, qBackup);
      fs.rmdirSync(ef); fs.writeFileSync(ef, eBackup);
    }
    assert.deepEqual(rejections, [], 'two simultaneous disk sinks failing must never surface as an unhandled rejection');
    const disk = new QuestStore(realConfig).get('FRFOUR-1');
    assert.equal(disk.status, 'dispatched', 'neither write went through, so the durable record stays at its last real state — the slot is not lost');
    assert.ok(disk.assignee, 'the reservation is untouched');
  });
});
