import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { resolveConfig } from '../../src/core/config.js';
import { QuestStore } from '../../src/core/store.js';
import { createDispatcher } from '../../src/server/dispatcher.js';
import { createOpenCodeSessionAdapter } from '../../src/server/workerControlAdapters.js';
import { readJsonLines } from '../../src/core/jsonl.js';
import { holdsSlot } from '../../src/core/rules.js';
import { makeProject, card, LANES } from '../helpers.js';

async function fakeLane(responses) {
  const calls = [];
  const server = http.createServer((request, response) => {
    calls.push({ method: request.method, path: request.url });
    const next = responses.shift();
    if (!next) { response.writeHead(404); response.end(); return; }
    const reply = () => {
      response.writeHead(next.status || 200, { 'content-type': 'application/json' });
      response.end(next.body === undefined ? '' : JSON.stringify(next.body));
    };
    if (next.delay) setTimeout(reply, next.delay);
    else reply();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, calls, base: `http://127.0.0.1:${server.address().port}` };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(5);
  }
  assert.ok(predicate(), 'bounded wait timed out');
}

const finishedMessages = [{ info: { role: 'assistant', time: { created: 1, completed: 2 }, finish: 'stop' }, parts: [{ type: 'text', text: 'finished' }] }];
const runningMessages = [{ info: { role: 'assistant', time: { created: Date.now() }, finish: 'tool-calls' }, parts: [{ type: 'text', text: 'still working' }] }];

function apiConfig(project, base) {
  return resolveConfig(project.root, {
    name: 'OpenCode cancellation fixture',
    lanes: { opencode: { ...LANES.opencode, api: base, control: { type: 'opencode-session' } } },
    briefs: { dispatchDirs: ['docs/briefs'] }, policy: {},
  });
}

function runningOpenCode(project, config, packageId) {
  const store = new QuestStore(config);
  project.write(`docs/briefs/${packageId}-x.md`, '# cancel\n\n## Files you may edit\n- `src/cancel.js`\n');
  store.post({ package: packageId, brief: `docs/briefs/${packageId}-x.md` });
  const assigned = store.assign(packageId, { adventurer: card('oc-mimo'), name: packageId.toLowerCase().replace('-', '') });
  const withSession = store.recordPhase(packageId, assigned.assignee, { phase: 'launching', session: { id: 'ses_api' } });
  return { store, assigned: withSession };
}

