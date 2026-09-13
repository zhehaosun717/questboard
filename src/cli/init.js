// `questboard init` — makes a folder ready to use: a project config whose lanes match the agent CLIs actually
// installed on this machine, the generic worker wrapper, a sample brief, and the machine roster.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadRosterOrEmpty, saveRoster } from '../core/roster.js';

export const INSTALL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WRAPPER_SOURCE = path.join(INSTALL_ROOT, 'examples', 'basic', 'scripts', 'run-worker.mjs');
const SAMPLE_BRIEF = path.join(INSTALL_ROOT, 'examples', 'basic', 'docs', 'briefs', 'RUN-1-first-task.md');

// Lanes we can write for anyone: each of these CLIs reads its instructions from stdin, which is what the
// wrapper pipes. Verified against their own --help, not from memory.
export const KNOWN_LANES = [
  { id: 'codex', binary: 'codex', provider: 'OpenAI Codex', agentArgs: ['codex', 'exec', '-m', '{model}'] },
  { id: 'claude', binary: 'claude', provider: 'Anthropic', agentArgs: ['claude', '--print', '--model', '{model}'], editCounter: 'stream-json' },
];

// Installed CLIs that take the prompt as an argument or need a session step, so their lane is project-specific.
export const MANUAL_LANE_CLIS = ['opencode', 'agy', 'gemini', 'cursor-agent'];

const LANE_ID = /^[a-z][a-z0-9-]{0,31}$/;

// `--lane aider=aider --model {model}` — anyone's own tool, without hand-editing the config. The command is
// whatever runs the agent; the brief arrives on its stdin, and {model} {variant} {name} {package} are filled.
export function parseLaneFlag(value) {
  const text = String(value === undefined ? '' : value);
  const split = text.indexOf('=');
  if (split <= 0) throw new Error(`--lane needs <name>=<command>, got "${text}"`);
  const id = text.slice(0, split).trim();
  if (!LANE_ID.test(id)) throw new Error(`lane name "${id}" must be lowercase letters, digits or hyphens, starting with a letter`);
  const agentArgs = text.slice(split + 1).trim().split(/\s+/).filter(Boolean);
  if (!agentArgs.length) throw new Error(`lane "${id}" has no command; write --lane ${id}="<the command that runs your agent>"`);
  return { id, agentArgs, custom: true };
}

export function commandExists(name, { platform = process.platform, run = spawnSync } = {}) {
  const finder = platform === 'win32' ? 'where.exe' : 'which';
  try {
    return run(finder, [name], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).status === 0;
  } catch {
    return false;
  }
}

const wrapperRun = (laneId, agentArgs) => [
  'node', 'scripts/run-worker.mjs',
  '--lane', laneId, '--name', '{name}', '--brief', '{brief}', '--model', '{model}', '--variant', '{variant}', '--package', '{package}',
  '--', ...agentArgs,
];

export function buildConfig({ name, port = 6097, lanes }) {
  return {
    name,
    port,
    dataDir: '.questboard-data',
    events: '.questboard-data/events.jsonl',
    registry: '.questboard-data/registry.jsonl',
    lockFile: '.questboard-data/dispatch.lock',
    briefs: {
      dispatchDirs: ['docs/briefs'],
      ownerDirs: ['docs/design'],
      packagePattern: '^[A-Z]+(?:-[A-Z]+)*-\\d+[A-Z]?',
      fileListHeading: '^#{1,6}\\s*files you may (edit|touch)',
      recentDays: 7,
    },
    reviewPages: { dir: 'docs/review' },
    lanes: Object.fromEntries(lanes.map((lane) => [lane.id, {
      run: wrapperRun(lane.id, lane.agentArgs),
      outputDir: `.questboard-data/workers/${lane.id}`,
      ...(lane.editCounter ? { editCounter: lane.editCounter } : {}),
    }])),
    policy: { bannedModelPatterns: [], bannedAgents: [] },
  };
}

function copyIfMissing(source, target, created, root) {
  if (fs.existsSync(target)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  created.push(path.relative(root, target).split(path.sep).join('/'));
}

export function runInit({ dir, name, port = 6097, force = false, home, exists = commandExists, extraLanes = [] } = {}) {
  const root = path.resolve(dir || process.cwd());
  const configFile = path.join(root, 'questboard.config.json');
  if (fs.existsSync(configFile) && !force) throw new Error(`${configFile} exists; pass --force to replace it`);
  if (!fs.existsSync(WRAPPER_SOURCE)) throw new Error(`this questboard install has no ${WRAPPER_SOURCE}; clone the repository rather than copying src/ alone`);

  const detected = KNOWN_LANES.filter((lane) => exists(lane.binary));
  // Lanes the owner named win over a detected one with the same id; the two built-in guesses are a fallback
  // only when nothing else is known, so a named lane never drags in a CLI that is not there.
  const named = new Map(extraLanes.map((lane) => [lane.id, lane]));
  const combined = [...detected.filter((lane) => !named.has(lane.id)), ...named.values()];
  const lanes = combined.length ? combined : KNOWN_LANES;
  const manual = MANUAL_LANE_CLIS.filter((binary) => exists(binary) && !named.has(binary));

  const created = [];
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(configFile, `${JSON.stringify(buildConfig({ name: name || path.basename(root), port, lanes }), null, 2)}\n`, 'utf8');
  created.push('questboard.config.json');
  copyIfMissing(WRAPPER_SOURCE, path.join(root, 'scripts', 'run-worker.mjs'), created, root);
  copyIfMissing(SAMPLE_BRIEF, path.join(root, 'docs', 'briefs', 'RUN-1-first-task.md'), created, root);
  for (const folder of ['docs/design', 'docs/review']) fs.mkdirSync(path.join(root, folder), { recursive: true });

  let rosterCreated = false;
  if (home && !fs.existsSync(home.roster)) {
    saveRoster(home.roster, loadRosterOrEmpty(home.roster));
    rosterCreated = true;
  }

  return {
    root, configFile, created, manual, rosterCreated,
    lanes: lanes.map((l) => l.id),
    detected: detected.filter((l) => !named.has(l.id)).map((l) => l.id),
    custom: [...named.keys()],
    rosterFile: home ? home.roster : null,
  };
}
