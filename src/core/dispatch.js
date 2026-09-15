// Turns an assignment into the project's dispatch commands, built from the lane templates in the project
// config. The project's scripts keep their own policy checks and write the registry.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fillTemplate } from './config.js';
import { readJsonLines } from './jsonl.js';

const GIT_BASH_CANDIDATES = ['D:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/bin/bash.exe', 'C:/Program Files (x86)/Git/bin/bash.exe'];

// Plain `bash` on Windows can resolve to WSL, which cannot run the scripts against Windows paths the way
// Git Bash does. Missing Git Bash is an error, not a fallback.
export function bashPath(config, env = process.env) {
  if (config.bash) return config.bash;
  if (env.QUESTBOARD_BASH) return env.QUESTBOARD_BASH;
  if (process.platform !== 'win32') return 'bash';
  const found = GIT_BASH_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error(`Git Bash not found; set "bash" in the project config or QUESTBOARD_BASH (looked in ${GIT_BASH_CANDIDATES.join(', ')})`);
  return found;
}

// Every worker name this project has ever recorded, on any quest, not only ones currently holding a slot.
// A finished quest's name is still its report/session/output file on disk (`.work/<lane>/<name>.*`,
// `.work/oc_session_<name>.txt`) — handing that name to an unrelated quest that normalizes the same way
// would silently reuse or overwrite that evidence, not just double-book a live slot. Legacy tracking (a
// name recorded here) is never itself authorization to stop or overwrite anything; it only ever narrows
// what a *new* name may be.
export function recordedNames(quests) {
  const names = new Set();
  for (const quest of quests) {
    for (const dispatch of quest.dispatches || []) if (dispatch && dispatch.name) names.add(dispatch.name);
    if (quest.assignee && quest.assignee.name) names.add(quest.assignee.name);
  }
  return names;
}

// usedNames is every worker name this project has ever recorded (see recordedNames) — passing the full
// history, not just currently active names, avoids handing out a name that collides with one of them, which
// can otherwise happen even between two different quests, including one already finished: package id
// normalization (strip everything but [a-z0-9]) is lossy, so two distinct ids can land on the same base
// name. A quest's own re-dispatch count only protects against colliding with its own past names.
export function workerName(quest, usedNames = new Set()) {
  const base = quest.id.toLowerCase().replace(/[^a-z0-9]/g, '');
  let count = (quest.dispatches || []).length;
  let name = count ? `${base}_${count + 1}` : base;
  while (usedNames.has(name)) { count += 1; name = `${base}_${count + 1}`; }
  return name;
}

export function planDispatch(config, quest, adventurer, name) {
  const lane = config.lanes[adventurer.lane];
  if (!lane) throw new Error(`this project has no lane ${adventurer.lane}`);
  const values = { name, brief: quest.brief, model: adventurer.model, variant: adventurer.variant, agent: adventurer.agent, package: quest.id };
  const field = `lanes.${adventurer.lane}`;
  const laneEnv = lane.env ? Object.fromEntries(Object.entries(lane.env).map(([k, v]) => [k, fillTemplate([v], values, `${field}.env.${k}`)[0]])) : {};
  // A card's own values win over the lane's, so one generic lane can serve several providers (a different
  // base URL per card). Secrets are refused at validation; the real key comes from the machine environment.
  const cardEnv = adventurer.env ? Object.fromEntries(Object.entries(adventurer.env).map(([k, v]) => [k, fillTemplate([v], values, `card ${adventurer.id}.env.${k}`)[0]])) : {};
  const env = { ...laneEnv, ...cardEnv };
  const steps = [];
  if (lane.session) {
    steps.push({ kind: 'session', command: fillTemplate(lane.session.run, values, `${field}.session.run`), saveTo: fillTemplate([lane.session.saveTo], values, `${field}.session.saveTo`)[0], env });
  }
  steps.push({ kind: 'run', command: fillTemplate(lane.run, values, `${field}.run`), env });
  return steps;
}

// `x.sh` runs under Git Bash, `node` under this Node, anything else as an executable.
function resolveCommand(config, command) {
  const [head, ...rest] = command;
  if (head.endsWith('.sh')) return { file: bashPath(config), args: command, script: head };
  if (head === 'node') return { file: process.execPath, args: rest, script: rest[0] };
  return { file: head, args: rest, script: null };
}

export function preflight(config, plan) {
  for (const step of plan) {
    const { script } = resolveCommand(config, step.command);
    if (script && !fs.existsSync(path.join(config.root, script))) throw new Error(`缺少派遣脚本 ${script}`);
  }
}

