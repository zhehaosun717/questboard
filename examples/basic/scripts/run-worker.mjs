#!/usr/bin/env node
// Generic worker wrapper for questboard lanes.
// Logs dispatch to the project registry, streams worker output to <outputDir>/<name>.out, optionally
// copies a report file to <name>.md, and publishes <outputDir>/<name>.exit last: the exit file is the
// board's terminal marker, so it is only written once every other artifact is in place. Before any of
// that, it takes an exclusive lock on this worker name and retires that name's previous terminal
// artifacts into an archive folder, so a repeated name can never be mistaken for the run in progress.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// 1. Separate wrapper flags from the agent command after '--'
const args = process.argv.slice(2);
const dashDash = args.indexOf('--');
if (dashDash === -1) fail('missing -- separator before agent command');

const wrapperArgs = args.slice(0, dashDash);
const agentCmd = args.slice(dashDash + 1);
if (agentCmd.length === 0) fail('no agent command specified after --');

// 2. Parse flags before '--' (flags may come in any order; unknown flags are an error)
let lane, name, brief, model = '', variant = '', pkg = '', report = null, role = null;
for (let i = 0; i < wrapperArgs.length; i++) {
  const flag = wrapperArgs[i];
  const next = () => (++i < wrapperArgs.length ? wrapperArgs[i] : fail(`missing value for ${flag}`));
  if (flag === '--lane') lane = next();
  else if (flag === '--name') name = next();
  else if (flag === '--brief') brief = next();
  else if (flag === '--model') model = next();
  else if (flag === '--variant') variant = next();
  else if (flag === '--package') pkg = next();
  else if (flag === '--report') report = next();
  else if (flag === '--role') role = next();
  else fail(`unknown option: ${flag}`);
}

if (!lane || !name || !brief) fail('missing required arguments (--lane, --name, --brief)');

// 3. Verify the brief file exists and read its content
const briefPath = path.resolve(process.cwd(), brief);
if (!fs.existsSync(briefPath)) fail(`brief file not found: ${brief}`);
let briefText;
try {
  briefText = fs.readFileSync(briefPath, 'utf8');
} catch (err) {
  fail(`cannot read brief file: ${err.message}`);
}

let roleText = '';
if (role) {
  const rolePath = path.resolve(process.cwd(), role);
  const relativeRole = path.relative(process.cwd(), rolePath);
  if (relativeRole === '..' || relativeRole.startsWith(`..${path.sep}`)) fail(`role card path is outside the project: ${role}`);
  try {
    roleText = fs.readFileSync(rolePath, 'utf8');
  } catch (err) {
    fail(`cannot read role card: ${err.message}`);
  }
}

