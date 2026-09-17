// Project configuration: everything that differs between game projects lives in questboard.config.json
// at the project root — where briefs are, how each lane is started, which models the project's scripts
// refuse. Missing or malformed config fails loudly and names the field.
import fs from 'node:fs';
import path from 'node:path';
import { isBrowserUnsafePort } from './browserUnsafePorts.js';
import { ALIBABA_EDITIONS, ALIBABA_REGIONS, MANUAL_PROVIDERS } from '../usage/manualProviders.js';

export const CONFIG_FILE = 'questboard.config.json';
// The one place the board's default port is a number; everywhere else (init, doctor, the CLI's own
// messages) imports this instead of repeating the literal.
export const DEFAULT_PORT = 6097;
const PLACEHOLDER = /\{([a-z]+)\}/g;
const PLACEHOLDERS = new Set(['name', 'brief', 'model', 'variant', 'agent', 'package', 'role']);
const LANE_ID = /^[a-z][a-z0-9-]{0,31}$/;
// Same shape as a roster card id (src/core/roster.js ID_PATTERN): the roster itself is machine-level, so a
// project config can only promise that the id it names is well-formed, never that the card exists.
const CARD_ID = /^[a-z0-9-]{1,48}$/;
// A structured bounce code: lowercase words joined by underscores, starting with a letter (e.g. rate_limit).
const BOUNCE_CODE = /^[a-z][a-z0-9_]*$/;
const EDIT_COUNTERS = new Set(['patch', 'stream-json', 'none']);
// Vendor-neutral server-lane contracts the board knows how to speak (src/lanes/protocols.js). Only one
// exists today (OpenCode's session API); a lane with `api` and no explicit `protocol` defaults to it so
// every config written before this field existed keeps resolving identically.
const LANE_PROTOCOLS = new Set(['opencode-session']);
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
const HOOK_ID = /^[a-z][a-z0-9_-]{1,40}$/;
const HOOK_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HOOK_KINDS = new Set(['code', 'art', 'review', 'owner']);