function runScript(config, step, logFile) {
  return new Promise((resolve) => {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    // 'w', never 'a': Node opens 'a' as an append-only Windows handle, Git Bash cannot write to it, the
    // wrapper's final echo fails under `set -e` and the dispatch reports exit 1 while its worker runs.
    const fd = fs.openSync(logFile, 'w');
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      fs.closeSync(fd);
      resolve(result);
    };
    let child;
    try {
      const { file, args } = resolveCommand(config, step.command);
      // stdio to a file, not a pipe: scripts background their worker with `( ... ) &`, and a pipe would stay
      // open until the worker ends. 'exit' fires when the script itself returns.
      child = spawn(file, args, { cwd: config.root, env: { ...process.env, ...step.env }, stdio: ['ignore', fd, fd], windowsHide: true, detached: true });
    } catch (error) {
      // A synchronous throw here means the OS never created a process at all — the one case this module can
      // itself verify as never having started anything, worth a distinct, typed signal rather than folding
      // into the same nonzero-code shape a wrapper's own failing exit produces (that exit can still follow a
      // worker that started fine; this cannot follow anything).
      finish({ code: -1, error: error.message, neverStarted: true });
      return;
    }
    // 'error' without a preceding 'exit' means spawn could not actually create the OS process (e.g. ENOENT) —
    // the same "verified nothing ran" fact as the synchronous throw above, just delivered asynchronously.
    child.on('error', (error) => finish({ code: -1, error: error.message, neverStarted: true }));
    child.on('exit', (code) => { child.unref(); finish({ code }); });
  });
}

function runSession(config, step) {
  return new Promise((resolve) => {
    const { file, args } = resolveCommand(config, step.command);
    execFile(file, args, { cwd: config.root, env: { ...process.env, ...step.env }, timeout: 30000, windowsHide: true }, (error, stdout, stderr) => {
      const id = String(stdout || '').trim().split(/\s+/).pop();
      if (error || !id) {
        resolve({ code: 1, error: (stderr || (error && error.message) || `no session id in output: ${stdout}`).slice(0, 500) });
        return;
      }
      // The process already reported a real id — a write failure here (locked file, full disk, a saveTo
      // that is itself a directory) must not be indistinguishable from "no session ever existed". Resolve
      // with the captured id *and* a distinct save-failure signal, never let the write throw out of this
      // callback: an uncaught exception here would crash the whole server (this callback runs outside any
      // promise chain executePlan can catch) and, because `resolve` was never called, would also wedge a
      // serialized lane's queue forever (every later queued attempt waits on this promise settling).
      try {
        fs.mkdirSync(path.dirname(path.join(config.root, step.saveTo)), { recursive: true });
        fs.writeFileSync(path.join(config.root, step.saveTo), id, 'utf8');
      } catch (saveError) {
        resolve({ code: 1, session: id, error: `session 已建立（${id}），但写入 ${step.saveTo} 失败，不能确认落盘：${saveError.message}`.slice(0, 500), saveFailed: true });
        return;
      }
      resolve({ code: 0, session: id });
    });
  });
}

// A wrapper's exit code is not the truth about its worker. Evidence that it started is the registry row
// the script writes before launching, or the worker's output file.
export function workerEvidence(config, laneId, name, sinceIso) {
  const since = Date.parse(sinceIso) - 60 * 1000;
  const rows = readJsonLines(config.paths.registry).slice(-200);
  if (rows.some((row) => row && row.event === 'dispatch' && row.name === name && Date.parse(row.at) >= since)) return `登记表有 ${name} 的派遣记录`;
  const lane = config.lanes[laneId];
  if (lane && lane.outputDir) {
    const out = path.join(config.root, lane.outputDir, `${name}.out`);
    if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= since) return `${lane.outputDir}/${name}.out 已经在写`;
  }
  return null;
}

function tail(file, bytes = 1500) {
  try { return fs.readFileSync(file, 'utf8').slice(-bytes); } catch { return ''; }
}

