import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workerName, planDispatch, preflight, workerEvidence, executePlan, bashPath, recordedNames } from '../../src/core/dispatch.js';
import { writeApiDelivery, TRANSIENT_DELIVERY_CODES } from '../../src/core/deliveries.js';
import { appendJsonLine } from '../../src/core/jsonl.js';
import { resolveConfig } from '../../src/core/config.js';
import { makeProject, card, quest, tmpDir } from '../helpers.js';

const q = quest({ id: 'ART-WIRE-2H', brief: 'docs/briefs/ART-WIRE-2H-x.md' });

describe('planDispatch', () => {
  it('numbers re-dispatches so outputs are never overwritten', () => {
    assert.equal(workerName(q), 'artwire2h');
    assert.equal(workerName({ ...q, dispatches: [{}] }), 'artwire2h_2');
  });

  it('never hands out a worker name already held by another active quest, even when ids normalize the same', () => {
    // Package id normalization keeps only [a-z0-9], which is lossy: 'RUN-4' and 'RUN.4' collide on 'run4'.
    const a = { id: 'RUN-4', dispatches: [] };
    const b = { id: 'RUN.4', dispatches: [] };
    assert.equal(workerName(a), 'run4', 'no active names yet, so the plain base name is used');
    const nameB = workerName(b, new Set(['run4']));
    assert.equal(nameB, 'run4_2', 'a different quest with a colliding base name steps to the next free slot');
    const nameC = workerName({ id: 'RUN_4', dispatches: [] }, new Set(['run4', 'run4_2']));
    assert.equal(nameC, 'run4_3', 'each further collision keeps stepping forward');
    // A quest's own re-dispatch numbering (from its dispatch count) combines with collision avoidance.
    assert.equal(workerName({ ...a, dispatches: [{}] }, new Set(['run4', 'run4_2'])), 'run4_3');
  });

  it('records every name a quest has ever dispatched or currently holds, not just currently active ones', () => {
    const finished = { id: 'RUN-4', status: 'delivered', assignee: null, dispatches: [{ name: 'run4' }, { name: 'run4_2' }] };
    const running = { id: 'RUN-5', status: 'dispatched', assignee: { name: 'run5' }, dispatches: [{ name: 'run5' }] };
    const untouched = { id: 'RUN-6', status: 'posted', assignee: null, dispatches: [] };
    assert.deepEqual(recordedNames([finished, running, untouched]), new Set(['run4', 'run4_2', 'run5']));
  });

  it('never hands a finished quest\'s worker name to a different, later package that normalizes the same', () => {
    // 'AB-CD-4' finished (no longer holds a slot) before 'ABCD-4' — a different, valid package id that
    // normalizes to the same base name — is ever dispatched. Using only currently-held names (the old
    // behaviour) would let ABCD-4 reuse 'abcd4', silently landing on AB-CD-4's own report/session files.
    const finished = { id: 'AB-CD-4', status: 'delivered', assignee: null, dispatches: [{ name: 'abcd4' }] };
    const later = { id: 'ABCD-4', dispatches: [] };
    assert.equal(workerName(later, recordedNames([finished, later])), 'abcd4_2');
  });

  it('fills a file lane template', () => {
    const { config } = makeProject();
    assert.deepEqual(planDispatch(config, q, card('codex-luna'), 'artwire2h'), [{ kind: 'run', command: ['tools/codex-run.sh', 'artwire2h', q.brief, 'gpt-5.6-luna', 'high'], env: {} }]);
    assert.deepEqual(planDispatch(config, q, card('dsh-deepseek'), 'artwire2h')[0].command, ['tools/dsh-run.sh', 'artwire2h', q.brief]);
  });

  it('creates an API session under the agent, then sends with the agent set', () => {
    const { config } = makeProject();
    const [session, send] = planDispatch(config, q, card('oc-mimo'), 'artwire2h');
    assert.deepEqual(session, { kind: 'session', command: ['node', 'tools/oc.js', 'new', 'ART-WIRE-2H artwire2h'], saveTo: '.work/oc_session_artwire2h.txt', env: { OC_AGENT: 'build' } });
    assert.deepEqual(send.env, { OC_AGENT: 'build' });
  });

  it("gives a card's own env to its lane command, overriding the lane's", () => {
    const { config } = makeProject();
    const [, send] = planDispatch(config, q, card('oc-mimo', { env: { OPENAI_BASE_URL: 'https://api.example.test/v1', OC_AGENT: 'from-card' } }), 'artwire2h');
    assert.deepEqual(send.env, { OC_AGENT: 'from-card', OPENAI_BASE_URL: 'https://api.example.test/v1' }, 'the card wins, and adds its own');
    const filled = planDispatch(config, q, card('codex-luna', { env: { UPSTREAM_MODEL: '{model}' } }), 'artwire2h')[0];
    assert.deepEqual(filled.env, { UPSTREAM_MODEL: 'gpt-5.6-luna' }, 'a card env value fills placeholders like the lane does');
  });

  it('refuses a missing agent or an unknown lane instead of guessing', () => {
    const { config } = makeProject();
    assert.throws(() => planDispatch(config, q, card('oc-mimo', { agent: undefined }), 'n'), /needs \{agent\}/);
    assert.throws(() => planDispatch(config, q, card('codex-luna', { lane: 'claudia' }), 'n'), /no lane claudia/);
  });
});

