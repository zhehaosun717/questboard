import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../helpers.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WRAPPER_SRC = path.join(REPO_ROOT, 'examples', 'basic', 'scripts', 'run-worker.mjs');
const CONFIG_SRC = path.join(REPO_ROOT, 'examples', 'basic', 'questboard.config.json');

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
});