// recheck, when given, runs before every step — the session spawn and the run spawn alike, so a job that
// waited in a serialized lane's queue (or across the async gap between creating a session and sending to
// it) gets one last look at the world right before it actually does something, not just at drop time. A
// recheck refusal stops the plan cold: the step it would have gated never runs, and nothing after it does
// either. `blocked` (as opposed to a step actually failing) tells the caller this was a deliberate skip,
// not a wrapper/session failure that might still have started a worker underneath it.
//
// `phase` on the result is the caller's write-ahead signal for what to trust: 'queued' means no step ever
// actually ran (a pure queue-not-started refusal — safe to treat as if this attempt never touched anything).
// 'session_creating' and 'launching' both mean at least one effect already ran (a session step, or the run
// step) before the plan stopped, whether it stopped by a later recheck's refusal, a persistence failure, or
// a step failing outright — a blocked result at either phase is not proof nothing started (a session step
// can create a real, possibly billable resource upstream even though the run step that would have used it
// never fired), so the caller must treat anything other than 'queued' the same cautious way, not just
// 'launching'. `session` carries whatever was captured from a session step: a real id, or `unknown: true` if
// the step reported success without one to capture (never silently treated as "no session exists").
//
// `onPhase`, when given, is the write-ahead persistence hook: it is awaited immediately before a step's own
// effect actually runs (once for 'session_creating' before the session effect, once for 'launching' before
// the run effect — never both for the same step) and again right after a session step resolves (the binding
// to persist). Each call happens strictly before the effect it announces, so a crash between the write-ahead
// call and the effect itself still leaves a durable record that it was attempted. If onPhase itself throws
// (the caller could not durably persist the phase — a stale attempt, a disk error), the step it would have
// gated never runs: the plan stops there, `blocked: true`, at whatever phase was last durably persisted, so
// the caller never spawns an effect it could not first write down.
export async function executePlan(config, plan, { name, runners = {}, recheck, onPhase = () => {} } = {}) {
  const logFile = path.join(config.paths.data, 'dispatch', `${name}.log`);
  const run = runners.run || ((step) => runScript(config, step, logFile));
  const session = runners.session || ((step) => runSession(config, step));
  let phase = 'queued';
  let sessionBinding = null;
  for (const step of plan) {
    if (recheck) {
      // recheck reads live state (the roster, the filesystem, canDispatch's own rules) to decide whether this
      // step may still spawn — an unexpected throw from any of that (not merely `verdict.ok === false`) is
      // exactly as uninformative about whether an earlier step already ran as any other ambiguous failure
      // here, and must be handled the same way: a blocked result the caller judges by `phase`, never a
      // rejection left to escape this function. Left unguarded, that rejection would propagate straight out
      // of executePlan itself, past every phase-aware branch below, to whatever generic top-level `.catch`
      // the caller has — which is exactly the false failed/free-the-slot shape this module exists to prevent.
      let verdict;
      try {
        verdict = await recheck(step);
      } catch (error) {
        verdict = { ok: false, detail: `复查出错，这次不派遣了：${error.message}` };
      }
      if (!verdict.ok) return { ok: false, blocked: true, logFile, detail: verdict.detail, phase, session: sessionBinding };
    }
    const nextPhase = step.kind === 'session' ? 'session_creating' : 'launching';
    if (phase !== nextPhase) {
      try {
        await onPhase(nextPhase, step);
      } catch (error) {
        return { ok: false, blocked: true, logFile, detail: `阶段记录失败，这一步不会执行：${error.message}`, phase, session: sessionBinding, persistFailed: true };
      }
      phase = nextPhase;
    }
    // A step that throws (a spawn crash, a rejected promise from a test double) is exactly as ambiguous as
    // one that resolves with a nonzero code: onPhase's write-ahead already ran for this step, so the caller
    // must still get a normal blocked/failed result to reason about, never an unhandled rejection that skips
    // straight past the phase/session bookkeeping below.
    let result;
    try {
      result = step.kind === 'session' ? await session(step) : await run(step);
    } catch (error) {
      result = { code: 1, error: error.message, thrown: true };
    }
    if (step.kind === 'session') {
      // A nonzero code (a bad exit, an execFile timeout) or a caught throw is not proof nothing happened
      // upstream — the process may have started and created a real resource before failing to report its id
      // back. Only a captured id is ever treated as known; anything else stays unknown, never silently
      // narrowed to "definitely no session" just because the step didn't succeed cleanly.
      // saveFailed (distinct from `unknown`): the session step itself reported a real id, but its own write to
      // saveTo never landed (runSession's own captured id + save-failure signal, see below) — a fact worth
      // persisting in its own right, never collapsed into "unknown", which means the opposite: no id was ever
      // captured at all. Only added to the binding when actually true, so every other, unaffected path's
      // session shape is untouched.
      sessionBinding = { id: result.session || null, saveTo: step.saveTo, unknown: !result.session, ...(result.saveFailed === true ? { saveFailed: true } : {}) };
      try {
        await onPhase('session', sessionBinding);
      } catch (error) {
        return { ok: false, blocked: true, logFile, detail: `session 绑定记录失败：${error.message}`, phase, session: sessionBinding, persistFailed: true };
      }
    }
    if (result.code !== 0) {
      const label = result.thrown ? '抛出异常' : `退出码 ${result.code}`;
      // neverStarted only ever comes from runScript's own spawn-level catch (see dispatch.js above) — a
      // caught throw from an arbitrary runner (a test double, a third-party override) is exactly as
      // ambiguous as a plain nonzero exit and must never be folded into this signal.
      return { ok: false, logFile, detail: `${step.command[0]} ${label}${result.error ? `：${result.error}` : ''}\n${tail(logFile)}`.trim(), phase, session: sessionBinding, neverStarted: result.neverStarted === true };
    }
  }
  return { ok: true, logFile, detail: tail(logFile, 400), session: sessionBinding };
}