// 4. Read questboard.config.json from cwd to resolve outputDir and registry path
const configPath = path.resolve(process.cwd(), 'questboard.config.json');
if (!fs.existsSync(configPath)) fail(`missing config: ${configPath}`);
let rawConfig;
try {
  rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (err) {
  fail(`cannot parse questboard.config.json: ${err.message}`);
}

const laneConfig = rawConfig.lanes && rawConfig.lanes[lane];
if (!laneConfig) fail(`unknown lane: ${lane}`);
const outputDirRel = laneConfig.outputDir || laneConfig.deliveryDir;
if (!outputDirRel) fail(`lane ${lane} has no outputDir`);

const dataDir = rawConfig.dataDir === undefined ? '.questboard-data' : rawConfig.dataDir;
const registryRel = rawConfig.registry === undefined ? path.join(dataDir, 'registry.jsonl') : rawConfig.registry;
const registryPath = path.resolve(process.cwd(), registryRel);
const outputDir = path.resolve(process.cwd(), outputDirRel);

// 5. Take an exclusive lock on this worker name before touching any shared artifact (registry row,
// .out/.exit/.md), so a concurrent invocation with the same name cannot interleave writes with this run.
// A lock is a plain file created with the 'wx' flag, which fails if the file already exists. If one is
// already there, this wrapper never inspects or kills whatever holds it -- an old lock left behind by a
// killed process must be removed by hand, deliberately, not guessed away, and only once that process is
// confirmed stopped (removing the lock of a still-running attempt does not stop it; it only lets a second
// attempt start alongside it). The lock carries a random per-run token; every later step that would delete
// the lock file or publish this run's final artifacts first re-reads the lock and checks the token is still
// ours (see ownsLock() below), so a lock removed and reclaimed by hand cannot be deleted out from under its
// new owner, and a run that lost its lock this way cannot overwrite the new owner's live output either. This
// narrows, but cannot fully close, the race: nothing stops something else from rewriting the lock file
// between our check and our write, and there is no guarantee against that kind of adversarial interference.
const lockPath = path.join(outputDir, `${name}.lock`);
fs.mkdirSync(outputDir, { recursive: true });
const lockToken = randomUUID();
let lockFd;
try {
  lockFd = fs.openSync(lockPath, 'wx');
} catch (err) {
  if (err.code === 'EEXIST') {
    fail(`worker "${name}" is already locked (${lockPath} exists) -- a run with this name may be in progress. ` +
      'Only remove the lock file by hand once you have confirmed that run is actually stopped, then retry.');
  }
  fail(`cannot create lock for ${name}: ${err.message}`);
}
// Registered right after the lock file exists (before the write below) so a write failure still triggers
// automatic cleanup on the process.exit() inside the catch block, without unlinking a lock we never
// finished writing our token into (ownsLock() reads back what is actually on disk, not what we intended).
process.on('exit', () => {
  try {
    if (ownsLock()) fs.unlinkSync(lockPath);
  } catch {}
});
try {
  fs.writeSync(lockFd, `${JSON.stringify({ pid: process.pid, token: lockToken, startedAt: new Date().toISOString() })}\n`);
  fs.closeSync(lockFd);
} catch (err) {
  try { fs.closeSync(lockFd); } catch {}
  // The write failed, so no other run can have read our token out of this lock yet: it is safe to remove
  // directly here rather than rely on ownsLock(), which needs a fully-written, parseable lock to match.
  try { fs.unlinkSync(lockPath); } catch {}
  fail(`cannot write lock for ${name}: ${err.message}`);
}

// True only while the lock file at lockPath still holds this run's token. Every step that deletes the lock
// or publishes this run's terminal artifacts (.exit/.md at their live, non-archived paths) checks this
// first: if it is false, this run's lock was removed and re-acquired by a newer run under the same name,
// and touching either the lock or the live paths now would corrupt that newer run's state instead of ours.
function ownsLock() {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8')).token === lockToken;
  } catch {
    return false;
  }
}

// 6. Retire this name's previous terminal artifacts (.out/.exit/.md, whichever exist) into an archive
// folder rather than deleting them, so a repeated name can never inherit a prior run's report or exit
// code as if it were current, while the prior run's evidence stays recoverable on disk.
const outPath = path.join(outputDir, `${name}.out`);
const exitPath = path.join(outputDir, `${name}.exit`);
const staleStamp = `${Date.now()}.${process.pid}`;
const archiveDir = path.join(outputDir, '.archive');
for (const stalePath of [outPath, exitPath, path.join(outputDir, `${name}.md`)]) {
  if (!fs.existsSync(stalePath)) continue;
  try {
    fs.mkdirSync(archiveDir, { recursive: true });
    const archivePath = path.join(archiveDir, `${path.basename(stalePath)}.${staleStamp}`);
    fs.renameSync(stalePath, archivePath);
  } catch (err) {
    fail(`cannot archive stale ${path.basename(stalePath)}: ${err.message}`);
  }
}

// 7. Append one registry row before starting the worker (evidence workerEvidence looks for)
const dispatchRow = {
  at: new Date().toISOString(),
  event: 'dispatch',
  package: pkg,
  lane,
  model,
  variant,
  name,
  brief,
};
try {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.appendFileSync(registryPath, JSON.stringify(dispatchRow) + '\n', 'utf8');
} catch (err) {
  fail(`cannot write registry: ${err.message}`);
}

