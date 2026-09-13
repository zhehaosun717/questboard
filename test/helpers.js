// Shared fixtures: a temporary project with a config, and a small roster of cards.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig, CONFIG_FILE } from '../src/core/config.js';

export const tmpDir = (prefix = 'qb-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

export const LANES = {
  codex: { run: ['tools/codex-run.sh', '{name}', '{brief}', '{model}', '{variant}'], outputDir: '.work/codex' },
  claude: { run: ['tools/claude-run.sh', '{name}', '{brief}', '{model}', '{variant}'], outputDir: '.work/claude', editCounter: 'stream-json' },
  agy: { run: ['tools/agy-run.sh', '{name}', '{brief}', '{model}', '{variant}'], outputDir: '.work/agy', defaultModel: 'gemini-3.8-flash-high' },
  dsh: { run: ['tools/dsh-run.sh', '{name}', '{brief}'], outputDir: '.work/dsh', spacingMs: 0 },
  opencode: {
    session: { run: ['node', 'tools/oc.js', 'new', '{package} {name}'], saveTo: '.work/oc_session_{name}.txt' },
    run: ['tools/oc-send.sh', '{name}', '{brief}', '{model}', '{variant}'],
    env: { OC_AGENT: '{agent}' },
    api: 'http://oc.test',
    deliveryDir: '.work/oc',
    serialize: true,
  },
};

export function makeProject(overrides = {}) {
  const root = tmpDir('qb-project-');
  fs.mkdirSync(path.join(root, 'docs', 'briefs'), { recursive: true });
  const raw = {
    name: 'Test Game',
    lanes: LANES,
    briefs: { ownerDirs: ['docs/design'] },
    policy: { bannedModelPatterns: ['-fast(\\b|-)', 'gpt-5\\.5'], bannedAgents: ['Sisyphus'] },
    ...overrides,
  };
  const config = resolveConfig(root, raw);
  // On disk too, so processes that load the config from the project folder (CLI, MCP) see the same project.
  fs.writeFileSync(path.join(root, CONFIG_FILE), JSON.stringify(raw, null, 2));
  const write = (relative, text) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  return { root, config, write };
}

export const CARDS = [
  { id: 'codex-luna', name: 'Luna', provider: 'OpenAI Codex', lane: 'codex', model: 'gpt-5.6-luna', family: 'gpt-5.6-luna', variant: 'high', maxParallel: 1, strengths: ['code', 'review'], status: 'available' },
  { id: 'codex-astra', name: 'Astra', provider: 'OpenAI Codex', lane: 'codex', model: 'gpt-6-astra', family: 'gpt-6-astra', variant: 'high', maxParallel: 1, strengths: ['art'], status: 'available' },
  { id: 'agy-gemini', name: 'Gemini', provider: 'Google agy', lane: 'agy', model: 'gemini-3.8-flash-high', family: 'gemini-3.8-flash', variant: 'high', maxParallel: 2, strengths: ['review'], status: 'available' },
  { id: 'oc-mimo', name: 'MiMo', provider: 'Xiaomi', lane: 'opencode', model: 'xiaomi/mimo-v2.5-pro', family: 'mimo-v2.5-pro', variant: 'high', agent: 'build', maxParallel: 2, strengths: ['code'], status: 'available' },
  { id: 'oc-deepseek', name: 'DeepSeek', provider: 'DeepSeek', lane: 'opencode', model: 'deepseek/deepseek-v4-pro', family: 'deepseek-v4-pro', variant: 'max', agent: 'build', maxParallel: 1, strengths: ['code'], status: 'available' },
  { id: 'oc-nv-deepseek', name: 'DeepSeek NV', provider: 'NVIDIA', lane: 'opencode', model: 'nvidia/deepseek-ai/deepseek-v4-pro-0813', family: 'deepseek-v4-pro', variant: 'high', agent: 'build', maxParallel: 1, strengths: ['code'], status: 'available' },
  { id: 'dsh-deepseek', name: 'DeepSeek Harness', provider: 'DeepSeek dsh', lane: 'dsh', model: 'deepseek-harness', family: 'deepseek-harness', maxParallel: 1, strengths: ['code'], status: 'available' },
];

export const card = (id, overrides = {}) => ({ ...CARDS.find((c) => c.id === id), ...overrides });

export function quest(overrides = {}) {
  return { id: 'RUN-4', kind: 'code', status: 'posted', brief: 'docs/briefs/RUN-4-x.md', parents: [], conflicts: [], allowedLanes: [], needsOwner: '', assignee: null, dispatches: [], ...overrides };
}