const KNOWN_MANUAL_PROVIDER_IDS = new Set(MANUAL_PROVIDERS.map((provider) => provider.id));
const KNOWN_EXPERIMENTAL_PROVIDER_IDS = new Set(['codex-app-server']);

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
  if (isBrowserUnsafePort(port)) fail(`${field} ${port} 浏览器会直接拒绝连接（这是 Fetch 规范里的禁用端口），换一个端口，比如默认的 ${DEFAULT_PORT}`);
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
    const saveTo = requireString(lane.session.saveTo, `${field}.session.saveTo`);
    if (saveTo.includes('{role}')) fail(`${field}.session.saveTo cannot use {role}; the role card is not available in a save path`);
    result.session = { run: checkTemplate(lane.session.run, `${field}.session.run`), saveTo };
  }
  if (lane.roleInPrompt !== undefined) {
    if (typeof lane.roleInPrompt !== 'boolean') fail(`${field}.roleInPrompt must be a boolean`);
    result.roleInPrompt = lane.roleInPrompt;
  }
  if (lane.limits !== undefined) {
    if (!lane.limits || typeof lane.limits !== 'object' || Array.isArray(lane.limits)) fail(`${field}.limits must be an object`);
    const limits = {};
    for (const key of Object.keys(lane.limits)) {
      if (!['maxMessages', 'maxMinutes'].includes(key)) fail(`${field}.limits has unknown field ${key}`);
    }
    for (const key of ['maxMessages', 'maxMinutes']) {
      if (lane.limits[key] === undefined) continue;
      if (!Number.isSafeInteger(lane.limits[key]) || lane.limits[key] <= 0) {
        fail(`${field}.limits.${key} must be a positive integer`);
      }
      limits[key] = lane.limits[key];
    }
    result.limits = limits;
  }
  if (lane.env !== undefined) {
    if (!lane.env || typeof lane.env !== 'object' || Object.values(lane.env).some((v) => typeof v !== 'string')) fail(`${field}.env must map names to strings`);
    for (const [key, value] of Object.entries(lane.env || {})) {
      if (value.includes('{role}')) fail(`${field}.env.${key} cannot use {role}; the role card is never placed in environment variables`);
    }
    checkTemplate(Object.values(lane.env).length ? Object.values(lane.env) : [''], `${field}.env`);
    result.env = { ...lane.env };
  }
  if (lane.outputDir === undefined && lane.api === undefined) {
    fail(`${field} needs outputDir (workers that write <name>.out/.exit files) or api (an OpenCode server) so the board can see its workers`);
  }
  if (lane.outputDir !== undefined) result.outputDir = requireString(lane.outputDir, `${field}.outputDir`);
  if (lane.api !== undefined) result.api = requireString(lane.api, `${field}.api`);
  if (lane.protocol !== undefined && lane.api === undefined) fail(`${field}.protocol 需要先配置 api，没有 api 就没有服务器可以对话`);
  if (lane.api !== undefined) {
    const protocol = lane.protocol === undefined ? 'opencode-session' : requireString(lane.protocol, `${field}.protocol`);
    if (!LANE_PROTOCOLS.has(protocol)) fail(`通道 ${id} 的 protocol「${protocol}」不认识，只接受：${[...LANE_PROTOCOLS].join('、')}`);
    result.protocol = protocol;
  }
  if (lane.control !== undefined) {
    if (!lane.control || typeof lane.control !== 'object' || Array.isArray(lane.control)) fail(`${field}.control must be an object`);
    if (!['generic-wrapper', 'opencode-session'].includes(lane.control.type)) fail(`${field}.control.type must be generic-wrapper or opencode-session`);
    if (lane.control.type === 'opencode-session' && lane.api === undefined) fail(`${field}.control.type opencode-session requires api`);
    result.control = { type: lane.control.type };
  }
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
  if (rawUsage === undefined) return { manualProviders: [], experimentalProviders: [] };
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
  let experimentalProviders = [];
  if (rawUsage.experimentalProviders !== undefined) {
    if (!Array.isArray(rawUsage.experimentalProviders)) {
      fail('usage.experimentalProviders 必须是数组');
    }
    for (const item of rawUsage.experimentalProviders) {
      if (typeof item !== 'string' || !item.trim()) {
        fail('usage.experimentalProviders 条目必须是非空字符串');
      }
      const id = item.trim();
      if (!KNOWN_EXPERIMENTAL_PROVIDER_IDS.has(id)) {
        fail(`未知的用量来源：${id}`);
      }
      if (!experimentalProviders.includes(id)) {
        experimentalProviders.push(id);
      }
    }
  }
  const result = { manualProviders, experimentalProviders };
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

