// FB2-01.1: the dispatcher owns the job objects behind the collector's process-tree death check.
// verifyProcessTree answers 'empty' only when the board's own job for the attempt counts zero processes;
// anything unverifiable is 'unknown', never proof of death. Job handles outlive their wrapper until the
// attempt settles, and applyLanes is where settled jobs are closed and forgotten.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createDispatcher } from '../../src/server/dispatcher.js';
import { QuestStore } from '../../src/core/store.js';
import { resolveConfig, CONFIG_FILE } from '../../src/core/config.js';
import { makeProject, tmpDir } from '../helpers.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await wait(50);
  }
  assert.ok(await predicate(), 'bounded wait timed out');
}

const controlLane = { run: ['node', 'scripts/run-worker.mjs', '--lane', 'ctl', '--name', '{name}', '--brief', '{brief}', '--package', '{package}', '--', 'node', 'tools/sleeper.mjs'], outputDir: '.work/ctl', control: { type: 'generic-wrapper' } };
const controlCard = () => ({ id: 'ctl-card', name: 'Fixture', lane: 'ctl', model: 'fixture-model', family: 'fixture-family', maxParallel: 1, status: 'available' });
const brief = (name) => `# brief\n\n## Files you may edit\n- \`src/${name}.js\`\n`;

describe('dispatcher process-tree death check (FB2-01.1)', () => {
  it('reports unknown, never empty, when the dispatcher holds no job for the attempt', async () => {
    const { config, write } = makeProject({ lanes: { ctl: controlLane } });
    write('docs/briefs/DTH-1-x.md', brief('dth-1'));
    const store = new QuestStore(config);
    store.post({ package: 'DTH-1', brief: 'docs/briefs/DTH-1-x.md' });
    const assigned = store.assign('DTH-1', { adventurer: controlCard(), name: 'dth1' });
    const dispatcher = createDispatcher({ config, store });
    assert.equal(await dispatcher.verifyProcessTree({ attemptId: assigned.assignee.attemptId }), 'unknown', 'no control handle at all is unknown');
    assert.equal(await dispatcher.verifyProcessTree({}), 'unknown', 'no attempt id is unknown');
  });

  it('reports unknown while the handle exists but no job object was ever assigned', async () => {
    const { config, write } = makeProject({ lanes: { ctl: controlLane } });
    write('docs/briefs/DTH-2-x.md', brief('dth-2'));
    const store = new QuestStore(config);
    store.post({ package: 'DTH-2', brief: 'docs/briefs/DTH-2-x.md' });
    const dispatcher = createDispatcher({
      config, store,
      runners: { run: async () => { await new Promise((resolve) => setTimeout(resolve, 400)); return { code: 0 }; } },
    });
    const assigned = dispatcher.assign('DTH-2', controlCard(), 'owner');
    const attemptId = assigned.body.quest.assignee.attemptId;
    await waitFor(() => Boolean(dispatcher.getControlHandle(attemptId)?.token));
    assert.equal(await dispatcher.verifyProcessTree({ attemptId }), 'unknown', 'a handle without a job (no real wrapper on the other end) is unknown');
    await wait(500);
  });

  it('keeps the handle for a still-live attempt across applyLanes, and closes it once the quest settles', async () => {
    const { config, write } = makeProject({ lanes: { ctl: controlLane } });
    write('docs/briefs/DTH-3-x.md', brief('dth-3'));
    const store = new QuestStore(config);
    store.post({ package: 'DTH-3', brief: 'docs/briefs/DTH-3-x.md' });
    const dispatcher = createDispatcher({
      config, store,
      runners: { run: async () => { await new Promise((resolve) => setTimeout(resolve, 600)); return { code: 0 }; } },
    });
    const assigned = dispatcher.assign('DTH-3', controlCard(), 'owner');
    const attemptId = assigned.body.quest.assignee.attemptId;
    await waitFor(() => Boolean(dispatcher.getControlHandle(attemptId)?.token));
    const at = assigned.body.quest.assignee.at;
    const runningRow = { name: 'dth3', package: 'DTH-3', lane: 'ctl', model: 'fixture-model', state: 'running', dispatchedAt: new Date(Date.parse(at) + 1000).toISOString() };
    dispatcher.applyLanes({ packages: [runningRow] });
    assert.ok(dispatcher.getControlHandle(attemptId), 'a live dispatched quest keeps its handle for the death check');
    // The wrapper finishes and the collector reports a terminal row: the handle must now be closed and dropped.
    await wait(700);
    const doneRow = { ...runningRow, state: 'failed', reason: 'exit 1' };
    dispatcher.applyLanes({ packages: [doneRow] });
    await waitFor(() => dispatcher.getControlHandle(attemptId) === null);
    assert.equal(store.get('DTH-3').status, 'failed');
  });

  it('verifies an actually killed wrapper tree as empty through the real job object (Windows)', { skip: process.platform !== 'win32' }, async () => {
    const root = tmpDir('qb-death-');
    fs.mkdirSync(path.join(root, 'docs', 'briefs'), { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
    const raw = {
      name: 'Death Fixture',
      lanes: {
        ctl: {
          run: ['node', 'scripts/run-worker.mjs', '--lane', 'ctl', '--name', '{name}', '--brief', '{brief}', '--package', '{package}', '--', 'node', 'tools/long-child.mjs'],
          outputDir: '.work/ctl', control: { type: 'generic-wrapper' },
        },
      },
      briefs: { dispatchDirs: ['docs/briefs'] }, policy: {},
    };
    const config = resolveConfig(root, raw);
    fs.writeFileSync(path.join(root, CONFIG_FILE), JSON.stringify(raw, null, 2));
    fs.copyFileSync(path.resolve('examples/basic/scripts/run-worker.mjs'), path.join(root, 'scripts/run-worker.mjs'));
    fs.writeFileSync(path.join(root, 'tools', 'long-child.mjs'), "process.stdin.resume(); setInterval(() => {}, 1000);\n");
    fs.writeFileSync(path.join(root, 'docs', 'briefs', 'DTH-4-x.md'), '# brief\n');
    const store = new QuestStore(config);
    store.post({ package: 'DTH-4', brief: 'docs/briefs/DTH-4-x.md' });
    const dispatcher = createDispatcher({ config, store });
    const assigned = dispatcher.assign('DTH-4', controlCard(), 'owner');
    const attemptId = assigned.body.quest.assignee.attemptId;
    await waitFor(() => Boolean(dispatcher.getControlHandle(attemptId)?.jobId), 15000);
    const handle = dispatcher.getControlHandle(attemptId);
    try {
      assert.equal(await dispatcher.verifyProcessTree({ attemptId }), 'alive', 'a wrapper and its worker inside the job count as alive');
      // Force-kill the whole tree — the exact death the board must recognize (no .exit can be written).
      spawnSync('taskkill', ['/PID', String(handle.child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
      await waitFor(() => dispatcher.verifyProcessTree({ attemptId }).then((v) => v === 'empty'), 15000);
    } finally {
      if (handle?.child && handle.child.exitCode === null) { try { handle.child.kill(); } catch {} }
    }
  });
});
