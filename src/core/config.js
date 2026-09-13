// Project configuration: everything that differs between game projects lives in questboard.config.json
// at the project root — where briefs are, how each lane is started, which models the project's scripts
// refuse. Missing or malformed config fails loudly and names the field.
import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE = 'questboard.config.json';
const PLACEHOLDER = /\{([a-z]+)\}/g;
const PLACEHOLDERS = new Set(['name', 'brief', 'model', 'variant', 'agent', 'package']);
const LANE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const EDIT_COUNTERS = new Set(['patch', 'stream-json', 'none']);

function fail(message) {
  throw new Error(`questboard config: ${message}`);
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) fail(`${field} must be a non-empty string`);
  return value;
}

function stringList(value, field, fallback) {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) fail(`${field} must be an array of non-empty strings`);
  return value;
}

function regex(source, field, flags = '') {
  try {
    return new RegExp(requireString(source, field), flags);
  } catch (error) {
    return fail(`${field} is not a valid regular expression: ${error.message}`);
  }
}

function checkTemplate(args, field) {
  if (!Array.isArray(args) || !args.length || args.some((arg) => typeof arg !== 'string')) fail(`${field} must be a non-empty array of strings`);
  for (const arg of args) {
    for (const [, key] of arg.matchAll(PLACEHOLDER)) {
      if (!PLACEHOLDERS.has(key)) fail(`${field} uses unknown placeholder {${key}}; allowed: ${[...PLACEHOLDERS].map((p) => `{${p}}`).join(' ')}`);
    }
  }
  return args;
}

function validateLane(id, lane) {
  const field = `lanes.${id}`;
  if (!LANE_ID.test(id)) fail(`${field}: lane ids must match ${LANE_ID}`);
  if (!lane || typeof lane !== 'object') fail(`${field} must be an object`);
  const result = { id, run: checkTemplate(lane.run, `${field}.run`) };
  if (lane.session !== undefined) {
    result.session = { run: checkTemplate(lane.session.run, `${field}.session.run`), saveTo: requireString(lane.session.saveTo, `${field}.session.saveTo`) };
  }
  if (lane.env !== undefined) {
    if (!lane.env || typeof lane.env !== 'object' || Object.values(lane.env).some((v) => typeof v !== 'string')) fail(`${field}.env must map names to strings`);
    checkTemplate(Object.values(lane.env).length ? Object.values(lane.env) : [''], `${field}.env`);
    result.env = { ...lane.env };
  }
  if (lane.outputDir === undefined && lane.api === undefined) {
    fail(`${field} needs outputDir (workers that write <name>.out/.exit files) or api (an OpenCode server) so the board can see its workers`);
  }
  if (lane.outputDir !== undefined) result.outputDir = requireString(lane.outputDir, `${field}.outputDir`);
  if (lane.api !== undefined) result.api = requireString(lane.api, `${field}.api`);
  if (lane.deliveryDir !== undefined) result.deliveryDir = requireString(lane.deliveryDir, `${field}.deliveryDir`);
  // The model a lane's script uses when none is recorded; labels old registry rows as "inferred".
  if (lane.defaultModel !== undefined) result.defaultModel = requireString(lane.defaultModel, `${field}.defaultModel`);
  result.serialize = lane.serialize === undefined ? false : Boolean(lane.serialize);
  result.spacingMs = lane.spacingMs === undefined ? 0 : lane.spacingMs;
  if (!Number.isInteger(result.spacingMs) || result.spacingMs < 0) fail(`${field}.spacingMs must be a non-negative integer`);
  result.editCounter = lane.editCounter === undefined ? 'patch' : lane.editCounter;
  if (!EDIT_COUNTERS.has(result.editCounter)) fail(`${field}.editCounter must be one of ${[...EDIT_COUNTERS].join('|')}`);
  return result;
}

export function resolveConfig(root, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('the file must hold a JSON object');
  const base = path.resolve(root);
  const abs = (value, field) => path.resolve(base, requireString(value, field));
  if (!raw.lanes || typeof raw.lanes !== 'object' || !Object.keys(raw.lanes).length) fail('lanes must define at least one lane');
  const briefs = raw.briefs || {};
  const port = raw.port === undefined ? 6097 : raw.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('port must be an integer from 1 to 65535');
  const dataDir = raw.dataDir === undefined ? '.questboard-data' : raw.dataDir;
  return {
    root: base,
    name: requireString(raw.name, 'name'),
    port,
    paths: {
      data: abs(dataDir, 'dataDir'),
      events: abs(raw.events === undefined ? path.join(dataDir, 'events.jsonl') : raw.events, 'events'),
      registry: abs(raw.registry === undefined ? path.join(dataDir, 'registry.jsonl') : raw.registry, 'registry'),
      lock: abs(raw.lockFile === undefined ? path.join(dataDir, 'dispatch.lock') : raw.lockFile, 'lockFile'),
    },
    briefs: {
      dispatchDirs: stringList(briefs.dispatchDirs, 'briefs.dispatchDirs', ['docs/briefs']),
      ownerDirs: stringList(briefs.ownerDirs, 'briefs.ownerDirs', stringList(briefs.dispatchDirs, 'briefs.dispatchDirs', ['docs/briefs'])),
      packagePattern: regex(briefs.packagePattern || '^[A-Z]+(?:-[A-Z]+)*-\\d+[A-Z]?', 'briefs.packagePattern'),
      fileListHeading: regex(briefs.fileListHeading || '^#{1,6}\\s*files you may (edit|touch)', 'briefs.fileListHeading', 'i'),
      recentDays: briefs.recentDays === undefined ? 7 : briefs.recentDays,
    },
    reviewPages: raw.reviewPages ? { dir: abs(raw.reviewPages.dir, 'reviewPages.dir'), filePattern: regex(raw.reviewPages.filePattern || '^review_.+\\.html$', 'reviewPages.filePattern') } : null,
    verification: raw.verification ? { progressDirs: stringList(raw.verification.progressDirs, 'verification.progressDirs', []).map((dir) => path.resolve(base, dir)) } : null,
    bash: raw.bash === undefined ? null : requireString(raw.bash, 'bash'),
    lanes: Object.fromEntries(Object.entries(raw.lanes).map(([id, lane]) => [id, validateLane(id, lane)])),
    policy: {
      bannedModelPatterns: stringList(raw.policy && raw.policy.bannedModelPatterns, 'policy.bannedModelPatterns', []),
      bannedAgents: stringList(raw.policy && raw.policy.bannedAgents, 'policy.bannedAgents', []),
    },
  };
}

export function findProjectRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadProjectConfig(root) {
  const file = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(file)) fail(`no ${CONFIG_FILE} in ${root}`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return fail(`${file} is not valid JSON: ${error.message}`);
  }
  return resolveConfig(root, raw);
}

// Fills a lane template. A placeholder with no value is an error, not an empty string: an OpenCode send
// without {agent} would fall back to a persona the owner banned.
export function fillTemplate(args, values, field = 'template') {
  return args.map((arg) => arg.replace(PLACEHOLDER, (match, key) => {
    const value = values[key];
    if (value === undefined || value === null || value === '') fail(`${field} needs {${key}} but it has no value`);
    return String(value);
  }));
}
