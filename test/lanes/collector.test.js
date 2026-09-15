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
    write('.work/codex/old.exit', '1');
    write('.work/full/progress.txt', 'compile exit 0\nedit exit 0\nDONE\n');
    write('.work/full/edit.xml', '<test-run id="2" total="10" passed="10" failed="0">');
    const result = await createCollector(config).collect();
    assert.ok(result.laneLimits.codex.since);
    assert.equal(result.verification.done, true);
    assert.deepEqual(result.verification.editXml, { total: 10, passed: 10, failed: 0 });
  });

  it('never shows a stream-json tool transcript as the summary, and cuts a long report at a word boundary', async () => {
    const { config, write } = makeProject();
    dispatch(config, { package: 'ART-2', lane: 'claude', model: 'claude-opus-5', name: 'art2' });
    write('.work/claude/art2.out', '{"type":"tool","name":"Edit"}\n{"type":"tool","name":"Write"}\n');
    write('.work/claude/art2.exit', '0');
    dispatch(config, { package: 'RUN-5', lane: 'codex', model: 'gpt-5.6-luna', name: 'run5' });
    write('.work/codex/run5.out', 'working...');
    write('.work/codex/run5.md', `${'a'.repeat(310)} Strictly follow the taxonomy`);
    write('.work/codex/run5.exit', '0');
    // Past the report grace period, so ART-2's missing report is a terminal fact rather than a race with
    // the wrapper still copying it in.
    const { packages } = await createCollector(config).collect({ now: Date.now() + 31 * 1000 });
    const byPkg = Object.fromEntries(packages.map((p) => [p.package, p]));
    assert.equal(byPkg['ART-2'].state, 'failed', 'a confirmed exit with no usable report does not keep the slot as merely stalled');
    assert.equal(byPkg['ART-2'].lastText, '', 'a bare tool-call transcript is never surfaced as a report');
    assert.match(byPkg['RUN-5'].lastText, /^…/, 'a long report is cut at a word boundary, not mid-word');
    assert.ok(byPkg['RUN-5'].lastText.length <= 301);
  });
});

