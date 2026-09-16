// Regression tests for the QB-FB-LIFECYCLE-1 revision-5 fixes: the four review findings (F1-F4) and the
// requirement-5 non-durable session stopgap, exercised through the real dispatcher/store, not the review
// job's throwaway probes. Each test names the finding it guards against a regression of.
//
// New file, authorized alongside the twelve reviewed WIP files as a narrow lifecycle test file (see
// local/briefs/QB-FB-LIFECYCLE-1-revision5.md). See dispatcherDelivery.test.js, dispatcherRecheckEnv.test.js,
// dispatcherAmbiguous.test.js and dispatcherAdoptPhase.test.js for the tests split out of the former,
// over-800-line dispatcher.test.js.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDispatcher } from '../../src/server/dispatcher.js';
import { QuestStore } from '../../src/core/store.js';
import { makeProject, card } from '../helpers.js';

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe('F1: native session saveTo failure never crashes and never wedges a serialized lane\'s queue', () => {
  it('a later, independent attempt still gets its turn after an earlier one\'s session file could not be saved', async () => {
    const natsess = { session: { run: ['node', 'tools/sess.mjs', '{name}'], saveTo: '.work/sess_{name}.txt' }, run: ['node', 'tools/ok.mjs', '{name}'], serialize: true, outputDir: '.work/natsess' };
    const { config: realConfig, write, root } = makeProject({ lanes: { natsess } });
    write('tools/sess.mjs', "console.log('ses_fixture_' + process.argv[2]);\n");
    write('tools/ok.mjs', 'process.exit(0);\n');
    write('docs/briefs/SV-1-x.md', 'brief');
    write('docs/briefs/SV-2-x.md', 'brief');
    fs.mkdirSync(path.join(root, '.work', 'sess_sv1.txt'), { recursive: true }); // saveTo is a directory, not a writable file
    const store = new QuestStore(realConfig);
    store.post({ package: 'SV-1', brief: 'docs/briefs/SV-1-x.md', by: 'owner' });
    store.post({ package: 'SV-2', brief: 'docs/briefs/SV-2-x.md', by: 'owner' });
    const natCard = card('oc-mimo', { id: 'nat-sess', lane: 'natsess', model: 'fixture-model', family: 'fam-sess', agent: '', variant: '', maxParallel: 3 });
    const dispatcher = createDispatcher({ config: realConfig, store, evidenceWaitMs: 50 }); // no runner overrides: real runScript + runSession
    const rejections = [];
    const onRejection = (e) => rejections.push(e);
    process.on('unhandledRejection', onRejection);
    try {
      dispatcher.assign('SV-1', natCard, 'owner');
      await wait(300);
      dispatcher.assign('SV-2', natCard, 'owner');
      await wait(2500);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    assert.deepEqual(rejections, [], 'a saveTo write failure inside execFile\'s own callback must never surface as an unhandled rejection');
    const q1 = store.get('SV-1');
    const q2 = store.get('SV-2');
    assert.equal(q1.status, 'dispatched', 'SV-1\'s write failure is an ordinary ambiguous outcome, not a crash');
    assert.equal(q1.assignee.session.id, 'ses_fixture_sv1', 'the id SV-1 actually captured is never lost even though the file write failed');
    assert.equal(q1.assignee.session.saveFailed, true, 'R4: a real captured id whose own file write failed is distinct from an unknown session — never conflated');
    assert.equal(q1.assignee.session.unknown, false, 'unknown is specifically "no id was ever captured" — not the same fact as saveFailed');
    assert.notEqual(q2.assignee.phase, 'queued', 'SV-2 must actually get its turn — a stuck, never-settling promise would leave it queued forever');
    assert.ok(fs.existsSync(path.join(root, '.work', 'sess_sv2.txt')), 'SV-2\'s own session step actually ran and saved its file, proving the queue was never wedged');
  });
});

describe('F2: an event-append failure right after a real start never frees the slot', () => {
  it('keeps the assignee when the confirming "dispatched" event cannot be written', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/FRTWO-1-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'FRTWO-1', brief: 'docs/briefs/FRTWO-1-x.md', by: 'owner' });
    const ef = realConfig.paths.events;
    let backup;
    const dispatcher = createDispatcher({
      config: realConfig, store, evidenceWaitMs: 50,
      runners: { run: async () => { backup = fs.readFileSync(ef); fs.rmSync(ef); fs.mkdirSync(ef); return { code: 0 }; } },
    });
    const rejections = [];
    const onRejection = (e) => rejections.push(e);
    process.on('unhandledRejection', onRejection);
    try {
      dispatcher.assign('FRTWO-1', card('codex-luna'), 'owner');
      await wait(150);
    } finally {
      process.off('unhandledRejection', onRejection);
      fs.rmdirSync(ef);
      fs.writeFileSync(ef, backup);
    }
    assert.deepEqual(rejections, [], 'an event-append failure right after a real start must never surface as an unhandled rejection');
    const disk = new QuestStore(realConfig).get('FRTWO-1');
    assert.equal(disk.status, 'dispatched', 'the run genuinely succeeded; the slot must stay exactly as assign() left it');
    assert.ok(disk.assignee, 'the assignee must not be cleared just because the confirming event could not be written');
  });
});

