import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CONFIG_FILE } from '../../src/core/config.js';
import { appendJsonLine, readJsonLines } from '../../src/core/jsonl.js';
import { QuestStore } from '../../src/core/store.js';
import {
  createVerificationHookRunner,
  hookLogRelativePath,
  hookRunKey,
  readHookLog,
} from '../../src/core/verificationHooks.js';
import { card, makeProject } from '../helpers.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await wait(25);
  }
  throw new Error('timed out waiting for verification hook');
}

function hook(overrides = {}) {
  return {
    id: 'smoke',
    command: ['node', '-e', "process.stdout.write('hook stdout'); process.stderr.write('hook stderr')"],
    timeoutSeconds: 5,
    cwd: '.',
    envKeys: [],
    kinds: ['code'],
    trigger: 'delivered',
    enabled: true,
    ...overrides,
  };
}

function assignedProject(hooks) {
  const project = makeProject({ verification: { hooks } });
  const store = new QuestStore(project.config);
  store.post({ package: 'HOOK-1', brief: 'docs/briefs/HOOK-1-x.md' });
  const assigned = store.assign('HOOK-1', { adventurer: card('codex-luna'), name: 'hook-1' });
  return { project, store, assigned };
}

describe('verification hooks', () => {
  it('runs an enabled delivered hook once, appends the exact S2 records, and keeps status unchanged', async () => {
    const { project, store, assigned } = assignedProject([hook()]);
    const runner = createVerificationHookRunner({ config: project.config, store });

    runner.onDelivered(assigned);
    const done = await until(() => {
      const records = store.get('HOOK-1')?.assignee?.hooks || [];
      return records.at(-1)?.state === 'passed' ? records : null;
    });

    assert.deepEqual(done.map((record) => record.state), ['queued', 'running', 'passed']);
    assert.deepEqual(store.get('HOOK-1').assignee.hooks, store.get('HOOK-1').dispatches[0].hooks);
    assert.equal(store.get('HOOK-1').status, 'dispatched');
    for (const record of done) {
      assert.deepEqual(Object.keys(record).sort(), ['attemptId', 'commandRef', 'endedAt', 'exitCode', 'logDigest', 'logPath', 'startedAt', 'state']);
      assert.equal(record.attemptId, assigned.assignee.attemptId);
    }

    const final = done.at(-1);
    const log = readHookLog(project.config, final.logPath);
    assert.ok(log);
    assert.match(log.body.toString('utf8'), /hook stdout/);
    assert.match(log.body.toString('utf8'), /hook stderr/);
    assert.equal(final.logDigest, createHash('sha256').update(log.body).digest('hex'));

    const events = readJsonLines(project.config.paths.events).filter((event) => event.package === 'HOOK-1');
    assert.deepEqual(events.filter((event) => event.event.startsWith('hook_')).map((event) => event.event), ['hook_started', 'hook_finished']);
    assert.equal(events.find((event) => event.event === 'hook_started').detail, '');

    runner.onDelivered(store.get('HOOK-1'));
    await wait(50);
    assert.equal(store.get('HOOK-1').assignee.hooks.length, 3, 'attempt + hook definition is idempotent');
  });

  it('defaults hooks to disabled, ignores hook-shaped remote payload fields, and does not rewrite an old config', () => {
    const rawHook = hook({ enabled: undefined });
    const project = makeProject({ verification: { hooks: [rawHook], futureField: { keep: true } } });
    const before = fs.readFileSync(path.join(project.root, CONFIG_FILE));
    const store = new QuestStore(project.config);
    const result = store.post({ package: 'HOOK-2', brief: 'docs/briefs/HOOK-2-x.md', verification: { hooks: [hook()] } });

    assert.equal(result.errors, undefined);
    assert.equal(store.get('HOOK-2').verification, undefined);
    assert.equal(project.config.verification.hooks[0].enabled, false);
    assert.deepEqual(fs.readFileSync(path.join(project.root, CONFIG_FILE)), before);
  });

  it('rejects hook cwd escapes and non-name environment entries at config validation', () => {
    assert.throws(() => makeProject({ verification: { hooks: [hook({ cwd: '..' })] } }), /cwd/);
    assert.throws(() => makeProject({ verification: { hooks: [hook({ cwd: 'C:foo' })] } }), /cwd/);
    assert.throws(() => makeProject({ verification: { hooks: [hook({ envKeys: ['BAD-NAME'] })] } }), /envKeys/);
    assert.throws(() => makeProject({ verification: { hooks: [hook({ kinds: ['tool'] })] } }), /kinds/);
  });

  it('times out and cancels only its own child without changing quest status', async () => {
    const timeoutHook = hook({ command: ['node', '-e', 'setTimeout(() => {}, 10000)'], timeoutSeconds: 1 });
    const { project, store, assigned } = assignedProject([timeoutHook]);
    const runner = createVerificationHookRunner({ config: project.config, store });
    runner.onDelivered(assigned);
    const key = hookRunKey(assigned.assignee.attemptId, project.config.verification.hooks[0]);
    await until(() => runner.getHandle(key)?.cancel);
    assert.equal(runner.cancel(assigned.assignee.attemptId, 'smoke'), true);
    await until(() => store.get('HOOK-1').assignee.hooks.at(-1)?.state === 'unknown');
    assert.equal(store.get('HOOK-1').status, 'dispatched');

    const timedOutProject = assignedProject([timeoutHook]);
    const timedOutRunner = createVerificationHookRunner({ config: timedOutProject.project.config, store: timedOutProject.store });
    timedOutRunner.onDelivered(timedOutProject.assigned);
    await until(() => timedOutProject.store.get('HOOK-1').assignee.hooks.at(-1)?.state === 'timedout', 4000);
    assert.equal(timedOutProject.store.get('HOOK-1').status, 'dispatched');
  });

  it('recovers an expired running record as unknown and never starts a duplicate child', () => {
    const configured = hook({ timeoutSeconds: 1 });
    const { project, store, assigned } = assignedProject([configured]);
    const logPath = hookLogRelativePath(project.config, assigned.id, assigned.assignee.attemptId, configured.id);
    store.recordHook('HOOK-1', assigned.assignee, {
      state: 'running', commandRef: configured.id, startedAt: new Date(Date.now() - 5000).toISOString(), endedAt: null,
      exitCode: null, logPath, logDigest: null, attemptId: assigned.assignee.attemptId,
    });

    createVerificationHookRunner({ config: project.config, store });
    const records = store.get('HOOK-1').assignee.hooks;
    assert.equal(records.at(-1).state, 'unknown');
    assert.equal(records.length, 2);
  });

  describe('B1: sequential hooks and the worst-last guarantee', () => {
    it('fail-then-pass: the last element (and evidence) stays at the earlier failure', async () => {
      const first = hook({ id: 'fails-fast', command: ['node', '-e', 'process.exit(1)'] });
      const second = hook({ id: 'passes-late', command: ['node', '-e', 'process.exit(0)'] });
      const { project, store, assigned } = assignedProject([first, second]);
      const runner = createVerificationHookRunner({ config: project.config, store });

      runner.onDelivered(assigned);
      await until(() => {
        const records = store.get('HOOK-1')?.assignee?.hooks || [];
        return records.some((r) => r.commandRef === 'passes-late' && r.state === 'passed') ? records : null;
      });

      const records = store.get('HOOK-1').assignee.hooks;
      assert.deepEqual(records.map((r) => r.commandRef), [
        'fails-fast', 'fails-fast', 'fails-fast',
        'passes-late', 'passes-late', 'passes-late',
        'fails-fast',
      ]);
      assert.equal(records.at(-1).state, 'failed');
      // never run in parallel: fails-fast's own trio is fully queued/running/failed before passes-late starts
      assert.deepEqual(records.slice(0, 3).map((r) => r.state), ['queued', 'running', 'failed']);
      assert.deepEqual(records.slice(3, 6).map((r) => r.state), ['queued', 'running', 'passed']);
    });

    it('pass-then-fail: the last hook already ends the sequence on the failure, no duplicate needed', async () => {
      const first = hook({ id: 'passes-first', command: ['node', '-e', 'process.exit(0)'] });
      const second = hook({ id: 'fails-second', command: ['node', '-e', 'process.exit(1)'] });
      const { project, store, assigned } = assignedProject([first, second]);
      const runner = createVerificationHookRunner({ config: project.config, store });

      runner.onDelivered(assigned);
      await until(() => {
        const records = store.get('HOOK-1')?.assignee?.hooks || [];
        return records.at(-1)?.commandRef === 'fails-second' && records.at(-1)?.state === 'failed' ? records : null;
      });

      const records = store.get('HOOK-1').assignee.hooks;
      assert.equal(records.length, 6, 'no worst-last duplicate is appended when the tail already shows it');
      assert.equal(records.at(-1).state, 'failed');
    });

    it('all pass: the last element stays passed with no duplicate appended', async () => {
      const first = hook({ id: 'passes-a', command: ['node', '-e', 'process.exit(0)'] });
      const second = hook({ id: 'passes-b', command: ['node', '-e', 'process.exit(0)'] });
      const { project, store, assigned } = assignedProject([first, second]);
      const runner = createVerificationHookRunner({ config: project.config, store });

      runner.onDelivered(assigned);
      await until(() => {
        const records = store.get('HOOK-1')?.assignee?.hooks || [];
        return records.filter((r) => r.state === 'passed').length === 2 ? records : null;
      });

      const records = store.get('HOOK-1').assignee.hooks;
      assert.equal(records.length, 6);
      assert.equal(records.at(-1).state, 'passed');
    });

    it('a restart between hooks does not re-run the already-finished one, and still fixes the tail', async () => {
      const first = hook({ id: 'already-failed', command: ['node', '-e', 'process.exit(1)'] });
      const second = hook({ id: 'still-to-run', command: ['node', '-e', 'process.exit(0)'] });
      const { project, store, assigned } = assignedProject([first, second]);
      const logPathFirst = hookLogRelativePath(project.config, assigned.id, assigned.assignee.attemptId, first.id);
      // Simulate a previous board instance that already finished `already-failed` before it restarted.
      store.recordHook('HOOK-1', assigned.assignee, {
        state: 'failed', commandRef: first.id, startedAt: new Date(Date.now() - 5000).toISOString(),
        endedAt: new Date(Date.now() - 4000).toISOString(), exitCode: 1, logPath: logPathFirst, logDigest: null,
        attemptId: assigned.assignee.attemptId,
      });

      const runner = createVerificationHookRunner({ config: project.config, store });
      runner.onDelivered(store.get('HOOK-1'));
      await until(() => {
        const records = store.get('HOOK-1')?.assignee?.hooks || [];
        return records.some((r) => r.commandRef === 'still-to-run' && r.state === 'passed') ? records : null;
      });

      const records = store.get('HOOK-1').assignee.hooks;
      const alreadyFailedRecords = records.filter((r) => r.commandRef === 'already-failed');
      assert.equal(alreadyFailedRecords.length, 2, 'the seeded terminal record plus one worst-last duplicate, never a re-run');
      assert.equal(alreadyFailedRecords.filter((r) => r.state === 'queued' || r.state === 'running').length, 0);
      assert.equal(records.at(-1).commandRef, 'already-failed');
      assert.equal(records.at(-1).state, 'failed');
    });
  });

  describe('F1: stale records from a previous board instance', () => {
    it('finalizes a stale queued record at startup as unknown', () => {
      const configured = hook({ id: 'smoke' });
      const { project, store, assigned } = assignedProject([configured]);
      const logPath = hookLogRelativePath(project.config, assigned.id, assigned.assignee.attemptId, configured.id);
      store.recordHook('HOOK-1', assigned.assignee, {
        state: 'queued', commandRef: configured.id, startedAt: null, endedAt: null,
        exitCode: null, logPath, logDigest: null, attemptId: assigned.assignee.attemptId,
      });

      createVerificationHookRunner({ config: project.config, store });
      const records = store.get('HOOK-1').assignee.hooks;
      assert.equal(records.length, 2);
      assert.equal(records.at(-1).state, 'unknown');
    });

    it('finalizes a young running record owned by a previous instance immediately, with a Chinese note', () => {
      const configured = hook({ id: 'smoke', timeoutSeconds: 30 });
      const { project, store, assigned } = assignedProject([configured]);
      const logPath = hookLogRelativePath(project.config, assigned.id, assigned.assignee.attemptId, configured.id);
      const runsFile = path.join(project.config.paths.data, 'hooks', 'runs.jsonl');
      const key = hookRunKey(assigned.assignee.attemptId, project.config.verification.hooks[0]);
      appendJsonLine(runsFile, {
        at: new Date().toISOString(), key, state: 'running', instanceId: 'previous-instance',
        quest: 'HOOK-1', attemptId: assigned.assignee.attemptId, hookId: configured.id,
      });
      store.recordHook('HOOK-1', assigned.assignee, {
        state: 'running', commandRef: configured.id, startedAt: new Date().toISOString(), endedAt: null,
        exitCode: null, logPath, logDigest: null, attemptId: assigned.assignee.attemptId,
      });

      createVerificationHookRunner({ config: project.config, store, instanceId: 'new-instance' });
      const records = store.get('HOOK-1').assignee.hooks;
      assert.equal(records.at(-1).state, 'unknown');
      const log = readHookLog(project.config, records.at(-1).logPath);
      assert.ok(log);
      assert.match(log.body.toString('utf8'), /看板重启，无法确认这次钩子的结果/);
    });

    it('re-checks a young running record from the same board instance only after its timeout elapses', async () => {
      const configured = hook({ id: 'smoke', timeoutSeconds: 1 });
      const { project, store, assigned } = assignedProject([configured]);
      const logPath = hookLogRelativePath(project.config, assigned.id, assigned.assignee.attemptId, configured.id);
      const runsFile = path.join(project.config.paths.data, 'hooks', 'runs.jsonl');
      const key = hookRunKey(assigned.assignee.attemptId, project.config.verification.hooks[0]);
      const startedAt = new Date().toISOString();
      appendJsonLine(runsFile, {
        at: startedAt, key, state: 'running', instanceId: 'same-instance',
        quest: 'HOOK-1', attemptId: assigned.assignee.attemptId, hookId: configured.id,
      });
      store.recordHook('HOOK-1', assigned.assignee, {
        state: 'running', commandRef: configured.id, startedAt, endedAt: null,
        exitCode: null, logPath, logDigest: null, attemptId: assigned.assignee.attemptId,
      });

      createVerificationHookRunner({ config: project.config, store, instanceId: 'same-instance' });
      assert.equal(store.get('HOOK-1').assignee.hooks.at(-1).state, 'running', 'not finalized immediately');
      await until(() => store.get('HOOK-1').assignee.hooks.at(-1)?.state === 'unknown', 3000);
    });
  });
});
