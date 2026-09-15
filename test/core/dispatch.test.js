import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workerName, planDispatch, preflight, workerEvidence, executePlan, bashPath } from '../../src/core/dispatch.js';
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

  let bash = null;
  try { bash = bashPath(resolveConfig(tmpDir(), { name: 'x', lanes: { a: { run: ['a'], outputDir: 'o' } } })); } catch { bash = null; }

  it('captures a real bash wrapper that backgrounds its worker', { skip: !bash && 'Git Bash not installed' }, async () => {
    const { config, write } = makeProject({ lanes: { fake: { run: ['tools/fake-run.sh', '{name}'], outputDir: '.work/fake' } } });
    write('tools/fake-run.sh', '#!/usr/bin/env bash\nset -euo pipefail\n( sleep 1; echo 0 > "$1.exit" ) &\necho "fake worker started"\n');
    const result = await executePlan(config, planDispatch(config, q, card('codex-luna', { lane: 'fake' }), 'w1'), { name: 'w1' });
    assert.equal(result.ok, true, result.detail);
    assert.match(fs.readFileSync(result.logFile, 'utf8'), /fake worker started/);
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