// 8. Write <name>.out empty at once, open for write. A failure here happens after the registry row above
// but before the worker is ever spawned -- distinct from a pre-registration refusal (no registry row) and
// from a spawn/start failure (registry row AND a working .out both already exist). Nothing has run yet, so
// this is treated the same as any other pre-spawn refusal: fail() exits without an .exit file, releasing
// the lock through the normal exit handler.
let outFd;
try {
  fs.writeFileSync(outPath, '');
  outFd = fs.openSync(outPath, 'w');
} catch (err) {
  fail(`cannot create output file for ${name}: ${err.message}`);
}

// 9. Spawn agent command with brief piped to stdin; stdout+stderr appended to .out.
// On Windows, CLIs installed by npm are .cmd shims that only cmd.exe can start. A bare command name is
// looked up on PATH; a .cmd/.bat hit goes through cmd.exe with each argument quoted, anything else (node.exe,
// codex.exe) is started directly so its arguments arrive untouched. The brief travels over stdin.
function resolveOnPath(command) {
  if (process.platform !== 'win32' || /[\\/]/.test(command) || path.extname(command)) return command;
  const dirs = (process.env.PATH || '').split(';').filter(Boolean);
  const exts = ['.exe', '.cmd', '.bat', '.com'];
  for (const dir of dirs) for (const ext of exts) {
    const candidate = path.join(dir, command + ext);
    if (fs.existsSync(candidate)) return candidate;
  }
  return command;
}
// Quoting an argument in double quotes stops cmd.exe from treating whitespace or & | < > ^ ! ( ) as operators
// inside it -- well-documented cmd.exe behaviour. "%" is different: cmd.exe expands %name% references during
// its own command-line parsing even when "%name%" sits inside a quoted argument, so no amount of quoting here
// can guarantee a "%"-bearing value reaches the child unchanged. A literal double quote is different again: a
// backslash does not escape a quote for cmd.exe's own parser the way it does for the child's argv parser (that
// escaping only matters once the child re-parses its command line), so a `"` inside an argument flips cmd.exe's
// own quote state and un-quotes everything up to the next `"` -- including any metacharacters riding along in
// the same or a later argument. A CR or LF embedded in an argument is a third case: cmd.exe treats it as a
// command separator while parsing the /c string, silently truncating the argument instead of passing it
// through. None of these three can be made safe by quoting or escaping here, so rather than attempt ad hoc
// shell escaping this refuses any argument containing "%", a double quote, or a control character (CR/LF
// included) before spawning -- caught below, alongside a literal spawn() failure, and reported the same way: a
// failed start, not a silently altered one. This limitation is specific to the .cmd/.bat shim path: a real
// executable (node.exe, codex.exe, ...) receives argv directly from Node with no shell involved, so exact
// quotes, newlines and control characters all pass through unchanged there -- see the README for that option.
function quoteForCmd(arg) {
  if (arg.includes('%')) {
    throw new Error(
      `argument ${JSON.stringify(arg)} to "${cmd}" contains "%", which cmd.exe can expand into an ` +
      'environment variable value even inside quotes -- refusing to pass it through the .cmd/.bat shim ' +
      'rather than risk silently substituting something else. Avoid "%" in this value, or use a lane whose ' +
      'command is a real executable instead of a .cmd/.bat shim.',
    );
  }
  if (/["\x00-\x1f\x7f]/.test(arg)) {
    throw new Error(
      `argument ${JSON.stringify(arg)} to "${cmd}" contains a double quote or a control character (a CR/LF ` +
      'line break included) -- cmd.exe\'s own command-line parser cannot be safely quoted or escaped against ' +
      'either (a `"` flips its quote state instead of being escaped, and a line break truncates the argument), ' +
      'so this refuses to pass it through the .cmd/.bat shim rather than risk running something other than what ' +
      'was asked, or silently changing the value. Avoid quotes and control characters in this value, or use a ' +
      'lane whose command is a real executable instead of a .cmd/.bat shim -- a real executable receives argv ' +
      'directly with no shell involved and no such restriction.',
    );
  }
  const needsQuoting = arg === '' || /[\s&|<>^!()]/.test(arg);
  if (!needsQuoting) return arg;
  // A trailing backslash run sits immediately before the closing quote this adds, and the child's own argv
  // parser (CommandLineToArgvW-style, used by node.exe and any other real executable at the end of a .cmd
  // shim chain) treats N backslashes right before a `"` as N/2 literal backslashes, consuming the quote
  // itself if N is odd instead of closing the string -- silently swallowing the rest of the command line
  // into this argument. Doubling that trailing run here (to 2N) keeps it literal while still letting the
  // added quote close normally; cmd.exe's own parser does not treat backslashes specially, so this is safe
  // for its pass -- only the child's later argv parsing depends on it.
  const trailingBackslashes = /\\+$/.exec(arg);
  const escaped = trailingBackslashes ? arg + trailingBackslashes[0] : arg;
  return `"${escaped}"`;
}
const [cmd, ...cmdArgs] = agentCmd;
const resolved = resolveOnPath(cmd);
const viaShell = /\.(cmd|bat)$/i.test(resolved);
const file = viaShell ? process.env.ComSpec || 'cmd.exe' : resolved;

// Snapshot the report source, if any, before the child can touch it: copyReport() below only republishes
// it when this run's own child actually refreshed it (see N1 in the revision report). The wrapper itself
// never writes to reportPath.
let reportPrelaunchStat = null;
if (report) {
  try {
    const st = fs.statSync(path.resolve(process.cwd(), report));
    reportPrelaunchStat = { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    reportPrelaunchStat = null; // did not exist yet -- anything found after the child runs counts as fresh
  }
}

let settled = false;
let outClosed = false;

// A note is one stderr line (the dispatch log sees it) and one .out line (the board sees it).
function note(message) {
  process.stderr.write(`${message}\n`);
  if (!outClosed) { try { fs.writeSync(outFd, `${message}\n`); } catch {} }
}

function closeOut() {
  if (outClosed) return;
  outClosed = true;
  try { fs.closeSync(outFd); } catch {}
}

// Publish <name>.exit as a complete UTF-8 integer, atomically where practical: write a same-directory
// temp file then rename, so a reader never sees a half-written code. If rename itself fails (a locked
// target on Windows), fall back to one full overwrite rather than leave no terminal evidence at all.
function publishExit(code) {
  const tmpPath = `${exitPath}.${process.pid}.tmp`;
  const content = `${code}\n${cancelRequestId && cancelAcknowledged ? JSON.stringify({ requestId: cancelRequestId, scope: 'direct-child' }) + '\n' : ''}`;
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    try {
      fs.renameSync(tmpPath, exitPath);
      return;
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch {}
      fs.writeFileSync(exitPath, content, 'utf8');
    }
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    fail(`cannot publish exit code for ${name}: ${err.message}`);
  }
}

// If this run's lock was removed by hand and re-acquired by a newer run under the same name (ownsLock()
// is false), publishExit()/publishStagedReport() must not touch the live <name>.exit/<name>.md paths --
// those now belong to the newer run. This run's own result is not discarded, just kept out of the way:
// parked under .archive with an "orphaned" marker instead of the archive's usual "retired stale run"
// naming, so it stays on disk and distinguishable from either run's real terminal evidence. The report, if
// any, is the same staged temp file terminalExit() already has in hand (see stageReport()) -- it is moved
// into .archive, never re-read from reportPath, so the orphaned copy cannot pick up a newer writer's
// content that landed at reportPath after this run's child finished. As with the lock check itself, this is
// a bounded, best-effort guard (check-then-act), not a transactional guarantee against every interleaving.
function publishOrphanedEvidence(code, reportTmpPath) {
  const stamp = `${Date.now()}.${process.pid}`;
  note(`lock for "${name}" was reclaimed by another run while this run was still publishing its result; ` +
    `exit ${code} was NOT written to the live path and was parked under .archive instead.`);
  try {
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, `${name}.exit.orphaned.${stamp}`), `${code}\n`, 'utf8');
  } catch {}
  if (reportTmpPath) {
    const archivedReportPath = path.join(archiveDir, `${name}.md.orphaned.${stamp}`);
    try {
      fs.renameSync(reportTmpPath, archivedReportPath);
    } catch {
      // Rename can fail across filesystems/devices; fall back to a copy so the report still lands in
      // .archive. If even that fails, leave the staged temp file exactly where it is rather than delete the
      // only remaining copy of this run's report -- it stays recoverable on disk, just not filed under
      // .archive, and the note below says so instead of the loss passing silently.
      try {
        fs.copyFileSync(reportTmpPath, archivedReportPath);
        try { fs.unlinkSync(reportTmpPath); } catch {}
      } catch (err) {
        note(`could not archive orphaned report for "${name}": ${err.message}; the staged report bytes are ` +
          `still recoverable at ${reportTmpPath}`);
      }
    }
  }
}

