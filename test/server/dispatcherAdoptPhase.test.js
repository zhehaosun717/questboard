// Unit tests for the durable write-ahead phase/session record, worker-name reuse across quests, and adopt()'s
// name-conflict refusals.
//
// Split out of the former dispatcher.test.js (830 lines, over the file-size guideline) — see
// dispatcherRecheckEnv.test.js and dispatcherAmbiguous.test.js for the queued-start recheck cases,
// dispatcherDelivery.test.js for deliverFromApi/applyLanes, and dispatcherFaultRecovery.test.js for the new
// F1-F4 + requirement-5 regressions.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDispatcher } from '../../src/server/dispatcher.js';
import { QuestStore } from '../../src/core/store.js';
import { makeProject, card } from '../helpers.js';

const wait = () => new Promise((r) => setTimeout(r, 10));

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('dispatcher.assign: durable write-ahead phase and worker naming', () => {
  it('persists the write-ahead phase and session binding durably: visible mid-flight while the run effect is still unresolved, and after a fresh store reload', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/MOD-12-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'MOD-12', brief: 'docs/briefs/MOD-12-x.md', by: 'owner' });
    const runGate = deferred();
    const dispatcher = createDispatcher({
      config: realConfig,
      store,
      runners: {
        session: async () => ({ code: 0, session: 'ses_durable' }),
        // The run effect itself never resolves during this test — a real, ordinary runner (no test-only
        // hook into the dispatcher), just one whose promise we control the timing of.
        run: async () => { await runGate.promise; return { code: 0 }; },
      },
    });
    dispatcher.assign('MOD-12', card('oc-mimo'), 'owner');
    await wait(); // the session step has resolved; the run effect is now hanging on runGate, still unresolved
    const midFlight = store.get('MOD-12');
    assert.equal(midFlight.status, 'dispatched', 'still mid-flight, nothing has failed or completed yet');
    assert.equal(midFlight.assignee.phase, 'launching', 'the run effect\'s write-ahead phase was persisted before the (still-pending) run effect was even called');
    assert.deepEqual(midFlight.assignee.session, { id: 'ses_durable', saveTo: '.work/oc_session_mod12.txt', unknown: false }, 'the session binding is already durable too, persisted before the run effect that follows it');

    // A brand-new QuestStore, reading the same on-disk quests.jsonl from nothing — standing in for a
    // restart/reload — sees the identical phase and session binding: this was never only in the first
    // store's in-memory Map, or only in executePlan's own (still-pending) return value.
    const reloaded = new QuestStore(realConfig).get('MOD-12');
    assert.equal(reloaded.assignee.phase, 'launching');
    assert.deepEqual(reloaded.assignee.session, midFlight.assignee.session);

    runGate.resolve();
    await wait();
    assert.equal(store.get('MOD-12').status, 'dispatched');
  });

  it('never hands a finished quest\'s worker name to a later package normalizing the same, even once it stops holding its slot', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/AB-CD-4-x.md', 'brief');
    write('docs/briefs/ABCD-4-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'AB-CD-4', brief: 'docs/briefs/AB-CD-4-x.md', by: 'owner' });
    const dispatcher = createDispatcher({ config: realConfig, store, runners: { session: async () => ({ code: 0 }), run: async () => ({ code: 0 }) } });
    const first = dispatcher.assign('AB-CD-4', card('oc-mimo'), 'owner');
    assert.equal(first.body.quest.assignee.name, 'abcd4');
    store.setStatus('AB-CD-4', 'delivered', { detail: 'done', by: 'lanes' }); // finished; no longer holds a slot

    store.post({ package: 'ABCD-4', brief: 'docs/briefs/ABCD-4-x.md', by: 'owner' });
    const second = dispatcher.assign('ABCD-4', card('oc-mimo'), 'owner');
    assert.equal(second.status, 200);
    assert.notEqual(second.body.quest.assignee.name, 'abcd4', 'AB-CD-4\'s own name must not be handed to an unrelated later package');
    assert.equal(second.body.quest.assignee.name, 'abcd4_2');
  });

  it('refuses to adopt a worker name already recorded against a different quest, but allows the same quest to re-adopt its own', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/MOD-12-x.md', 'brief');
    write('docs/briefs/MOD-13-x.md', 'brief');
    write('docs/briefs/MOD-14-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'MOD-12', brief: 'docs/briefs/MOD-12-x.md', by: 'owner' });
    store.post({ package: 'MOD-13', brief: 'docs/briefs/MOD-13-x.md', by: 'owner' });
    store.post({ package: 'MOD-14', brief: 'docs/briefs/MOD-14-x.md', by: 'owner' });
    const dispatcher = createDispatcher({ config: realConfig, store });
    const adopted = dispatcher.adopt('MOD-12', card('oc-mimo'), 'shared1', 'owner');
    assert.equal(adopted.status, 200);

    const conflict = dispatcher.adopt('MOD-13', card('oc-mimo'), 'shared1', 'owner');
    assert.equal(conflict.status, 409);
    assert.match(conflict.body.error, /MOD-12/);
    assert.equal(store.get('MOD-13').status, 'posted', 'the ambiguous adoption must not have touched MOD-13');

    // The same quest re-adopting its own past name (a restart, a reconnect) is unambiguous and stays
    // allowed — OPEN_STATUSES lets a stalled quest (still holding its slot) be re-adopted without release().
    store.setStatus('MOD-12', 'stalled', { detail: 'quiet for now' });
    const reAdopted = dispatcher.adopt('MOD-12', card('oc-mimo'), 'shared1', 'owner');
    assert.equal(reAdopted.status, 200);

    // An idempotent repeat of the exact same request (same requestKey) is valid even when the name it
    // repeats is already recorded against this very quest — answered from the repeated() short-circuit
    // before the ambiguity check (which would find no *other* quest owns it anyway) ever runs.
    const first = dispatcher.adopt('MOD-14', card('oc-mimo'), 'shared2', 'owner', { requestKey: 'k1' });
    assert.equal(first.status, 200);
    const repeat = dispatcher.adopt('MOD-14', card('oc-mimo'), 'shared2', 'owner', { requestKey: 'k1' });
    assert.equal(repeat.status, 200);
    assert.equal(repeat.body.repeated, true);
  });

  it('refuses to re-adopt a name that belongs to a distinct, earlier attempt on the same quest — even after that attempt ended', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/RUN-5-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'RUN-5', brief: 'docs/briefs/RUN-5-x.md', by: 'owner' });
    const dispatcher = createDispatcher({ config: realConfig, store });
    dispatcher.adopt('RUN-5', card('codex-luna'), 'run5', 'owner');
    store.setStatus('RUN-5', 'failed', { detail: 'old attempt exited' });
    const before = store.get('RUN-5');

    const readopt = dispatcher.adopt('RUN-5', card('codex-luna'), 'run5', 'owner');
    assert.equal(readopt.status, 409, 'the name is this quest\'s own, but it belongs to an attempt that already ended, not a live reconnect');
    assert.match(readopt.body.error, /run5/);
    assert.deepEqual(store.get('RUN-5'), before, 'refused with no effects: status, assignee and dispatches are untouched');

    // A genuinely different, never-used name for the same quest is unaffected — only reusing a name a
    // distinct earlier attempt already owns is refused.
    const fresh = dispatcher.adopt('RUN-5', card('codex-luna'), 'run5b', 'owner');
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.quest.assignee.name, 'run5b');
  });
});
