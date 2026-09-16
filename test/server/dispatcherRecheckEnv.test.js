// Unit tests for dispatcher.assign's queued-start recheck: environment/roster/config changes that happen
// while a job waits its turn, against the real QuestStore + project fixtures (the recheck itself reads the
// store and the filesystem, so a fake store cannot stand in here). The opencode lane is `serialize: true`
// (see test/helpers.js), so its executePlan only actually starts on a later microtask — the same gap a real
// serialized lane's queue creates — which is what lets these tests mutate state *after* assign() returns and
// still land before the recheck runs.
//
// Split out of the former dispatcher.test.js (830 lines, over the file-size guideline) — this file owns the
// "world changed while queued, and must refuse cleanly before anything ran" cases; see
// dispatcherAmbiguous.test.js for the cases where a step already ran before the block, dispatcherDelivery.test.js
// for deliverFromApi/applyLanes, and dispatcherAdoptPhase.test.js for durable-phase-persistence/adopt/naming.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDispatcher } from '../../src/server/dispatcher.js';
import { QuestStore } from '../../src/core/store.js';
import { makeProject, card } from '../helpers.js';

const wait = () => new Promise((r) => setTimeout(r, 10));

describe('dispatcher.assign queued-start recheck: environment changes', () => {
  const okRunners = { session: async () => ({ code: 0 }), run: async () => ({ code: 0 }) };

  it('never spawns once the tree lock appears while the job waited its turn, and fails with a clear reason', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/MOD-3-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'MOD-3', brief: 'docs/briefs/MOD-3-x.md', by: 'owner' });
    const dispatcher = createDispatcher({ config: realConfig, store, runners: okRunners });
    const result = dispatcher.assign('MOD-3', card('oc-mimo'), 'owner');
    assert.equal(result.status, 200);
    fs.mkdirSync(path.dirname(realConfig.paths.lock), { recursive: true });
    fs.writeFileSync(realConfig.paths.lock, '');
    await wait();
    const quest = store.get('MOD-3');
    assert.equal(quest.status, 'failed');
    assert.match(quest.lastDetail, /锁/);
  });

  it('never spawns once its brief disappears while the job waited its turn', async () => {
    const { config: realConfig, write, root } = makeProject();
    write('docs/briefs/MOD-4-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'MOD-4', brief: 'docs/briefs/MOD-4-x.md', by: 'owner' });
    const dispatcher = createDispatcher({ config: realConfig, store, runners: okRunners });
    dispatcher.assign('MOD-4', card('oc-mimo'), 'owner');
    fs.rmSync(path.join(root, 'docs/briefs/MOD-4-x.md'));
    await wait();
    const quest = store.get('MOD-4');
    assert.equal(quest.status, 'failed');
    assert.match(quest.lastDetail, /brief/);
  });

  it('never spawns once a declared conflict starts holding its slot while the job waited', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/MOD-5-x.md', 'brief');
    write('docs/briefs/MOD-6-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'MOD-5', brief: 'docs/briefs/MOD-5-x.md', conflicts: 'MOD-6', by: 'owner' });
    store.post({ package: 'MOD-6', brief: 'docs/briefs/MOD-6-x.md', by: 'owner' });
    const dispatcher = createDispatcher({ config: realConfig, store, runners: okRunners });
    const result = dispatcher.assign('MOD-5', card('oc-mimo'), 'owner');
    assert.equal(result.status, 200, 'MOD-6 does not hold a slot yet, so the initial check passes');
    // MOD-6 starts holding its slot only now, while MOD-5's own spawn is still queued behind it.
    store.assign('MOD-6', { adventurer: card('codex-luna'), name: 'mod6', by: 'owner' });
    await wait();
    const quest = store.get('MOD-5');
    assert.equal(quest.status, 'failed');
    assert.match(quest.lastDetail, /排队/);
  });

  it('an attempt cancelled while queued never spawns, and the cancellation itself is left untouched', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/MOD-7-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'MOD-7', brief: 'docs/briefs/MOD-7-x.md', by: 'owner' });
    const dispatcher = createDispatcher({ config: realConfig, store, runners: okRunners });
    dispatcher.assign('MOD-7', card('oc-mimo'), 'owner');
    store.setStatus('MOD-7', 'cancelled', { by: 'owner', detail: 'owner说不要了', source: 'ui', ack: true });
    await wait();
    const quest = store.get('MOD-7');
    assert.equal(quest.status, 'cancelled', 'the cancellation must not be overwritten by the blocked queued job');
    assert.equal(quest.lastDetail, 'owner说不要了');
  });

  it('an attempt superseded by a fresh assignment while queued never spawns, and never touches the new attempt', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/MOD-8-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'MOD-8', brief: 'docs/briefs/MOD-8-x.md', by: 'owner' });
    const dispatcher = createDispatcher({ config: realConfig, store, runners: okRunners });
    dispatcher.assign('MOD-8', card('oc-mimo'), 'owner');
    const reassigned = store.assign('MOD-8', { adventurer: card('codex-luna'), name: 'mod8_2', by: 'owner' });
    await wait();
    const quest = store.get('MOD-8');
    assert.equal(quest.status, 'dispatched', 'the new attempt stays dispatched, not knocked over by the old queued job');
    assert.equal(quest.assignee.attemptId, reassigned.assignee.attemptId);
  });

  it('recognizes a real Map of down lanes at recheck time, not just a Set — the production shape wired by questRoutes.js', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/D-61-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'D-61', brief: 'docs/briefs/D-61-x.md', by: 'owner' });
    let down = null;
    const dispatcher = createDispatcher({
      config: realConfig, store, getDownLanes: () => down, getAdventurer: (id) => card(id),
      runners: { session: async () => ({ code: 0, session: 's' }), run: async () => ({ code: 0 }) },
    });
    dispatcher.assign('D-61', card('oc-mimo'), 'owner');
    down = new Map([['opencode', 'http://oc.test']]); // the plan's own lane goes down while queued
    await wait();
    const quest = store.get('D-61');
    assert.equal(quest.status, 'failed', 'the recheck must consult a real Map exactly like canDispatch does — a Set-only fixture would crash on downLanes.get()');
    assert.match(quest.lastDetail, /opencode 通道的服务没开/);
  });

  it('a different lane going down in that same Map does not block a queued job whose own plan is on a healthy lane', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/D-62-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'D-62', brief: 'docs/briefs/D-62-x.md', by: 'owner' });
    let down = null;
    const calls = [];
    const dispatcher = createDispatcher({
      config: realConfig, store, getDownLanes: () => down, getAdventurer: (id) => card(id),
      runners: { session: async () => { calls.push('session'); return { code: 0, session: 's' }; }, run: async () => { calls.push('run'); return { code: 0 }; } },
    });
    dispatcher.assign('D-62', card('oc-mimo'), 'owner');
    down = new Map([['codex', 'http://codex.test']]);
    await wait();
    assert.deepEqual(calls, ['session', 'run']);
    assert.equal(store.get('D-62').status, 'dispatched');
  });

  it('reads the adventurer\'s roster status fresh at recheck time, not the object captured at drop time', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/MOD-11-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'MOD-11', brief: 'docs/briefs/MOD-11-x.md', by: 'owner' });
    // getAdventurer stands in for questRoutes.js's effectiveRoster-backed resolver: the roster changes
    // (the card is paused) after the drop, and the captured `adventurer` object passed to assign() is never
    // mutated — only a fresh re-resolve at recheck time can see the change.
    let paused = false;
    const dispatcher = createDispatcher({
      config: realConfig,
      store,
      runners: { session: async () => ({ code: 0 }), run: async () => ({ code: 0 }) },
      getAdventurer: (id) => (paused ? card(id, { status: 'paused' }) : card(id)),
    });
    dispatcher.assign('MOD-11', card('oc-mimo'), 'owner');
    paused = true; // the owner pauses the card while the job still waits its turn in the opencode queue
    await wait();
    const quest = store.get('MOD-11');
    assert.equal(quest.status, 'failed', 'a card paused after the drop must still be caught before it actually spawns');
    assert.match(quest.lastDetail, /暂停/);
  });

  it('a real getAdventurer resolver reporting the card gone must refuse to start, never falling back to the captured card', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/MOD-13-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'MOD-13', brief: 'docs/briefs/MOD-13-x.md', by: 'owner' });
    let removed = false;
    const dispatcher = createDispatcher({
      config: realConfig,
      store,
      runners: okRunners,
      getAdventurer: (id) => (removed ? null : card(id)),
    });
    dispatcher.assign('MOD-13', card('oc-mimo'), 'owner');
    removed = true; // the owner deletes the card from the roster while the job still waits its turn
    await wait();
    const quest = store.get('MOD-13');
    assert.equal(quest.status, 'failed', 'a card removed after the drop must be refused, not silently re-dispatched under the stale captured object');
    assert.match(quest.lastDetail, /不在名册里/);
  });

  it('a getAdventurer resolver that throws also fails closed, same as one reporting the card gone', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/MOD-14-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'MOD-14', brief: 'docs/briefs/MOD-14-x.md', by: 'owner' });
    let broken = false;
    const dispatcher = createDispatcher({
      config: realConfig,
      store,
      runners: okRunners,
      getAdventurer: (id) => { if (broken) throw new Error('roster file locked'); return card(id); },
    });
    dispatcher.assign('MOD-14', card('oc-mimo'), 'owner');
    broken = true;
    await wait();
    const quest = store.get('MOD-14');
    assert.equal(quest.status, 'failed', 'a resolver error must refuse to start, not crash past the check or silently proceed');
    assert.match(quest.lastDetail, /查询名册出错/);
  });

  it('no getAdventurer at all (the default) keeps falling back to the captured card — absent-resolver compatibility is not the same as a removed card', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/MOD-15-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'MOD-15', brief: 'docs/briefs/MOD-15-x.md', by: 'owner' });
    const dispatcher = createDispatcher({ config: realConfig, store, runners: okRunners }); // no getAdventurer passed at all
    dispatcher.assign('MOD-15', card('oc-mimo'), 'owner');
    await wait();
    assert.equal(store.get('MOD-15').status, 'dispatched', 'with no resolver wired, the recheck has no way to know better and must not refuse on that basis alone');
  });

  it('refuses to start when the fresh card no longer matches the plan already built — a lane change is a stale plan, not something to silently reroute', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/P-5-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'P-5', brief: 'docs/briefs/P-5-x.md', by: 'owner' });
    const calls = [];
    let moved = false;
    let down = null;
    const dispatcher = createDispatcher({
      config: realConfig,
      store,
      getDownLanes: () => down,
      getAdventurer: (id) => (moved ? card(id, { lane: 'codex' }) : card(id)),
      runners: {
        session: async (step) => { calls.push(['session', step.command[0]]); return { code: 0, session: 's5' }; },
        run: async (step) => { calls.push(['run', step.command[0]]); return { code: 0 }; },
      },
    });
    dispatcher.assign('P-5', card('oc-mimo'), 'owner');
    // The card moves to a different lane after the drop, and the *original* plan's lane (opencode) goes
    // down — a recheck that judged only the fresh card's (now healthy) lane would miss this entirely.
    moved = true;
    down = new Set(['opencode']);
    await wait();
    assert.deepEqual(calls, [], 'neither the session nor the run step ever spawns once the plan is stale');
    const quest = store.get('P-5');
    assert.equal(quest.status, 'failed', 'refused cleanly before anything ran, so nothing is left ambiguous');
    assert.match(quest.lastDetail, /配置变了/);
  });

  it('rechecks again between the session step and the run step, not just once before the plan starts', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/MOD-9-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'MOD-9', brief: 'docs/briefs/MOD-9-x.md', by: 'owner' });
    const runCalls = [];
    const dispatcher = createDispatcher({
      config: realConfig,
      store,
      runners: {
        // The session step itself is where, in practice, the async gap before the run step opens up —
        // simulate the world changing (a cancel) right in that gap.
        session: async () => { store.setStatus('MOD-9', 'cancelled', { by: 'owner', detail: '临时取消', source: 'ui', ack: true }); return { code: 0 }; },
        run: async (step) => { runCalls.push(step); return { code: 0 }; },
      },
    });
    dispatcher.assign('MOD-9', card('oc-mimo'), 'owner');
    await wait();
    assert.deepEqual(runCalls, [], 'the run step must never fire once the session step invalidated the attempt');
    assert.equal(store.get('MOD-9').status, 'cancelled');
  });
});
