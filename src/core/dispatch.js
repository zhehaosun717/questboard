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

export function workerName(quest) {
  const base = quest.id.toLowerCase().replace(/[^a-z0-9]/g, '');
  const count = (quest.dispatches || []).length;
  return count ? `${base}_${count + 1}` : base;
}

export function planDispatch(config, quest, adventurer, name) {
  const lane = config.lanes[adventurer.lane];
  if (!lane) throw new Error(`this project has no lane ${adventurer.lane}`);
  const values = { name, brief: quest.brief, model: adventurer.model, variant: adventurer.variant, agent: adventurer.agent, package: quest.id };
  const field = `lanes.${adventurer.lane}`;
  const env = lane.env ? Object.fromEntries(Object.entries(lane.env).map(([k, v]) => [k, fillTemplate([v], values, `${field}.env.${k}`)[0]])) : {};
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
      finish({ code: -1, error: error.message });
      return;
    }
    child.on('error', (error) => finish({ code: -1, error: error.message }));
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
      fs.mkdirSync(path.dirname(path.join(config.root, step.saveTo)), { recursive: true });
      fs.writeFileSync(path.join(config.root, step.saveTo), id, 'utf8');
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

export async function executePlan(config, plan, { name, runners = {} } = {}) {
  const logFile = path.join(config.paths.data, 'dispatch', `${name}.log`);
  const run = runners.run || ((step) => runScript(config, step, logFile));
  const session = runners.session || ((step) => runSession(config, step));
  for (const step of plan) {
    const result = step.kind === 'session' ? await session(step) : await run(step);
    if (result.code !== 0) {
      return { ok: false, logFile, detail: `${step.command[0]} 退出码 ${result.code}${result.error ? `：${result.error}` : ''}\n${tail(logFile)}`.trim() };
    }
  }
  return { ok: true, logFile, detail: tail(logFile, 400) };
}
