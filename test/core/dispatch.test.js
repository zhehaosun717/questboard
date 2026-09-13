import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workerName, planDispatch, preflight, workerEvidence, executePlan, bashPath } from '../../src/core/dispatch.js';
import { writeApiDelivery } from '../../src/core/deliveries.js';
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

  it('writes the last assistant text to the delivery dir', async () => {
    const { config, write } = makeProject();
    write('.work/oc_session_mod1.txt', 'ses_abc\n');
    let asked = '';
    const messages = [
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'early' }] },
      { info: { role: 'assistant' }, parts: [{ type: 'tool', tool: 'edit' }, { type: 'text', text: '1. Files' }, { type: 'text', text: '2. Assumptions' }] },
    ];
    const out = await writeApiDelivery(config, 'opencode', 'mod1', { fetchImpl: async (url) => { asked = url; return reply(messages)(); } });
    assert.equal(asked, 'http://oc.test/session/ses_abc/message');
    assert.equal(fs.readFileSync(out, 'utf8'), '1. Files\n\n2. Assumptions\n');
    assert.equal(out, path.join(config.root, '.work', 'oc', 'mod1.md'));
  });

  it('fails loudly on a missing session, an HTTP error, no text, or a bad name', async () => {
    const { config, write } = makeProject();
    write('.work/oc_session_mod1.txt', 'ses_abc');
    await assert.rejects(writeApiDelivery(config, 'opencode', 'nope', { fetchImpl: reply([]) }), /no session file/);
    await assert.rejects(writeApiDelivery(config, 'opencode', 'mod1', { fetchImpl: reply({}, false, 500) }), /answered 500/);
    await assert.rejects(writeApiDelivery(config, 'opencode', 'mod1', { fetchImpl: reply([{ info: { role: 'assistant' }, parts: [] }]) }), /no final assistant text/);
    await assert.rejects(writeApiDelivery(config, 'opencode', '../x', { fetchImpl: reply([]) }), /bad worker name/);
    await assert.rejects(writeApiDelivery(config, 'codex', 'mod1', { fetchImpl: reply([]) }), /has no api/);
  });
});
