import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../helpers.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WRAPPER_SRC = path.join(REPO_ROOT, 'examples', 'basic', 'scripts', 'run-worker.mjs');
const CONFIG_SRC = path.join(REPO_ROOT, 'examples', 'basic', 'questboard.config.json');
const runFile = promisify(execFile);

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for wrapper heartbeat');
}

describe('example-wrapper', () => {
  it('runs worker, logs dispatch, pipes brief, streams output, and records exit code', () => {
    const root = tmpDir('example-wrapper-');
    fs.copyFileSync(CONFIG_SRC, path.join(root, 'questboard.config.json'));
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.copyFileSync(WRAPPER_SRC, path.join(root, 'scripts', 'run-worker.mjs'));

    const briefRel = path.join('docs', 'briefs', 'RUN-1-test.md');
    const briefAbs = path.join(root, briefRel);
    fs.mkdirSync(path.dirname(briefAbs), { recursive: true });
    fs.writeFileSync(briefAbs, 'Please implement feature X\n');

    const agentScript = "process.stdin.resume(); process.stdin.on('end', () => { console.log('hello'); process.exit(3) })";
    const wrapper = path.join(root, 'scripts', 'run-worker.mjs');

    // First run: worker exits 3, wrapper exits 0
    execFileSync(process.execPath, [
      wrapper,
      '--lane', 'codex',
      '--name', 'run1_task',
      '--brief', briefRel,
      '--model', 'gpt-5.6-luna',
      '--variant', 'high',
      '--package', 'RUN-1',
      '--',
      process.execPath,
      '-e',
      agentScript,
    ], { cwd: root, encoding: 'utf8' });

    // Assert registry has one dispatch row with the name
    const registryPath = path.join(root, '.questboard-data', 'registry.jsonl');
    assert.ok(fs.existsSync(registryPath));
    const lines = fs.readFileSync(registryPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const row = JSON.parse(lines[0]);
    assert.equal(row.event, 'dispatch');
    assert.equal(row.name, 'run1_task');
    assert.equal(row.lane, 'codex');
    assert.equal(row.package, 'RUN-1');

    // Assert <outputDir>/<name>.out contains 'hello'
    const outPath = path.join(root, '.questboard-data', 'workers', 'codex', 'run1_task.out');
    assert.ok(fs.existsSync(outPath));
    const outContent = fs.readFileSync(outPath, 'utf8');
    assert.match(outContent, /hello/);

    // Assert <name>.exit contains '3'
    const exitPath = path.join(root, '.questboard-data', 'workers', 'codex', 'run1_task.exit');
    assert.ok(fs.existsSync(exitPath));
    assert.equal(fs.readFileSync(exitPath, 'utf8').trim(), '3');

    // Second run with a missing brief exits non-zero with a one-line stderr
    assert.throws(() => {
      execFileSync(process.execPath, [
        wrapper,
        '--lane', 'codex',
        '--name', 'run2_task',
        '--brief', 'docs/briefs/missing.md',
        '--model', 'gpt-5.6-luna',
        '--variant', 'high',
        '--package', 'RUN-2',
        '--',
        process.execPath,
        '-e',
        'process.exit(0)',
      ], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    }, (err) => {
      assert.notEqual(err.status, 0);
      const stderrLines = err.stderr.trim().split('\n');
      assert.equal(stderrLines.length, 1);
      assert.match(stderrLines[0], /brief/i);
      return true;
    });
  });

  it('copies report file to <outputDir>/<name>.md if --report is provided and file exists', () => {
    const root = tmpDir('example-wrapper-report-');
    fs.copyFileSync(CONFIG_SRC, path.join(root, 'questboard.config.json'));
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.copyFileSync(WRAPPER_SRC, path.join(root, 'scripts', 'run-worker.mjs'));

    const briefRel = 'brief.md';
    fs.writeFileSync(path.join(root, briefRel), 'Task');
    const reportRel = 'my-report.md';

    const wrapper = path.join(root, 'scripts', 'run-worker.mjs');
    execFileSync(process.execPath, [
      wrapper,
      '--lane', 'codex',
      '--name', 'report_worker',
      '--brief', briefRel,
      '--package', 'RUN-3',
      '--report', reportRel,
      '--',
      process.execPath,
      '-e',
      "import('node:fs').then((fs) => fs.writeFileSync('my-report.md', '# Summary report'));",
    ], { cwd: root, encoding: 'utf8' });

    const mdPath = path.join(root, '.questboard-data', 'workers', 'codex', 'report_worker.md');
    assert.ok(fs.existsSync(mdPath));
    assert.equal(fs.readFileSync(mdPath, 'utf8'), '# Summary report');
  });

  it('writes a token-matching heartbeat periodically and removes it after exit', async () => {
    const root = tmpDir('example-wrapper-heartbeat-');
    fs.copyFileSync(CONFIG_SRC, path.join(root, 'questboard.config.json'));
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.copyFileSync(WRAPPER_SRC, path.join(root, 'scripts', 'run-worker.mjs'));
    fs.writeFileSync(path.join(root, 'brief.md'), 'heartbeat test');

    const wrapper = path.join(root, 'scripts', 'run-worker.mjs');
    const outputDir = path.join(root, '.questboard-data', 'workers', 'codex');
    const alivePath = path.join(outputDir, 'heartbeat_worker.alive');
    const execution = runFile(process.execPath, [
      wrapper, '--lane', 'codex', '--name', 'heartbeat_worker', '--brief', 'brief.md', '--package', 'HB-1',
      '--heartbeat-seconds', '5', '--', process.execPath, '-e', 'setTimeout(() => process.exit(0), 6500)',
    ], { cwd: root, encoding: 'utf8' });

    await waitFor(() => fs.existsSync(alivePath));
    const firstStat = fs.statSync(alivePath);
    const first = JSON.parse(fs.readFileSync(alivePath, 'utf8'));
    assert.equal(first.intervalSeconds, 5);
    assert.equal(first.phase, 'running');
    await waitFor(() => fs.statSync(alivePath).mtimeMs > firstStat.mtimeMs, 6000);
    const second = JSON.parse(fs.readFileSync(alivePath, 'utf8'));
    assert.equal(second.token, first.token);
    assert.notEqual(second.at, first.at);

    const result = await execution;
    assert.equal(result.stderr, '');
    assert.equal(fs.existsSync(alivePath), false);
    assert.equal(fs.readFileSync(path.join(outputDir, 'heartbeat_worker.exit'), 'utf8').trim(), '0');
    const registry = JSON.parse(fs.readFileSync(path.join(root, '.questboard-data', 'registry.jsonl'), 'utf8').trim());
    assert.equal(registry.token, first.token);
  });

  it('prepends --role card text to the agent stdin prompt', () => {
    const root = tmpDir('example-wrapper-role-');
    fs.copyFileSync(CONFIG_SRC, path.join(root, 'questboard.config.json'));
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.copyFileSync(WRAPPER_SRC, path.join(root, 'scripts', 'run-worker.mjs'));
    fs.writeFileSync(path.join(root, 'brief.md'), 'BRIEF BODY');
    fs.writeFileSync(path.join(root, 'role.md'), 'ROLE CARD');
    const wrapper = path.join(root, 'scripts', 'run-worker.mjs');
    execFileSync(process.execPath, [
      wrapper, '--lane', 'codex', '--name', 'role_worker', '--brief', 'brief.md', '--role', 'role.md', '--',
      process.execPath, '-e', "process.stdin.setEncoding('utf8'); let text=''; process.stdin.on('data', (chunk) => text += chunk); process.stdin.on('end', () => console.log(text));",
    ], { cwd: root, encoding: 'utf8' });
    const outPath = path.join(root, '.questboard-data', 'workers', 'codex', 'role_worker.out');
    const output = fs.readFileSync(outPath, 'utf8');
    assert.match(output, /ROLE CARD\n\nBRIEF BODY/);
  });

  it('QB_FIX_HINT appends the board self-check feedback to the agent prompt over stdin (FB2-05)', () => {
    const root = tmpDir('example-wrapper-hint-');
    fs.copyFileSync(CONFIG_SRC, path.join(root, 'questboard.config.json'));
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.copyFileSync(WRAPPER_SRC, path.join(root, 'scripts', 'run-worker.mjs'));
    fs.writeFileSync(path.join(root, 'brief.md'), 'BRIEF BODY');
    const wrapper = path.join(root, 'scripts', 'run-worker.mjs');
    execFileSync(process.execPath, [
      wrapper, '--lane', 'codex', '--name', 'hint_worker', '--brief', 'brief.md', '--',
      process.execPath, '-e', "process.stdin.setEncoding('utf8'); let text=''; process.stdin.on('data', (chunk) => text += chunk); process.stdin.on('end', () => console.log(text));",
    ], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, QB_FIX_HINT: '自检失败（第 1 轮），错误如下：FAIL src/x.test.js broke' },
    });
    const outPath = path.join(root, '.questboard-data', 'workers', 'codex', 'hint_worker.out');
    const output = fs.readFileSync(outPath, 'utf8');
    assert.match(output, /【看板自检反馈】上一轮交付没有通过自检/);
    assert.match(output, /FAIL src\/x\.test\.js broke/);
    assert.match(output, /BRIEF BODY/);
  });

  it('cancel IPC stops the direct child and its still-alive grandchild on Windows', async () => {
    if (process.platform !== 'win32') return;
    const { fork } = await import('node:child_process');
    const root = tmpDir('example-wrapper-tree-');
    fs.copyFileSync(CONFIG_SRC, path.join(root, 'questboard.config.json'));
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.copyFileSync(WRAPPER_SRC, path.join(root, 'scripts', 'run-worker.mjs'));
    fs.writeFileSync(path.join(root, 'brief.md'), 'BRIEF');
    const heartbeat = path.join(root, 'grandchild-heartbeat.txt');
    const agent = path.join(root, 'agent.cjs');
    const agentBody = [
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      "const hb = process.argv[2];",
      "const grand = spawn(process.execPath, ['-e', \"setInterval(() => require('node:fs').writeFileSync(process.argv[1], String(Date.now())), 100)\", hb], { stdio: 'ignore' });",
      "grand.unref();",
      "setInterval(() => {}, 1000);",
    ].join('\n');
    fs.writeFileSync(agent, agentBody);
    const wrapper = path.join(root, 'scripts', 'run-worker.mjs');
    const child = fork(wrapper, [
      '--lane', 'codex', '--name', 'tree_worker', '--brief', 'brief.md', '--package', 'RUN-TREE', '--',
      process.execPath, agent, heartbeat,
    ], {
      cwd: root,
      env: { ...process.env, QUESTBOARD_ATTEMPT_ID: 'att-tree', QUESTBOARD_CONTROL_TOKEN: 'tok-tree' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    try {
      await waitFor(() => fs.existsSync(heartbeat), 5000);
      const ack = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no cancel ack')), 5000);
        child.on('message', (message) => {
          if (message && message.type === 'questboard-cancel-ack' && message.scope === 'direct-child') {
            clearTimeout(timer);
            resolve(message);
          }
        });
      });
      child.send({ type: 'questboard-cancel', attemptId: 'att-tree', requestId: 'req-tree', token: 'tok-tree' });
      await ack;
      const last = fs.readFileSync(heartbeat, 'utf8');
      await waitFor(() => {
        if (!fs.existsSync(heartbeat)) return true;
        return fs.readFileSync(heartbeat, 'utf8') === last;
      }, 5000);
    } finally {
      try { child.kill(); } catch {}
    }
  });
});
