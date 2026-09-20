import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCollector } from '../../src/lanes/collector.js';
import { laneLimit, laneLimitFromEvidence, active, laneEvidence, workerState, countEdits, bounceTimeMs } from '../../src/lanes/workers.js';
import { parseProgress, latestProgress } from '../../src/lanes/progress.js';
import { fetchJson, sessionLimitReason, sessionModel, sessionState } from '../../src/lanes/opencode.js';
import { PROTOCOLS } from '../../src/lanes/protocols.js';
import { deriveTransitions } from '../../src/core/sync.js';
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

  it('passes a registry token through to the lane row heartbeat', async () => {
    const { config, root, write } = makeProject();
    const now = Date.parse('2026-09-16T12:00:00.000Z');
    appendJsonLine(config.paths.registry, {
      at: new Date(now).toISOString(), event: 'dispatch', variant: '', package: 'HB-1', lane: 'codex',
      model: 'gpt-5.6-luna', name: 'hb-1', token: 'run-token',
    });
    write('.work/codex/hb-1.out', 'quiet');
    const alive = write('.work/codex/hb-1.alive', JSON.stringify({ token: 'run-token', at: new Date(now).toISOString(), phase: 'running' }) + '\n');
    fs.utimesSync(alive, new Date(now - 1000), new Date(now - 1000));
    const [row] = (await createCollector(config).collect({ now })).packages;
    assert.equal(row.state, 'running');
    assert.deepEqual(row.heartbeat, { at: new Date(now).toISOString(), ageMs: 1000, token: 'run-token', phase: 'running' });
    assert.equal(row.token, undefined, 'the registry token stays out of the public lane row');
    assert.equal(fs.existsSync(path.join(root, '.work', 'codex', 'hb-1.alive')), true);
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

  it('names why a server lane is unreachable instead of going silent (Bundle 3)', async () => {
    const { config } = makeProject();
    dispatch(config, { package: 'MOD-2', lane: 'opencode', model: 'unknown', name: 'mod2', session: 'ses_2' });
    const fetchImpl = async () => ({ ok: false, status: 503, json: async () => { throw new Error('should not be called'); } });
    const [row] = (await createCollector(config, { fetchImpl }).collect()).packages;
    assert.equal(row.state, 'unknown');
    assert.match(row.reason, /opencode api unreachable：HTTP 503/);
  });

  it('honours a registry entry with different URL shapes instead of collector.js hard-coding OpenCode\'s paths (M2)', async () => {
    const { config } = makeProject();
    // A made-up second protocol, registered only for this test, with URL shapes nothing like OpenCode's —
    // if collector.js still built `${lane.api}/session/...` itself anywhere, these stubbed responses (keyed
    // on the vendor's own path) would never be seen and the row would stay 'unknown'.
    config.lanes.vendor2 = { api: 'http://vendor2.test', protocol: 'vendor2-chat' };
    dispatch(config, { package: 'V2-1', lane: 'vendor2', model: 'unknown', name: 'v2-1', session: 'chat_1' });
    const messages = [{ info: { role: 'assistant', time: { completed: Date.now() } }, parts: [{ type: 'text', text: 'ok' }] }];
    const seenUrls = [];
    const fetchImpl = async (url) => {
      seenUrls.push(url);
      return { ok: true, json: async () => (url.endsWith('/msgs') ? messages : { tokens: { input: 1, output: 2 } }) };
    };
    PROTOCOLS['vendor2-chat'] = {
      fetchJson, sessionModel, sessionState, sessionLimitReason,
      messagesUrl: (lane, session) => `${lane.api}/v2/chats/${session}/msgs`,
      sessionUrl: (lane, session) => `${lane.api}/v2/chats/${session}`,
    };
    try {
      const [row] = (await createCollector(config, { fetchImpl }).collect()).packages;
      assert.equal(row.state, 'delivered');
      assert.deepEqual(row.tokens, { input: 1, output: 2 });
      assert.deepEqual(seenUrls, ['http://vendor2.test/v2/chats/chat_1/msgs', 'http://vendor2.test/v2/chats/chat_1']);
    } finally {
      delete PROTOCOLS['vendor2-chat'];
    }
  });

  it('stalls file lanes over maxMinutes and session lanes over all-message maxMessages', async () => {
    const { config } = makeProject({ lanes: {
      filelimited: { run: ['tools/run.sh'], outputDir: '.work/file-limited', limits: { maxMinutes: 1 } },
      sessionlimited: {
        session: { run: ['node', 'tools/new-session.mjs'], saveTo: '.work/session-{name}.txt' },
        run: ['tools/send.sh', '{name}', '{brief}'], api: 'http://oc.test', deliveryDir: '.work/session-limited',
        limits: { maxMessages: 2 },
      },
    } });
    const now = Date.now();
    appendJsonLine(config.paths.registry, { at: new Date(now - 2 * 60 * 1000).toISOString(), event: 'dispatch', variant: '', package: 'LIMIT-F', lane: 'filelimited', model: 'm', name: 'limitf' });
    appendJsonLine(config.paths.registry, { at: new Date(now).toISOString(), event: 'dispatch', variant: '', package: 'LIMIT-S', lane: 'sessionlimited', model: 'm', name: 'limits', session: 'ses-limit' });
    const messages = [{ info: { role: 'user' } }, { info: { role: 'assistant', time: { created: now } }, parts: [] }, { info: { role: 'user' } }];
    const result = await createCollector(config, { fetchImpl: async (url) => ({ ok: true, json: async () => (url.endsWith('/message') ? messages : {}) }) }).collect({ now });
    const byPackage = Object.fromEntries(result.packages.map((row) => [row.package, row]));
    assert.equal(byPackage['LIMIT-F'].state, 'stalled');
    assert.equal(byPackage['LIMIT-F'].reason, '超过时长上限 1 分钟');
    assert.equal(byPackage['LIMIT-F'].manualRequired, true);
    assert.equal(byPackage['LIMIT-S'].state, 'stalled');
    assert.equal(byPackage['LIMIT-S'].reason, '超过消息上限 2 条');
    assert.equal(byPackage['LIMIT-S'].manualRequired, true);
  });

  it('keeps terminal file evidence after the lane time bound', async () => {
    const { config, write } = makeProject({ lanes: {
      limited: { run: ['tools/run.sh'], outputDir: '.work/limited', limits: { maxMinutes: 1 } },
    } });
    const now = Date.parse('2026-09-16T12:00:00.000Z');
    const at = new Date(now - 2 * 60 * 1000).toISOString();
    appendJsonLine(config.paths.registry, { at, event: 'dispatch', variant: '', package: 'LIMIT-D', lane: 'limited', model: 'm', name: 'done' });
    write('.work/limited/done.out', 'final report');
    write('.work/limited/done.md', '1. delivered');
    write('.work/limited/done.exit', '0');
    appendJsonLine(config.paths.registry, { at, event: 'dispatch', variant: '', package: 'LIMIT-F', lane: 'limited', model: 'm', name: 'failed' });
    write('.work/limited/failed.out', 'crashed');
    write('.work/limited/failed.exit', '1');
    const rows = await createCollector(config).collect({ now });
    const byPackage = Object.fromEntries(rows.packages.map((row) => [row.package, row]));
    assert.equal(byPackage['LIMIT-D'].state, 'delivered');
    assert.equal(byPackage['LIMIT-D'].limitReason, undefined);
    assert.equal(byPackage['LIMIT-F'].state, 'failed');
    assert.equal(byPackage['LIMIT-F'].reason, 'exit 1');
  });

  it('measures a collected row from the current quest attempt when it is newer than the registry row', async () => {
    const { config, write } = makeProject({ lanes: {
      limited: { run: ['tools/run.sh'], outputDir: '.work/limited', limits: { maxMinutes: 1 } },
    } });
    const registryAt = Date.parse('2026-09-16T11:00:00.000Z');
    const attemptAt = Date.parse('2026-09-16T11:59:30.000Z');
    appendJsonLine(config.paths.registry, { at: new Date(registryAt).toISOString(), event: 'dispatch', variant: '', package: 'LIMIT-A', lane: 'limited', model: 'm', name: 'adopted' });
    write('.work/limited/adopted.out', 'working');
    const questFile = path.join(config.paths.data, 'quests.jsonl');
    fs.mkdirSync(path.dirname(questFile), { recursive: true });
    fs.writeFileSync(questFile, `${JSON.stringify({ id: 'LIMIT-A', status: 'dispatched', assignee: { name: 'adopted', at: new Date(attemptAt).toISOString(), adopted: true }, dispatches: [], kind: 'code' })}\n`);
    const [row] = (await createCollector(config).collect({ now: Date.parse('2026-09-16T12:00:00.000Z') })).packages;
    assert.equal(row.elapsed, 30 * 1000);
    assert.equal(row.dispatchedAt, new Date(registryAt).toISOString());
    assert.equal(row.attemptAt, new Date(attemptAt).toISOString());
  });

  it('keeps collector rows bound to their own time before deriveTransitions checks adopted and fresh attempts', async () => {
    const adoptedProject = makeProject({ lanes: {
      limited: { run: ['tools/run.sh'], outputDir: '.work/limited', limits: { maxMinutes: 1 } },
    } });
    const adoptionAt = Date.parse('2026-09-16T12:00:00.000Z');
    const laterDispatchAt = adoptionAt + 30 * 60 * 1000;
    appendJsonLine(adoptedProject.config.paths.registry, {
      at: new Date(laterDispatchAt).toISOString(), event: 'dispatch', variant: '', package: 'R1A',
      lane: 'limited', model: 'm', name: 'run4',
    });
    adoptedProject.write('.work/limited/run4.out', 'unrelated later run');
    adoptedProject.write('.work/limited/run4.md', 'unrelated report');
    adoptedProject.write('.work/limited/run4.exit', '0');
    const adoptedQuest = {
      id: 'R1A', status: 'dispatched', assignee: { name: 'run4', at: new Date(adoptionAt).toISOString(), adopted: true },
      dispatches: [], kind: 'code',
    };
    fs.mkdirSync(path.dirname(adoptedProject.config.paths.data), { recursive: true });
    fs.writeFileSync(path.join(adoptedProject.config.paths.data, 'quests.jsonl'), `${JSON.stringify(adoptedQuest)}\n`);
    const adoptedNow = laterDispatchAt + 1000;
    const adoptedLanes = await createCollector(adoptedProject.config).collect({ now: adoptedNow });
    assert.equal(adoptedLanes.packages[0].dispatchedAt, new Date(laterDispatchAt).toISOString());
    assert.equal(adoptedLanes.packages[0].attemptAt, undefined, 'an unrelated later row gets no attempt start');
    assert.deepEqual(deriveTransitions([adoptedQuest], adoptedLanes.packages, adoptedNow).map((transition) => transition.status), ['stalled']);

    const freshProject = makeProject({ lanes: {
      limited: { run: ['tools/run.sh'], outputDir: '.work/limited', limits: { maxMinutes: 1 } },
    } });
    const freshAt = Date.parse('2026-09-16T12:00:00.000Z');
    const oldDispatchAt = freshAt - 2 * 24 * 60 * 60 * 1000;
    appendJsonLine(freshProject.config.paths.registry, {
      at: new Date(oldDispatchAt).toISOString(), event: 'dispatch', variant: '', package: 'R1B',
      lane: 'limited', model: 'm', name: 'run4',
    });
    freshProject.write('.work/limited/run4.out', 'old hand run');
    freshProject.write('.work/limited/run4.exit', '1');
    const freshQuest = {
      id: 'R1B', status: 'dispatched', assignee: { name: 'run4', at: new Date(freshAt).toISOString() },
      dispatches: [], kind: 'code',
    };
    fs.mkdirSync(path.dirname(freshProject.config.paths.data), { recursive: true });
    fs.writeFileSync(path.join(freshProject.config.paths.data, 'quests.jsonl'), `${JSON.stringify(freshQuest)}\n`);
    const freshNow = freshAt + 60 * 1000;
    const freshLanes = await createCollector(freshProject.config).collect({ now: freshNow });
    assert.equal(freshLanes.packages[0].dispatchedAt, new Date(oldDispatchAt).toISOString());
    assert.equal(freshLanes.packages[0].attemptAt, undefined, 'an old row gets no current-at override');
    assert.deepEqual(deriveTransitions([freshQuest], freshLanes.packages, freshNow), []);
  });

  it('an older attempt sharing the row name must not lend its start time to an unrelated hand run', async () => {
    const { config, write } = makeProject({ lanes: {
      limited: { run: ['tools/run.sh'], outputDir: '.work/limited', limits: { maxMinutes: 30 } },
    } });
    const t0 = Date.parse('2026-09-16T10:00:00.000Z');
    const t1 = Date.parse('2026-09-16T11:00:00.000Z');
    const handRunAt = t1 + 5 * 60 * 1000;
    const now = t1 + 15 * 60 * 1000;

    appendJsonLine(config.paths.registry, {
      at: new Date(handRunAt).toISOString(), event: 'dispatch', variant: '', package: 'PKG-1',
      lane: 'limited', model: 'm', name: 'run4',
    });
    write('.work/limited/run4.out', 'still running');

    const quest = {
      id: 'PKG-1',
      status: 'dispatched',
      assignee: { name: 'run4-2', at: new Date(t1).toISOString() },
      dispatches: [{ name: 'run4', at: new Date(t0).toISOString() }],
      kind: 'code',
    };
    const questFile = path.join(config.paths.data, 'quests.jsonl');
    fs.mkdirSync(path.dirname(questFile), { recursive: true });
    fs.writeFileSync(questFile, `${JSON.stringify(quest)}\n`);

    const lanes = await createCollector(config).collect({ now });
    assert.equal(lanes.packages[0].dispatchedAt, new Date(handRunAt).toISOString());
    assert.equal(lanes.packages[0].attemptAt, undefined, 'an older attempt sharing the row name must not lend attemptAt');
    assert.equal(lanes.packages[0].elapsed, 10 * 60 * 1000);
    assert.equal(lanes.packages[0].state, 'running');
  });

  it('reports lane limits and the verification strip', async () => {
    const { config, write } = makeProject({ verification: { progressDirs: ['.work/full'] } });
    dispatch(config, { package: 'LIMIT-1', lane: 'codex', model: 'gpt-5.6-luna', name: 'old', adventurerId: 'codex-luna' });
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

  it('keeps an OpenCode quota bounce as lane evidence across a reassignment, then clears it on that card\'s later success (N9)', async () => {
    const { config } = makeProject();
    let respond = null;
    const fetchImpl = async (url) => respond(url);
    const collector = createCollector(config, { fetchImpl });

    // Phase 1: oc-mimo bounces on a structured 402.
    const t1 = Date.parse('2026-09-16T10:00:00.000Z');
    dispatch(config, { package: 'RUN-9', lane: 'opencode', model: 'xiaomi/mimo-v2.5-pro', name: 'oc-a', session: 'ses_a', adventurerId: 'oc-mimo' });
    const bouncedMessages = [{ info: { role: 'assistant', time: { completed: t1 }, error: { status: 402 } } }];
    respond = async (url) => ({ ok: true, json: async () => (url.endsWith('/message') ? bouncedMessages : {}) });
    const first = await collector.collect({ now: t1 });
    assert.equal(first.packages[0].state, 'bounced');
    assert.ok(first.laneLimits.opencode?.cards?.['oc-mimo'], 'the bounce is visible while it is the current attempt');

    // Phase 2: RUN-9 is reassigned to a different card (oc-deepseek), now merely running. The current
    // package row no longer mentions oc-mimo at all, but the evidence must not vanish with it.
    const t2 = t1 + 5 * 60 * 1000;
    dispatch(config, { package: 'RUN-9', lane: 'opencode', model: 'deepseek/deepseek-v4-pro', name: 'oc-b', session: 'ses_b', adventurerId: 'oc-deepseek' });
    const runningMessages = [{ info: { role: 'assistant', time: { created: t2 } }, parts: [] }];
    respond = async (url) => ({ ok: true, json: async () => (url.endsWith('/message') ? runningMessages : {}) });
    const second = await collector.collect({ now: t2 });
    assert.equal(second.packages[0].adventurerId, 'oc-deepseek', 'the live row now belongs to the reassigned card');
    assert.ok(second.laneLimits.opencode?.cards?.['oc-mimo'], 'the evidence belongs to the card and lane, not the assignment');
    assert.equal(second.laneLimits.opencode.cards['oc-deepseek'], undefined);

    // Phase 3: oc-mimo is dispatched again and this time succeeds — the remembered bounce clears, exactly
    // like a file lane's own later-success rule.
    const t3 = t2 + 5 * 60 * 1000;
    dispatch(config, { package: 'RUN-9', lane: 'opencode', model: 'xiaomi/mimo-v2.5-pro', name: 'oc-c', session: 'ses_c', adventurerId: 'oc-mimo' });
    const successMessages = [{ info: { role: 'assistant', time: { completed: t3 } }, parts: [{ type: 'text', text: 'done' }] }];
    respond = async (url) => ({ ok: true, json: async () => (url.endsWith('/message') ? successMessages : {}) });
    const third = await collector.collect({ now: t3 });
    assert.equal(third.packages[0].state, 'delivered');
    assert.equal(third.laneLimits.opencode, undefined, 'a later success by the same card clears its remembered bounce entirely');
    assert.equal(third.laneEvidence.opencode, undefined, 'cleared by success leaves no residual evidence either, like a file lane');
  });
});

describe('collector worker death (FB2-01.1)', () => {
  const questRow = (config, id, assigneeName, at, overrides = {}) => {
    const questFile = path.join(config.paths.data, 'quests.jsonl');
    fs.mkdirSync(path.dirname(questFile), { recursive: true });
    fs.writeFileSync(questFile, `${JSON.stringify({
      id, status: 'dispatched',
      assignee: { name: assigneeName, at: new Date(at).toISOString(), attemptId: `att-${id}` },
      dispatches: [], kind: 'code', ...overrides,
    })}\n`);
  };

  it('fails a dispatched worker whose process tree is verified empty, with the .out tail as the reason, without waiting for the stall threshold', async () => {
    const { config, write } = makeProject();
    const now = Date.now();
    appendJsonLine(config.paths.registry, { at: new Date(now).toISOString(), event: 'dispatch', variant: '', package: 'DEAD-1', lane: 'codex', model: 'gpt-5.6-luna', name: 'dead1' });
    write('.work/codex/dead1.out', 'working...\nlast line before the kill');
    questRow(config, 'DEAD-1', 'dead1', now);
    const seen = [];
    const collector = createCollector(config, {
      verifyProcessTree: async (candidate) => { seen.push(candidate); return 'empty'; },
    });
    const { packages } = await collector.collect({ now: now + 1000 });
    const [row] = packages;
    assert.equal(row.state, 'failed');
    assert.match(row.reason, /进程树已空/);
    assert.match(row.reason, /last line before the kill/);
    assert.equal(row.lastText, '', 'the .out tail travels in the reason, not duplicated as a summary');
    assert.deepEqual(seen, [{ attemptId: 'att-DEAD-1', name: 'dead1', lane: 'codex', package: 'DEAD-1' }]);
    const quest = { id: 'DEAD-1', status: 'dispatched', assignee: { name: 'dead1', at: new Date(now).toISOString(), attemptId: 'att-DEAD-1' }, dispatches: [], kind: 'code' };
    const [transition] = deriveTransitions([quest], packages, now + 1000);
    assert.equal(transition.status, 'failed');
    assert.match(transition.detail, /进程树已空/);
    assert.match(transition.detail, /last line before the kill/);
  });

  it('keeps a worker running when the process tree is verified alive, and when the verdict is unknown', async () => {
    for (const verdict of ['alive', 'unknown']) {
      const { config, write } = makeProject();
      const now = Date.now();
      appendJsonLine(config.paths.registry, { at: new Date(now).toISOString(), event: 'dispatch', variant: '', package: 'DEAD-2', lane: 'codex', model: 'gpt-5.6-luna', name: 'dead2' });
      write('.work/codex/dead2.out', 'still working');
      questRow(config, 'DEAD-2', 'dead2', now);
      const collector = createCollector(config, { verifyProcessTree: async () => verdict });
      const [row] = (await collector.collect({ now: now + 1000 })).packages;
      assert.equal(row.state, 'running', `${verdict} is not proof the worker died`);
      assert.equal(row.reason, '');
    }
  });

  it('turns an already-stalled dead worker into failed instead of leaving it stalled', async () => {
    const { config, write } = makeProject();
    const now = Date.now();
    const at = now - 30 * 60 * 1000;
    appendJsonLine(config.paths.registry, { at: new Date(at).toISOString(), event: 'dispatch', variant: '', package: 'DEAD-3', lane: 'codex', model: 'gpt-5.6-luna', name: 'dead3' });
    const out = write('.work/codex/dead3.out', 'quiet for a long time');
    fs.utimesSync(out, new Date(at), new Date(at));
    questRow(config, 'DEAD-3', 'dead3', at);
    const collector = createCollector(config, { verifyProcessTree: async () => 'empty' });
    const [row] = (await collector.collect({ now })).packages;
    assert.equal(row.state, 'failed', 'a verified-empty tree is terminal, not another stall');
    assert.match(row.reason, /quiet for a long time/);
  });

  it('never consults the process tree when terminal evidence already exists (.exit or .md)', async () => {
    const { config, write } = makeProject();
    const now = Date.now();
    appendJsonLine(config.paths.registry, { at: new Date(now).toISOString(), event: 'dispatch', variant: '', package: 'DEAD-4', lane: 'codex', model: 'gpt-5.6-luna', name: 'dead4' });
    write('.work/codex/dead4.out', 'crashed');
    write('.work/codex/dead4.exit', '1');
    questRow(config, 'DEAD-4', 'dead4', now);
    let consulted = 0;
    const collector = createCollector(config, { verifyProcessTree: async () => { consulted += 1; return 'empty'; } });
    const [row] = (await collector.collect({ now: now + 1000 })).packages;
    assert.equal(row.state, 'failed');
    assert.equal(row.reason, 'exit 1');
    assert.equal(consulted, 0, 'an exit file is the terminal fact; the tree check adds nothing');
  });

  it('does not apply death detection to a quest that is not currently dispatched', async () => {
    const { config, write } = makeProject();
    const now = Date.now();
    appendJsonLine(config.paths.registry, { at: new Date(now).toISOString(), event: 'dispatch', variant: '', package: 'DEAD-5', lane: 'codex', model: 'gpt-5.6-luna', name: 'dead5' });
    write('.work/codex/dead5.out', 'leftover output');
    let consulted = 0;
    const collector = createCollector(config, { verifyProcessTree: async () => { consulted += 1; return 'empty'; } });
    const [row] = (await collector.collect({ now: now + 1000 })).packages;
    assert.equal(row.state, 'running', 'a registry row without a dispatched quest is not a death candidate');
    assert.equal(consulted, 0);

    questRow(config, 'DEAD-5', 'someone-else', now);
    const [other] = (await createCollector(config, { verifyProcessTree: async () => { consulted += 1; return 'empty'; } }).collect({ now: now + 1000 })).packages;
    assert.equal(other.state, 'running', 'a row owned by a different assignee is not this attempt\'s evidence');
    assert.equal(consulted, 0);
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

  it('uses a fresh matching heartbeat instead of .out activity, and reports its age', () => {
    const { root, write } = makeProject();
    const base = (name) => path.join(root, '.work', name);
    const now = Date.parse('2026-09-16T12:00:00.000Z');
    write('.work/h.out', 'working');
    const alive = write('.work/h.alive', JSON.stringify({ token: 'run-token', at: '2026-09-16T11:59:45.000Z', phase: 'running' }) + '\n');
    fs.utimesSync(alive, new Date(now - 10 * 1000), new Date(now - 10 * 1000));
    assert.deepEqual(workerState(base('h'), now, { token: 'run-token' }), {
      state: 'running',
      heartbeat: { at: '2026-09-16T11:59:45.000Z', ageMs: 10 * 1000, token: 'run-token', phase: 'running' },
    });
  });

  it('stalls a quiet heartbeat even when .out is fresh, using a declared interval', () => {
    const { root, write } = makeProject();
    const base = (name) => path.join(root, '.work', name);
    const now = Date.parse('2026-09-16T12:00:00.000Z');
    write('.work/hb-stalled.out', 'new output');
    const alive = write('.work/hb-stalled.alive', JSON.stringify({ token: 'run-token', at: '2026-09-16T11:59:44.000Z', phase: 'running', intervalSeconds: 5 }) + '\n');
    fs.utimesSync(alive, new Date(now - 16 * 1000), new Date(now - 16 * 1000));
    const result = workerState(base('hb-stalled'), now, { token: 'run-token', stallAfterMinutes: 1 });
    assert.equal(result.state, 'stalled');
    assert.equal(result.reason, '心跳停止 1 分钟（worker 可能已经不在了）');
    assert.equal(result.heartbeat.ageMs, 16 * 1000);
  });

  it('rejects a heartbeat from another run and treats malformed heartbeat content as a counted diagnostic', () => {
    const { root, write } = makeProject();
    const base = (name) => path.join(root, '.work', name);
    const now = Date.now();
    write('.work/foreign.out', 'fresh output');
    write('.work/foreign.alive', JSON.stringify({ token: 'other-token', at: new Date(now).toISOString(), phase: 'running' }));
    const foreign = workerState(base('foreign'), now, { token: 'run-token' });
    assert.deepEqual(foreign, { state: 'unknown', reason: '心跳来自另一次运行', heartbeat: null });

    write('.work/bad.out', 'fresh output');
    write('.work/bad.alive', 'x'.repeat(4097));
    const malformed = workerState(base('bad'), now, { token: 'run-token' });
    assert.equal(malformed.state, 'unknown');
    assert.equal(malformed.heartbeat, null);
    assert.deepEqual(malformed.diagnostics, { malformedHeartbeats: 1 });
  });

  it('lets a valid exit file win over a stale or foreign heartbeat', () => {
    const { root, write } = makeProject();
    const base = (name) => path.join(root, '.work', name);
    const now = Date.now();
    write('.work/finished.out', 'failed');
    write('.work/finished.exit', '3');
    write('.work/finished.alive', JSON.stringify({ token: 'other-token', at: new Date(now - 3600 * 1000).toISOString(), phase: 'running' }));
    assert.deepEqual(workerState(base('finished'), now, { token: 'run-token' }), { state: 'failed', reason: 'exit 3', heartbeat: null });
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

  it('does not read a test-count summary line as a quota bounce (A2)', () => {
    const { root, write } = makeProject();
    const base = (name) => path.join(root, '.work', name);
    const now = Date.now();
    write('.work/q1.out', 'working...\nQuota: 3 of 5 tests skipped');
    write('.work/q1.exit', '1');
    assert.equal(workerState(base('q1'), now).state, 'failed', 'a test-count summary that starts with "Quota" is not bounce evidence');
    write('.work/q2.out', 'working...\nusage limit tests: 2 failed');
    write('.work/q2.exit', '1');
    assert.equal(workerState(base('q2'), now).state, 'failed', 'a test-count summary that starts with "usage limit" is not bounce evidence');
    // Real quota sentences immediately followed by punctuation, not a test count, still bounce.
    write('.work/q3.out', 'working...\nQuota exceeded, try again at 3:00 PM');
    write('.work/q3.exit', '1');
    assert.equal(workerState(base('q3'), now).state, 'bounced');
  });

  it('bounces on a configured exit-line pattern with its label and code, built-in detection first', () => {
    const { root, write } = makeProject();
    const base = (name) => path.join(root, '.work', name);
    const now = Date.now();
    const patterns = [{ code: 'quota_5h', label: '额度用尽', pattern: /resets (at|in)|try again at/i }];
    write('.work/p1.out', 'working...\nrate window resets in 3h');
    write('.work/p1.exit', '1');
    assert.deepEqual(workerState(base('p1'), now, { bouncePatterns: patterns }), { state: 'bounced', reason: '额度用尽', code: 'quota_5h', bounceUntil: null });
    // The built-in usage-limit detection runs first and stays uncoded, even when a pattern matches the same line.
    write('.work/p2.out', 'working...\nusage limit reached, try again at 2:15 PM');
    write('.work/p2.exit', '1');
    assert.deepEqual(workerState(base('p2'), now, { bouncePatterns: patterns }), { state: 'bounced', reason: 'usage limit', bounceUntil: '2:15 PM' });
    // Only the exit line is consulted: the same wording earlier in .out is never matched.
    write('.work/p3.out', 'rate window resets in 3h\nall done');
    write('.work/p3.exit', '1');
    assert.equal(workerState(base('p3'), now, { bouncePatterns: patterns }).state, 'failed');
    // Without configured patterns the default behaviour is untouched.
    write('.work/p4.out', 'rate window resets in 3h');
    write('.work/p4.exit', '1');
    assert.equal(workerState(base('p4'), now).state, 'failed');
  });

  it('recognizes the documented Codex quota prefix and trailing reset sentence', () => {
    const { root, write } = makeProject();
    const base = (name) => path.join(root, '.work', 'codex', name);
    const now = Date.now();
    const fixtures = [
      ['real-a', "ERROR: You've hit your usage limit ... try again at 1:54 PM", '1:54 PM'],
      ['real-b', "ERROR: usage limit ... try again at 1:54 PM", '1:54 PM'],
      ['real-c', "You've hit your usage limit. Try again at 1:54 PM.", '1:54 PM'],
      ['real-d', 'RESOURCE_EXHAUSTED', null],
    ];
    for (const [name, line, reset] of fixtures) {
      write(`.work/codex/${name}.out`, line);
      write(`.work/codex/${name}.exit`, '1');
      const result = workerState(base(name), now);
      assert.equal(result.state, 'bounced', line);
      assert.equal(result.bounceUntil, reset, line);
    }
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

  it('reads the stall threshold from the configured minutes, not a frozen constant', () => {
    const { root, write } = makeProject();
    const base = (name) => path.join(root, '.work', name);
    const now = Date.now();
    write('.work/s1.out', 'working');
    assert.equal(workerState(base('s1'), now + 44 * 60 * 1000, { stallAfterMinutes: 45 }).state, 'running', 'under the configured threshold the worker is still working');
    const stalled = workerState(base('s1'), now + 46 * 60 * 1000, { stallAfterMinutes: 45 });
    assert.equal(stalled.state, 'stalled');
    assert.equal(stalled.reason, 'no .exit, .out stale >45m');
    const dflt = workerState(base('s1'), now + 21 * 60 * 1000);
    assert.equal(dflt.state, 'stalled');
    assert.equal(dflt.reason, 'no .exit, .out stale >20m', 'without a configured value the reason keeps the original default');
    write('.work/s2.out', 'working');
    write('.work/s2.exit', 'nope');
    const malformed = workerState(base('s2'), now + 46 * 60 * 1000, { stallAfterMinutes: 45 });
    assert.equal(malformed.state, 'stalled');
    assert.equal(malformed.reason, 'malformed .exit, .out stale >45m');
  });

  it('reads the session stall threshold from policy.stallAfterMinutes', async () => {
    const { config } = makeProject({ policy: { stallAfterMinutes: 45 } });
    const now = Date.now();
    dispatch(config, { package: 'STALL-1', lane: 'opencode', model: 'unknown', name: 'stall1', session: 'ses_stall' });
    let messages = [
      { info: { role: 'assistant', time: { created: now - 21 * 60 * 1000 } }, parts: [{ type: 'text', text: 'working' }] },
    ];
    const fetchImpl = async (url) => ({ ok: true, json: async () => (url.endsWith('/message') ? messages : {}) });
    const collector = createCollector(config, { fetchImpl });
    const [row21] = (await collector.collect({ now })).packages;
    assert.equal(row21.state, 'running');

    messages = [
      { info: { role: 'assistant', time: { created: now - 46 * 60 * 1000 } }, parts: [{ type: 'text', text: 'working' }] },
    ];
    const [row46] = (await collector.collect({ now })).packages;
    assert.equal(row46.state, 'stalled');
    assert.equal(row46.reason, 'running, no activity >45m');
  });

  it('skips a malformed .exit file when computing a lane limit', () => {
    const { root, write } = makeProject();
    write('.work/codex/m.out', 'usage limit reached, try again at 3:00 PM');
    write('.work/codex/m.exit', '');
    assert.equal(laneLimit(path.join(root, '.work', 'codex')), null, 'an unreadable exit code is not authoritative evidence of a bounce');
  });

  it('derives the same lane limit from precomputed evidence as from a fresh directory read (A6)', () => {
    const { root, write } = makeProject();
    write('.work/codex/a.out', 'usage limit reached, try again at 3:00 PM');
    write('.work/codex/a.exit', '1');
    const dir = path.join(root, '.work', 'codex');
    const now = Date.now();
    const options = { identityByName: () => 'card-a' };
    const evidence = laneEvidence(dir, now, options);
    assert.deepEqual(laneLimitFromEvidence(evidence, now), laneLimit(dir, now, options));
  });

  it('active() is the one expiry rule shared by laneLimit and the collector\'s evidence split (A6)', () => {
    assert.equal(active({ resetsAt: null }, Date.now()), true, 'an unknown-duration reset stays active');
    assert.equal(active({ resetsAt: new Date(Date.now() - 1000).toISOString() }, Date.now()), false, 'a reset already in the past is not active');
    assert.equal(active({ resetsAt: new Date(Date.now() + 1000).toISOString() }, Date.now()), true, 'a reset still in the future is active');
  });

  it('reads each lane output folder once per poll (A6)', async () => {
    const { config, write } = makeProject();
    dispatch(config, { package: 'RUN-6', lane: 'codex', model: 'gpt-5.6-luna', name: 'run6' });
    write('.work/codex/run6.out', 'working');
    write('.work/codex/run6.exit', '0');
    write('.work/codex/run6.md', 'ok');
    dispatch(config, { package: 'RUN-OTHER', lane: 'codex', model: 'gpt-5.6-luna', name: 'other', adventurerId: 'codex-other' });
    write('.work/codex/other.out', 'usage limit reached, try again at 3:00 PM');
    write('.work/codex/other.exit', '1');
    const outputDir = path.join(config.root, '.work', 'codex');
    const original = fs.readdirSync;
    let calls = 0;
    fs.readdirSync = (dir, ...rest) => {
      if (path.resolve(String(dir)) === outputDir) calls += 1;
      return original(dir, ...rest);
    };
    try {
      const { laneLimits } = await createCollector(config).collect();
      assert.ok(laneLimits.codex, 'the limit is still computed correctly through the shared evidence read');
    } finally {
      fs.readdirSync = original;
    }
    assert.equal(calls, 1, 'the collector reads a lane output folder once per poll, not once for the limit and once for the evidence');
  });

  it('clears a lane limit only after a later success for the same verified card', () => {
    const { root, write } = makeProject();
    const bounced = write('.work/codex/a.out', 'usage limit');
    const bounceExit = write('.work/codex/a.exit', '1');
    const past = new Date(Date.now() - 60 * 1000);
    fs.utimesSync(bounced, past, past);
    fs.utimesSync(bounceExit, past, past);
    const success = write('.work/codex/b.out', 'ok'); const successExit = write('.work/codex/b.exit', '0');
    fs.utimesSync(success, new Date(), new Date()); fs.utimesSync(successExit, new Date(), new Date());
    const ids = { a: 'card-a', b: 'card-b' };
    assert.ok(laneLimit(path.join(root, '.work', 'codex'), Date.now(), { identityByName: (name) => ids[name] }), 'a different card cannot clear the bounce');
    assert.equal(laneLimit(path.join(root, '.work', 'codex'), Date.now(), { identityByName: (name) => name === 'a' || name === 'b' ? 'card-a' : null }), null, 'the same card clears it');
  });

  it('carries the configured bounce code through laneLimit and laneEvidence rows', () => {
    const { root, write } = makeProject();
    const now = Date.now();
    const put = (name, text) => {
      const out = write(`.work/codex/${name}.out`, text);
      const exit = write(`.work/codex/${name}.exit`, '1');
      fs.utimesSync(out, new Date(now), new Date(now));
      fs.utimesSync(exit, new Date(now), new Date(now));
    };
    put('p1', 'rate window resets in 3h');
    put('leftover', 'rate window resets in 3h');
    const options = {
      identityByName: (name) => (name === 'p1' ? 'card-a' : null),
      bouncePatterns: [{ code: 'quota_5h', label: '额度用尽', pattern: /resets (at|in)/i }],
    };
    const limit = laneLimit(path.join(root, '.work', 'codex'), now + 1000, options);
    assert.equal(limit.cards['card-a'].code, 'quota_5h');
    assert.equal(limit.cards['card-a'].until, null);
    const evidence = laneEvidence(path.join(root, '.work', 'codex'), now + 1000, options);
    assert.equal(evidence.unidentified[0].code, 'quota_5h');
  });

  it('keeps the newest bounce for every card and retains a newer unidentified advisory separately', () => {
    const { root, write } = makeProject();
    const at = Date.now() - 5000;
    const put = (name, text, code, time) => {
      const out = write(`.work/codex/${name}.out`, text);
      const exit = write(`.work/codex/${name}.exit`, String(code));
      fs.utimesSync(out, new Date(time), new Date(time));
      fs.utimesSync(exit, new Date(time), new Date(time));
    };
    put('a1', "You've hit your usage limit.", 1, at);
    put('b1', "You've hit your usage limit.", 1, at + 1000);
    put('leftover', "You've hit your usage limit.", 1, at + 2000);
    const options = { identityByName: (name) => ({ a1: 'card-a', b1: 'card-b' }[name] || null) };
    const limit = laneLimit(path.join(root, '.work', 'codex'), at + 3000, options);
    const evidence = laneEvidence(path.join(root, '.work', 'codex'), at + 3000, options);
    assert.deepEqual(Object.keys(limit.cards).sort(), ['card-a', 'card-b']);
    assert.equal(limit.cards['card-a'].name, 'a1');
    assert.equal(limit.cards['card-b'].name, 'b1');
    assert.equal(limit.unidentified, undefined, 'unidentified evidence is not exposed to lane-wide chips');
    assert.deepEqual(evidence.unidentified.map((entry) => entry.name), ['leftover']);
  });

  it('emits only active identified limits and keeps expired or unidentified evidence in laneEvidence', async () => {
    const { config, write } = makeProject();
    const now = Date.parse('2026-09-16T12:00:00.000Z');
    const put = (name, text, code, time) => {
      const out = write(`.work/codex/${name}.out`, text);
      const exit = write(`.work/codex/${name}.exit`, String(code));
      fs.utimesSync(out, new Date(time), new Date(time));
      fs.utimesSync(exit, new Date(time), new Date(time));
    };
    dispatch(config, { package: 'EXPIRED-1', lane: 'codex', model: 'gpt-5.6-luna', name: 'expired', adventurerId: 'codex-luna' });
    put('expired', 'usage limit reached, try again at 2026-09-15T12:00:00Z', 1, Date.parse('2026-09-16T10:00:00Z'));
    put('legacy', "You've hit your usage limit.", 1, Date.parse('2026-09-16T11:30:00Z'));

    let result = await createCollector(config).collect({ now });
    assert.equal(result.laneLimits.codex, undefined, 'expired-only and unidentified-only evidence cannot create a lane chip');
    assert.equal(result.laneEvidence.codex.cards['codex-luna'].name, 'expired');
    assert.deepEqual(result.laneEvidence.codex.unidentified.map((entry) => entry.name), ['legacy']);

    dispatch(config, { package: 'ACTIVE-1', lane: 'codex', model: 'gpt-6-astra', name: 'active', adventurerId: 'codex-astra' });
    const activeAt = Date.parse('2026-09-16T09:00:00Z');
    put('active', 'usage limit reached, try again at 2026-09-17T12:00:00Z', 1, activeAt);
    result = await createCollector(config).collect({ now });
    const limit = result.laneLimits.codex;
    assert.equal(limit.adventurerId, 'codex-astra');
    assert.equal(limit.at, new Date(activeAt).toISOString(), 'the top level comes from the newest active card');
    assert.equal(limit.until, '2026-09-17T12:00:00Z');
    assert.equal(result.laneEvidence.codex.cards['codex-luna'].name, 'expired');
    assert.deepEqual(result.laneEvidence.codex.unidentified.map((entry) => entry.name), ['legacy']);
  });

  it('rolls a time-only reset across midnight and never invents an unknown-duration expiry', () => {
    const late = new Date('2026-09-13T23:30:00');
    const reset = bounceTimeMs('1:00 AM', late.getTime());
    assert.ok(reset > late.getTime(), 'the reset is after the bounce');
    assert.equal(new Date(reset).getDate(), late.getDate() + 1, 'the time-only reset rolls to tomorrow');
    const { root, write } = makeProject();
    const out = write('.work/codex/unknown.out', "You've hit your usage limit.");
    const exit = write('.work/codex/unknown.exit', '1');
    const bounceAt = Date.now() - 60 * 1000;
    fs.utimesSync(out, new Date(bounceAt), new Date(bounceAt)); fs.utimesSync(exit, new Date(bounceAt), new Date(bounceAt));
    assert.ok(laneLimit(path.join(root, '.work', 'codex'), bounceAt + 5 * 3600 * 1000, { identityByName: () => 'card-unknown' }), 'an identified unknown-duration bounce remains limited after five hours');
  });

  it('rejects bare 402 and try-again text as quota evidence', () => {
    const { root, write } = makeProject();
    const now = Date.now();
    for (const [name, text] of [['plain402', 'npm test\n# fail 402 of 900 assertions'], ['http503', 'fetch error: server said please try again at 3:00 PM (HTTP 503)']]) {
      const out = write(`.work/codex/${name}.out`, text); const exit = write(`.work/codex/${name}.exit`, '1');
      fs.utimesSync(out, new Date(now), new Date(now)); fs.utimesSync(exit, new Date(now), new Date(now));
      assert.notEqual(workerState(path.join(root, '.work', 'codex', name), now).state, 'bounced');
    }
    assert.equal(laneLimit(path.join(root, '.work', 'codex'), now), null);
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

describe('FB2-01 outcome recognition', () => {
  const base = (root, name) => path.join(root, '.work', name);

  it('delivers a stream-json worker whose .out ends in a result line even without .exit (FB2-01.3)', () => {
    const { root, write } = makeProject();
    const now = Date.now();
    const result = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '1. 改完了\n2. 测试全绿' });
    write('.work/sj.out', ['{"type":"assistant"}', result].join('\n'));
    const state = workerState(base(root, 'sj'), now, { editCounter: 'stream-json' });
    assert.equal(state.state, 'delivered');
    assert.equal(state.streamResult, '1. 改完了\n2. 测试全绿');
    // An error result is a failure carrying the original text, never a delivery.
    write('.work/sje.out', JSON.stringify({ type: 'result', is_error: true, result: 'API Error: 401' }));
    const errored = workerState(base(root, 'sje'), now, { editCounter: 'stream-json' });
    assert.equal(errored.state, 'failed');
    assert.match(errored.reason, /API Error: 401/);
    // No result line: unchanged behaviour (running, then stalled) — content alone is not terminal.
    write('.work/sjr.out', '{"type":"assistant"}');
    assert.equal(workerState(base(root, 'sjr'), now, { editCounter: 'stream-json' }).state, 'running');
    // A non-stream-json lane never reads its .out as a transcript.
    write('.work/plain.out', result);
    assert.equal(workerState(base(root, 'plain'), now).state, 'running');
  });

  it('collector carries the stream-json result onto the row and uses it as the summary (FB2-01.3)', async () => {
    const { config, write } = makeProject();
    dispatch(config, { package: 'ART-9', lane: 'claude', model: 'claude-opus-5', name: 'art9' });
    const result = JSON.stringify({ type: 'result', is_error: false, result: '最终报告：完成了交付' });
    write('.work/claude/art9.out', ['{"type":"assistant"}', result].join('\n'));
    const [row] = (await createCollector(config).collect()).packages;
    assert.equal(row.state, 'delivered');
    assert.equal(row.streamResult, '最终报告：完成了交付');
    assert.equal(row.lastText, '最终报告：完成了交付', 'the result text stands in for the missing .md summary');
    const quest = { id: 'ART-9', status: 'dispatched', assignee: { name: 'art9', at: new Date().toISOString() }, dispatches: [], kind: 'art' };
    const [transition] = deriveTransitions([quest], [row]);
    assert.equal(transition.status, 'delivered');
    assert.equal(transition.streamResult, '最终报告：完成了交付', 'the dispatcher gets the text to write into .md');
  });

  it('parses the agy VERDICT line at the .out tail into entry.verdict (FB2-01.4)', async () => {
    const { config, write } = makeProject();
    dispatch(config, { package: 'SPEC-9', lane: 'agy', model: 'gemini-3.8-flash-high', name: 'spec9' });
    write('.work/agy/spec9.out', '审查了报告\n发现问题\nVERDICT: PASS WITH FINDINGS\n');
    write('.work/agy/spec9.exit', '0');
    write('.work/agy/spec9.md', '# 复核报告');
    const [row] = (await createCollector(config).collect()).packages;
    assert.equal(row.state, 'delivered');
    assert.equal(row.verdict, 'findings');
    // No VERDICT line: the field is simply absent.
    dispatch(config, { package: 'SPEC-10', lane: 'agy', model: 'gemini-3.8-flash-high', name: 'spec10' });
    write('.work/agy/spec10.out', '还在看\n');
    const rows = (await createCollector(config).collect()).packages;
    const other = rows.find((r) => r.name === 'spec10');
    assert.equal(Object.hasOwn(other, 'verdict'), false);
  });

  it('bounces with code auth_failed and the original line on a 401/invalid_api_key exit (FB2-01.2)', () => {
    const { root, write } = makeProject();
    const now = Date.now();
    const fixtures = [
      ['a1', 'Error: 401 Unauthorized: invalid api key provided'],
      ['a2', 'API Error: 401 authentication failed'],
      ['a3', 'invalid_api_key: sk-...'],
      ['a4', 'AUTH_ERROR: credentials rejected'],
    ];
    for (const [name, line] of fixtures) {
      write(`.work/${name}.out`, `working...\n${line}`);
      write(`.work/${name}.exit`, '1');
      const state = workerState(base(root, name), now);
      assert.equal(state.state, 'bounced', line);
      assert.equal(state.code, 'auth_failed', line);
      assert.equal(state.reason, line, 'the original line is the reason');
    }
    // Without a real exit, the same words are not terminal evidence.
    write('.work/a5.out', 'Error: 401 Unauthorized: invalid api key provided');
    assert.equal(workerState(base(root, 'a5'), now).state, 'running');
    // A few lines back from the end still counts (最后几行), not only the literal last line.
    write('.work/a6.out', 'working\nError 401: invalid api key\n（重试提示）\n');
    write('.work/a6.exit', '1');
    assert.equal(workerState(base(root, 'a6'), now).state, 'bounced');
    assert.equal(workerState(base(root, 'a6'), now).code, 'auth_failed');
  });

  it('bounces with code model_gone on 410/404/model-not-found (FB2-01.2)', () => {
    const { root, write } = makeProject();
    const now = Date.now();
    const fixtures = [
      ['m1', 'Error: 410 Gone: model gpt-5.5-luna is decommissioned'],
      ['m2', '404 model not found: kimi-legacy'],
      ['m3', 'model_not_found: deepseek-v3-old'],
      ['m4', 'the model claude-old no longer available'],
    ];
    for (const [name, line] of fixtures) {
      write(`.work/${name}.out`, `working...\n${line}`);
      write(`.work/${name}.exit`, '1');
      const state = workerState(base(root, name), now);
      assert.equal(state.state, 'bounced', line);
      assert.equal(state.code, 'model_gone', line);
      assert.equal(state.reason, line);
      assert.equal(state.bounceUntil, null, 'a dead model has no reset window');
    }
    // Negatives: an ordinary 404 mention without a model, and a model remark without a death signal.
    write('.work/m5.out', 'test failed: expected 404 but got 200');
    write('.work/m5.exit', '1');
    assert.equal(workerState(base(root, 'm5'), now).state, 'failed');
    write('.work/m6.out', 'the model config file was not found in settings');
    write('.work/m6.exit', '1');
    assert.equal(workerState(base(root, 'm6'), now).state, 'failed');
  });

  it('carries auth_failed/model_gone codes through lane evidence the way configured codes already travel', () => {
    const { root, write } = makeProject();
    const now = Date.now();
    write('.work/codex/gone.out', 'Error: 410 Gone: model gpt-5.6-luna is decommissioned');
    write('.work/codex/gone.exit', '1');
    const evidence = laneLimit(path.join(root, '.work', 'codex'), now, { identityByName: () => 'codex-luna' });
    assert.equal(evidence.code, 'model_gone');
    assert.equal(evidence.cards['codex-luna'].code, 'model_gone');
  });
});
