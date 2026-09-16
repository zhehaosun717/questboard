import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveConfig, CONFIG_FILE } from '../../src/core/config.js';
import { QuestStore } from '../../src/core/store.js';
import { createDispatcher } from '../../src/server/dispatcher.js';
import { readJsonLines } from '../../src/core/jsonl.js';
import { withFileSets } from '../../src/core/briefs.js';
import { holdsSlot } from '../../src/core/rules.js';
import { makeProject, card, tmpDir } from '../helpers.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(25);
  }
  assert.ok(predicate(), 'bounded wait timed out');
}

function controlProject() {
  const root = tmpDir('qb-control-');
  const fixtureToken = randomUUID();
  fs.mkdirSync(path.join(root, 'docs', 'briefs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
  const raw = {
    name: 'Control Fixture',
    lanes: {
      generic: {
        run: ['node', 'scripts/run-worker.mjs', '--lane', 'generic', '--name', '{name}', '--brief', '{brief}', '--package', '{package}', '--', 'node', 'tools/finite-child.mjs'],
        outputDir: '.work/generic', control: { type: 'generic-wrapper' }, env: { FIXTURE_TOKEN: fixtureToken },
      },
    },
    briefs: { dispatchDirs: ['docs/briefs'] }, policy: {},
  };
  const config = resolveConfig(root, raw);
  fs.writeFileSync(path.join(root, CONFIG_FILE), JSON.stringify(raw, null, 2));
  fs.copyFileSync(path.resolve('examples/basic/scripts/run-worker.mjs'), path.join(root, 'scripts/run-worker.mjs'));
  const heartbeatPath = path.join(root, 'tools', 'heartbeat.log');
  const donePath = path.join(root, 'tools', 'done.marker');
  fs.writeFileSync(path.join(root, 'tools', 'agent-child.mjs'), [
    "import fs from 'node:fs';",
    `if (process.env.FIXTURE_TOKEN !== ${JSON.stringify(fixtureToken)}) process.exit(2);`,
    `const heartbeat = ${JSON.stringify(heartbeatPath)};`,
    `const done = ${JSON.stringify(donePath)};`,
    "const beat = () => { fs.appendFileSync(heartbeat, `${process.env.FIXTURE_TOKEN}\\n`); };",
    'beat();',
    'const timer = setInterval(beat, 40);',
    `setTimeout(() => { clearInterval(timer); fs.writeFileSync(done, process.env.FIXTURE_TOKEN); process.exit(0); }, 1600);`,
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'tools/finite-child.mjs'), [
    "import { spawn } from 'node:child_process';",
    `if (process.env.FIXTURE_TOKEN !== ${JSON.stringify(fixtureToken)}) process.exit(2);`,
    `const agent = spawn(process.execPath, [${JSON.stringify(path.join(root, 'tools', 'agent-child.mjs'))}], { cwd: ${JSON.stringify(root)}, env: process.env, stdio: 'ignore', detached: true });`,
    'agent.unref();',
    'setTimeout(() => process.exit(0), 2000);',
    'process.stdin.resume();',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'tools', 'fixture-agent.cmd'), '@echo off\r\nnode "%~dp0finite-child.mjs"\r\n');
  fs.writeFileSync(path.join(root, 'docs/briefs/CAN-2-x.md'), '# bounded\n\n## Files you may edit\n- `src/can-2.js`\n');
  return { root, config, heartbeatPath: path.join(root, 'tools', 'heartbeat.log'), donePath: path.join(root, 'tools', 'done.marker'), adventurer: { id: 'generic-card', name: 'Fixture', lane: 'generic', model: 'fixture-model', family: 'fixture-family', maxParallel: 1, status: 'available' } };
}

describe('dispatcher cancellation lifecycle', () => {
  it('cancels a queued attempt before any effect and proves never_started from the queued write-ahead', async () => {
    const project = makeProject({ lanes: { codex: { run: ['tools/codex-run.sh', '{name}', '{brief}', '{model}', '{variant}'], outputDir: '.work/codex', serialize: true } } });
    const store = new QuestStore(project.config);
    project.write('docs/briefs/CAN-3-x.md', '# queued\n\n## Files you may edit\n- `src/can-3.js`\n');
    project.write('docs/briefs/CAN-4-x.md', '# queued\n\n## Files you may edit\n- `src/can-4.js`\n');
    store.post({ package: 'CAN-3', brief: 'docs/briefs/CAN-3-x.md' });
    store.post({ package: 'CAN-4', brief: 'docs/briefs/CAN-4-x.md' });
    let unblock;
    const gate = new Promise((resolve) => { unblock = resolve; });
    let runs = 0;
    const dispatcher = createDispatcher({
      config: project.config, store,
      runners: { run: async () => { runs += 1; if (runs === 1) await gate; return { code: 0 }; } },
    });
    dispatcher.assign('CAN-3', card('codex-luna'), 'owner');
    const second = dispatcher.assign('CAN-4', card('codex-astra', { strengths: ['code'], maxParallel: 2 }), 'owner');
    const attemptId = second.body.quest.assignee.attemptId;
    const requested = await dispatcher.cancel('CAN-4', 'ui', 'queued cancellation');
    assert.equal(requested.body.result, 'pending');
    unblock();
    await waitFor(() => store.get('CAN-4').status === 'cancelled');
    const stopped = store.get('CAN-4');
    assert.equal(runs, 1);
    assert.equal(stopped.assignee, null);
    assert.equal(stopped.cancelRequest.result, 'never_started');
    assert.equal(stopped.cancelRequest.attemptId, attemptId);
  });

  it('uses the real generic wrapper: wrong tokens are ignored and matching ack plus exit metadata stays held while the child self-expires', async () => {
    const project = controlProject();
    const store = new QuestStore(project.config);
    store.post({ package: 'CAN-2', brief: 'docs/briefs/CAN-2-x.md' });
    const dispatcher = createDispatcher({ config: project.config, store });
    const assigned = dispatcher.assign('CAN-2', project.adventurer, 'owner');
    assert.equal(assigned.status, 200);
    const attemptId = assigned.body.quest.assignee.attemptId;
    await waitFor(() => dispatcher.getControlHandle(attemptId)?.child);
    const handle = dispatcher.getControlHandle(attemptId);
    try {
      await waitFor(() => fs.existsSync(project.heartbeatPath), 4000);
      handle.child.send({ type: 'questboard-cancel', attemptId, requestId: 'wrong-request', token: 'wrong-token' });
      await wait(50);
      assert.equal(store.get('CAN-2').status, 'dispatched');
      const result = await dispatcher.cancel('CAN-2', 'cli', 'stop the fixture');
      assert.equal(result.body.result, 'stopped_by_wrapper', JSON.stringify(result.body));
      const held = store.get('CAN-2');
      assert.equal(held.status, 'dispatched');
      assert.equal(holdsSlot(held), true);
      assert.ok(withFileSets(project.config, [held])[0].files.includes('src/can-2.js'));
      assert.equal(store.get('CAN-2').cancelRequest.result, 'stopped_by_wrapper');
      assert.equal(store.get('CAN-2').cancelRequest.evidence.scope, 'direct-child');
      assert.equal(fs.readFileSync(path.join(project.root, '.work', 'generic', 'can2.exit'), 'utf8').includes('wrong-request'), false);
      const before = fs.readFileSync(project.heartbeatPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).length;
      await wait(180);
      const after = fs.readFileSync(project.heartbeatPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).length;
      assert.ok(after > before, 'the wrapper exit must not be treated as proof that its child is gone');
      await waitFor(() => fs.existsSync(project.donePath), 3000);
    } finally {
      if (handle?.child && handle.child.exitCode === null) handle.child.kill();
    }
  });

  it('does not rewrite a held cancellation when applyLanes replays the same exit evidence', () => {
    const project = makeProject();
    const store = new QuestStore(project.config);
    store.post({ package: 'CAN-REPLAY-1', brief: 'docs/briefs/CAN-REPLAY-1-x.md' });
    const assigned = store.assign('CAN-REPLAY-1', { adventurer: card('codex-luna'), name: 'canreplay' });
    const requested = store.requestCancellation('CAN-REPLAY-1', { source: 'ui', reason: 'stop this replay fixture' });
    const row = {
      name: assigned.assignee.name, lane: assigned.assignee.lane, model: assigned.assignee.model,
      state: 'failed', dispatchedAt: assigned.assignee.at,
      cancelRequestId: requested.cancelRequest.requestId, cancelScope: 'direct-child',
    };
    const dispatcher = createDispatcher({ config: project.config, store });
    const before = store.get('CAN-REPLAY-1').revision;
    for (let i = 0; i < 5; i += 1) dispatcher.applyLanes({ packages: [row] });

    const final = store.get('CAN-REPLAY-1');
    const events = readJsonLines(project.config.paths.events);
    assert.equal(final.status, 'dispatched');
    assert.equal(final.cancelRequest.result, 'stopped_by_wrapper');
    assert.equal(final.revision, before + 1, 'the first scoped evidence write is the only new revision');
    assert.equal(events.filter((event) => event.event === 'cancel_acknowledged').length, 1);
  });
});
