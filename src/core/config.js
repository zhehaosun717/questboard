// Project configuration: everything that differs between game projects lives in questboard.config.json
// at the project root — where briefs are, how each lane is started, which models the project's scripts
// refuse. Missing or malformed config fails loudly and names the field.
import fs from 'node:fs';
import path from 'node:path';
import { isBrowserUnsafePort } from './browserUnsafePorts.js';
import { ALIBABA_EDITIONS, ALIBABA_REGIONS, MANUAL_PROVIDERS } from '../usage/manualProviders.js';

export const CONFIG_FILE = 'questboard.config.json';
const PLACEHOLDER = /\{([a-z]+)\}/g;
const PLACEHOLDERS = new Set(['name', 'brief', 'model', 'variant', 'agent', 'package']);
const LANE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const EDIT_COUNTERS = new Set(['patch', 'stream-json', 'none']);
// name/brief/model/package are always required and can never be dropped; only these two may control an
// optional argument group (lanes.<id>.optionalArgs — see validateOptionalArgs and fillOptionalArgs below).
const OPTIONAL_ARGS_WHEN = new Set(['variant', 'agent']);
const OPTIONAL_ARGS_GROUP_KEYS = new Set(['when', 'args', 'omitWhen', 'insertAt']);
// Generous but finite ceilings on the parts of optionalArgs a human writes by hand. No real lane declares
// more than a few flags per group or a few omitWhen markers; these stay far above any legitimate use while
// stopping a hand-edited (or scripted) config from turning one dispatch into thousands of spliced argv
// elements — the settings page's 1 MB HTTP body cap (http.js) does not apply to a file edited outside it.
const MAX_OPTIONAL_ARGS_GROUPS = 20;
const MAX_ARGS_PER_GROUP = 20;
const MAX_OMIT_WHEN = 20;
// Comfortably longer than any real flag value (a path, a model name, a short id) yet far short of Windows'
// ~32K total command-line length, so one oversized argument can never by itself blow past that OS limit.
const MAX_ARG_LENGTH = 4096;

const KNOWN_MANUAL_PROVIDER_IDS = new Set(MANUAL_PROVIDERS.map((provider) => provider.id));

function fail(message) {
  throw new Error(`questboard config: ${message}`);
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) fail(`${field} must be a non-empty string`);
  return value;
}

// The one board-port validator: range, finiteness and the browser-unsafe list, all in Chinese. Used by
// resolveConfig for the config file's own `port` field, and by the CLI's `--port` override (src/cli/commands.js)
// and startServer's `options.port` (src/server/server.js) so an invalid override is refused the same way
// before anything starts or binds, never silently replaced with a fallback.
export function validateBoardPort(port, field = 'port') {
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`${field} 必须是 1 到 65535 之间的整数`);
  if (isBrowserUnsafePort(port)) fail(`${field} ${port} 浏览器会直接拒绝连接（这是 Fetch 规范里的禁用端口），换一个端口，比如默认的 6097`);
  return port;
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