function validateVerificationHooks(rawHooks, base) {
  if (rawHooks === undefined) return [];
  if (!Array.isArray(rawHooks)) fail('verification.hooks must be an array');
  const seen = new Set();
  return rawHooks.map((hook, index) => {
    const field = `verification.hooks[${index}]`;
    if (!hook || typeof hook !== 'object' || Array.isArray(hook)) fail(`${field} must be an object`);
    const id = requireString(hook.id, `${field}.id`);
    if (!HOOK_ID.test(id)) fail(`${field}.id must match /^[a-z][a-z0-9_-]{1,40}$/`);
    if (seen.has(id)) fail(`${field}.id must not repeat`);
    seen.add(id);
    if (!Array.isArray(hook.command) || !hook.command.length || hook.command.some((arg) => typeof arg !== 'string' || !arg.trim())) {
      fail(`${field}.command must be a non-empty array of non-empty strings`);
    }
    if (!Number.isInteger(hook.timeoutSeconds) || hook.timeoutSeconds < 1 || hook.timeoutSeconds > 3600) {
      fail(`${field}.timeoutSeconds must be a positive integer no greater than 3600`);
    }
    const cwd = requireString(hook.cwd, `${field}.cwd`);
    if (cwd.includes('\0') || path.isAbsolute(cwd) || /^[A-Za-z]:/.test(cwd) || cwd.startsWith('\\\\')) {
      fail(`${field}.cwd must be a relative path inside the project`);
    }
    const cwdPath = path.resolve(base, cwd);
    if (lexicalContainmentIssue(base, cwd) || realpathContainmentIssue(base, cwdPath)) {
      fail(`${field}.cwd must resolve inside the project`);
    }
    const envKeys = hook.envKeys === undefined ? [] : hook.envKeys;
    if (!Array.isArray(envKeys) || envKeys.some((key) => typeof key !== 'string' || !HOOK_ENV_KEY.test(key))) {
      fail(`${field}.envKeys must be an array of environment variable names`);
    }
    if (new Set(envKeys).size !== envKeys.length) fail(`${field}.envKeys must not repeat`);
    if (!Array.isArray(hook.kinds) || !hook.kinds.length || hook.kinds.some((kind) => !HOOK_KINDS.has(kind))) {
      fail(`${field}.kinds must be a non-empty subset of code|art|review|owner`);
    }
    if (new Set(hook.kinds).size !== hook.kinds.length) fail(`${field}.kinds must not repeat`);
    if (hook.trigger !== 'delivered') fail(`${field}.trigger must be delivered`);
    if (hook.enabled !== undefined && typeof hook.enabled !== 'boolean') fail(`${field}.enabled must be a boolean`);
    return {
      id,
      command: [...hook.command],
      timeoutSeconds: hook.timeoutSeconds,
      cwd,
      cwdPath,
      envKeys: [...envKeys],
      kinds: [...hook.kinds],
      trigger: 'delivered',
      enabled: hook.enabled === true,
    };
  });
}

function validateVerificationConfig(rawVerification, base) {
  if (!rawVerification) return null;
  if (!rawVerification || typeof rawVerification !== 'object' || Array.isArray(rawVerification)) fail('verification must be an object');
  const progressDirs = stringList(rawVerification.progressDirs, 'verification.progressDirs', []).map((dir) => path.resolve(base, dir));
  return { progressDirs, hooks: validateVerificationHooks(rawVerification.hooks, base) };
}

