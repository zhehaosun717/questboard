import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDispatcher } from '../../src/server/dispatcher.js';
import { QuestStore } from '../../src/core/store.js';
import { readJsonLines } from '../../src/core/jsonl.js';
import { appendJsonLine } from '../../src/core/jsonl.js';
import { createCollector } from '../../src/lanes/collector.js';
import { makeProject, card, quest } from '../helpers.js';

const waitForMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 20));

function postAndAssign(project, packageId = 'RUN-4') {
  project.write(`docs/briefs/${packageId}-x.md`, '# bounded\n\n## Files you may edit\n- `src/run4.js`\n');
  const store = new QuestStore(project.config);
  store.post({ package: packageId, brief: `docs/briefs/${packageId}-x.md`, by: 'owner' });
  const assigned = store.assign(packageId, { adventurer: card('codex-luna'), name: 'run4', by: 'owner' });
  return { store, assigned };
}

function boundedRow(assigned, extra = {}) {
  return {
    package: 'RUN-4', name: 'run4', lane: 'codex', dispatchedAt: assigned.assignee.at,
    state: 'stalled', reason: '超过时长上限 1 分钟', limitReason: '超过时长上限 1 分钟', elapsed: 61 * 1000,
    ...extra,
  };
}

describe('feedback 10 bound cancellation', () => {
  it('keeps a no-adapter over-limit quest stalled and without a cancellation request', () => {
    const project = makeProject();
    const { store, assigned } = postAndAssign(project);
    const dispatcher = createDispatcher({ config: project.config, store, runners: { run: async () => ({ code: 0 }) } });
    dispatcher.applyLanes({ packages: [boundedRow(assigned, { manualRequired: true })] });
    const next = store.get('RUN-4');
    assert.equal(next.status, 'stalled');
    assert.equal(next.cancelRequest, null);
    assert.match(next.lastDetail, /超过时长上限 1 分钟/);
    assert.match(next.lastDetail, /无法自动停止，请手动处理/);
  });

  it('uses the generic-wrapper cancellation path once per attempt and records manual_required without a handle', async () => {
    const project = makeProject({ lanes: {
      generic: { run: ['tools/run.sh'], outputDir: '.work/generic', control: { type: 'generic-wrapper' } },
    } });
    project.write('docs/briefs/RUN-4-x.md', '# bounded\n\n## Files you may edit\n- `src/run4.js`\n');
    const store = new QuestStore(project.config);
    store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md', by: 'owner' });
    const adventurer = { ...card('codex-luna'), id: 'generic-card', lane: 'generic' };
    const assigned = store.assign('RUN-4', { adventurer, name: 'run4', by: 'owner' });
    store.recordPhase('RUN-4', assigned.assignee, { phase: 'launching' });
    const dispatcher = createDispatcher({ config: project.config, store, runners: { run: async () => ({ code: 0 }) } });
    const row = { ...boundedRow(assigned), lane: 'generic' };
    dispatcher.applyLanes({ packages: [row] });
    await waitForMicrotasks();
    dispatcher.applyLanes({ packages: [row] });
    await waitForMicrotasks();
    const next = store.get('RUN-4');
    assert.equal(next.status, 'stalled');
    assert.equal(next.cancelRequest.bySource, 'limit');
    assert.equal(next.cancelRequest.result, 'manual_required');
    assert.equal(next.cancelRequest.reason, '超过时长上限 1 分钟');
    assert.match(next.cancelRequest.detail, /无法自动停止，请手动处理/);
    assert.equal(readJsonLines(project.config.paths.events).filter((event) => event.event === 'cancel_requested').length, 1);
  });

  it('dedupes a no-adapter bound stall while a session keeps adding messages', async () => {
    const project = makeProject({ lanes: {
      sessionlimited: {
        session: { run: ['node', 'tools/new-session.mjs'], saveTo: '.work/session-{name}.txt' },
        run: ['tools/send.sh', '{name}', '{brief}'], api: 'http://oc.test', limits: { maxMessages: 2 },
      },
    } });
    project.write('docs/briefs/RUN-4-x.md', '# bounded\n\n## Files you may edit\n- `src/run4.js`\n');
    const store = new QuestStore(project.config);
    store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md', by: 'owner' });
    const adventurer = { ...card('codex-luna'), id: 'session-card', lane: 'sessionlimited' };
    const assigned = store.assign('RUN-4', { adventurer, name: 'run4', by: 'owner' });
    appendJsonLine(project.config.paths.registry, {
      at: assigned.assignee.at, event: 'dispatch', variant: '', package: 'RUN-4', lane: 'sessionlimited',
      model: adventurer.model, name: 'run4', session: 'ses-live',
    });
    const at = Date.parse(assigned.assignee.at);
    const messages = [
      { info: { role: 'user' }, parts: [] },
      { info: { role: 'assistant', time: { created: at }, finish: 'tool-calls' }, parts: [{ type: 'text', text: 'step 1' }] },
      { info: { role: 'user' }, parts: [] },
    ];
    const fetchImpl = async (url) => ({ ok: true, json: async () => (url.endsWith('/message') ? messages : {}) });
    const dispatcher = createDispatcher({ config: project.config, store });
    const observedText = [];
    for (let poll = 1; poll <= 4; poll += 1) {
      const lanes = await createCollector(project.config, { fetchImpl }).collect({ now: at + poll * 1000 });
      observedText.push(lanes.packages[0].lastText);
      dispatcher.applyLanes(lanes);
      if (poll < 4) messages.push({
        info: { role: 'assistant', time: { created: at + poll * 1000 }, finish: 'tool-calls' },
        parts: [{ type: 'text', text: `step ${poll + 1}` }],
      });
    }
    assert.deepEqual(observedText, ['step 1', 'step 2', 'step 3', 'step 4']);
    assert.equal(store.get('RUN-4').status, 'stalled');
    assert.match(store.get('RUN-4').lastDetail, /step 1/);
    assert.doesNotMatch(store.get('RUN-4').lastDetail, /step [234]/);
    assert.equal(readJsonLines(project.config.paths.events).filter((event) => event.event === 'stalled').length, 1);
  });

  it('refuses an adoption with a deleted brief before assigning, preserving the open quest and slot availability', () => {
    const project = makeProject();
    const brief = project.write('docs/briefs/RUN-4-x.md', '# bounded');
    const store = new QuestStore(project.config);
    store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md', by: 'owner' });
    fs.unlinkSync(brief);
    const dispatcher = createDispatcher({ config: project.config, store });
    const result = dispatcher.adopt('RUN-4', card('codex-luna'), 'handrun', 'owner');
    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'refused');
    assert.equal(result.body.reasons[0].code, 'brief_missing');
    assert.equal(store.get('RUN-4').status, 'posted');
    assert.equal(store.get('RUN-4').assignee, null);
    assert.equal(readJsonLines(project.config.paths.events).filter((event) => event.event === 'assigned').length, 0);
  });

  it('dispatches a legacy quest whose usable brief is outside dispatchDirs', async () => {
    const project = makeProject();
    project.write('docs/old/RUN-5-legacy.md', '# legacy\n\n## Files you may edit\n- `src/legacy.js`\n');
    const store = new QuestStore(project.config);
    const at = new Date().toISOString();
    store.save({ ...quest({ id: 'RUN-5', brief: 'docs/old/RUN-5-legacy.md' }), title: 'legacy', postedBy: 'owner', createdAt: at, updatedAt: at });
    const calls = [];
    const dispatcher = createDispatcher({ config: project.config, store, runners: { run: async (step) => { calls.push(step); return { code: 0 }; } } });
    const result = dispatcher.assign('RUN-5', card('codex-luna'), 'owner');
    assert.equal(result.status, 200);
    await waitForMicrotasks();
    assert.equal(store.get('RUN-5').status, 'dispatched');
    assert.equal(store.get('RUN-5').assignee.roleCard.digest.length, 64);
    assert.equal(calls.length, 1);
  });

  it('delivers a finished session even when its message count is over the lane bound', async () => {
    const project = makeProject({ lanes: {
      sessionlimited: {
        session: { run: ['node', 'tools/new-session.mjs'], saveTo: '.work/session-{name}.txt' },
        run: ['tools/send.sh', '{name}', '{brief}'], api: 'http://oc.test', deliveryDir: '.work/session-limited',
        limits: { maxMessages: 2 },
      },
    } });
    project.write('docs/briefs/RUN-6-x.md', '# session');
    const store = new QuestStore(project.config);
    store.post({ package: 'RUN-6', brief: 'docs/briefs/RUN-6-x.md', by: 'owner' });
    const adventurer = { ...card('codex-luna'), id: 'session-card', lane: 'sessionlimited' };
    const assigned = store.assign('RUN-6', { adventurer, name: 'run6', by: 'owner' });
    const now = Date.parse('2026-09-16T12:00:00.000Z');
    appendJsonLine(project.config.paths.registry, { at: assigned.assignee.at, event: 'dispatch', variant: '', package: 'RUN-6', lane: 'sessionlimited', model: adventurer.model, name: 'run6', session: 'ses-final' });
    const messages = [
      { info: { role: 'user' }, parts: [] },
      { info: { role: 'assistant', time: { completed: now }, finish: 'stop' }, parts: [{ type: 'text', text: 'final report' }] },
      { info: { role: 'user' }, parts: [] },
    ];
    const lanes = await createCollector(project.config, { fetchImpl: async (url) => ({ ok: true, json: async () => (url.endsWith('/message') ? messages : {}) }) }).collect({ now });
    assert.equal(lanes.packages[0].state, 'delivered');
    const dispatcher = createDispatcher({
      config: project.config,
      store,
      writeDelivery: async (config, lane, name) => {
        const file = path.join(config.root, '.work', 'session-limited', `${name}.md`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'final report');
        return file;
      },
    });
    dispatcher.applyLanes(lanes);
    await waitForMicrotasks();
    assert.equal(store.get('RUN-6').status, 'delivered');
    assert.equal(fs.readFileSync(path.join(project.root, '.work/session-limited/run6.md'), 'utf8'), 'final report');
  });
});