// A lane's optional argument groups: each one is a flag(+value) block that is appended (or inserted) to
// `run` only when its controlling placeholder (variant or agent) actually has a value on the card doing the
// dispatch — dropped as a whole, never partially, when that value is absent or explicitly listed in
// omitWhen. Lanes that omit optionalArgs entirely are unaffected: fillOptionalArgs is a no-op for them, so
// every existing lane keeps behaving byte-for-byte as before this field existed.
function validateOptionalArgs(optionalArgs, run, field) {
  if (!Array.isArray(optionalArgs)) fail(`${field} must be an array`);
  if (optionalArgs.length > MAX_OPTIONAL_ARGS_GROUPS) fail(`${field} must have at most ${MAX_OPTIONAL_ARGS_GROUPS} groups`);
  return optionalArgs.map((group, index) => {
    const gf = `${field}[${index}]`;
    if (!group || typeof group !== 'object' || Array.isArray(group)) fail(`${gf} must be an object`);
    // Unlike the config file's own top-level fields (preserved verbatim by saveProjectConfig even when
    // resolveConfig does not recognize them), a group here exists only to control argv — a misspelled key
    // such as `omitwhen` would silently do nothing while looking configured, so it is refused, not ignored.
    for (const key of Object.keys(group)) {
      if (!OPTIONAL_ARGS_GROUP_KEYS.has(key)) fail(`${gf} has unknown field ${key}; allowed: ${[...OPTIONAL_ARGS_GROUP_KEYS].join(', ')}`);
    }
    if (!OPTIONAL_ARGS_WHEN.has(group.when)) fail(`${gf}.when must be one of ${[...OPTIONAL_ARGS_WHEN].join('|')}`);
    const args = checkTemplate(group.args, `${gf}.args`);
    if (args.length > MAX_ARGS_PER_GROUP) fail(`${gf}.args must have at most ${MAX_ARGS_PER_GROUP} elements`);
    for (const arg of args) {
      if (arg.length > MAX_ARG_LENGTH) fail(`${gf}.args elements must be at most ${MAX_ARG_LENGTH} characters`);
    }
    if (!args.some((arg) => arg.includes(`{${group.when}}`))) fail(`${gf}.args must use {${group.when}} somewhere, or the group could never tell whether it was supplied`);
    // stringList already refuses a whitespace-only entry (a real, non-empty argv value must never be
    // silently trimmed down to something that could accidentally collide with one) so an ambiguous
    // omitWhen marker like `" "` fails loudly here instead of quietly matching nothing, or everything.
    const omitWhen = group.omitWhen === undefined ? [] : stringList(group.omitWhen, `${gf}.omitWhen`, []);
    if (omitWhen.length > MAX_OMIT_WHEN) fail(`${gf}.omitWhen must have at most ${MAX_OMIT_WHEN} entries`);
    for (const value of omitWhen) {
      if (value.length > MAX_ARG_LENGTH) fail(`${gf}.omitWhen entries must be at most ${MAX_ARG_LENGTH} characters`);
    }
    if (new Set(omitWhen).size !== omitWhen.length) fail(`${gf}.omitWhen must not repeat a value`);
    const insertAt = group.insertAt === undefined ? run.length : group.insertAt;
    // Position 0 of `run` is always the lane's own script/binary (dispatch.js's resolveCommand reads
    // command[0] as the executable unconditionally) — inserting before it would silently turn a flag into
    // the program questboard tries to spawn, so the lowest legal position is 1, not 0. For a `node` lane,
    // resolveCommand also reads command[1] unconditionally as the script to hand to this Node binary, so
    // insertAt 1 would push that script to position 2 and hand Node a flag as its script instead — the
    // lowest legal position there is 2.
    const minInsertAt = run[0] === 'node' ? 2 : 1;
    if (!Number.isInteger(insertAt) || insertAt < minInsertAt || insertAt > run.length) {
      const why = run[0] === 'node' ? `position 0 is always node, position 1 is always its script` : `position 0 is always the lane's own command`;
      fail(`${gf}.insertAt must be an integer between ${minInsertAt} and ${run.length} (${why})`);
    }
    return { when: group.when, args, omitWhen, insertAt };
  });
}