// Move the already-staged report temp file (see stageReport()) onto the live <name>.md. Only called once
// terminalExit() has confirmed this run still owns the lock, so this always runs before publishExit() --
// the same report-before-exit ordering as before. Rename failure falls back to copying from the temp file
// itself (never re-reading reportPath), so the report is still delivered whole in one write either way.
// Throws if neither the rename nor the copy fallback can land the report at mdPath (for example mdPath is a
// directory). The caller (terminalExit) is responsible for turning that into a conservative non-zero .exit
// instead of a raw crash; on that path this deliberately leaves tmpPath in place rather than delete the only
// remaining copy of the report, so terminalExit's own diagnostic can still point at recoverable bytes.
function publishStagedReport(tmpPath) {
  const mdPath = path.join(outputDir, `${name}.md`);
  try {
    fs.renameSync(tmpPath, mdPath);
    return;
  } catch {}
  fs.copyFileSync(tmpPath, mdPath);
  try { fs.unlinkSync(tmpPath); } catch {}
}

// The single path every terminal branch below uses to end the wrapper: check ownership immediately before
// publishing anything live, then either publish the report (if staged) and the exit code for real (exit
// wrapperExitCode), or park both as orphaned evidence (exit 1, regardless of wrapperExitCode, since nothing
// was actually delivered to the live path). Ownership is checked once for both artifacts together, so a
// lock lost between publishing the report and publishing the exit code can no longer happen -- that was B2.
function terminalExit(publishCode, wrapperExitCode, reportTmpPath = null) {
  if (!ownsLock()) {
    publishOrphanedEvidence(publishCode, reportTmpPath);
    process.exit(1);
    return;
  }
  if (reportTmpPath) {
    try {
      publishStagedReport(reportTmpPath);
    } catch (err) {
      // Staging already succeeded (reportTmpPath exists with the report's bytes); only the final move/copy
      // to the live .md failed here, after this run confirmed it still owns the lock. Do not let that
      // propagate into an uncaught exception with no .exit at all -- publish a conservative non-zero .exit
      // instead, the same terminal-failure shape as any other publish problem, so the board ends this run
      // instead of leaving it stalled forever.
      note(`failed to publish staged report for "${name}": ${err.message}; the staged report bytes are ` +
        `still recoverable at ${reportTmpPath}`);
      publishExit(1);
      process.exit(1);
      return;
    }
  }
  publishExit(publishCode);
  process.exit(wrapperExitCode);
}