describe('preflight and evidence', () => {
  it('names a missing script', () => {
    const { config, write } = makeProject({ bash: process.execPath });
    const plan = planDispatch(config, q, card('oc-mimo'), 'n1');
    assert.throws(() => preflight(config, plan), /tools\/oc\.js/);
    write('tools/oc.js', '');
    assert.throws(() => preflight(config, plan), /tools\/oc-send\.sh/);
    write('tools/oc-send.sh', '');
    assert.doesNotThrow(() => preflight(config, plan));
  });

  it('finds a fresh registry row or output file, ignoring older ones', () => {
    const { config, write } = makeProject();
    const since = new Date().toISOString();
    assert.equal(workerEvidence(config, 'codex', 'run3c', since), null);
    appendJsonLine(config.paths.registry, { at: '2026-09-01T00:00:00.000Z', event: 'dispatch', name: 'run3c' });
    assert.equal(workerEvidence(config, 'codex', 'run3c', since), null);
    appendJsonLine(config.paths.registry, { at: new Date().toISOString(), event: 'dispatch', name: 'run3c' });
    assert.match(workerEvidence(config, 'codex', 'run3c', since), /登记表/);
    write('.work/claude/art1.out', '{}');
    assert.match(workerEvidence(config, 'claude', 'art1', since), /\.work\/claude\/art1\.out/);
  });
});