describe('OpenCode session cancellation containment', () => {
  it('uses only POST abort plus one follow-up message read, and requires an ended session', async () => {
    const lane = await fakeLane([{ status: 200, body: true }, { status: 200, body: finishedMessages }]);
    try {
      const adapter = createOpenCodeSessionAdapter({ timeoutMs: 1000 });
      const result = await adapter({
        attempt: { attemptId: 'attempt-api', name: 'api1', lane: 'opencode', at: new Date().toISOString() },
        laneConfig: { api: lane.base },
        assignee: { attemptId: 'attempt-api', name: 'api1', lane: 'opencode', at: new Date().toISOString(), session: { id: 'ses_api' } },
      });
      assert.equal(result.result, 'stopped_by_api');
      assert.equal(result.evidence.followupEnded, true);
      assert.deepEqual(lane.calls, [
        { method: 'POST', path: '/session/ses_api/abort' },
        { method: 'GET', path: '/session/ses_api/message' },
      ]);
    } finally {
      await new Promise((resolve) => lane.server.close(resolve));
    }
  });

  it('reports manual_required in Chinese when no session id or lane api base was recorded', async () => {
    const adapter = createOpenCodeSessionAdapter({ timeoutMs: 1000 });
    const result = await adapter({ attempt: { attemptId: 'attempt-none', name: 'none1' }, laneConfig: {}, assignee: { attemptId: 'attempt-none', name: 'none1' } });
    assert.equal(result.result, 'manual_required');
    assert.match(result.detail, /需要手动确认/);
  });

  it('keeps an acknowledged but still-running session unknown in Chinese', async () => {
    const lane = await fakeLane([{ status: 200, body: true }, { status: 200, body: runningMessages }]);
    try {
      const adapter = createOpenCodeSessionAdapter({ timeoutMs: 1000 });
      const result = await adapter({ attempt: { attemptId: 'attempt-running', name: 'run1' }, laneConfig: { api: lane.base }, assignee: { attemptId: 'attempt-running', name: 'run1', sessionId: 'ses_running' } });
      assert.equal(result.result, 'unknown');
      assert.match(result.detail, /后续读取没有显示 session 已结束/);
      assert.equal(result.detail.includes('still'), false);
    } finally {
      await new Promise((resolve) => lane.server.close(resolve));
    }
  });

  it('does not treat false abort acknowledgement or an object-form follow-up error as proof', async () => {
    const lane = await fakeLane([{ status: 200, body: false }, { status: 200, body: { status: 'error', message: 'session not found' } }]);
    try {
      const adapter = createOpenCodeSessionAdapter({ timeoutMs: 1000 });
      const result = await adapter({ attempt: { attemptId: 'attempt-false', name: 'false1' }, laneConfig: { api: lane.base }, assignee: { attemptId: 'attempt-false', name: 'false1', sessionId: 'ses_false' } });
      assert.equal(result.result, 'unknown');
      assert.match(result.detail, /false/);
      assert.deepEqual(lane.calls, [
        { method: 'POST', path: '/session/ses_false/abort' },
        { method: 'GET', path: '/session/ses_false/message' },
      ]);
    } finally {
      await new Promise((resolve) => lane.server.close(resolve));
    }
  });

  it('downgrades stopped_by_api without evidence and with a different session scope', async () => {
    const lane = await fakeLane([]);
    try {
      const project = makeProject();
      const config = apiConfig(project, lane.base);
      const { store, assigned } = runningOpenCode(project, config, 'OC-PROOF-1');
      const requested = store.requestCancellation('OC-PROOF-1', {
        source: 'ui', reason: 'proof boundary', adapter: 'opencode-session', deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const missing = store.recordCancellationResult('OC-PROOF-1', { requestId: requested.cancelRequest.requestId, result: 'stopped_by_api' });
      assert.equal(missing.cancelRequest.result, 'unknown');
      const wrongScope = store.recordCancellationResult('OC-PROOF-1', {
        requestId: requested.cancelRequest.requestId, result: 'stopped_by_api',
        evidence: {
          kind: 'opencode-session', attemptId: assigned.assignee.attemptId, ack: true, followupEnded: true,
          sessionId: 'ses_other',
        },
      });
      assert.equal(wrongScope.cancelRequest.result, 'unknown');
      assert.equal(wrongScope.status, 'dispatched');
    } finally {
      await new Promise((resolve) => lane.server.close(resolve));
    }
  });

  it('records stopped_by_api without freeing the slot until collector terminal evidence', async () => {
    const lane = await fakeLane([{ status: 204 }, { status: 200, body: finishedMessages }]);
    try {
      const project = makeProject();
      const config = apiConfig(project, lane.base);
      const { store } = runningOpenCode(project, config, 'OC-CANCEL-1');
      const dispatcher = createDispatcher({ config, store });
      const result = await dispatcher.cancel('OC-CANCEL-1', 'ui', 'owner requested stop');
      assert.equal(result.body.result, 'stopped_by_api');
      assert.equal(store.get('OC-CANCEL-1').status, 'dispatched');
      assert.equal(holdsSlot(store.get('OC-CANCEL-1')), true);
      assert.equal(store.get('OC-CANCEL-1').cancelRequest.adapter, 'opencode-session');
      const events = readJsonLines(config.paths.events).filter((event) => event.event.startsWith('cancel_'));
      assert.deepEqual(events.map((event) => event.event), ['cancel_requested', 'cancel_result', 'cancel_acknowledged']);
      for (const event of events.filter((entry) => ['cancel_requested', 'cancel_result'].includes(entry.event))) {
        assert.equal(event.quest, 'OC-CANCEL-1');
        assert.equal(event.attemptId, store.get('OC-CANCEL-1').assignee.attemptId);
        assert.equal(event.requestId, result.body.request.requestId);
        assert.equal(event.source, 'ui');
        assert.equal(event.adapter, 'opencode-session');
        assert.ok(event.instanceId);
        assert.equal(JSON.stringify(event).includes('token'), false);
      }
      const callsBeforeRepeat = lane.calls.length;
      const repeated = await dispatcher.cancel('OC-CANCEL-1', 'ui', 'second click');
      assert.equal(repeated.body.result, 'stopped_by_api');
      assert.equal(lane.calls.length, callsBeforeRepeat);
      dispatcher.applyLanes({ packages: [{
        package: 'OC-CANCEL-1', name: store.get('OC-CANCEL-1').assignee.name, lane: 'opencode', model: store.get('OC-CANCEL-1').assignee.model,
        state: 'failed', dispatchedAt: store.get('OC-CANCEL-1').assignee.at,
      }] });
      assert.equal(store.get('OC-CANCEL-1').status, 'failed');
      assert.equal(store.get('OC-CANCEL-1').assignee, null);
    } finally {
      await new Promise((resolve) => lane.server.close(resolve));
    }
  });

  it('returns a safe unknown result when a generic cancellation races with reassignment', async () => {
    const project = makeProject();
    const config = resolveConfig(project.root, {
      name: 'Generic cancellation race fixture',
      lanes: { generic: { run: ['node', 'tools/noop.mjs'], outputDir: '.work/generic', control: { type: 'generic-wrapper' } } },
      briefs: { dispatchDirs: ['docs/briefs'] }, policy: {},
    });
    project.write('docs/briefs/GEN-RACE-1-x.md', '# race\n\n## Files you may edit\n- `src/race.js`\n');
    const store = new QuestStore(config);
    store.post({ package: 'GEN-RACE-1', brief: 'docs/briefs/GEN-RACE-1-x.md' });
    const genericCard = { id: 'generic-card', name: 'Generic', lane: 'generic', model: 'generic-model', family: 'generic-family', maxParallel: 1, strengths: ['code'], status: 'available' };
    const assigned = store.assign('GEN-RACE-1', { adventurer: genericCard, name: 'generic-old' });
    store.recordPhase('GEN-RACE-1', assigned.assignee, { phase: 'launching' });
    let resolveAdapter;
    let adapterCalled = false;
    const adapterResult = new Promise((resolve) => { resolveAdapter = resolve; });
    const dispatcher = createDispatcher({
      config, store,
      genericWrapperAdapter: async () => { adapterCalled = true; return adapterResult; },
    });
    const cancelPromise = dispatcher.cancel('GEN-RACE-1', 'ui', 'generic race');
    await waitFor(() => adapterCalled);
    const oldAttempt = store.get('GEN-RACE-1').assignee;
    store.setStatus('GEN-RACE-1', 'failed', { source: 'collector', by: 'lanes', detail: 'old attempt ended', evidence: { kind: 'collector', attemptId: oldAttempt.attemptId } });
    const reassigned = store.assign('GEN-RACE-1', { adventurer: genericCard, name: 'generic-new' });
    resolveAdapter({ result: 'stopped_by_wrapper', detail: '包装脚本已确认并记下：它直接启动的进程已停止' });
    const result = await cancelPromise;
    assert.equal(result.status, 202);
    assert.equal(result.body.result, 'unknown');
    assert.equal(result.body.detail, '取消已变更，取消结果未记录');
    assert.equal(store.get('GEN-RACE-1').assignee.attemptId, reassigned.assignee.attemptId);
    assert.equal(store.get('GEN-RACE-1').cancelRequest, null);
    assert.equal(readJsonLines(config.paths.events).filter((event) => event.event === 'cancel_result').length, 0);
  });

  it('returns a safe unknown result when an API cancellation races with reassignment', async () => {
    const lane = await fakeLane([{ status: 200, body: true, delay: 40 }]);
    try {
      const project = makeProject();
      const config = apiConfig(project, lane.base);
      const { store } = runningOpenCode(project, config, 'OC-RACE-1');
      const dispatcher = createDispatcher({ config, store });
      const cancelPromise = dispatcher.cancel('OC-RACE-1', 'ui', 'api race');
      await waitFor(() => lane.calls.length === 1);
      const oldAttempt = store.get('OC-RACE-1').assignee;
      store.setStatus('OC-RACE-1', 'failed', { source: 'collector', by: 'lanes', detail: 'old attempt ended', evidence: { kind: 'collector', attemptId: oldAttempt.attemptId } });
      const replacement = store.assign('OC-RACE-1', { adventurer: card('oc-mimo'), name: 'api-new' });
      store.recordPhase('OC-RACE-1', replacement.assignee, { phase: 'launching', session: { id: 'ses_new' } });
      const result = await cancelPromise;
      assert.equal(result.status, 202);
      assert.equal(result.body.result, 'unknown');
      assert.equal(result.body.detail, '取消已变更，取消结果未记录');
      assert.equal(store.get('OC-RACE-1').assignee.attemptId, replacement.assignee.attemptId);
      assert.equal(store.get('OC-RACE-1').cancelRequest, null);
      assert.equal(readJsonLines(config.paths.events).filter((event) => event.event === 'cancel_result').length, 0);
    } finally {
      await new Promise((resolve) => lane.server.close(resolve));
    }
  });

  it('expires pending requests on restart and a foreign dispatcher does not resend them', async () => {
    const project = makeProject();
    const raw = {
      name: 'Restart cancellation fixture',
      lanes: { opencode: { ...LANES.opencode, api: 'http://127.0.0.1:1', control: { type: 'opencode-session' } } },
      briefs: { dispatchDirs: ['docs/briefs'] }, policy: {},
    };
    const config = resolveConfig(project.root, raw);
    project.write('docs/briefs/OC-RESTART-1-x.md', '# restart\n\n## Files you may edit\n- `src/restart.js`\n');
    const first = new QuestStore(config);
    first.post({ package: 'OC-RESTART-1', brief: 'docs/briefs/OC-RESTART-1-x.md' });
    const assigned = first.assign('OC-RESTART-1', { adventurer: card('oc-mimo'), name: 'restart1' });
    const deadlineAt = new Date(Date.now() + 60_000).toISOString();
    const requested = first.requestCancellation('OC-RESTART-1', { source: 'cli', reason: 'restart test', instanceId: 'instance-a', adapter: 'opencode-session', deadlineAt });
    const second = new QuestStore(config);
    const foreign = createDispatcher({ config, store: second, fetchImpl: async () => { throw new Error('must not call the foreign lane'); } });
    const notResent = await foreign.cancel('OC-RESTART-1', 'cli', 'retry from another board');
    assert.equal(notResent.body.result, 'pending');
    assert.match(notResent.body.note, /由其他看板实例发起，等待其结果/);
    assert.equal(second.get('OC-RESTART-1').cancelRequest.requestId, requested.cancelRequest.requestId);
    assert.equal(second.get('OC-RESTART-1').cancelRequest.result, 'pending');

    const expiredProject = makeProject();
    const expiredConfig = resolveConfig(expiredProject.root, raw);
    expiredProject.write('docs/briefs/OC-EXPIRE-1-x.md', '# expiry\n\n## Files you may edit\n- `src/expire.js`\n');
    const pending = new QuestStore(expiredConfig);
    pending.post({ package: 'OC-EXPIRE-1', brief: 'docs/briefs/OC-EXPIRE-1-x.md' });
    const running = pending.assign('OC-EXPIRE-1', { adventurer: card('oc-mimo'), name: 'expire1' });
    const oldDeadline = new Date(Date.now() - 1000).toISOString();
    pending.requestCancellation('OC-EXPIRE-1', { source: 'mcp', reason: 'expired request', instanceId: 'instance-old', adapter: 'opencode-session', deadlineAt: oldDeadline });
    const replayed = new QuestStore(expiredConfig).get('OC-EXPIRE-1');
    assert.equal(replayed.cancelRequest.result, 'unknown');
    assert.match(replayed.cancelRequest.detail, new RegExp(oldDeadline.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok(replayed.cancelRequest.resultAt);
    assert.ok(replayed.cancelRequest.resultInstanceId);
    assert.equal(replayed.cancelRequest.adapter, 'opencode-session');
    assert.equal(replayed.assignee.attemptId, running.assignee.attemptId);
    assert.equal(readJsonLines(expiredConfig.paths.events).filter((event) => event.event === 'cancel_result').length, 1);
  });

  it('settles a pending cancellation after its attempt lost the slot on the next poll', async () => {
    const project = makeProject();
    const config = project.config;
    project.write('docs/briefs/OC-STALE-1-x.md', '# stale\n\n## Files you may edit\n- `src/stale.js`\n');
    const store = new QuestStore(config);
    store.post({ package: 'OC-STALE-1', brief: 'docs/briefs/OC-STALE-1-x.md' });
    const assigned = store.assign('OC-STALE-1', { adventurer: card('oc-mimo'), name: 'stale1' });
    const deadlineAt = new Date(Date.now() + 25).toISOString();
    const requested = store.requestCancellation('OC-STALE-1', { source: 'ui', reason: 'stale request', deadlineAt, adapter: 'opencode-session' });
    store.setStatus('OC-STALE-1', 'failed', { source: 'collector', by: 'lanes', detail: 'old attempt ended', evidence: { kind: 'collector', attemptId: assigned.assignee.attemptId } });
    await wait(40);
    const dispatcher = createDispatcher({ config, store, fetchImpl: async () => { throw new Error('stale request must not call the lane'); } });
    dispatcher.applyLanes({ packages: [] });
    const settled = store.get('OC-STALE-1');
    assert.equal(settled.assignee, null);
    assert.equal(settled.cancelRequest.requestId, requested.cancelRequest.requestId);
    assert.equal(settled.cancelRequest.result, 'unknown');
    assert.equal(settled.cancelRequest.detail, '取消已结束，取消请求作废');
  });

  it('requires the explicit opencode-session control type and leaves old lane resolution unchanged', () => {
    const project = makeProject();
    assert.equal(project.config.lanes.opencode.control, undefined);
    const configured = resolveConfig(project.root, {
      name: 'Configured', lanes: { opencode: { ...LANES.opencode, control: { type: 'opencode-session' } } }, policy: {},
    });
    assert.equal(configured.lanes.opencode.control.type, 'opencode-session');
    assert.throws(() => resolveConfig(project.root, { name: 'Invalid', lanes: { opencode: { ...LANES.opencode, api: undefined, outputDir: '.work/opencode', control: { type: 'opencode-session' } } } }), /requires api/);
  });
});