describe('F3: a registry read failure is unknown, never proof of failure', () => {
  it('never treats a registry read failure as verified never-started, with no prior session binding', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/FRTHREE-1-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'FRTHREE-1', brief: 'docs/briefs/FRTHREE-1-x.md', by: 'owner' });
    fs.mkdirSync(path.dirname(realConfig.paths.registry), { recursive: true });
    fs.mkdirSync(realConfig.paths.registry); // registry path is a directory: workerEvidence's own read throws
    const dispatcher = createDispatcher({ config: realConfig, store, evidenceWaitMs: 50, runners: { run: async () => ({ code: 1, error: 'wrapper exit' }) } });
    dispatcher.assign('FRTHREE-1', card('codex-luna'), 'owner');
    await wait(300);
    const quest = store.get('FRTHREE-1');
    assert.equal(quest.status, 'dispatched', 'a registry read failure must never be treated as proof the worker never started');
    assert.ok(quest.assignee, 'the slot must stay reserved');
    assert.equal(quest.assignee.unresolved, true);
  });

  it('keeps a known session binding independent of the registry\'s own health — the run step never routes through workerEvidence at all once a session id is known', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/FRTHREE-2-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'FRTHREE-2', brief: 'docs/briefs/FRTHREE-2-x.md', by: 'owner' });
    fs.mkdirSync(path.dirname(realConfig.paths.registry), { recursive: true });
    fs.mkdirSync(realConfig.paths.registry);
    const dispatcher = createDispatcher({
      config: realConfig, store, evidenceWaitMs: 50,
      runners: { session: async () => ({ code: 0, session: 'ses_f3' }), run: async () => ({ code: 1, error: 'send failed' }) },
    });
    dispatcher.assign('FRTHREE-2', card('oc-mimo'), 'owner');
    await wait(300);
    const quest = store.get('FRTHREE-2');
    assert.equal(quest.status, 'dispatched');
    assert.equal(quest.assignee.unresolved, true);
    assert.equal(quest.assignee.session.id, 'ses_f3', 'a known session binding is preserved regardless of the registry\'s own health');
  });
});