describe('executePlan', () => {
  it('stops at the first failing step and reports it', async () => {
    const { config } = makeProject();
    const calls = [];
    const result = await executePlan(config, planDispatch(config, q, card('oc-mimo'), 'n2'), {
      name: 'n2',
      runners: { session: async (step) => { calls.push(step.kind); return { code: 1, error: 'api down' }; }, run: async () => ({ code: 0 }) },
    });
    assert.equal(result.ok, false);
    assert.match(result.detail, /api down/);
    assert.deepEqual(calls, ['session']);
  });

  it('never runs a step recheck refuses, and stops the plan there instead of continuing', async () => {
    const { config } = makeProject();
    const calls = [];
    let checks = 0;
    const plan = planDispatch(config, q, card('oc-mimo'), 'n2b');
    const result = await executePlan(config, plan, {
      name: 'n2b',
      runners: { session: async () => { calls.push('session'); return { code: 0 }; }, run: async () => { calls.push('run'); return { code: 0 }; } },
      // Approves the session step (the first recheck), then refuses the run step (the second) — the queued
      // world changed in the gap between the two, exactly what a serialized lane's wait creates in practice.
      recheck: async () => { checks += 1; return checks === 1 ? { ok: true } : { ok: false, detail: '排队时条件变了' }; },
    });
    assert.deepEqual(calls, ['session'], 'the run step must never fire once its own recheck refused it');
    // The session step already ran (its runner returned success with no id to capture) before the run
    // step's own recheck blocked it — phase 'session_creating', not 'queued' or 'launching' (that phase is
    // reserved for "before the run effect"), and an explicit-unknown binding.
    assert.deepEqual(result, { ok: false, blocked: true, logFile: result.logFile, detail: '排队时条件变了', phase: 'session_creating', session: { id: null, saveTo: plan[0].saveTo, unknown: true } });
  });

  it('a recheck approving every step changes nothing about a normal run', async () => {
    const { config } = makeProject();
    const result = await executePlan(config, planDispatch(config, q, card('oc-mimo'), 'n2c'), {
      name: 'n2c',
      runners: { session: async () => ({ code: 0 }), run: async () => ({ code: 0 }) },
      recheck: async () => ({ ok: true }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.blocked, undefined);
  });

  it('reports phase "queued" when recheck blocks before any step ran, and "session_creating" once the session step already has', async () => {
    const { config } = makeProject();
    const plan = planDispatch(config, q, card('oc-mimo'), 'n2d');
    const queuedResult = await executePlan(config, plan, {
      name: 'n2d',
      runners: { session: async () => ({ code: 0, session: 'ses_x' }), run: async () => ({ code: 0 }) },
      recheck: async () => ({ ok: false, detail: '排队时条件变了' }),
    });
    assert.equal(queuedResult.phase, 'queued', 'blocked on the very first step, before anything ran');
    assert.equal(queuedResult.session, null, 'no session step ever ran, so nothing to bind');

    // The run step's own recheck (the second call) is what blocks here — the session step already ran and
    // resolved. Its write-ahead phase is 'session_creating', persisted before the session effect; 'launching'
    // is only ever persisted immediately before the run effect itself, with no recheck in between it and that
    // effect, so a blocked result can never report 'launching' — reaching 'launching' means the run effect is
    // about to run, not that it was stopped first.
    let checks = 0;
    const launchingResult = await executePlan(config, plan, {
      name: 'n2e',
      runners: { session: async () => ({ code: 0, session: 'ses_y' }), run: async () => ({ code: 0 }) },
      recheck: async () => { checks += 1; return checks === 1 ? { ok: true } : { ok: false, detail: '排队时条件变了' }; },
    });
    assert.equal(launchingResult.phase, 'session_creating', 'the session step already ran before the run step was blocked, but the run effect itself never got a write-ahead phase');
    assert.deepEqual(launchingResult.session, { id: 'ses_y', saveTo: plan[0].saveTo, unknown: false });
  });

  it('a step that fails outright (not a recheck block) still reports the phase it reached', async () => {
    const { config } = makeProject();
    const result = await executePlan(config, planDispatch(config, q, card('oc-mimo'), 'n2h'), {
      name: 'n2h',
      runners: { session: async () => ({ code: 0, session: 'ses_z' }), run: async () => ({ code: 1, error: 'boom' }) },
    });
    assert.equal(result.ok, false);
    assert.equal(result.blocked, undefined, 'a real step failure is not a recheck block');
    assert.equal(result.phase, 'launching', 'the session step already ran before the run step failed');
    assert.deepEqual(result.session, { id: 'ses_z', saveTo: planDispatch(config, q, card('oc-mimo'), 'n2h')[0].saveTo, unknown: false });
  });

  it('a session step\'s nonzero exit (a bad code, an execFile timeout) never claims a known absence of session — unknown stays true, not just "no id yet"', async () => {
    const { config } = makeProject();
    const plan = planDispatch(config, q, card('oc-mimo'), 'n2j');
    const result = await executePlan(config, plan, {
      name: 'n2j',
      runners: { session: async () => ({ code: 1, error: 'timeout' }), run: async () => ({ code: 0 }) },
    });
    assert.equal(result.ok, false);
    assert.equal(result.blocked, undefined);
    assert.equal(result.phase, 'session_creating');
    assert.deepEqual(result.session, { id: null, saveTo: plan[0].saveTo, unknown: true }, 'a nonzero exit is not proof the session was never created upstream');
  });

  it('a session step that throws is caught, not left to reject the whole plan — treated the same as a nonzero exit', async () => {
    const { config } = makeProject();
    const plan = planDispatch(config, q, card('oc-mimo'), 'n2k');
    const result = await executePlan(config, plan, {
      name: 'n2k',
      runners: { session: async () => { throw new Error('spawn crashed mid-create'); }, run: async () => ({ code: 0 }) },
    });
    assert.equal(result.ok, false);
    assert.equal(result.blocked, undefined);
    assert.match(result.detail, /抛出异常/);
    assert.match(result.detail, /spawn crashed mid-create/);
    assert.equal(result.phase, 'session_creating');
    assert.deepEqual(result.session, { id: null, saveTo: plan[0].saveTo, unknown: true });
  });

  it('a run step that throws is caught the same way, at the "launching" phase with no session binding involved', async () => {
    const { config } = makeProject();
    const plan = planDispatch(config, q, card('codex-luna'), 'n2l');
    const result = await executePlan(config, plan, {
      name: 'n2l',
      runners: { run: async () => { throw new Error('run crashed'); } },
    });
    assert.equal(result.ok, false);
    assert.equal(result.blocked, undefined);
    assert.match(result.detail, /抛出异常/);
    assert.match(result.detail, /run crashed/);
    assert.equal(result.phase, 'launching');
    assert.equal(result.session, null, 'no session step in this plan at all');
  });

  it('persists an explicit "unknown" session binding when the runner reports success without a session id to capture', async () => {
    const { config } = makeProject();
    const plan = planDispatch(config, q, card('oc-mimo'), 'n2f');
    const result = await executePlan(config, plan, {
      name: 'n2f',
      runners: { session: async () => ({ code: 0 }), run: async () => ({ code: 0 }) },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.session, { id: null, saveTo: plan[0].saveTo, unknown: true }, 'success with no id is captured as explicitly unknown, never silently "no session"');
  });

  it('calls onPhase as a write-ahead signal before each effect — session_creating before the session runs, launching before the run does', async () => {
    const { config } = makeProject();
    const plan = planDispatch(config, q, card('oc-mimo'), 'n2g');
    const calls = [];
    await executePlan(config, plan, {
      name: 'n2g',
      runners: {
        session: async () => { calls.push('session-ran'); return { code: 0, session: 'ses_w' }; },
        run: async () => { calls.push('run-ran'); return { code: 0 }; },
      },
      onPhase: (phase) => calls.push(`onPhase:${phase}`),
    });
    assert.deepEqual(calls, ['onPhase:session_creating', 'session-ran', 'onPhase:session', 'onPhase:launching', 'run-ran'], 'each write-ahead phase call precedes the effect it announces');
  });

  it('never runs a step whose write-ahead onPhase persistence itself fails', async () => {
    const { config } = makeProject();
    const plan = planDispatch(config, q, card('oc-mimo'), 'n2i');
    const calls = [];
    const result = await executePlan(config, plan, {
      name: 'n2i',
      runners: {
        session: async () => { calls.push('session-ran'); return { code: 0, session: 'ses_v' }; },
        run: async () => { calls.push('run-ran'); return { code: 0 }; },
      },
      // The session effect persists fine; the run step's own write-ahead phase cannot be recorded (a stale
      // attempt, a disk error) — the run effect must never fire, exactly as if a recheck had refused it.
      onPhase: (phase) => { if (phase === 'launching') throw new Error('disk full'); },
    });
    assert.deepEqual(calls, ['session-ran'], 'the run effect never runs once its own write-ahead phase could not be persisted');
    assert.equal(result.ok, false);
    assert.equal(result.blocked, true, 'a persistence failure is treated exactly like a recheck refusal: nothing after it runs');
    assert.equal(result.persistFailed, true);
    assert.equal(result.phase, 'session_creating', 'the last phase that was actually persisted');
    assert.deepEqual(result.session, { id: 'ses_v', saveTo: plan[0].saveTo, unknown: false }, 'the session binding persisted fine before the failure');
  });

  it('flags a run step whose own spawn never created a process as neverStarted, not just a plain failure', async () => {
    // A bare, unresolvable executable name (no .sh, not 'node') goes straight to spawn() as the command
    // itself — never through Git Bash, which would spawn fine and only fail internally, an entirely
    // different, ambiguous shape this test is not exercising.
    const { config } = makeProject({ lanes: { ghost: { run: ['this-binary-does-not-exist-xyz123'], outputDir: '.work/ghost' } } });
    const plan = planDispatch(config, q, card('codex-luna', { lane: 'ghost' }), 'n2m');
    const result = await executePlan(config, plan, { name: 'n2m' }); // no runner override — exercises the real runScript spawn path
    assert.equal(result.ok, false);
    assert.equal(result.neverStarted, true, 'a spawn that never created a process is a distinct, verified signal');
  });

  it('never flags a run step that merely throws through a third-party runner override as neverStarted', async () => {
    const { config } = makeProject();
    const result = await executePlan(config, planDispatch(config, q, card('codex-luna'), 'n2n'), {
      name: 'n2n',
      runners: { run: async () => { throw new Error('third-party runner crashed'); } },
    });
    assert.equal(result.ok, false);
    assert.notEqual(result.neverStarted, true, 'an arbitrary throw from a runner override is ambiguous, not a verified never-started signal');
  });

  let bash = null;
  try { bash = bashPath(resolveConfig(tmpDir(), { name: 'x', lanes: { a: { run: ['a'], outputDir: 'o' } } })); } catch { bash = null; }

  it('captures a real bash wrapper that backgrounds its worker', { skip: !bash && 'Git Bash not installed' }, async () => {
    const { config, write } = makeProject({ lanes: { fake: { run: ['tools/fake-run.sh', '{name}'], outputDir: '.work/fake' } } });
    write('tools/fake-run.sh', '#!/usr/bin/env bash\nset -euo pipefail\n( sleep 1; echo 0 > "$1.exit" ) &\necho "fake worker started"\n');
    const result = await executePlan(config, planDispatch(config, q, card('codex-luna', { lane: 'fake' }), 'w1'), { name: 'w1' });
    assert.equal(result.ok, true, result.detail);
    assert.match(fs.readFileSync(result.logFile, 'utf8'), /fake worker started/);
  });

  // F1 (native): a real session step (execFile, no runner override) whose saveTo happens to already be a
  // directory used to crash the whole process (an unguarded writeFileSync throw inside execFile's own
  // callback, uncatchable from here) and silently drop the id it had already captured. Exercised through the
  // real runSession, not an injected runner double, since the bug lived in code an injected double bypasses.
  it('a real session step whose saveTo is an existing directory never crashes and never loses the captured id (F1)', async () => {
    const natsess = { session: { run: ['node', 'tools/sess.mjs', '{name}'], saveTo: '.work/sess_{name}.txt' }, run: ['node', 'tools/ok.mjs', '{name}'], outputDir: '.work/natsess' };
    const { config, write, root } = makeProject({ lanes: { natsess } });
    write('tools/sess.mjs', "console.log('ses_fixture_' + process.argv[2]);\n");
    write('tools/ok.mjs', 'process.exit(0);\n');
    const name = 'n3f';
    fs.mkdirSync(path.join(root, '.work', `sess_${name}.txt`), { recursive: true }); // saveTo is a directory, not a writable file
    const plan = planDispatch(config, q, card('codex-luna', { lane: 'natsess' }), name);
    const result = await executePlan(config, plan, { name }); // no runner overrides: the real runScript + runSession run
    assert.equal(result.ok, false, 'a write failure is a normal step failure, never an uncaught exception that reaches here');
    assert.equal(result.phase, 'session_creating', 'the run step must never fire once its required session file failed to save');
    assert.deepEqual(result.session, { id: `ses_fixture_${name}`, saveTo: plan[0].saveTo, unknown: false, saveFailed: true }, 'the id the process actually reported is never discarded just because the file write failed; R4: distinct from an unknown session');
    assert.match(result.detail, new RegExp(`ses_fixture_${name}`), 'the captured id is visible in the failure detail too');
  });
});

describe('writeApiDelivery', () => {
  const reply = (body, ok = true, status = 200) => async () => ({ ok, status, json: async () => body });

  const completed = (parts, at = Date.now()) => ({ info: { role: 'assistant', time: { completed: at } }, parts });
  const running = (parts) => ({ info: { role: 'assistant', time: {} }, parts });

  it('writes the last completed assistant text to the delivery dir', async () => {
    const { config, write } = makeProject();
    write('.work/oc_session_mod1.txt', 'ses_abc\n');
    let asked = '';
    const messages = [
      completed([{ type: 'text', text: 'early' }], 1),
      completed([{ type: 'tool', tool: 'edit' }, { type: 'text', text: '1. Files' }, { type: 'text', text: '2. Assumptions' }], 2),
    ];
    const out = await writeApiDelivery(config, 'opencode', 'mod1', { fetchImpl: async (url) => { asked = url; return reply(messages)(); } });
    assert.equal(asked, 'http://oc.test/session/ses_abc/message');
    assert.equal(fs.readFileSync(out, 'utf8'), '1. Files\n\n2. Assumptions\n');
    assert.equal(out, path.join(config.root, '.work', 'oc', 'mod1.md'));
  });

  it('never walks back to an earlier turn when the last one is tool-only — that turn might still be mid-session', async () => {
    const { config, write } = makeProject();
    write('.work/oc_session_mod1.txt', 'ses_abc');
    const messages = [
      { info: { role: 'user' }, parts: [{ type: 'text', text: '交付前先跑一遍测试' }] },
      completed([{ type: 'text', text: '1. Files changed\n2. Tests pass' }], 1),
      completed([{ type: 'tool', tool: 'bash' }], 2),
    ];
    // Before the fix this walked back to the first completed turn and delivered its progress text — but
    // a completed tool-only turn is what a session looks like between steps, not a final report; only the
    // last message is ever read. With no `finish` field on that last turn either, it is the P1 ambiguity:
    // uncertain (transient), not a terminal "no text" failure — but still never the earlier turn's text.
    await assert.rejects(
      writeApiDelivery(config, 'opencode', 'mod1', { fetchImpl: reply(messages) }),
      (error) => TRANSIENT_DELIVERY_CODES.has(error.code) && /finish field/.test(error.message),
    );
  });

  it('rejects a completed turn whose finish reason says the session only stopped to run tools', async () => {
    const { config, write } = makeProject();
    write('.work/oc_session_mod1.txt', 'ses_abc');
    // The AssistantMessage.finish field the installed OpenCode SDK exposes (types.gen.d.ts): "tool-calls"
    // means another assistant turn follows once the tool result lands, even though this turn's own
    // time.completed is set and it happens to carry text.
    const messages = [{ info: { role: 'assistant', time: { completed: 1 }, finish: 'tool-calls' }, parts: [{ type: 'text', text: 'Reading the code first, then I will run the tests.' }] }];
    await assert.rejects(writeApiDelivery(config, 'opencode', 'mod1', { fetchImpl: reply(messages) }), /ended on a tool call/, 'a mid-step turn is not a final report just because it has text');
  });

  it('does not fabricate success from an in-flight tool cycle', async () => {
    const { config, write } = makeProject();
    write('.work/oc_session_mod1.txt', 'ses_abc');
    const messages = [
      completed([{ type: 'text', text: '1. Files changed' }], 1),
      running([{ type: 'tool', tool: 'bash', state: { status: 'running' } }]),
    ];
    await assert.rejects(writeApiDelivery(config, 'opencode', 'mod1', { fetchImpl: reply(messages) }), /still running/, 'a live tool call is not "delivered" just because an earlier turn had text');
  });

  it('fails loudly on a missing session, an HTTP error, no text, or a bad name', async () => {
    const { config, write } = makeProject();
    write('.work/oc_session_mod1.txt', 'ses_abc');
    await assert.rejects(writeApiDelivery(config, 'opencode', 'nope', { fetchImpl: reply([]) }), /no session file/);
    await assert.rejects(writeApiDelivery(config, 'opencode', 'mod1', { fetchImpl: reply({}, false, 500) }), /answered 500/);
    await assert.rejects(writeApiDelivery(config, 'opencode', 'mod1', { fetchImpl: reply([{ info: { role: 'assistant' }, parts: [] }]) }), /still running/, 'no time.completed at all is not proof the turn is done');
    await assert.rejects(writeApiDelivery(config, 'opencode', '../x', { fetchImpl: reply([]) }), /bad worker name/);
    await assert.rejects(writeApiDelivery(config, 'codex', 'mod1', { fetchImpl: reply([]) }), /has no api/);
  });

  it('does not treat an absent finish field on a completed, textless turn as terminal — only as uncertain (P1/N2-a)', async () => {
    const { config, write } = makeProject();
    write('.work/oc_session_mod1.txt', 'ses_abc');
    // Indistinguishable here from a real tool-only step mid-session on an SDK build that does not always
    // set `finish`: a false terminal failure here would free the quest's slot while the session might still
    // be running, so this must be transient (retryable), not the generic terminal "no final assistant text".
    await assert.rejects(
      writeApiDelivery(config, 'opencode', 'mod1', { fetchImpl: reply([completed([])]) }),
      (error) => TRANSIENT_DELIVERY_CODES.has(error.code) && /finish field/.test(error.message),
      'an absent finish field on a textless completed turn must be transient, not a terminal failure',
    );
  });

  it('still fails loudly (terminal) when the adapter explicitly says a turn ended with no text', async () => {
    const { config, write } = makeProject();
    write('.work/oc_session_mod1.txt', 'ses_abc');
    const explicit = { info: { role: 'assistant', time: { completed: 1 }, finish: 'stop' }, parts: [] };
    await assert.rejects(
      writeApiDelivery(config, 'opencode', 'mod1', { fetchImpl: reply([explicit]) }),
      (error) => !TRANSIENT_DELIVERY_CODES.has(error.code) && /no final assistant text/.test(error.message),
      'finish says the turn is really over, so an empty text here is a genuine terminal fact',
    );
  });

  it('treats a malformed response body as transient, not a terminal delivery failure (N7)', async () => {
    const { config, write } = makeProject();
    write('.work/oc_session_mod1.txt', 'ses_abc');
    const brokenJson = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } });
    await assert.rejects(
      writeApiDelivery(config, 'opencode', 'mod1', { fetchImpl: brokenJson }),
      (error) => TRANSIENT_DELIVERY_CODES.has(error.code),
      'a body that fails to parse is a read failure, not proof the session ended badly',
    );
  });

  it('bounds a request that never resolves, and recovers once a real response arrives (N8, timeout recovery)', async () => {
    const { config, write } = makeProject();
    write('.work/oc_session_mod1.txt', 'ses_abc');
    const hangingRequest = () => new Promise(() => {});
    await assert.rejects(
      writeApiDelivery(config, 'opencode', 'mod1', { fetchImpl: hangingRequest, timeout: 20 }),
      (error) => TRANSIENT_DELIVERY_CODES.has(error.code) && /timed out/.test(error.message),
      'a request that never settles must still bound out instead of leaking the pending-delivery slot forever',
    );
    // The next poll, with a fetchImpl that actually answers, delivers normally — nothing about the timed-out
    // attempt is left behind to block a later success.
    const messages = [completed([{ type: 'text', text: 'Final report' }], 1)];
    const out = await writeApiDelivery(config, 'opencode', 'mod1', { fetchImpl: reply(messages) });
    assert.equal(fs.readFileSync(out, 'utf8'), 'Final report\n');
  });

  it('bounds a response whose body never finishes streaming (N8, timeout covers the read too)', async () => {
    const { config, write } = makeProject();
    write('.work/oc_session_mod1.txt', 'ses_abc');
    const hangingBody = async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) });
    await assert.rejects(
      writeApiDelivery(config, 'opencode', 'mod1', { fetchImpl: hangingBody, timeout: 20 }),
      (error) => TRANSIENT_DELIVERY_CODES.has(error.code) && /timed out/.test(error.message),
      'the connection opening is not the only thing that can hang — the body read must be bounded too',
    );
  });

  it('does not write a length-truncated or aborted turn as a delivered report, but keeps the partial text visible (N10)', async () => {
    const { config, write } = makeProject();
    write('.work/oc_session_mod1.txt', 'ses_abc');
    const truncated = { info: { role: 'assistant', time: { completed: 1 }, finish: 'length' }, parts: [{ type: 'text', text: 'Here is the first half of the report' }] };
    await assert.rejects(
      writeApiDelivery(config, 'opencode', 'mod1', { fetchImpl: reply([truncated]) }),
      (error) => !TRANSIENT_DELIVERY_CODES.has(error.code) && /length limit/.test(error.message) && error.message.includes('Here is the first half of the report'),
      'a length cutoff is a terminal fact, and its partial text must survive in the failure detail',
    );
    assert.equal(fs.existsSync(path.join(config.root, '.work', 'oc', 'mod1.md')), false, 'no delivery file for a truncated turn');

    const aborted = { info: { role: 'assistant', time: { completed: 1 }, error: { name: 'MessageAbortedError' } }, parts: [{ type: 'text', text: 'Partial notes before the abort' }] };
    await assert.rejects(
      writeApiDelivery(config, 'opencode', 'mod1', { fetchImpl: reply([aborted]) }),
      (error) => !TRANSIENT_DELIVERY_CODES.has(error.code) && /MessageAbortedError/.test(error.message) && error.message.includes('Partial notes before the abort'),
      'an abort is a terminal fact, and its partial text must survive in the failure detail',
    );
    assert.equal(fs.existsSync(path.join(config.root, '.work', 'oc', 'mod1.md')), false, 'no delivery file for an aborted turn either');
  });
});
