// Unit tests for dispatcher.assign's queued-start recheck: cases where a step already ran (a session was
// created, or the run step itself fired) before the plan was blocked or failed — the reservation must be
// preserved and marked unresolved, never freed, because an earlier effect may already have happened upstream.
//
// Split out of the former dispatcher.test.js (830 lines, over the file-size guideline) — this file owns the
// ambiguous-outcome cases; see dispatcherRecheckEnv.test.js for "nothing ran yet, refuse cleanly",
// dispatcherDelivery.test.js for deliverFromApi/applyLanes, dispatcherAdoptPhase.test.js for durable-phase
// persistence/adopt/naming, and dispatcherFaultRecovery.test.js for the new F1-F4 + requirement-5 regressions.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDispatcher } from '../../src/server/dispatcher.js';
import { QuestStore } from '../../src/core/store.js';
import { readJsonLines } from '../../src/core/jsonl.js';
import { makeProject, card } from '../helpers.js';

describe('dispatcher.assign queued-start recheck: ambiguous outcomes preserve the reservation', () => {
  it('preserves the reservation instead of marking failed when a queued recheck blocks after the session step already ran', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/MOD-10-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'MOD-10', brief: 'docs/briefs/MOD-10-x.md', by: 'owner' });
    const dispatcher = createDispatcher({
      config: realConfig,
      store,
      runners: {
        // The session step's own side effect is what the run step's recheck then sees — the tree lock
        // appearing is standing in for "a session was created upstream", the thing the recheck must not
        // pretend away just because it happens to block the next step.
        session: async () => {
          fs.mkdirSync(path.dirname(realConfig.paths.lock), { recursive: true });
          fs.writeFileSync(realConfig.paths.lock, '');
          return { code: 0, session: 'ses_777' };
        },
        run: async () => ({ code: 0 }),
      },
    });
    dispatcher.assign('MOD-10', card('oc-mimo'), 'owner');
    await new Promise((r) => setTimeout(r, 10));
    const quest = store.get('MOD-10');
    assert.equal(quest.status, 'dispatched', 'must not be marked failed once a session may already exist upstream');
    assert.ok(quest.assignee, 'the slot must stay reserved, not silently freed');
    const events = readJsonLines(realConfig.paths.events);
    assert.ok(events.some((e) => e.event === 'status_note' && /ses_777/.test(e.detail) && /手动确认/.test(e.detail)), 'the known session binding and the ambiguity are both surfaced, not silently resolved either way');
  });

  it('preserves the reservation instead of marking failed when the session step itself fails with a nonzero code after session_creating was persisted', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/P-1-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'P-1', brief: 'docs/briefs/P-1-x.md', by: 'owner' });
    const calls = [];
    const dispatcher = createDispatcher({
      config: realConfig,
      store,
      evidenceWaitMs: 50,
      runners: {
        session: async () => { calls.push('session'); return { code: 1, error: 'timeout' }; },
        run: async () => { calls.push('run'); return { code: 0 }; },
      },
    });
    dispatcher.assign('P-1', card('oc-mimo'), 'owner');
    await new Promise((r) => setTimeout(r, 300));
    const quest = store.get('P-1');
    assert.deepEqual(calls, ['session'], 'the run step never fires once the session step itself failed');
    assert.equal(quest.status, 'dispatched', 'a nonzero session exit is not proof nothing happened upstream; must not be marked failed');
    assert.ok(quest.assignee, 'the slot must stay reserved, not silently freed');
    assert.equal(quest.assignee.unresolved, true, 'a structured marker, not just prose, records the ambiguity');
    assert.deepEqual(quest.assignee.session, { id: null, saveTo: '.work/oc_session_p1.txt', unknown: true }, 'never narrowed to a known absence of session');
    const events = readJsonLines(realConfig.paths.events);
    assert.ok(events.some((e) => e.event === 'status_note' && /手动确认/.test(e.detail)), 'the ambiguity is surfaced, not silently resolved either way');
  });

  it('preserves the reservation the same way when the session runner throws instead of resolving nonzero', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/P-2-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'P-2', brief: 'docs/briefs/P-2-x.md', by: 'owner' });
    const dispatcher = createDispatcher({
      config: realConfig,
      store,
      evidenceWaitMs: 50,
      runners: { session: async () => { throw new Error('spawn crashed mid-create'); }, run: async () => ({ code: 0 }) },
    });
    dispatcher.assign('P-2', card('oc-mimo'), 'owner');
    await new Promise((r) => setTimeout(r, 300));
    const quest = store.get('P-2');
    assert.equal(quest.status, 'dispatched', 'a thrown session step is not proof nothing happened upstream either');
    assert.ok(quest.assignee, 'the slot must stay reserved');
    assert.equal(quest.assignee.unresolved, true);
  });

  it('preserves the reservation, not failed, when a run-only lane\'s run step exits nonzero with no evidence by the deadline (P7a)', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/P-7A-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'P-7A', brief: 'docs/briefs/P-7A-x.md', by: 'owner' });
    const dispatcher = createDispatcher({ config: realConfig, store, evidenceWaitMs: 50, runners: { run: async () => ({ code: 1, error: 'wrapper exit' }) } });
    dispatcher.assign('P-7A', card('codex-luna'), 'owner');
    await new Promise((r) => setTimeout(r, 300));
    const quest = store.get('P-7A');
    assert.equal(quest.status, 'dispatched', 'a run step\'s own nonzero exit, with no evidence either way, must not be treated as verified never-started');
    assert.ok(quest.assignee, 'the slot must stay reserved');
    assert.equal(quest.assignee.unresolved, true);
    const events = readJsonLines(realConfig.paths.events);
    assert.ok(events.some((e) => e.event === 'status_note' && /手动确认/.test(e.detail)), 'the ambiguity is surfaced with the current wording, not silently resolved either way');
  });

  it('preserves the reservation the same way when a run-only lane\'s run step throws instead of resolving nonzero (P7b)', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/P-7B-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'P-7B', brief: 'docs/briefs/P-7B-x.md', by: 'owner' });
    const dispatcher = createDispatcher({ config: realConfig, store, evidenceWaitMs: 50, runners: { run: async () => { throw new Error('spawn crashed'); } } });
    dispatcher.assign('P-7B', card('codex-luna'), 'owner');
    await new Promise((r) => setTimeout(r, 300));
    const quest = store.get('P-7B');
    assert.equal(quest.status, 'dispatched', 'a caught throw from a third-party runner is exactly as ambiguous as a plain nonzero exit');
    assert.ok(quest.assignee);
    assert.equal(quest.assignee.unresolved, true);
  });

  it('always keeps a known session binding, even when the run step that follows it exits nonzero (P7c)', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/P-7C-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'P-7C', brief: 'docs/briefs/P-7C-x.md', by: 'owner' });
    const dispatcher = createDispatcher({
      config: realConfig, store, evidenceWaitMs: 50,
      runners: { session: async () => ({ code: 0, session: 'ses_known' }), run: async () => ({ code: 1, error: 'send failed' }) },
    });
    dispatcher.assign('P-7C', card('oc-mimo'), 'owner');
    await new Promise((r) => setTimeout(r, 300));
    const quest = store.get('P-7C');
    assert.equal(quest.status, 'dispatched', 'a known session id already names a real resource upstream, no matter what the run step proves');
    assert.ok(quest.assignee, 'the slot must stay reserved');
    assert.equal(quest.assignee.unresolved, true);
    assert.equal(quest.assignee.session.id, 'ses_known', 'the session id itself must not be lost from the current record');
    const events = readJsonLines(realConfig.paths.events);
    assert.ok(events.some((e) => e.event === 'status_note' && /ses_known/.test(e.detail) && /手动确认/.test(e.detail)), 'the known session binding and the ambiguity are both surfaced with the current wording');
  });

  it('always keeps a known session binding when the run step throws instead of resolving nonzero (P7d)', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/P-7D-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'P-7D', brief: 'docs/briefs/P-7D-x.md', by: 'owner' });
    const dispatcher = createDispatcher({
      config: realConfig, store, evidenceWaitMs: 50,
      runners: { session: async () => ({ code: 0, session: 'ses_known' }), run: async () => { throw new Error('send crash'); } },
    });
    dispatcher.assign('P-7D', card('oc-mimo'), 'owner');
    await new Promise((r) => setTimeout(r, 300));
    const quest = store.get('P-7D');
    assert.equal(quest.status, 'dispatched');
    assert.ok(quest.assignee);
    assert.equal(quest.assignee.unresolved, true);
    assert.equal(quest.assignee.session.id, 'ses_known');
  });

  it('never lets a disk failure at the very first write-ahead throw twice and crash the process, and leaves the quest exactly as durable (P3)', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/P-3-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'P-3', brief: 'docs/briefs/P-3-x.md', by: 'owner' });
    const dispatcher = createDispatcher({ config: realConfig, store, evidenceWaitMs: 50, runners: { session: async () => ({ code: 0, session: 'x' }), run: async () => ({ code: 0 }) } });
    const rejections = [];
    const onRejection = (error) => rejections.push(error);
    process.on('unhandledRejection', onRejection);
    const qp = path.join(realConfig.paths.data, 'quests.jsonl');
    try {
      dispatcher.assign('P-3', card('oc-mimo'), 'owner');
      const backup = fs.readFileSync(qp);
      fs.rmSync(qp);
      fs.mkdirSync(qp);
      await new Promise((r) => setTimeout(r, 300));
      const mem = store.get('P-3');
      fs.rmdirSync(qp);
      fs.writeFileSync(qp, backup);
      assert.equal(mem.status, 'dispatched', 'no effect/status advance while quests.jsonl could not be written at all');
      assert.equal(mem.assignee.phase, 'queued');
      const disk = new QuestStore(realConfig).get('P-3');
      assert.equal(disk.status, 'dispatched');
      assert.equal(disk.assignee.phase, 'queued');
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    assert.deepEqual(rejections, [], 'a persistence failure at the very first phase must never surface as an unhandled rejection');
  });

  it('preserves the ambiguous session reservation, not failed, when the events file itself fails to append the note (P6)', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/P-6-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'P-6', brief: 'docs/briefs/P-6-x.md', by: 'owner' });
    const ef = realConfig.paths.events;
    let backup;
    const dispatcher = createDispatcher({
      config: realConfig, store, evidenceWaitMs: 50,
      runners: {
        session: async () => { backup = fs.readFileSync(ef); fs.rmSync(ef); fs.mkdirSync(ef); return { code: 1, error: 'timeout' }; },
        run: async () => ({ code: 0 }),
      },
    });
    const rejections = [];
    const onRejection = (error) => rejections.push(error);
    process.on('unhandledRejection', onRejection);
    try {
      dispatcher.assign('P-6', card('oc-mimo'), 'owner');
      await new Promise((r) => setTimeout(r, 300));
      const mem = store.get('P-6');
      fs.rmdirSync(ef);
      fs.writeFileSync(ef, backup);
      assert.equal(mem.status, 'dispatched', 'must never fall through to failIfStillOurs just because the note event could not be written');
      assert.equal(mem.assignee.unresolved, true, 'the structured marker is still recorded — it lives on quests.jsonl, untouched by the events failure');
      const disk = new QuestStore(realConfig).get('P-6');
      assert.equal(disk.status, 'dispatched');
      assert.equal(disk.assignee.unresolved, true);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    assert.deepEqual(rejections, [], 'an events-append failure while handling an ambiguous session must never surface as an unhandled rejection');
  });
});