// T5 in the audit: a placeholder cannot be required in one template surface and optional in another — the
// meaning would be contradictory (fillTemplate would refuse the very same dispatch that fillOptionalArgs
// just decided to skip supplying a value for). Checked once, against every surface the lane actually has.
function checkOptionalOverlap(id, field, optionalArgs, result) {
  const surfaces = [[`lanes.${id}.run`, result.run]];
  if (result.session) surfaces.push([`lanes.${id}.session.run`, result.session.run], [`lanes.${id}.session.saveTo`, [result.session.saveTo]]);
  if (result.env) surfaces.push([`lanes.${id}.env`, Object.values(result.env)]);
  for (const group of optionalArgs) {
    const placeholder = `{${group.when}}`;
    for (const [surfaceField, strings] of surfaces) {
      if (strings.some((s) => s.includes(placeholder))) fail(`${field} makes ${placeholder} optional, but ${surfaceField} still requires it — a placeholder cannot be both required and optional`);
    }
  }
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
  // The command that starts a server lane's server (e.g. `opencode serve --port 6096`), so the board can start
  // it when nothing answers at api. It runs once for the lane, not per quest, so it takes no placeholders.
  if (lane.serve !== undefined) {
    if (lane.api === undefined) fail(`${field}.serve starts the lane's server, so the lane also needs api`);
    result.serve = checkTemplate(lane.serve, `${field}.serve`);
    if (result.serve.some((arg) => /\{[a-z]+\}/.test(arg))) fail(`${field}.serve runs once for the whole lane, so it cannot use placeholders`);
  }
  // Optional: how the board tells this lane's server is actually healthy, not just "something answered".
  // Without it, the board keeps its long-standing behaviour of treating any HTTP reply as reachable — custom
  // lanes whose response shape is unknown stay compatible, and the board never guesses a provider's contract.
  if (lane.health !== undefined) {
    if (lane.api === undefined) fail(`${field}.health checks the lane's server, so the lane also needs api`);
    if (!lane.health || typeof lane.health !== 'object' || Array.isArray(lane.health)) fail(`${field}.health must be an object`);
    // checkServerHealth joins api and health.path by plain concatenation (`${api}${path}`). A trailing / on
    // api, or a ? or # anywhere in it, makes that join ambiguous (`//global/health`, `?x=1/global/health`,
    // `#frag/global/health`) and can turn a healthy server into a false conflict. Reject rather than guess.
    if (/\/$/.test(lane.api)) fail(`${field}.health needs api without a trailing /, since it is joined directly with health.path: ${lane.api}`);
    if (/[?#]/.test(lane.api)) fail(`${field}.health needs api without a query or fragment, since it is joined directly with health.path: ${lane.api}`);
    const healthPath = requireString(lane.health.path, `${field}.health.path`);
    if (!healthPath.startsWith('/')) fail(`${field}.health.path must start with /`);
    if (healthPath.startsWith('//') || healthPath.includes('\\')) fail(`${field}.health.path must be a plain path, not // or contain \\: ${healthPath}`);
    result.health = { path: healthPath };
    if (lane.health.json !== undefined) {
      if (!lane.health.json || typeof lane.health.json !== 'object' || Array.isArray(lane.health.json)) fail(`${field}.health.json must be an object of expected fields`);
      // Expected values are compared with `!==`, so an object or array here could never match (reference
      // equality) and would silently make the lane permanently unhealthy. Primitives only.
      for (const [key, value] of Object.entries(lane.health.json)) {
        if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
          fail(`${field}.health.json.${key} must be a string, number, boolean, or null`);
        }
      }
      result.health.json = { ...lane.health.json };
    }
  }
  if (lane.deliveryDir !== undefined) result.deliveryDir = requireString(lane.deliveryDir, `${field}.deliveryDir`);
  // The model a lane's script uses when none is recorded; labels old registry rows as "inferred".
  if (lane.defaultModel !== undefined) result.defaultModel = requireString(lane.defaultModel, `${field}.defaultModel`);
  result.serialize = lane.serialize === undefined ? false : Boolean(lane.serialize);
  result.spacingMs = lane.spacingMs === undefined ? 0 : lane.spacingMs;
  if (!Number.isInteger(result.spacingMs) || result.spacingMs < 0) fail(`${field}.spacingMs must be a non-negative integer`);
  result.editCounter = lane.editCounter === undefined ? 'patch' : lane.editCounter;
  if (!EDIT_COUNTERS.has(result.editCounter)) fail(`${field}.editCounter must be one of ${[...EDIT_COUNTERS].join('|')}`);
  if (lane.optionalArgs !== undefined) {
    result.optionalArgs = validateOptionalArgs(lane.optionalArgs, result.run, `${field}.optionalArgs`);
    checkOptionalOverlap(id, `${field}.optionalArgs`, result.optionalArgs, result);
  }
  return result;
}

// A folder that lexically escapes the project root can never be safely scanned or written into (its
// contents would go to a third-party model, or a write would land outside the project) — refused loudly
// here, at config-validation time, rather than silently discovered later as an empty/broken folder. This
// only catches what pure path arithmetic can see (a literal ".." or an absolute path elsewhere); a folder
// that only resolves outside via a symlink or junction still passes here and is caught at read/dispatch
// time instead (patterns.js briefPathAllowed, briefs.js discoverBriefs/fileSetFor) — the per-folder "项目外"
// diagnostic those report is expected even for an otherwise-valid config, and is not a config error itself.
function checkBriefDirs(base, dirs, field) {
  for (const dir of dirs) {
    const issue = lexicalContainmentIssue(base, dir);
    if (issue) fail(`${field} 的 ${dir} 不合法：${issue}`);
  }
  return dirs;
}

// An Alibaba choice must be exactly one of the fixed allowlisted values (trimmed, case-folded) or the
// whole config is refused: a value the owner wrote that is not accepted is never silently turned into
// "unknown" — the failure names the field in Chinese so the settings page can point at it. The rejected
// value itself is never repeated back.
function validateAlibabaChoice(value, allowlist, field, label) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : null;
  if (normalized === null || !allowlist.has(normalized)) {
    fail(`${field} 不是有效的${label}，可选：${[...allowlist].join('、')}`);
  }
  return normalized;
}

