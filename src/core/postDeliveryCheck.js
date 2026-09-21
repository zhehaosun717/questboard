// The delivery self-check shared by the project gate (policy.postDeliveryCheck, FB2-05 item 2) and the
// one-off mechanical review (quest.review === 'mechanical', FB2-05 item 3). Both run after the worker
// leaves delivery evidence and before the board settles the quest: the gate holds delivery on a miss, the
// mechanical check never bounces and only records its conclusion.
//
// One bounded runner for both: an argv array for the configured gate (never joined and re-split — each
// element stays one argument, 'node' runs under this Node, a .sh script runs under Git Bash), or a plain
// shell command string for the owner-typed --mechanical-check (Git Bash -c). stdout/stderr go to a log
// file opened with 'w' (never 'a' on Windows: the append-only handle would wedge Git Bash writes), and
// the whole run is bounded by timeoutMs — a hung check is a failed round with an explicit 超时 summary,
// never a silent pass and never an infinite poll block.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { bashPath, resolveCommand } from './dispatch.js';
import { fillTemplate } from './config.js';

const SUMMARY_MAX = 800;
const DEFAULT_MECHANICAL_TIMEOUT_MS = 60000;

function tail(file, bytes = 4000) {
  try { return fs.readFileSync(file, 'utf8').slice(-bytes); } catch { return ''; }
}

// The check log lives next to the attempt's other artifacts: the lane's outputDir, or deliveryDir for a
// server lane; a lane with neither falls back under the project's data dir so the log is always writable.
export function checkArtifactDir(config, lane) {
  const rel = (lane && (lane.outputDir || lane.deliveryDir)) || path.join(config.paths.data, 'dispatch');
  return path.join(config.root, rel);
}

export function checkLogPath(config, lane, name) {
  return path.join(checkArtifactDir(config, lane), `${name}.check.log`);
}

export function mechanicalLogPath(config, lane, name) {
  return path.join(checkArtifactDir(config, lane), `${name}.mechanical-check.log`);
}

// The session id a server-lane attempt is bound to: the durable record first, then the lane's own session
// save file (the same source writeApiDelivery reads), so a delivery that exists at all usually has one.
export function readSessionId(config, lane, name, known = null) {
  if (known) return known;
  if (!lane || !lane.session || !lane.session.saveTo) return null;
  try {
    const rel = fillTemplate([lane.session.saveTo], { name }, 'lanes.session.saveTo')[0];
    return fs.readFileSync(path.join(config.root, rel), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

// One bounded spawn of the check command. `command` is an argv array; resolution mirrors the dispatcher
// (a .sh head runs under Git Bash, 'node' under this Node, anything else as an executable). Resolves with
// what is known about the run — the outcome interpretation lives in checkOutcome below.
export function runCheckCommand({ config, command, logPath, timeoutMs, env = {} }) {
  return new Promise((resolve) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const fd = fs.openSync(logPath, 'w');
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { fs.closeSync(fd); } catch { /* the log handle itself is never the story */ }
      resolve(value);
    };
    let child;
    try {
      const { file, args } = resolveCommand(config, command);
      child = spawn(file, args, {
        cwd: config.root,
        env: { ...process.env, ...env },
        stdio: ['ignore', fd, fd],
        windowsHide: true,
      });
    } catch (error) {
      // The OS never created a process: the loudest honest outcome, never a silent pass.
      finish({ code: null, timedOut: false, neverStarted: true, error: error.message });
      return;
    }
    const timer = setTimeout(() => {
      // A hung check must not block delivery forever. Kill the direct process; descendants a check script
      // may have spawned are the script's own business — the round is recorded as 超时 either way.
      try { child.kill(); } catch { /* already gone */ }
      finish({ code: null, timedOut: true, neverStarted: false, error: null });
    }, Math.max(1, timeoutMs));
    child.on('error', (error) => finish({ code: null, timedOut: false, neverStarted: true, error: error.message }));
    child.on('exit', (code) => finish({ code, timedOut: false, neverStarted: false, error: null }));
  });
}

// The same bounded runner for a plain shell command string (questboard post --mechanical-check "cmd").
// Runs under Git Bash with -c, so the owner types one command the way they would in a terminal.
export function runShellCheck({ config, command, logPath, timeoutMs, env = {} }) {
  return runCheckCommand({
    config,
    command: [bashPath(config), '-c', command],
    logPath,
    timeoutMs,
    env,
  });
}

// Interprets one finished check run into the appendCheckResult shape: { ok, exitCode, summary }.
// failPattern matches against the collected output when the command itself exited cleanly; a nonzero
// exit, a timeout or a spawn failure is a failed round in its own right, each with its own named reason —
// a check that could not run is never reported as a passing delivery.
export function checkOutcome({ code, timedOut, neverStarted, error, logPath, failPattern, timeoutMs }) {
  const text = tail(logPath);
  const lines = text.split(/\r?\n/).filter(Boolean);
  const exitCode = Number.isInteger(code) ? code : null;
  const cut = (value) => String(value || '').slice(-SUMMARY_MAX);
  if (neverStarted) return { ok: false, exitCode: null, summary: `自检命令没能启动：${error || 'spawn 失败'}` };
  if (timedOut) return { ok: false, exitCode: null, summary: cut(`自检超时（超过 ${timeoutMs} 毫秒被中止）\n${text}`) };
  if (code !== 0) return { ok: false, exitCode, summary: cut(`自检命令非零退出（exit ${code}）\n${text}`) };
  if (failPattern) {
    let pattern;
    try { pattern = new RegExp(failPattern); } catch { pattern = null; }
    if (pattern) {
      const hits = lines.filter((line) => pattern.test(line)).slice(-12);
      if (hits.length) return { ok: false, exitCode: 0, summary: cut(`自检没过（输出匹配 ${failPattern}）：\n${hits.join('\n')}`) };
    }
  }
  return { ok: true, exitCode: 0, summary: cut(text) };
}

// The gate runner: policy.postDeliveryCheck.run with its own timeout and failPattern, writing
// <outputDir>/<name>.check.log. The dispatcher injects a fake through its `runCheck` option in tests.
export async function runPostDeliveryGate({ config, check, logPath, env = {} }) {
  const result = await runCheckCommand({
    config, command: check.run, logPath, timeoutMs: check.timeoutMs, env,
  });
  return checkOutcome({ ...result, logPath, failPattern: check.failPattern, timeoutMs: check.timeoutMs });
}

// The mechanical review runner: a shell command string, bounded like the gate (reusing its timeout when
// the project configured one), writing <outputDir>/<name>.mechanical-check.log. No failPattern — the exit
// code is the verdict — and the outcome is recorded, never bounced on.
export async function runMechanicalCheck({ config, command, logPath, env = {}, timeoutMs = null }) {
  const result = await runShellCheck({
    config,
    command,
    logPath,
    timeoutMs: timeoutMs || DEFAULT_MECHANICAL_TIMEOUT_MS,
    env,
  });
  return checkOutcome({ ...result, logPath, failPattern: null, timeoutMs: timeoutMs || DEFAULT_MECHANICAL_TIMEOUT_MS });
}