// The project policy: what the board refuses to dispatch, plus the limits and preferences the owner edits
// on the settings page. Every field is additive and optional — a config file that never mentions any of
// them resolves to exactly the behaviour from before they existed (stall after 20 minutes, no per-lane
// limit, no preferred lane or card, no extra bounce patterns). Unknown policy keys are not touched here;
// saveProjectConfig writes the raw file object back, so they survive a save untouched.
function validatePolicyConfig(rawPolicy, laneIds) {
  if (rawPolicy !== undefined && (!rawPolicy || typeof rawPolicy !== 'object' || Array.isArray(rawPolicy))) fail('policy must be an object');
  const policy = rawPolicy || {};
  const laneConcurrency = Object.create(null); // no prototype: lane names are asked as plain keys
  const result = {
    bannedModelPatterns: stringList(policy.bannedModelPatterns, 'policy.bannedModelPatterns', []),
    bannedAgents: stringList(policy.bannedAgents, 'policy.bannedAgents', []),
    stallAfterMinutes: 20,
    laneConcurrency,
    defaultLane: null,
    defaultCard: null,
    bouncePatterns: [],
    reviewRequires: [],
  };
  if (policy.stallAfterMinutes !== undefined) {
    if (!Number.isInteger(policy.stallAfterMinutes) || policy.stallAfterMinutes < 1) fail('policy.stallAfterMinutes must be a positive integer (minutes)');
    result.stallAfterMinutes = policy.stallAfterMinutes;
  }
  if (policy.laneConcurrency !== undefined) {
    if (!policy.laneConcurrency || typeof policy.laneConcurrency !== 'object' || Array.isArray(policy.laneConcurrency)) fail('policy.laneConcurrency must be an object of lane limits');
    for (const [lane, limit] of Object.entries(policy.laneConcurrency)) {
      if (!laneIds.has(lane)) fail(`policy.laneConcurrency.${lane} names a lane that is not configured`);
      if (!Number.isInteger(limit) || limit < 1) fail(`policy.laneConcurrency.${lane} must be a positive integer`);
      laneConcurrency[lane] = limit;
    }
  }
  if (policy.defaultLane !== undefined && policy.defaultLane !== null) {
    const lane = requireString(policy.defaultLane, 'policy.defaultLane');
    if (!laneIds.has(lane)) fail(`policy.defaultLane ${lane} is not a configured lane`);
    result.defaultLane = lane;
  }
  if (policy.defaultCard !== undefined && policy.defaultCard !== null) {
    const card = requireString(policy.defaultCard, 'policy.defaultCard');
    if (!CARD_ID.test(card)) fail('policy.defaultCard must match /^[a-z0-9-]{1,48}$/ (a roster card id)');
    result.defaultCard = card;
  }
  if (policy.bouncePatterns !== undefined) {
    if (!Array.isArray(policy.bouncePatterns)) fail('policy.bouncePatterns must be an array');
    result.bouncePatterns = policy.bouncePatterns.map((entry, index) => {
      const field = `policy.bouncePatterns[${index}]`;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`${field} must be an object`);
      const code = requireString(entry.code, `${field}.code`);
      if (!BOUNCE_CODE.test(code)) fail(`${field}.code must match /^[a-z][a-z0-9_]*$/`);
      const label = requireString(entry.label, `${field}.label`);
      // Compiled here, at resolve time, so an invalid pattern fails loudly before any worker runs; the
      // compiled RegExp rides along in the resolved config and is applied to an exit line only.
      return { code, label, pattern: regex(entry.pattern, `${field}.pattern`) };
    });
  }
  // Suggestion S3: which of the parent's current-attempt evidence kinds a review must actually have passed
  // before it may be dispatched (src/core/rules.js reviewUpstreamEvidence). Empty (the default) means the
  // board only ever warns, never refuses, on this ground.
  if (policy.reviewRequires !== undefined) {
    const list = stringList(policy.reviewRequires, 'policy.reviewRequires', []);
    const allowed = new Set(['report', 'project-verification', 'hook']);
    for (const kind of list) if (!allowed.has(kind)) fail(`policy.reviewRequires must only name report|project-verification|hook, got "${kind}"`);
    result.reviewRequires = [...new Set(list)];
  }
  return result;
}

export function resolveConfig(root, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('the file must hold a JSON object');
  const base = path.resolve(root);
  const abs = (value, field) => path.resolve(base, requireString(value, field));
  if (!raw.lanes || typeof raw.lanes !== 'object' || !Object.keys(raw.lanes).length) fail('lanes must define at least one lane');
  const briefs = raw.briefs || {};
  const port = raw.port === undefined ? DEFAULT_PORT : raw.port;
  // A browser refuses to open the board at all on a blocked port (see src/core/browserUnsafePorts.js) — the
  // port would "work" (the server listens fine) but every tab would just show a connection-refused page.
  validateBoardPort(port);
  const dataDir = raw.dataDir === undefined ? '.questboard-data' : raw.dataDir;
  const laneIds = new Set(Object.keys(raw.lanes));
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
    verification: validateVerificationConfig(raw.verification, base),
    bash: raw.bash === undefined ? null : requireString(raw.bash, 'bash'),
    // No prototype: `config.lanes[name]` is asked with names from briefs, rosters and requests, and
    // "constructor" must not count as a lane.
    lanes: Object.assign(Object.create(null), Object.fromEntries(Object.entries(raw.lanes).map(([id, lane]) => [id, validateLane(id, lane)]))),
    policy: validatePolicyConfig(raw.policy, laneIds),
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