function validateUsageConfig(rawUsage) {
  if (rawUsage === undefined) return { manualProviders: [] };
  if (!rawUsage || typeof rawUsage !== 'object' || Array.isArray(rawUsage)) {
    fail('usage must be an object');
  }
  let manualProviders = [];
  if (rawUsage.manualProviders !== undefined) {
    if (!Array.isArray(rawUsage.manualProviders)) {
      fail('usage.manualProviders must be an array');
    }
    for (const item of rawUsage.manualProviders) {
      if (typeof item !== 'string' || !item.trim()) {
        fail('usage.manualProviders entries must be non-empty strings');
      }
      const id = item.trim();
      if (!KNOWN_MANUAL_PROVIDER_IDS.has(id)) {
        fail(`未知的用量来源：${id}`);
      }
      if (!manualProviders.includes(id)) {
        manualProviders.push(id);
      }
    }
  }
  const result = { manualProviders };
  if (rawUsage.alibaba !== undefined) {
    if (!rawUsage.alibaba || typeof rawUsage.alibaba !== 'object' || Array.isArray(rawUsage.alibaba)) {
      fail('usage.alibaba must be an object');
    }
    result.alibaba = {
      edition: validateAlibabaChoice(rawUsage.alibaba.edition, ALIBABA_EDITIONS, 'usage.alibaba.edition', '阿里云版本'),
      region: validateAlibabaChoice(rawUsage.alibaba.region, ALIBABA_REGIONS, 'usage.alibaba.region', '阿里云区域'),
    };
  }
  return result;
}

export function resolveConfig(root, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('the file must hold a JSON object');
  const base = path.resolve(root);
  const abs = (value, field) => path.resolve(base, requireString(value, field));
  if (!raw.lanes || typeof raw.lanes !== 'object' || !Object.keys(raw.lanes).length) fail('lanes must define at least one lane');
  const briefs = raw.briefs || {};
  const port = raw.port === undefined ? 6097 : raw.port;
  // A browser refuses to open the board at all on a blocked port (see src/core/browserUnsafePorts.js) — the
  // port would "work" (the server listens fine) but every tab would just show a connection-refused page.
  validateBoardPort(port);
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
      dispatchDirs: checkBriefDirs(base, stringList(briefs.dispatchDirs, 'briefs.dispatchDirs', ['docs/briefs']), 'briefs.dispatchDirs'),
      ownerDirs: checkBriefDirs(base, stringList(briefs.ownerDirs, 'briefs.ownerDirs', stringList(briefs.dispatchDirs, 'briefs.dispatchDirs', ['docs/briefs'])), 'briefs.ownerDirs'),
      packagePattern: regex(briefs.packagePattern || '^[A-Z]+(?:-[A-Z]+)*-\\d+[A-Z]?', 'briefs.packagePattern'),
      fileListHeading: regex(briefs.fileListHeading || '^#{1,6}\\s*files you may (edit|touch)', 'briefs.fileListHeading', 'i'),
      recentDays: briefs.recentDays === undefined ? 7 : briefs.recentDays,
    },
    reviewPages: raw.reviewPages ? { dir: abs(raw.reviewPages.dir, 'reviewPages.dir'), filePattern: regex(raw.reviewPages.filePattern || '^review_.+\\.html$', 'reviewPages.filePattern') } : null,
    verification: raw.verification ? { progressDirs: stringList(raw.verification.progressDirs, 'verification.progressDirs', []).map((dir) => path.resolve(base, dir)) } : null,
    bash: raw.bash === undefined ? null : requireString(raw.bash, 'bash'),
    // No prototype: `config.lanes[name]` is asked with names from briefs, rosters and requests, and
    // "constructor" must not count as a lane.
    lanes: Object.assign(Object.create(null), Object.fromEntries(Object.entries(raw.lanes).map(([id, lane]) => [id, validateLane(id, lane)]))),
    policy: {
      bannedModelPatterns: stringList(raw.policy && raw.policy.bannedModelPatterns, 'policy.bannedModelPatterns', []),
      bannedAgents: stringList(raw.policy && raw.policy.bannedAgents, 'policy.bannedAgents', []),
    },
    usage: validateUsageConfig(raw.usage),
  };
}

const KEEP_CONFIG_BACKUPS = 8;