describe('requirement 5: a captured session id survives non-durably when its write-ahead record fails to persist', () => {
  it('exposes the id through the non-durable stopgap, and never claims durable success it does not have', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/P-3B-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'P-3B', brief: 'docs/briefs/P-3B-x.md', by: 'owner' });
    const qp = path.join(realConfig.paths.data, 'quests.jsonl');
    let backup;
    const dispatcher = createDispatcher({
      config: realConfig, store, evidenceWaitMs: 50,
      runners: {
        // quests.jsonl breaks only after the phase write-ahead for 'session_creating' already succeeded —
        // the session step itself is what captures the real id and then finds its own binding-persistence
        // write blocked (P3b's exact shape from the review).
        session: async () => { backup = fs.readFileSync(qp); fs.rmSync(qp); fs.mkdirSync(qp); return { code: 0, session: 'ses_real' }; },
        run: async () => ({ code: 0 }),
      },
    });
    const rejections = [];
    const onRejection = (e) => rejections.push(e);
    process.on('unhandledRejection', onRejection);
    let attemptId;
    try {
      const assigned = dispatcher.assign('P-3B', card('oc-mimo'), 'owner');
      attemptId = assigned.body.quest.assignee.attemptId;
      await wait(300);
    } finally {
      process.off('unhandledRejection', onRejection);
      fs.rmdirSync(qp);
      fs.writeFileSync(qp, backup);
    }
    assert.deepEqual(rejections, [], 'a disk-first save failure right after a captured session id must never surface as an unhandled rejection');

    const mem = store.get('P-3B');
    assert.equal(mem.status, 'dispatched');
    assert.equal(mem.assignee.phase, 'session_creating', 'the durable record honestly stays at the last phase it actually wrote — never a phase it merely attempted');
    assert.equal(mem.assignee.session, undefined, 'the captured id is not in the durable in-memory copy either — store.save() is disk-first');

    const disk = new QuestStore(realConfig).get('P-3B');
    assert.equal(disk.assignee.phase, 'session_creating');
    assert.equal(disk.assignee.session, undefined, 'and not on disk either — this is exactly the gap the non-durable stopgap exists for');

    // R3: the stopgap now lives inside this dispatcher instance, not a module-level Map — read it the same
    // way an HTTP consumer of the quest-detail diagnostic would, through the dispatcher's own sanitized getter.
    const note = dispatcher.getUnpersistedSession('P-3B', attemptId);
    assert.ok(note, 'the id the process actually captured must still be queryable in this process, even though it never became durable');
    assert.equal(note.sessionId, 'ses_real');
    assert.equal(note.persisted, false, 'never presented as a confirmed, restart-safe fact — the field says exactly what it is');
    assert.equal(note.error, undefined, 'the sanitized diagnostic never carries raw error text (a path, a command\'s stderr)');
  });
});

// A QuestStore whose recordPhase fails exactly once for the write that carries a `session` patch (a
// deterministic stand-in for a transient EBUSY on the session-binding save — the reviewer's C1 probe), and
// whose emitEvent fails exactly once for a 'status_note' — simulating both durable sinks under stress at the
// same moment, so a fix that accidentally depends on the *event* write succeeding (rather than only the
// recordPhase write) would be caught here.
class FailOnceStore extends QuestStore {
  constructor(config, { failSessionRecordOnce = false, failStatusNoteOnce = false } = {}) {
    super(config);
    this._failSessionRecordOnce = failSessionRecordOnce;
    this._failStatusNoteOnce = failStatusNoteOnce;
  }

  recordPhase(id, attempt, patch) {
    if (this._failSessionRecordOnce && patch && patch.session !== undefined) {
      this._failSessionRecordOnce = false;
      throw new Error('EBUSY: transient session-binding save failure (C1 fixture)');
    }
    return super.recordPhase(id, attempt, patch);
  }

  emitEvent(quest, event, fields) {
    if (this._failStatusNoteOnce && event === 'status_note') {
      this._failStatusNoteOnce = false;
      throw new Error('EBUSY: transient events-append failure (C1 fixture)');
    }
    return super.emitEvent(quest, event, fields);
  }
}

