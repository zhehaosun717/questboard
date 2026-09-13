import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCollector } from '../../src/lanes/collector.js';
import { laneLimit, workerState, countEdits } from '../../src/lanes/workers.js';
import { parseProgress, latestProgress } from '../../src/lanes/progress.js';
import { sessionModel } from '../../src/lanes/opencode.js';
import { appendJsonLine } from '../../src/core/jsonl.js';
import { makeProject } from '../helpers.js';

const dispatch = (config, fields) => appendJsonLine(config.paths.registry, { at: new Date().toISOString(), event: 'dispatch', variant: 'high', ...fields });

describe('collector', () => {
  it('reads file workers per lane config: state, edits, report text', async () => {
    const { config, write } = makeProject();
    dispatch(config, { package: 'RUN-4', lane: 'codex', model: 'gpt-5.6-luna', name: 'run4' });
    write('.work/codex/run4.out', 'apply patch\n+++ b/a.cs\n');
    write('.work/codex/run4.exit', '0');
    write('.work/codex/run4.md', '1. Files changed');
    dispatch(config, { package: 'ART-1', lane: 'claude', model: 'claude-opus-5', name: 'art1' });
    write('.work/claude/art1.out', '{"name":"Write"} {"name":"Edit"} {"name":"Read"}');
    dispatch(config, { package: 'SPEC-1', lane: 'agy', model: 'unknown', name: 'spec1' });
    dispatch(config, { package: 'X-1', lane: 'cursor', model: 'm', name: 'x1' });
    const { packages } = await createCollector(config).collect();
    const byPkg = Object.fromEntries(packages.map((p) => [p.package, p]));
    assert.equal(byPkg['RUN-4'].state, 'delivered');
    assert.equal(byPkg['RUN-4'].edits, 2);
    assert.equal(byPkg['RUN-4'].lastText, '1. Files changed');
    assert.equal(byPkg['ART-1'].state, 'running');
    assert.equal(byPkg['ART-1'].edits, 2);
    assert.deepEqual([byPkg['SPEC-1'].model, byPkg['SPEC-1'].modelSource], ['gemini-3.8-flash-high', 'inferred']);
    assert.match(byPkg['X-1'].reason, /lane cursor is not configured/);
  });

  it('polls API workers and recovers the real model of an unknown row', async () => {
    const { config } = makeProject();
    dispatch(config, { package: 'MOD-1', lane: 'opencode', model: 'unknown', name: 'mod1', session: 'ses_1' });
    const messages = [
      { info: { role: 'user', model: { providerID: 'kimi-for-coding', modelID: 'k3-256k', variant: 'high' } } },
      { info: { role: 'assistant', time: { completed: Date.now() } }, parts: [{ type: 'tool', tool: 'edit' }, { type: 'text', text: 'done' }] },
    ];
    const fetchImpl = async (url) => ({ ok: true, json: async () => (url.endsWith('/message') ? messages : { tokens: { input: 5, output: 7 } }) });
    const [row] = (await createCollector(config, { fetchImpl }).collect()).packages;
    assert.equal(row.state, 'delivered');
    assert.equal(row.edits, 1);
    assert.deepEqual(row.tokens, { input: 5, output: 7 });
    assert.deepEqual([row.model, row.modelSource], ['kimi-for-coding/k3-256k', 'session']);
  });

  it('reports lane limits and the verification strip', async () => {
    const { config, write } = makeProject({ verification: { progressDirs: ['.work/full'] } });
    write('.work/codex/old.out', "You've hit your usage limit.");
    write('.work/full/progress.txt', 'compile exit 0\nedit exit 0\nDONE\n');
    write('.work/full/edit.xml', '<test-run id="2" total="10" passed="10" failed="0">');
    const result = await createCollector(config).collect();
    assert.ok(result.laneLimits.codex.since);
    assert.equal(result.verification.done, true);
    assert.deepEqual(result.verification.editXml, { total: 10, passed: 10, failed: 0 });
  });
});

describe('workers', () => {
  it('distinguishes running, stalled, bounced, superseded, failed and delivered', () => {
    const { root, write } = makeProject();
    const base = (name) => path.join(root, '.work', name);
    const now = Date.now();
    write('.work/a.out', 'working');
    assert.equal(workerState(base('a'), now).state, 'running');
    assert.equal(workerState(base('a'), now + 21 * 60 * 1000).state, 'stalled');
    write('.work/b.out', 'usage limit reached, try again at 1:54 PM');
    assert.deepEqual(workerState(base('b'), now), { state: 'bounced', reason: 'usage limit', bounceUntil: '1:54 PM' });
    assert.equal(workerState(base('b'), now + 6 * 3600 * 1000).state, 'superseded');
    write('.work/c.out', 'x'); write('.work/c.exit', '3');
    assert.equal(workerState(base('c'), now).state, 'failed');
    assert.equal(workerState(base('none'), now).state, 'unknown');
    assert.equal(countEdits('anything', 'none'), 0);
  });

  it('clears a lane limit after a later success', () => {
    const { root, write } = makeProject();
    const bounced = write('.work/codex/a.out', 'usage limit');
    const past = new Date(Date.now() - 60 * 1000);
    fs.utimesSync(bounced, past, past);
    write('.work/codex/b.out', 'ok'); write('.work/codex/b.exit', '0');
    assert.equal(laneLimit(path.join(root, '.work', 'codex')), null);
  });

  it('parses progress lines and session models', () => {
    assert.deepEqual(parseProgress('compile exit 1\nnoise\nDONE').steps.map((s) => s.kind), ['exit', 'done']);
    assert.equal(latestProgress([]), null);
    assert.deepEqual(sessionModel([{ info: { role: 'assistant', providerID: 'xiaomi', modelID: 'mimo-v2.5-pro' } }]), { model: 'xiaomi/mimo-v2.5-pro', variant: '' });
    assert.equal(sessionModel([]), null);
  });
});