// Writes a new project config, but only after it passes the same validation the board starts with: a board
// that refuses to start is worse than a setting you could not change from the page. The previous file is kept
// as a timestamped backup, newest eight.
export function saveProjectConfig(root, raw, { now = Date.now() } = {}) {
  const resolved = resolveConfig(root, raw);
  const file = path.join(root, CONFIG_FILE);
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, `${file}.bak-${new Date(now).toISOString().replace(/[:.]/g, '-')}`);
    const prefix = `${CONFIG_FILE}.bak-`;
    const old = fs.readdirSync(root).filter((name) => name.startsWith(prefix)).sort().reverse().slice(KEEP_CONFIG_BACKUPS);
    for (const name of old) fs.rmSync(path.join(root, name), { force: true });
  }
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  return resolved;
}

// The file as written, which is what the settings page edits; resolveConfig's output has absolute paths and
// compiled patterns and cannot be written back.
export function readRawConfig(root) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
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

// A configured brief folder must stay inside the project root, checked two different ways at two different
// times. This one is pure path arithmetic (no filesystem access), so it can run even before the folder
// exists — at POST time (briefPathAllowed) a brief a few lines away from being written should not need to
// already be on disk to be validated, and resolveConfig itself runs long before any of a project's briefs
// folders may have been created. It catches a literal ".." or an absolute path pointing outside root.
export function lexicalContainmentIssue(root, dir) {
  const base = path.resolve(root);
  const resolved = path.resolve(base, dir);
  const same = process.platform === 'win32' ? resolved.toLowerCase() === base.toLowerCase() : resolved === base;
  const inside = process.platform === 'win32'
    ? resolved.toLowerCase().startsWith(`${base.toLowerCase()}${path.sep}`)
    : resolved.startsWith(`${base}${path.sep}`);
  return same || inside ? null : `配置目录在项目外（相对路径逃逸）：${dir}`;
}

// The filesystem-backed half: realpath the root and the nearest EXISTING ancestor of the target, then
// rejoin whatever suffix of the path does not exist yet (a folder about to be scanned or written into may
// not exist at all, or may exist only partway down). Only this half catches a symlink or Windows junction
// that resolves outside the project — lexicalContainmentIssue alone cannot, since the string alone looks
// contained. Re-run at read and dispatch time, not only once at post time, because the target on disk (a
// junction's destination, a folder that gets created later) can change after the first check ever ran.
export function realpathContainmentIssue(root, absoluteTarget) {
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return '项目根目录不可读';
  }
  let current = path.resolve(absoluteTarget);
  const suffix = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) { suffix.length = 0; current = path.resolve(absoluteTarget); break; }
    suffix.unshift(path.basename(current));
    current = parent;
  }
  let realAncestor;
  try {
    realAncestor = fs.realpathSync(current);
  } catch (err) {
    return `目录不可读（${err.code || err.message}）`;
  }
  const realTarget = suffix.length ? path.join(realAncestor, ...suffix) : realAncestor;
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const rootN = norm(realRoot);
  const targetN = norm(realTarget);
  if (targetN === rootN || targetN.startsWith(`${rootN}${path.sep}`)) return null;
  return '目录在项目外（符号链接或联接点逃逸）';
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

// Splices a lane's optionalArgs groups into its (still unfilled) run template, in insertAt order — groups
// sharing an insertAt keep the order they were declared in, each landing right after the previous one. A
// group is dropped as a whole (never partially) when its controlling value is exactly absent (undefined,
// null or '', the same emptiness fillTemplate itself treats as "no value") or exactly matches one of its
// own omitWhen entries — a real value is never trimmed or otherwise guessed at (a whitespace-only variant,
// for instance, is a real, if unusual, value and passes through untouched, not treated as absent). Kept
// groups stay as raw placeholder strings; the caller's own fillTemplate call substitutes them along with the
// rest of the array, so a group's non-{when} placeholders (e.g. {name}) stay exactly as strictly required as
// they already were, with one shared, already-tested error message shape.
export function fillOptionalArgs(run, optionalArgs, values) {
  if (!optionalArgs || !optionalArgs.length) return run;
  const ordered = optionalArgs.map((group, order) => ({ group, order })).sort((a, b) => (a.group.insertAt - b.group.insertAt) || (a.order - b.order));
  const result = [...run];
  let offset = 0;
  for (const { group } of ordered) {
    const value = values[group.when];
    const absent = value === undefined || value === null || value === '';
    if (absent || group.omitWhen.includes(value)) continue;
    result.splice(group.insertAt + offset, 0, ...group.args);
    offset += group.args.length;
  }
  return result;
}