describe('R1 (C1): a successful preserve retry must persist the known session id together with unresolved', () => {
  it('clears the non-durable note only once the durable retry write actually carries the session id, independent of a simultaneous events failure', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/RONE-1-x.md', 'brief');
    const store = new FailOnceStore(realConfig, { failSessionRecordOnce: true, failStatusNoteOnce: true });
    store.post({ package: 'RONE-1', brief: 'docs/briefs/RONE-1-x.md', by: 'owner' });
    const dispatcher = createDispatcher({
      config: realConfig, store, evidenceWaitMs: 50,
      runners: { session: async () => ({ code: 0, session: 'ses_c1' }), run: async () => ({ code: 0 }) },
    });
    const assigned = dispatcher.assign('RONE-1', card('oc-mimo'), 'owner');
    const attemptId = assigned.body.quest.assignee.attemptId;
    await wait(200);

    const quest = store.get('RONE-1');
    assert.equal(quest.status, 'dispatched');
    assert.equal(quest.assignee.unresolved, true, 'the retry\'s own write-ahead still marks this attempt unresolved');
    assert.ok(quest.assignee.session, 'the retry must persist the session binding, not merely `unresolved: true`');
    assert.equal(quest.assignee.session.id, 'ses_c1', 'requirement 5: a later write must not clear the only structured session id without ever recording it durably');

    const disk = new QuestStore(realConfig).get('RONE-1');
    assert.equal(disk.assignee.session.id, 'ses_c1', 'durable on disk too, not only in the in-memory copy');

    const note = dispatcher.getUnpersistedSession('RONE-1', attemptId);
    assert.equal(note, null, 'once the durable record actually carries the same session id, the non-durable stopgap is redundant and is cleared');
  });

  it('does NOT clear the stopgap when the retry write succeeds without the session id (guards the exact bug the reviewer found)', async () => {
    // A store whose recordPhase always succeeds but whose caller (a deliberately unpatched preserveAmbiguous)
    // would only send `{ unresolved: true }` is exactly the confirmed R1 bug: this test exercises the real,
    // fixed dispatcher and would fail if the fix regressed back to a session-less retry.
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/RTWO-1-x.md', 'brief');
    const store = new FailOnceStore(realConfig, { failSessionRecordOnce: true });
    store.post({ package: 'RTWO-1', brief: 'docs/briefs/RTWO-1-x.md', by: 'owner' });
    const dispatcher = createDispatcher({
      config: realConfig, store, evidenceWaitMs: 50,
      runners: { session: async () => ({ code: 0, session: 'ses_c1b' }), run: async () => ({ code: 0 }) },
    });
    const assigned = dispatcher.assign('RTWO-1', card('oc-deepseek'), 'owner');
    const attemptId = assigned.body.quest.assignee.attemptId;
    await wait(200);
    const quest = store.get('RTWO-1');
    assert.equal(quest.assignee.session.id, 'ses_c1b', 'the fixed retry always resends the known id, so the durable record has it');
    assert.equal(dispatcher.getUnpersistedSession('RTWO-1', attemptId), null, 'and the stopgap is cleared because the two now agree');
  });

  it('a replacement attempt on the same quest never disturbs an older, still-unresolved attempt\'s own stopgap entry', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/RTHREE-1-x.md', 'brief');
    // The first attempt's session-binding write fails every time (a standing fault, not transient) — its
    // note is never cleared, and it stays that way even after the quest moves on to a second, independent
    // attempt.
    class AlwaysFailSessionStore extends QuestStore {
      recordPhase(id, attempt, patch) {
        if (patch && patch.session !== undefined) throw new Error('EBUSY: standing session-binding fault');
        return super.recordPhase(id, attempt, patch);
      }
    }
    const store = new AlwaysFailSessionStore(realConfig);
    store.post({ package: 'RTHREE-1', brief: 'docs/briefs/RTHREE-1-x.md', by: 'owner' });
    const dispatcher = createDispatcher({
      config: realConfig, store, evidenceWaitMs: 50,
      runners: { session: async () => ({ code: 0, session: 'ses_c1_old' }), run: async () => ({ code: 0 }) },
    });
    const first = dispatcher.assign('RTHREE-1', card('oc-mimo'), 'owner');
    const oldAttemptId = first.body.quest.assignee.attemptId;
    await wait(200);
    assert.equal(dispatcher.getUnpersistedSession('RTHREE-1', oldAttemptId).sessionId, 'ses_c1_old', 'the old attempt\'s own note is recorded');

    // The quest is still 'dispatched' (session write never became durable, so it stayed preserved/unresolved,
    // never freed) — force it open the way an operator ruling would, then dispatch a fresh, independent
    // attempt that succeeds cleanly. 'failed' is an OPEN_STATUSES member, so it is dispatchable again exactly
    // like a fresh 'posted' quest — no re-post needed to reopen it.
    store.setStatus('RTHREE-1', 'failed', { detail: 'operator override for this test', by: 'owner', source: 'ui', ack: true });
    const second = dispatcher.assign('RTHREE-1', card('oc-deepseek'), 'owner');
    const newAttemptId = second.body.quest.assignee.attemptId;
    assert.notEqual(newAttemptId, oldAttemptId);
    await wait(200);

    assert.equal(dispatcher.getUnpersistedSession('RTHREE-1', oldAttemptId).sessionId, 'ses_c1_old', 'the replacement attempt never overwrites or clears the older attempt\'s own entry');
    // The new attempt's own session write also fails the same standing way, so it gets its own, independent note.
    assert.equal(dispatcher.getUnpersistedSession('RTHREE-1', newAttemptId).sessionId, 'ses_c1_old', 'both attempts happen to capture the same fixture id here; they are still tracked as two separate entries by attemptId, never merged');
  });
});

