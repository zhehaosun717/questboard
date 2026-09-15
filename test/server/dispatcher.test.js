// Unit tests for createDispatcher's API-lane delivery path: deliverFromApi/applyLanes, against a fake
// store so timing (a write that resolves after the quest moved on) is fully controllable and deterministic.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createDispatcher } from '../../src/server/dispatcher.js';
import { QuestStore } from '../../src/core/store.js';
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
});