describe('workers', () => {
  it('distinguishes running, stalled, failed and unknown from output alone (no .exit is never a bounce)', () => {
    const { root, write } = makeProject();
    const base = (name) => path.join(root, '.work', name);
    const now = Date.now();
    write('.work/a.out', 'working');
    assert.equal(workerState(base('a'), now).state, 'running');
    assert.equal(workerState(base('a'), now + 21 * 60 * 1000).state, 'stalled');
    // Even output that is nothing but quota wording, with no .exit file, is not terminal evidence: it
    // stays running, then stalled from staleness alone — never bounced from content.
    write('.work/b.out', 'usage limit reached, try again at 1:54 PM');
    assert.equal(workerState(base('b'), now).state, 'running');
    assert.equal(workerState(base('b'), now + 6 * 3600 * 1000).state, 'stalled');
    write('.work/c.out', 'x'); write('.work/c.exit', '3');
    assert.equal(workerState(base('c'), now).state, 'failed');
    assert.equal(workerState(base('none'), now).state, 'unknown');
    assert.equal(countEdits('anything', 'none'), 0);
  });

  it('never bounces a live worker over quota words, even as the literal last line, without a genuine exit', () => {
    const { root, write } = makeProject();
    const base = (name) => path.join(root, '.work', name);
    const now = Date.now();
    write('.work/d.out', 'reading vendor.log...\nfound this in an old log line: "you\'ve hit your usage limit"');
    assert.equal(workerState(base('d'), now).state, 'running', 'no .exit file means no terminal evidence, no matter what the last line says');
  });

  it('detects a genuine structured terminal quota failure instead of calling it a plain failure', () => {
    const { root, write } = makeProject();
    const base = (name) => path.join(root, '.work', name);
    const now = Date.now();
    write('.work/e.out', 'working...\nusage limit reached, try again at 2:15 PM');
    write('.work/e.exit', '1');
    assert.deepEqual(workerState(base('e'), now), { state: 'bounced', reason: 'usage limit', bounceUntil: '2:15 PM' });
    write('.work/f.out', 'working...\nTypeError: unexpected token');
    write('.work/f.exit', '1');
    assert.equal(workerState(base('f'), now).state, 'failed', 'a nonzero exit with no quota evidence stays a plain failure');
  });

  it('requires real evidence of a report before calling a wrapper success delivered', () => {
    const { root, write } = makeProject();
    const base = (name) => path.join(root, '.work', name);
    const now = Date.now();
    const pastGrace = now + 31 * 1000;
    write('.work/g.out', '{"type":"tool","name":"Edit"}\n{"type":"tool","name":"Write"}\n');
    write('.work/g.exit', '0');
    assert.equal(workerState(base('g'), pastGrace, { editCounter: 'stream-json' }).state, 'failed', 'a tool-call transcript is never a report by itself, and a confirmed exit does not keep the slot as stalled');
    write('.work/h.out', 'lots of text here');
    write('.work/h.exit', '0');
    write('.work/h.md', '   \n');
    assert.equal(workerState(base('h'), pastGrace).state, 'failed', 'a blank .md is not proof of a useful delivery');
    write('.work/i.out', 'All done. 3 files changed.');
    write('.work/i.exit', '0');
    assert.equal(workerState(base('i'), now).state, 'delivered', 'a text-only lane may still use its own stdout as the report');
  });

  it('gives a wrapper that writes .exit before its report a short grace period, instead of calling it failed', () => {
    const { root, write } = makeProject();
    const base = (name) => path.join(root, '.work', name);
    write('.work/j.out', '{"type":"tool","name":"Edit"}\n');
    write('.work/j.exit', '0');
    const pollNow = Date.now();
    assert.equal(workerState(base('j'), pollNow, { editCounter: 'stream-json' }).state, 'running', 'a poll right after .exit lands, before the report is copied, is not yet a terminal fact');
    write('.work/j.md', '1. Files changed');
    assert.equal(workerState(base('j'), pollNow).state, 'delivered', 'the report lands a moment later, inside the same grace window');
    assert.equal(workerState(base('j'), pollNow + 31 * 1000).state, 'delivered', 'once written, the report stands regardless of how stale .exit later gets');
  });

  it('treats a malformed or empty .exit like no .exit at all, never as a terminal fact', () => {
    const { root, write } = makeProject();
    const base = (name) => path.join(root, '.work', name);
    const now = Date.now();
    write('.work/k.out', 'working...\nusage limit reached, try again at 3:00 PM');
    write('.work/k.exit', '');
    assert.equal(workerState(base('k'), now).state, 'running', 'an empty .exit (a truncated echo, or the instant writeFileSync creates the file) proves nothing yet');
    assert.equal(workerState(base('k'), now + 21 * 60 * 1000).state, 'stalled', 'staleness of .out, not the malformed exit code, is what eventually calls it stalled');
    write('.work/l.out', 'x');
    write('.work/l.exit', 'nope');
    assert.equal(workerState(base('l'), now).state, 'running', 'a non-numeric .exit is not a valid terminal code either');
  });

  it('skips a malformed .exit file when computing a lane limit', () => {
    const { root, write } = makeProject();
    write('.work/codex/m.out', 'usage limit reached, try again at 3:00 PM');
    write('.work/codex/m.exit', '');
    assert.equal(laneLimit(path.join(root, '.work', 'codex')), null, 'an unreadable exit code is not authoritative evidence of a bounce');
  });

  it('clears a lane limit after a later success', () => {
    const { root, write } = makeProject();
    const bounced = write('.work/codex/a.out', 'usage limit');
    write('.work/codex/a.exit', '1');
    const past = new Date(Date.now() - 60 * 1000);
    fs.utimesSync(bounced, past, past);
    write('.work/codex/b.out', 'ok'); write('.work/codex/b.exit', '0');
    assert.equal(laneLimit(path.join(root, '.work', 'codex')), null);
  });

  it('does not poison a whole lane from a still-running worker, even when its last line is quota wording', () => {
    const { root, write } = makeProject();
    write('.work/codex/a.out', 'grepping logs...\nfound this: "insufficient_balance" in vendor.log');
    assert.equal(laneLimit(path.join(root, '.work', 'codex')), null, 'worker a has no .exit file — still running, never authoritative — so worker b is not greyed out');
  });

  it('parses progress lines and session models', () => {
    assert.deepEqual(parseProgress('compile exit 1\nnoise\nDONE').steps.map((s) => s.kind), ['exit', 'done']);
    assert.equal(latestProgress([]), null);
    assert.deepEqual(sessionModel([{ info: { role: 'assistant', providerID: 'xiaomi', modelID: 'mimo-v2.5-pro' } }]), { model: 'xiaomi/mimo-v2.5-pro', variant: '' });
    assert.equal(sessionModel([]), null);
  });
});