describe('R2 (C2): the top-level generic .catch is phase-aware, never a blind free-and-fail', () => {
  it('preserves the reservation when an unexpected runner return follows a real, known session (post-effect)', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/RFOUR-1-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'RFOUR-1', brief: 'docs/briefs/RFOUR-1-x.md', by: 'owner' });
    const dispatcher = createDispatcher({
      config: realConfig, store, evidenceWaitMs: 50,
      runners: {
        session: async () => ({ code: 0, session: 'ses_c2' }),
        // An unexpected runner return (null, not a normal result object) after a real session is exactly
        // the kind of bug — never a documented, expected shape — the generic top-level `.catch` exists for:
        // accessing `.code` on it throws inside executePlan's own run step, well after the session's effect.
        run: async () => null,
      },
    });
    const assigned = dispatcher.assign('RFOUR-1', card('oc-mimo'), 'owner');
    const attempt = { attemptId: assigned.body.quest.assignee.attemptId, name: assigned.body.quest.assignee.name, lane: 'opencode', at: assigned.body.quest.assignee.at };
    await wait(200);
    const quest = store.get('RFOUR-1');
    assert.equal(quest.status, 'dispatched', 'a known session must never be dropped just because a later step threw something unexpected');
    assert.ok(quest.assignee, 'the reservation is preserved, not freed');
    assert.equal(quest.assignee.attemptId, attempt.attemptId);
    assert.equal(quest.assignee.unresolved, true, 'recorded as unresolved rather than silently ignored');
    assert.equal(quest.assignee.session.id, 'ses_c2', 'the known session id itself is untouched');
  });

  it('still fails and frees an ordinary pre-effect refusal (queued, no session, an unexpected throw before any step ever ran)', async () => {
    const { config: realConfig, write } = makeProject();
    write('docs/briefs/RFIVE-1-x.md', 'brief');
    const store = new QuestStore(realConfig);
    store.post({ package: 'RFIVE-1', brief: 'docs/briefs/RFIVE-1-x.md', by: 'owner' });
    const dispatcher = createDispatcher({ config: realConfig, store, evidenceWaitMs: 50, runners: { run: async () => ({ code: 0 }) } });
    // executePlan's very first line (before the loop, before the first recheck or onPhase ever runs, so
    // durably still 'queued' with no session) builds its log path from config.paths.data — the one place in
    // the function with no try/catch around it, because nothing has happened yet for it to need to guard.
    // Breaking it here is a genuine (if contrived) way to reach the generic top-level `.catch` in a truly
    // pre-effect state, rather than asserting the boundary function's contract without ever calling it.
    const realData = realConfig.paths.data;
    realConfig.paths.data = undefined;
    try {
      dispatcher.assign('RFIVE-1', card('codex-luna'), 'owner');
      await wait(200);
    } finally {
      realConfig.paths.data = realData;
    }
    const quest = store.get('RFIVE-1');
    assert.equal(quest.status, 'failed', 'a verified pre-effect (queued, no session) throw is still freed, not preserved forever');
    assert.equal(quest.assignee, null, 'the slot is freed exactly like any other proven-never-started outcome');
  });
});
