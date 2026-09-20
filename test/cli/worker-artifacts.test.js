import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../helpers.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WRAPPER_SRC = path.join(REPO_ROOT, 'examples', 'basic', 'scripts', 'run-worker.mjs');
const CONFIG_SRC = path.join(REPO_ROOT, 'examples', 'basic', 'questboard.config.json');

function setup(prefix) {
  const root = tmpDir(prefix);
  fs.copyFileSync(CONFIG_SRC, path.join(root, 'questboard.config.json'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(WRAPPER_SRC, path.join(root, 'scripts', 'run-worker.mjs'));
  fs.writeFileSync(path.join(root, 'brief.md'), 'Do the thing');
  return root;
}

const workerDir = (root) => path.join(root, '.questboard-data', 'workers', 'codex');
const readExit = (root, name) => fs.readFileSync(path.join(workerDir(root), `${name}.exit`), 'utf8');
function registryRows(root) {
  const registryPath = path.join(root, '.questboard-data', 'registry.jsonl');
  if (!fs.existsSync(registryPath)) return [];
  return fs.readFileSync(registryPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function runWrapper(root, name, extra, agentCmd) {
  return execFileSync(process.execPath, [
    path.join(root, 'scripts', 'run-worker.mjs'),
    '--lane', 'codex',
    '--name', name,
    '--brief', 'brief.md',
    '--package', 'ART-1',
    ...extra,
    '--',
    ...agentCmd,
  ], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
}

function runWrapperExpectingFailure(root, name, extra, agentCmd) {
  try {
    runWrapper(root, name, extra, agentCmd);
    assert.fail('the wrapper exited successfully but should not have');
  } catch (err) {
    if (err instanceof assert.AssertionError) throw err;
    return err;
  }
}

function spawnWrapper(root, name, extra, agentCmd) {
  return spawn(process.execPath, [
    path.join(root, 'scripts', 'run-worker.mjs'),
    '--lane', 'codex',
    '--name', name,
    '--brief', 'brief.md',
    '--package', 'ART-1',
    ...extra,
    '--',
    ...agentCmd,
  ], { cwd: root });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(check, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(intervalMs);
  }
  throw new Error('condition not met before timeout');
}

// Waits for at least `count` registry rows for `name`. The wrapper appends this row only after it has
// finished archiving any of that name's stale terminal artifacts (see run-worker.mjs step 6 then 7), so
// this is a real post-archive barrier -- unlike waiting for the lock file, which exists before archiving
// even starts and was the source of this suite's flakiness (see the revision report's D2).
async function waitForRegistryRows(root, name, count, opts) {
  await waitUntil(() => registryRows(root).filter((row) => row.name === name).length >= count, opts);
}

async function waitForOutMatch(root, name, pattern) {
  const outPath = path.join(workerDir(root), `${name}.out`);
  await waitUntil(() => fs.existsSync(outPath) && pattern.test(fs.readFileSync(outPath, 'utf8')));
}

const waitForClose = (child) => new Promise((resolve) => child.on('close', resolve));

// A minimal .cmd shim, shaped like a real npm-installed one (`@echo off` then re-forward `%*`), so argv
// tests exercise the same double cmd.exe parse (once for the wrapper's own /d /s /c line, once for the
// shim's own %* re-issue) that a real npm shim would. It writes the exact argv it received to a JSON file
// so the test can assert on it, and never runs any of the argument text as a command itself.
function makeCmdShim(root) {
  const dumpPath = path.join(root, 'dump.mjs');
  fs.writeFileSync(
    dumpPath,
    "import fs from 'node:fs';\nfs.writeFileSync('dump-out.json', JSON.stringify(process.argv.slice(2)));\n",
  );
  const shimPath = path.join(root, 'shim.cmd');
  fs.writeFileSync(shimPath, `@echo off\r\n"${process.execPath}" "${dumpPath}" %*\r\n`);
  return shimPath;
}

describe('worker-artifacts', () => {
  it('copies the report before publishing the exit, keeps the original intact, and leaves no temp files', () => {
    const root = setup('worker-artifacts-ok-');
    runWrapper(root, 'ok_report', ['--report', 'report-src.md'], [
      process.execPath, '-e', "import('node:fs').then((fs) => fs.writeFileSync('report-src.md', '报告 done'));",
    ]);
    const dir = workerDir(root);
    assert.equal(fs.readFileSync(path.join(dir, 'ok_report.md'), 'utf8'), '报告 done');
    assert.match(readExit(root, 'ok_report'), /^0\n$/);
    assert.equal(fs.readFileSync(path.join(root, 'report-src.md'), 'utf8'), '报告 done');
    assert.deepEqual(fs.readdirSync(dir).filter((file) => file.includes('.tmp')), []);
  });

  it('keeps a non-zero child exit code accurate even when a report was copied', () => {
    const root = setup('worker-artifacts-nonzero-');
    runWrapper(root, 'bad_child', ['--report', 'report-src.md'], [
      process.execPath, '-e', "import('node:fs').then((fs) => { fs.writeFileSync('report-src.md', '# partial'); process.exit(4); });",
    ]);
    assert.equal(readExit(root, 'bad_child').trim(), '4');
    assert.ok(fs.existsSync(path.join(workerDir(root), 'bad_child.md')));
  });

  it('publishes exit 127 as terminal evidence when the executable is missing', () => {
    const root = setup('worker-artifacts-missing-');
    const err = runWrapperExpectingFailure(root, 'ghost', [], [path.join(root, 'no-such-worker.exe')]);
    assert.notEqual(err.status, 0);
    assert.equal(readExit(root, 'ghost').trim(), '127');
    assert.match(fs.readFileSync(path.join(workerDir(root), 'ghost.out'), 'utf8'), /ENOENT/);
    assert.equal(fs.existsSync(path.join(workerDir(root), 'ghost.md')), false);
    assert.ok(registryRows(root).some((row) => row.event === 'dispatch' && row.name === 'ghost'));
  });

  it('publishes a conservative failure when the report exists but cannot be copied', () => {
    const root = setup('worker-artifacts-copyfail-');
    fs.mkdirSync(path.join(root, 'blocked-report'), { recursive: true });
    const err = runWrapperExpectingFailure(root, 'blocked', ['--report', 'blocked-report'], [
      process.execPath, '-e', 'process.exit(0)',
    ]);
    assert.notEqual(err.status, 0);
    assert.equal(readExit(root, 'blocked').trim(), '1');
    assert.equal(fs.existsSync(path.join(workerDir(root), 'blocked.md')), false);
    assert.match(fs.readFileSync(path.join(workerDir(root), 'blocked.out'), 'utf8'), /failed to copy report/);
  });

  it('treats a report path that the worker never wrote as an optional success', () => {
    const root = setup('worker-artifacts-noreport-');
    runWrapper(root, 'quiet', ['--report', 'never-written.md'], [
      process.execPath, '-e', "console.log('x'.repeat(300)); process.exit(0);",
    ]);
    assert.equal(readExit(root, 'quiet').trim(), '0');
    assert.equal(fs.existsSync(path.join(workerDir(root), 'quiet.md')), false);
  });

  it('retires a repeated name\'s stale exit code and report into a recoverable archive instead of reusing them', () => {
    const root = setup('worker-artifacts-repeat-');
    const dir = workerDir(root);
    runWrapper(root, 'rep', ['--report', 'report-src.md'], [
      process.execPath, '-e', "import('node:fs').then((fs) => fs.writeFileSync('report-src.md', 'FIRST RUN REPORT'));",
    ]);
    assert.equal(fs.readFileSync(path.join(dir, 'rep.md'), 'utf8'), 'FIRST RUN REPORT');
    assert.equal(readExit(root, 'rep').trim(), '0');

    // A repeated name, no report this time, and a different exit code.
    runWrapper(root, 'rep', [], [process.execPath, '-e', 'process.exit(3)']);

    assert.equal(readExit(root, 'rep').trim(), '3');
    assert.equal(
      fs.existsSync(path.join(dir, 'rep.md')),
      false,
      "a repeated run with no report must not leave the previous run's report looking current",
    );

    const archived = fs.readdirSync(path.join(dir, '.archive'));
    const archivedReport = archived.find((file) => file.startsWith('rep.md.'));
    const archivedExit = archived.find((file) => file.startsWith('rep.exit.'));
    assert.ok(archivedReport, "the first run's report must be recoverable, not deleted");
    assert.ok(archivedExit, "the first run's exit code must be recoverable, not deleted");
    assert.equal(fs.readFileSync(path.join(dir, '.archive', archivedReport), 'utf8'), 'FIRST RUN REPORT');
    assert.equal(fs.readFileSync(path.join(dir, '.archive', archivedExit), 'utf8').trim(), '0');
  });

  it('does not recopy an unrefreshed report source for a repeated name (fake child that never rewrites it)', () => {
    const root = setup('worker-artifacts-stale-source-');
    const dir = workerDir(root);
    runWrapper(root, 'again', ['--report', 'report-src.md'], [
      process.execPath, '-e', "import('node:fs').then((fs) => fs.writeFileSync('report-src.md', 'FIRST RUN REPORT'));",
    ]);
    assert.equal(fs.readFileSync(path.join(dir, 'again.md'), 'utf8'), 'FIRST RUN REPORT');

    // Repeated name, same --report path, but this run's child is a no-op: it never rewrites report-src.md.
    runWrapper(root, 'again', ['--report', 'report-src.md'], [process.execPath, '-e', 'process.exit(0)']);

    assert.equal(
      fs.existsSync(path.join(dir, 'again.md')),
      false,
      "the unrefreshed report source must not be recopied as this run's own fresh delivery",
    );
    assert.equal(readExit(root, 'again').trim(), '0');
    assert.equal(
      fs.readFileSync(path.join(root, 'report-src.md'), 'utf8'),
      'FIRST RUN REPORT',
      'the wrapper must never modify the report source itself',
    );
    const archived = fs.readdirSync(path.join(dir, '.archive'));
    assert.ok(
      archived.some((f) => f.startsWith('again.md.')),
      "the first run's own delivered report must still be retired into .archive",
    );
  });

  it('still copies a genuinely refreshed report for a repeated name reusing the same --report path', () => {
    const root = setup('worker-artifacts-fresh-source-');
    const dir = workerDir(root);
    runWrapper(root, 'refresh', ['--report', 'report-src.md'], [
      process.execPath, '-e', "import('node:fs').then((fs) => fs.writeFileSync('report-src.md', 'FIRST'));",
    ]);
    assert.equal(fs.readFileSync(path.join(dir, 'refresh.md'), 'utf8'), 'FIRST');

    runWrapper(root, 'refresh', ['--report', 'report-src.md'], [
      process.execPath, '-e', "import('node:fs').then((fs) => fs.writeFileSync('report-src.md', 'SECOND RUN'));",
    ]);
    assert.equal(fs.readFileSync(path.join(dir, 'refresh.md'), 'utf8'), 'SECOND RUN');
  });

  it('clears a repeated name\'s stale .exit before the new child ever starts, not just after it finishes', async () => {
    const root = setup('worker-artifacts-repeat-live-');
    const dir = workerDir(root);
    runWrapper(root, 'slow', [], [process.execPath, '-e', 'process.exit(1)']);
    assert.equal(readExit(root, 'slow').trim(), '1');

    const child = spawnWrapper(root, 'slow', [], [process.execPath, '-e', 'setTimeout(() => process.exit(0), 800)']);
    try {
      // Wait for the second dispatch row, which is only appended after archiving finishes -- a real barrier,
      // unlike waiting for the lock file (which exists before archiving even starts).
      await waitForRegistryRows(root, 'slow', 2);
      // While the repeated run is still in flight, the previous run's .exit must not exist: a reader
      // (the board) must never mistake it for this run's terminal marker.
      assert.equal(fs.existsSync(path.join(dir, 'slow.exit')), false);
    } finally {
      await waitForClose(child);
    }
    assert.equal(readExit(root, 'slow').trim(), '0');
  });

  it('rejects a concurrent run under the same name without disturbing the first run\'s registry row or output', async () => {
    const root = setup('worker-artifacts-collision-');
    const dir = workerDir(root);

    const first = spawnWrapper(root, 'busy', [], [process.execPath, '-e', "console.log('first'); setTimeout(() => process.exit(0), 800)"]);
    try {
      await waitForRegistryRows(root, 'busy', 1);
      // Confirm the first run is genuinely active -- has produced real output bytes -- before the second,
      // rejected invocation starts, not just that its lock/registry row exist.
      await waitForOutMatch(root, 'busy', /first/);

      const err = runWrapperExpectingFailure(root, 'busy', [], [process.execPath, '-e', 'process.exit(0)']);
      assert.match(err.stderr, /already locked/);

      // The rejected concurrent attempt must not have appended a second registry row for the same name,
      // nor published any exit file that could be mistaken for the first run's outcome, nor disturbed the
      // first run's still-active output.
      assert.equal(registryRows(root).filter((row) => row.name === 'busy').length, 1);
      assert.equal(fs.existsSync(path.join(dir, 'busy.exit')), false);
      assert.match(fs.readFileSync(path.join(dir, 'busy.out'), 'utf8'), /first/);
    } finally {
      await waitForClose(first);
    }

    assert.equal(readExit(root, 'busy').trim(), '0');
    assert.match(fs.readFileSync(path.join(dir, 'busy.out'), 'utf8'), /first/);
    assert.equal(fs.existsSync(path.join(dir, 'busy.lock')), false, 'the lock must be released once the run finishes');
  });

  it('keeps a new owner\'s lock and live artifacts safe when a stale run\'s lock was removed by hand and it finishes later', async () => {
    const root = setup('worker-artifacts-lock-theft-');
    const dir = workerDir(root);

    // Run A takes the lock and starts a short sleep.
    const runA = spawnWrapper(root, 'dup', [], [process.execPath, '-e', "console.log('A-OUT'); setTimeout(() => process.exit(0), 500)"]);
    const runAClosed = waitForClose(runA);
    let runB = null;
    let runBClosed = null;
    // If any wait/assertion below throws (e.g. under load, a waitFor* timeout), runA/runB must still be
    // reaped here so a failing case never leaves a spawned child dangling into the next test or the file's
    // own shutdown -- that dangling child is what previously cancelled the whole suite mid-run.
    try {
      await waitForRegistryRows(root, 'dup', 1);
      await waitForOutMatch(root, 'dup', /A-OUT/);

      // Operator mistake the README warns against: A's lock is removed by hand while A is still running.
      fs.unlinkSync(path.join(dir, 'dup.lock'));

      // Run B starts under the same name, takes a fresh lock (a different token), and archives A's still-live
      // .out. B sleeps much longer than A, so A finishes first while B is still the active owner.
      runB = spawnWrapper(root, 'dup', [], [process.execPath, '-e', "console.log('B-OUT'); setTimeout(() => process.exit(0), 2500)"]);
      runBClosed = waitForClose(runB);
      await waitForRegistryRows(root, 'dup', 2);
      await waitForOutMatch(root, 'dup', /B-OUT/);
      const bLockToken = JSON.parse(fs.readFileSync(path.join(dir, 'dup.lock'), 'utf8')).token;

      await runAClosed;
      // A has now finished while B is still the active owner. A must not have deleted B's lock, and must not
      // have published its own (now-stale) result over the live dup.exit/dup.out that B still owns.
      assert.equal(fs.existsSync(path.join(dir, 'dup.lock')), true, "A's completion must not delete B's live lock");
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(dir, 'dup.lock'), 'utf8')).token,
        bLockToken,
        "the lock present after A exits must still be B's",
      );
      assert.equal(
        fs.existsSync(path.join(dir, 'dup.exit')),
        false,
        'B has not finished yet; A must not have published an exit code in its place',
      );

      // A's own result must be preserved somewhere recoverable, not silently discarded.
      const archivedAfterA = fs.readdirSync(path.join(dir, '.archive'));
      assert.ok(
        archivedAfterA.some((f) => f.startsWith('dup.exit.orphaned.')),
        "A's result must be preserved as orphaned evidence once it loses ownership, not discarded",
      );

      await runBClosed;
      // B's own, legitimate result is what ends up live.
      assert.equal(readExit(root, 'dup').trim(), '0');
      assert.match(fs.readFileSync(path.join(dir, 'dup.out'), 'utf8'), /B-OUT/);
      assert.equal(fs.existsSync(path.join(dir, 'dup.lock')), false, "B's own lock is released once B finishes normally");
    } finally {
      runA.kill();
      await runAClosed;
      if (runB) {
        runB.kill();
        await runBClosed;
      }
    }
  });

  it("keeps a stale owner's report from ever landing on the new owner's live path (B2)", async () => {
    const root = setup('worker-artifacts-lock-theft-report-');
    const dir = workerDir(root);

    // Run A takes the lock, has --report, and its child writes the report then sleeps briefly -- long enough
    // for B to take over the name before A's own close handler (and its ownership check) runs.
    const runA = spawnWrapper(root, 'dupreport', ['--report', 'report-src.md'], [
      process.execPath, '-e',
      "import('node:fs').then((fs) => fs.writeFileSync('report-src.md', 'A REPORT'));" +
      "console.log('A-OUT'); setTimeout(() => process.exit(0), 700);",
    ]);
    const runAClosed = waitForClose(runA);
    let runB = null;
    let runBClosed = null;
    // Same reasoning as the sibling lock-theft test above: guarantee both children are reaped even if a
    // wait/assertion throws partway, so a failing case can never leave a spawned child dangling.
    try {
      await waitForRegistryRows(root, 'dupreport', 1);
      await waitForOutMatch(root, 'dupreport', /A-OUT/);

      // Operator mistake the README warns against: A's lock is removed by hand while A is still running.
      fs.unlinkSync(path.join(dir, 'dupreport.lock'));

      // Run B starts under the same name with no --report of its own, takes a fresh lock, and sleeps much
      // longer than A, so A finishes (and tries to publish its report) first while B is still the active owner.
      runB = spawnWrapper(root, 'dupreport', [], [
        process.execPath, '-e', "console.log('B-OUT'); setTimeout(() => process.exit(0), 2500)",
      ]);
      runBClosed = waitForClose(runB);
      await waitForRegistryRows(root, 'dupreport', 2);
      await waitForOutMatch(root, 'dupreport', /B-OUT/);

      await runAClosed;
      // A staged its report, then found it no longer owns the lock. B never passed --report, so if A's stale
      // ownership check were skipped (B2), A's report would appear at the live path anyway -- it must not.
      assert.equal(
        fs.existsSync(path.join(dir, 'dupreport.md')),
        false,
        "A's stale report must never appear at the live path once B owns the name, during or after B",
      );
      const archivedAfterA = fs.readdirSync(path.join(dir, '.archive'));
      assert.ok(
        archivedAfterA.some((f) => f.startsWith('dupreport.md.orphaned.')),
        "A's report must be preserved as orphaned evidence once it loses ownership, not discarded and not published live",
      );

      await runBClosed;
      // B's own result is what ends up live: exit 0, and still no report, never A's.
      assert.equal(readExit(root, 'dupreport').trim(), '0');
      assert.equal(
        fs.existsSync(path.join(dir, 'dupreport.md')),
        false,
        "B never requested a report; A's must still not have leaked onto the live path after B exits either",
      );
    } finally {
      runA.kill();
      await runAClosed;
      if (runB) {
        runB.kill();
        await runBClosed;
      }
    }
  });

  it("archives the live report itself when --report points at this run's own live <name>.md (M1)", () => {
    const root = setup('worker-artifacts-report-is-live-');
    const dir = workerDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const liveMdPath = path.join(dir, 'selfreport.md');
    fs.writeFileSync(liveMdPath, 'OLD SELF REPORT');

    // --report points directly at this run's own live <name>.md path; the worker never touches it.
    runWrapper(root, 'selfreport', ['--report', path.relative(root, liveMdPath)], [
      process.execPath, '-e', 'process.exit(0)',
    ]);

    assert.equal(readExit(root, 'selfreport').trim(), '0');
    assert.equal(
      fs.existsSync(liveMdPath),
      false,
      'the previous live report was retired like any other stale artifact for this name, not left as if current',
    );
    const archived = fs.readdirSync(path.join(dir, '.archive'));
    const archivedReport = archived.find((file) => file.startsWith('selfreport.md.'));
    assert.ok(archivedReport, 'the old report bytes must be recoverable in .archive, not silently lost');
    assert.equal(fs.readFileSync(path.join(dir, '.archive', archivedReport), 'utf8'), 'OLD SELF REPORT');
  });

  it('quotes cmd.exe metacharacters into literal argv for a .cmd shim instead of letting them run as shell operators', () => {
    const root = setup('worker-artifacts-cmdquote-');
    const shim = makeCmdShim(root);
    // No double quote or control character here -- those are refused before spawn (see the "%"-style
    // refusal tests below), not passed through, so they are not "ordinary metacharacters" for this test.
    const payloads = [
      'plain',
      'two words',
      'trail\\',
      'a&b',
      'a|b',
      '(parens)',
      'a<redirect>b',
      'ca^ret',
      'ba!ng',
      'x & type nul > SENTINEL_MUST_NOT_EXIST.txt',
    ];
    runWrapper(root, 'quoting', [], [shim, ...payloads]);

    assert.equal(
      fs.existsSync(path.join(root, 'SENTINEL_MUST_NOT_EXIST.txt')),
      false,
      'a metacharacter in an argument must never be interpreted as a shell operator',
    );
    const received = JSON.parse(fs.readFileSync(path.join(root, 'dump-out.json'), 'utf8'));
    assert.deepEqual(received, payloads);
  });

  it('refuses an argument containing "%" to a .cmd shim rather than risk cmd.exe expanding it', () => {
    const root = setup('worker-artifacts-percent-');
    const dir = workerDir(root);
    const shim = makeCmdShim(root);
    const err = runWrapperExpectingFailure(root, 'pctarg', [], [shim, '100%SystemRoot%']);
    assert.notEqual(err.status, 0);
    // This is a spawn/start failure, not a pre-registration refusal: the registry row and .out already
    // exist by the time argv is built, so both must be present, with .exit forced to 1.
    assert.ok(registryRows(root).some((row) => row.name === 'pctarg'));
    assert.equal(readExit(root, 'pctarg').trim(), '1');
    assert.match(fs.readFileSync(path.join(dir, 'pctarg.out'), 'utf8'), /%/);
    assert.equal(fs.existsSync(path.join(root, 'dump-out.json')), false, 'the shim must never have been invoked');
  });

  // B1: a "\"" escaped as "\\\"" flips cmd.exe's own quote state rather than being escaped by it, so a
  // metacharacter riding in the same or a later argument used to still reach cmd.exe as an operator. These
  // four payloads are exact reproductions of the reviewer's independent probe (QB-FB-REVIEW-WRAPPER3), each
  // with its own harmless sentinel file that must never be created because the fix refuses before spawn.
  const b1Cases = [
    {
      label: 'quote-then-operator-then-quote in one argument',
      args: ['a"&type nul > SENTINEL_P1a.txt&"b'],
      sentinel: 'SENTINEL_P1a.txt',
    },
    {
      label: 'a lone trailing quote in one argument, operator in the next (neither alone looks suspicious)',
      args: ['x"', 'y&type nul > SENTINEL_P1b.txt'],
      sentinel: 'SENTINEL_P1b.txt',
    },
    {
      label: 'backslash-quote sequence still containing a literal quote',
      args: ['q\\"&type nul > SENTINEL_P1c.txt&\\"'],
      sentinel: 'SENTINEL_P1c.txt',
    },
    {
      label: 'an embedded line break ahead of an operator',
      args: ['line1\n&type nul > SENTINEL_P1d.txt'],
      sentinel: 'SENTINEL_P1d.txt',
    },
  ];
  for (const { label, args, sentinel } of b1Cases) {
    it(`refuses a .cmd shim argument with ${label} instead of letting cmd.exe re-parse it`, () => {
      const root = setup('worker-artifacts-quotecrlf-');
      const dir = workerDir(root);
      const shim = makeCmdShim(root);
      const err = runWrapperExpectingFailure(root, 'quotecrlf', [], [shim, ...args]);
      assert.notEqual(err.status, 0);
      assert.equal(fs.existsSync(path.join(root, sentinel)), false, 'the shim must never have run');
      assert.equal(fs.existsSync(path.join(root, 'dump-out.json')), false, 'the shim must never have been invoked');
      // Spawn/start failure: the registry row and .out already exist by the time argv is built.
      assert.ok(registryRows(root).some((row) => row.name === 'quotecrlf'));
      assert.equal(readExit(root, 'quotecrlf').trim(), '1');
      assert.match(fs.readFileSync(path.join(dir, 'quotecrlf.out'), 'utf8'), /quote|control character/);
    });
  }

  it('keeps ordinary same-process argv exact even where the .cmd shim would refuse it (direct executable, no shell)', () => {
    // The .cmd/.bat shim's quote/control-character refusal is a shim-specific limitation; a real executable
    // gets argv straight from Node with no shell involved, so exact quotes and newlines still pass through.
    // '' and a trailing backslash are included here too (N5): the direct-executable path never runs
    // quoteForCmd at all, so both must arrive exactly regardless of what the shim path does with them.
    const root = setup('worker-artifacts-directargv-');
    const dumpPath = path.join(root, 'dump.mjs');
    fs.writeFileSync(
      dumpPath,
      "import fs from 'node:fs';\nfs.writeFileSync('direct-argv.json', JSON.stringify(process.argv.slice(2)));\n",
    );
    const payloads = ['say "hi"', 'line1\nline2', 'a&b', '100%SystemRoot%', '', 'trail\\'];
    runWrapper(root, 'directargv', [], [process.execPath, dumpPath, ...payloads]);
    const received = JSON.parse(fs.readFileSync(path.join(root, 'direct-argv.json'), 'utf8'));
    assert.deepEqual(received, payloads);
  });

  // N5: quoteForCmd (the .cmd/.bat shim path only) used to return an empty argument unchanged -- which cmd.exe
  // then drops entirely instead of passing through as an empty positional -- and wrapped a whitespace-bearing
  // argument in quotes without doubling a trailing backslash run, which flips the child's argv parser into
  // reading the added closing quote as an escaped literal backslash instead of the end of the string, merging
  // the rest of the command line into that one argument. These reproduce the reviewer's exact rows
  // (QB-FB-REVIEW-WRAPPER4) plus the variants it called out as missing: multiple trailing backslashes, and a
  // cross-argument check that nothing downstream of the merged argument goes missing either.
  it('preserves an empty shim argument exactly instead of dropping it (N5)', () => {
    const root = setup('worker-artifacts-argv-empty-');
    const shim = makeCmdShim(root);
    const payloads = ['before', '', 'after'];
    runWrapper(root, 'argvempty', [], [shim, ...payloads]);
    const received = JSON.parse(fs.readFileSync(path.join(root, 'dump-out.json'), 'utf8'));
    assert.deepEqual(received, payloads, 'an empty argument must arrive as its own empty argument, not vanish');
  });

  it('keeps a spaced argument ending in one trailing backslash from merging into the next argument (N5)', () => {
    const root = setup('worker-artifacts-argv-trailbs-');
    const shim = makeCmdShim(root);
    const payloads = ['two words\\', 'next'];
    runWrapper(root, 'argvtrailbs', [], [shim, ...payloads]);
    const received = JSON.parse(fs.readFileSync(path.join(root, 'dump-out.json'), 'utf8'));
    assert.deepEqual(
      received,
      payloads,
      'the trailing backslash must not escape the added closing quote and swallow the next argument',
    );
  });

  it('doubles a run of several trailing backslashes on a quoted shim argument, not just a single one (N5)', () => {
    const root = setup('worker-artifacts-argv-multibs-');
    const shim = makeCmdShim(root);
    const payloads = ['two words\\\\', 'three words\\\\\\', 'next'];
    runWrapper(root, 'argvmultibs', [], [shim, ...payloads]);
    const received = JSON.parse(fs.readFileSync(path.join(root, 'dump-out.json'), 'utf8'));
    assert.deepEqual(received, payloads);
  });

  it('leaves a trailing backslash with no surrounding whitespace unquoted and unchanged on the shim path (N5)', () => {
    // Nothing here needs quoting (no whitespace/metacharacter), so quoteForCmd must return it as-is -- the
    // same "trail\\" shape the prior review's ordinary-args gate already covered, kept here as its own
    // regression check now that quoteForCmd's quoting branch changed.
    const root = setup('worker-artifacts-argv-rawtrailbs-');
    const shim = makeCmdShim(root);
    const payloads = ['trail\\', 'plain'];
    runWrapper(root, 'argvrawtrailbs', [], [shim, ...payloads]);
    const received = JSON.parse(fs.readFileSync(path.join(root, 'dump-out.json'), 'utf8'));
    assert.deepEqual(received, payloads);
  });

  // M2: a failure staging the copied-or-renamed report onto the live <name>.md, discovered only after this
  // run confirmed it still owns the lock, used to propagate as an uncaught exception -- a raw stack trace on
  // stderr and no <name>.exit at all, leaving the board's view of this worker stalled forever instead of
  // failed. The child creates a directory at its own live <name>.md path (harmless: nothing else is using
  // it yet) after writing a fresh report source, so publishStagedReport's rename and copy fallback both fail.
  it('catches a report-publish failure after staging, forces a non-zero .exit, and keeps the staged report recoverable (M2)', () => {
    const root = setup('worker-artifacts-publishfail-');
    const dir = workerDir(root);
    const liveMdRel = path.posix.join('.questboard-data', 'workers', 'codex', 'pub.md');
    const err = runWrapperExpectingFailure(root, 'pub', ['--report', 'report-src.md'], [
      process.execPath, '-e',
      "import('node:fs').then((fs) => { " +
        "fs.writeFileSync('report-src.md', 'STAGED REPORT'); " +
        `fs.mkdirSync(${JSON.stringify(liveMdRel)}, { recursive: true }); ` +
        'process.exit(0); ' +
      '});',
    ]);
    assert.notEqual(err.status, 0);
    assert.equal(readExit(root, 'pub').trim(), '1', '.exit must still be written, forced non-zero, not omitted');

    const stderrLines = err.stderr.trim().split('\n').filter(Boolean);
    assert.equal(stderrLines.length, 1, 'one bounded diagnostic line, not a raw uncaught-exception stack trace');
    assert.match(stderrLines[0], /publish/i);

    // The directory the child created at the live path is untouched -- the wrapper must not have deleted or
    // written through it.
    assert.ok(fs.statSync(path.join(dir, 'pub.md')).isDirectory());

    // The staged report bytes must still be recoverable on disk, not deleted, since neither the rename nor
    // the copy onto the live path could succeed.
    const leftoverTmp = fs.readdirSync(dir).find((f) => f.startsWith('pub.md.') && f.endsWith('.tmp'));
    assert.ok(leftoverTmp, 'the staged report temp file must be retained for recovery, not deleted on publish failure');
    assert.equal(fs.readFileSync(path.join(dir, leftoverTmp), 'utf8'), 'STAGED REPORT');
  });
});

describe('wrapper polite-stop signals (FB2-01.6)', () => {
  // SIGTERM/SIGINT never reach a Node process on Windows (and taskkill /F runs no handler at all), so this
  // test is POSIX-only by design: on Windows the force-killed case is covered board-side by the job-object
  // process-tree check (test/server/dispatcherWorkerDeath.test.js), not by the wrapper.
  it('publishes a conservative non-zero .exit when the wrapper receives SIGTERM', { skip: process.platform === 'win32' }, async () => {
    const root = setup('qb-sigterm-');
    const child = spawnWrapper(root, 'sig', [], [process.execPath, '-e', 'setTimeout(() => process.exit(0), 60000)']);
    try {
      await waitForRegistryRows(root, 'sig', 1);
      await waitForOutMatch(root, 'sig', /./s).catch(() => {}); // .out may be empty; the exit file is what matters
      child.kill('SIGTERM');
      await waitForClose(child);
      assert.equal(readExit(root, 'sig').trim(), '1', 'a politely stopped wrapper leaves terminal evidence, not silence');
      const out = fs.readFileSync(path.join(workerDir(root), 'sig.out'), 'utf8');
      assert.match(out, /SIGTERM/, 'the stop reason is visible in the worker output the board reads');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
});