// Copy the report through a temp file so <name>.md only ever appears complete and the original is untouched
// -- but only stage it here; publishing it to the live path (or parking it as orphaned evidence) happens
// later in terminalExit(), after the ownership check, so a stale owner can never commit a report past that
// check (B2). A missing report is not an error: the report is optional by contract. A report that exists but
// matches its prelaunch snapshot exactly (same mtime and size) was not touched by this run's child either --
// most likely a lane reuses the same --report path across runs -- so it is treated the same as a missing
// report rather than staged as if this run had just produced it. This cannot be fooled by a real update that
// happens to keep the exact same size, but that is a coincidence this wrapper has no way to rule out, and
// erring toward "not fresh" is the safer of the two wrong answers for a delivery signal the board trusts.
// Returns the temp file path if there is fresh content to publish, or null if there is nothing to publish.
function stageReport() {
  const reportPath = path.resolve(process.cwd(), report);
  if (!fs.existsSync(reportPath)) return null;
  const mdPath = path.join(outputDir, `${name}.md`);
  const tmpPath = `${mdPath}.${process.pid}.tmp`;
  // Copy to the temp file first, same as before, so a real I/O error (an unreadable path, a directory
  // where a file was expected) still surfaces exactly as it did before this freshness check existed. Only
  // once that succeeds do we decide whether the result is worth publishing.
  try {
    fs.copyFileSync(reportPath, tmpPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
  const postStat = reportPrelaunchStat ? fs.statSync(reportPath) : null;
  const unrefreshed = postStat
    && postStat.mtimeMs === reportPrelaunchStat.mtimeMs
    && postStat.size === reportPrelaunchStat.size;
  if (unrefreshed) {
    try { fs.unlinkSync(tmpPath); } catch {}
    return null;
  }
  return tmpPath;
}

let child;
const controlAttemptId = process.env.QUESTBOARD_ATTEMPT_ID || '';
const controlToken = process.env.QUESTBOARD_CONTROL_TOKEN || '';
let cancelRequestId = null;
let cancelAcknowledged = false;

// The board's cooperative stop boundary is intentionally narrow: verify the per-attempt IPC payload,
// acknowledge that exact request, and kill only the direct child handle this wrapper created.
function receiveControl(message) {
  if (settled || !message || typeof message !== 'object' || message.type !== 'questboard-cancel') return;
  const requestId = typeof message.requestId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(message.requestId) ? message.requestId : null;
  if (!requestId || message.attemptId !== controlAttemptId || message.token !== controlToken || cancelRequestId) return;
  cancelRequestId = requestId;
  cancelAcknowledged = true;
  try { if (typeof process.send === 'function') process.send({ type: 'questboard-cancel-ack', attemptId: controlAttemptId, requestId, scope: 'direct-child' }); } catch {}
  try { child.kill(); } catch {}
}

if (controlAttemptId && controlToken) process.on('message', receiveControl);
try {
  const fileArgs = viaShell
    // /v:off disables delayed expansion unconditionally, so an argument containing "!" always passes through
    // literally instead of only when the machine happens not to have delayed expansion on by registry default.
    ? ['/d', '/v:off', '/s', '/c', `"${[quoteForCmd(resolved), ...cmdArgs.map(quoteForCmd)].join(' ')}"`]
    : cmdArgs;
  child = spawn(file, fileArgs, {
    cwd: process.cwd(),
    // The wrapper needs these values for its own IPC boundary, but the agent does not. Keeping them out
    // of the child environment reduces accidental disclosure without changing the wrapper protocol.
    env: (() => {
      const childEnv = { ...process.env };
      delete childEnv.QUESTBOARD_ATTEMPT_ID;
      delete childEnv.QUESTBOARD_CONTROL_TOKEN;
      return childEnv;
    })(),
    stdio: ['pipe', outFd, outFd],
    windowsVerbatimArguments: viaShell,
    windowsHide: true,
  });
} catch (err) {
  settled = true;
  // Covers both a synchronous spawn() throw and quoteForCmd()'s refusal of an unsafe "%" argument: either
  // way the worker never ran, so leave a failed exit file so the board ends it now instead of stalling.
  note(`failed to spawn worker: ${err.message}`);
  closeOut();
  terminalExit(1, 1);
}

child.on('error', (err) => {
  if (settled) return;
  settled = true;
  note(`failed to start worker: ${err.message}`);
  closeOut();
  // 127 is command-not-found, 1 any other start failure.
  terminalExit(err.code === 'ENOENT' ? 127 : 1, 1);
});

child.stdin.on('error', () => {});
child.stdin.end(roleText ? `${roleText}\n\n${briefText}` : briefText);

child.on('close', (code) => {
  if (settled) return;
  settled = true;

  const exitCode = Number.isInteger(code) ? code : 1;
  let reportTmpPath = null;
  if (report) {
    try {
      reportTmpPath = stageReport();
    } catch (err) {
      // A child that succeeded but whose report cannot be copied must not look delivered: the board
      // reads the .exit code as terminal truth, so publish a conservative failure instead.
      note(`failed to copy report: ${err.message}`);
      closeOut();
      terminalExit(exitCode === 0 ? 1 : exitCode, 1);
      return;
    }
  }
  closeOut();
  terminalExit(exitCode, 0, reportTmpPath);
});
