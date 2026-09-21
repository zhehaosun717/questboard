// The machine roster: which models exist and how they are reached. Facts only — no status, no dated
// owner notes (those are status records, see status.js).
import fs from 'node:fs';
import { writeJsonAtomic } from './jsonl.js';

const ID_PATTERN = /^[a-z0-9-]{1,48}$/;
const LANE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const BILLING = Object.freeze(['subscription', 'plan', 'payg', 'free']);

function fail(message) {
  throw new Error(`roster: ${message}`);
}

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const PLAIN_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Obvious key shapes. This cannot catch every secret, which is exactly why the rule is "no secrets here":
// the roster is a plain file that travels between projects.
const LOOKS_LIKE_A_SECRET = /^(sk-|sk_|ghp_|gho_|github_pat_|xox[baprs]-|AIza|AKIA|glpat-)/;
const MAX_ENV = 10;
const MAX_ENV_VALUE = 200;
// Reviewed deny policy: dynamic loaders, language/runtime search paths, tool bootstraps, and process
// configuration/proxy paths are all inherited by spawned workers and therefore do not belong on a card.
export const LOADER_ENV_PREFIXES = Object.freeze([
  'LD_', 'DYLD_', 'PYTHON', 'RUBY', 'PERL', 'LUA_', 'NODE_', 'JAVA_', '_JAVA', 'JDK_JAVA', 'GIT_',
  'QUESTBOARD_', 'BASH_', 'SHELLOPTS', 'BASHOPTS', 'PS4', 'ENV', 'CLASSPATH', 'PSMODULEPATH', 'COMSPEC',
  'SYSTEMROOT', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA',
  'LOCALAPPDATA', 'XDG_', 'GCONV_PATH', 'GLIBC_TUNABLES', 'MALLOC_', 'DOTNET_', 'COREHOST_', 'RUST_',
  'GOFLAGS', 'GOPATH', 'GOROOT', 'CARGO_', 'NPM_CONFIG_', 'YARN_', 'PNPM_', 'PIP_', 'UV_', 'CONDA_',
  'VIRTUAL_ENV', 'NVM_', 'VOLTA_', 'ASDF_', 'SDKMAN_', 'PROMPT_COMMAND', 'IFS', 'CDPATH', 'OPENSSL_',
  'SSL_CERT_', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS', 'HTTP_PROXY', 'HTTPS_PROXY',
  'ALL_PROXY', 'NO_PROXY', 'PROXY',
  // Round 3 ruling: the .NET/CoreCLR profiler loaders, plus the remaining tool-bootstrap, proxy and
  // pager/editor/shell families the round-2 review named (PHP auto_prepend, Qt plugins, the Go toolchain
  // fetch/proxy, cgo linker flags, Tcl/R profile files, Electron's Node passthrough, TLS key logging,
  // resolver overrides, and the commands several tools shell out to).
  'COR_', 'CORECLR_', 'COMPLUS_', 'PHP', 'QT_', 'GOTOOLCHAIN', 'GOPROXY', 'CGO_', 'TCL', 'R_PROFILE',
  'R_ENVIRON', 'ZDOTDIR', 'ELECTRON_', 'SSLKEYLOGFILE', 'LOCALDOMAIN', 'HOSTALIASES', 'RES_OPTIONS',
  'LESS', 'PAGER', 'EDITOR', 'VISUAL', 'BROWSER', 'SHELL',
  // Round 6: the browser-download mirror families. *_DOWNLOAD_BASE_URL makes a worker download a browser
  // (or a Cypress binary) from that host and then run it, so a card must not be able to point the mirror
  // anywhere; ELECTRON_ above already covers the Electron family itself.
  'PUPPETEER_', 'PLAYWRIGHT_', 'CYPRESS_',
  // Round 4 ruling: the Rust and Go toolchain families widened to their whole prefix (not just RUST_,
  // which missed RUSTC*/RUSTUP*/RUSTFLAGS/RUSTDOC*; GO alone also covers GOENV, whose file can set the
  // denied GOFLAGS/GOTOOLCHAIN/GOPROXY), plus the JVM/Ruby/Erlang/Julia/Deno/Composer bootstrap variables,
  // the ssh prompt override, locale/history file families and the remaining generic prefixes the review named.
  'RUST', 'GO', 'GEM_', 'BUNDLE_', 'ERL_', 'JULIA_', 'DENO_', 'COMPOSER_', 'MAVEN_', 'GRADLE_', 'SSH_',
  'NLS', 'LOC', 'HG', 'WGET', 'CURL_', 'MAKE', 'LIBRARY_', 'PKG_CONFIG', 'PS', '__',
]);

// Round 4 ruling: a structural rule alongside the prefix list. A name shaped like a config/home/rc
// directory, a search-path list, a flags/options bundle, or a wrapper/toolchain/shell/askpass override is
// refused regardless of prefix. This is also why CODEX_HOME and CLAUDE_CONFIG_DIR are refused: a card must
// not redirect a lane's config directory, because that changes where the lane reads config or loads code from.
export const LOADER_ENV_SUFFIXES = Object.freeze([
  'PATH', '_HOME', '_DIR', 'FLAGS', '_OPTS', '_OPTIONS', '_WRAPPER', '_TOOLCHAIN', '_SHELL', '_ROOT',
  '_ENV', 'RC', '_ASKPASS', '_ASKPASS_REQUIRE', '_GEMFILE', '_LAYER',
]);

// Round 4 ruling: exact names too narrow or too common a shape for a prefix or suffix rule (a bare `CC`
// prefix would refuse far too much) — the native/cgo build compilers and linker tools, the MSYS/Cygwin
// shells, and the Windows program/terminfo/execution-policy variables the review named.
export const LOADER_ENV_EXACT_NAMES = Object.freeze([
  'CC', 'CXX', 'LD', 'AR', 'AS', 'NM', 'RANLIB', 'STRIP', 'OBJDUMP', 'MAKE', 'MSYS', 'CYGWIN',
  'PROGRAMFILES', 'COMMONPROGRAMFILES', 'PROGRAMDATA', 'TERMINFO', 'PSEXECUTIONPOLICYPREFERENCE',
]);

// Round 5 ruling: card env is for provider settings only, so a name is accepted only in one of these
// shapes (case-sensitive UPPER_SNAKE_CASE), or when the project lists it in policy.cardEnvAllow. The deny
// policy above still runs first on every name, so a deny hit wins even over an allowed shape or the
// project list (defence in depth). Base URLs are allowed on purpose: one lane, several providers.
export const CARD_ENV_ALLOWED_SUFFIXES = Object.freeze([
  // Owner decision 2026-09-17: '_BASE' joins the base-URL class. A project's own lane wrappers commonly
  // read a plain '..._BASE' name (this machine's Wastecape uses OC_BASE in tools/oc.js and in the lane's
  // env), and it is the same kind of setting as _BASE_URL: where the provider is reached.
  '_BASE', '_BASE_URL', '_API_BASE', '_API_URL', '_MODEL', '_MODEL_NAME', '_MODEL_ID', '_REGION', '_ACCOUNT_ID',
  '_PROJECT_ID', '_ORG_ID', '_ORGANIZATION', '_TIMEOUT_MS', '_MAX_TOKENS', '_TEMPERATURE', '_EFFORT',
  '_VARIANT', '_PROVIDER', '_DEPLOYMENT', '_API_VERSION',
]);
export const CARD_ENV_ALLOWED_NAMES = Object.freeze(['MAX_TOKENS', 'MODEL_NAME', 'MODEL', 'PROVIDER_REGION', 'API_TIMEOUT_MS']);

export function isAllowedCardEnvShape(name, cardEnvAllow = []) {
  if (typeof name !== 'string' || !ENV_NAME.test(name)) return false;
  return CARD_ENV_ALLOWED_NAMES.includes(name)
    || CARD_ENV_ALLOWED_SUFFIXES.some((suffix) => name.length > suffix.length && name.endsWith(suffix))
    || cardEnvAllow.includes(name);
}

function notAllowedEnvReason(name) {
  return `环境变量 ${name} 不是卡片可以设置的：卡片只能带模型服务的设置，名字要以 _BASE_URL、_MODEL、_REGION 等结尾，或写进项目设置 policy.cardEnvAllow`;
}

// Only a name shaped like a normal identifier is checked against the deny policy; a name that is not
// (a leading '-', or any other character outside letters/digits/underscore) is left to the plain
// UPPER_SNAKE_CASE check below, which already refuses it — never silently accepted here either way.
function loaderMatchKind(name) {
  if (typeof name !== 'string' || name.startsWith('-') || !PLAIN_ENV_NAME.test(name)) return null;
  const upper = name.toUpperCase();
  if (LOADER_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))) return 'prefix';
  if (LOADER_ENV_EXACT_NAMES.includes(upper)) return 'exact';
  if (LOADER_ENV_SUFFIXES.some((suffix) => upper.endsWith(suffix))) return 'suffix';
  return null;
}

export function isLoaderEnv(name) {
  return loaderMatchKind(name) !== null;
}

function isDashLikeEnvName(name) {
  return typeof name === 'string' && name.startsWith('-');
}

function loaderEnvReason(name) {
  if (isDashLikeEnvName(name)) return `环境变量名 ${name} 不是普通名称，这张卡不能设置它`;
  const effect = loaderMatchKind(name) === 'prefix' ? '会改变程序加载方式' : '会改变程序从哪里读配置或加载代码';
  return `环境变量 ${name} ${effect}，这张卡不能设置它`;
}

// Round 4 ruling: an invalid name (not UPPER_SNAKE_CASE, or not a plain identifier at all) gets a plain
// Chinese reason naming it, with the UPPER_SNAKE_CASE token kept at the end for the tests that grep it.
export function invalidEnvNameReason(name) {
  return `环境变量名 ${name} 只能用大写字母、数字和下划线，且不能以数字开头 (UPPER_SNAKE_CASE)`;
}

function allowList(cardEnvAllow) {
  return Array.isArray(cardEnvAllow) ? cardEnvAllow : [];
}

// The one place that decides whether a name breaks the card env policy (deny first, then the allowed
// shapes): reused both to throw on a write and, leniently, to explain why an already-saved legacy card
// cannot be dispatched or resaved unchanged (see loadRoster and validateAdventurer's lenientEnv option).
// A name that is not UPPER_SNAKE_CASE and not denied is left to the plain name check, which throws.
function policyReason(name, cardEnvAllow) {
  if (isDashLikeEnvName(name) || isLoaderEnv(name)) return loaderEnvReason(name);
  if (ENV_NAME.test(name) && !isAllowedCardEnvShape(name, allowList(cardEnvAllow))) return notAllowedEnvReason(name);
  return null;
}

function firstPolicyViolation(env, cardEnvAllow) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return null;
  for (const name of Object.keys(env)) {
    const reason = policyReason(name, cardEnvAllow);
    if (reason) return { name, reason };
  }
  return null;
}

// Facts-only view of a card's env for callers that only want to know whether it is dispatch-eligible or
// needs a note on the roster page — never throws, never touches disk. `cardEnvAllow` is the project's
// policy.cardEnvAllow list; without it only the built-in shapes are allowed.
export function envPolicyViolation(entry, { cardEnvAllow = [] } = {}) {
  const violation = firstPolicyViolation(entry && entry.env, cardEnvAllow);
  return violation ? { variable: violation.name, reason: violation.reason } : null;
}

function refuseLeadingOption(value, field) {
  if (typeof value === 'string' && value.startsWith('-')) fail(`${field} 不能以 - 开头`);
}

// A card may carry non-secret environment values (a base URL, an account id) so one generic lane can serve
// several providers. Keys belong in the machine environment, which the lane command already inherits.
// `at` is the full path to the env value itself (e.g. "adventurer (id).env" or "patch.env.set"), so every
// message below names the real field. `lenientEnv` skips only the policy refusal (deny list or allowed
// shapes), for a read of a card already on disk (see loadRoster) or a write that does not touch that
// card's env. `cardEnvAllow` is the project's policy.cardEnvAllow list of extra exact names.
export function validateCardEnv(entry, at, { lenientEnv = false, cardEnvAllow = [] } = {}) {
  if (entry.env === undefined) return;
  if (!entry.env || typeof entry.env !== 'object' || Array.isArray(entry.env)) fail(`${at} 必须是「变量名: 值」这样的对象`);
  const names = Object.keys(entry.env);
  if (names.length > MAX_ENV) fail(`${at} 最多只能设置 ${MAX_ENV} 个环境变量，现在有 ${names.length} 个`);
  for (const [name, value] of Object.entries(entry.env)) {
    const reason = policyReason(name, cardEnvAllow);
    if (reason) {
      if (lenientEnv) continue;
      fail(`${at}.${name} ${reason}`);
    }
    if (!ENV_NAME.test(name)) fail(`${at}.${name} ${invalidEnvNameReason(name)}`);
    if (typeof value !== 'string' || value.length > MAX_ENV_VALUE) fail(`${at}.${name} 环境变量 ${name} 的值必须是文字，最长 ${MAX_ENV_VALUE} 个字符`);
    if (LOOKS_LIKE_A_SECRET.test(value)) fail(`${at}.${name} 环境变量 ${name} 的值看起来像密钥：密钥请放在本机环境变量里（通道命令会继承它），名册会在项目之间共用，不能放密钥`);
  }
}

export function validateAdventurer(entry, where = 'adventurer', { lenientEnv = false, cardEnvAllow = [] } = {}) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`${where} must be an object`);
  if (!ID_PATTERN.test(entry.id || '')) fail(`${where}.id must match ${ID_PATTERN}`);
  const at = `${where} (${entry.id})`;
  for (const field of ['name', 'provider', 'model', 'family']) {
    if (typeof entry[field] !== 'string' || !entry[field].trim()) fail(`${at}.${field} is required`);
  }
  for (const field of ['model', 'variant', 'agent']) refuseLeadingOption(entry[field], `${at}.${field}`);
  if (!LANE_PATTERN.test(entry.lane || '')) fail(`${at}.lane must match ${LANE_PATTERN}`);
  if (entry.status !== undefined || entry.statusChangedAt !== undefined) {
    fail(`${at} has a status field; statuses are records in the status log (questboard status set ${entry.id} ...), not roster data`);
  }
  if (entry.billing !== undefined && !BILLING.includes(entry.billing)) fail(`${at}.billing must be one of ${BILLING.join('|')}`);
  if (entry.maxParallel !== undefined && (!Number.isInteger(entry.maxParallel) || entry.maxParallel < 1)) fail(`${at}.maxParallel must be a positive integer`);
  if (entry.strengths !== undefined && (!Array.isArray(entry.strengths) || entry.strengths.some((s) => typeof s !== 'string'))) fail(`${at}.strengths must be an array of strings`);
  // FB2-03: measured/declared capabilities are machine facts about the card, like strengths.
  if (entry.capabilities !== undefined && (!Array.isArray(entry.capabilities) || entry.capabilities.some((s) => typeof s !== 'string' || !s.trim()))) fail(`${at}.capabilities must be an array of non-empty strings`);
  if (entry.notes !== undefined && (typeof entry.notes !== 'string' || entry.notes.length > 300)) fail(`${at}.notes must be a string of at most 300 characters`);
  if (entry.variant !== undefined && typeof entry.variant !== 'string') fail(`${at}.variant must be a string`);
  if (entry.variants !== undefined) {
    if (!Array.isArray(entry.variants) || entry.variants.some((variant) => typeof variant !== 'string' || !variant.trim())) {
      fail(`${at}.variants must be an array of non-empty strings`);
    }
    if (entry.variants.some((variant) => variant.trim() !== variant)) {
      fail(`${at}.variants entries must not contain leading or trailing whitespace`);
    }
    entry.variants.forEach((variant) => refuseLeadingOption(variant, `${at}.variants`));
    if (new Set(entry.variants).size !== entry.variants.length) fail(`${at}.variants must not contain duplicate values`);
  }
  if (entry.agent !== undefined && typeof entry.agent !== 'string') fail(`${at}.agent must be a string`);
  validateCardEnv(entry, `${at}.env`, { lenientEnv, cardEnvAllow });
  return entry;
}

// `lenientEnv` never throws for a card whose env breaks the loader/CLI-flag policy; it is for a read of
// whatever is already on disk (loadRoster) or a write that leaves an untouched card's env exactly as it
// was (upsertAdventurer, the roster bulk routes). Everything else about a card — id, lane, other fields —
// still fails loudly either way; a legacy card is refused for dispatch instead (see envPolicyViolation and
// core/rules.js), never silently accepted.
export function validateRoster(value, { lenientEnv = false, cardEnvAllow = [] } = {}) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.adventurers)) fail('adventurers array is required');
  value.adventurers.forEach((entry, index) => validateAdventurer(entry, `adventurers[${index}]`, { lenientEnv, cardEnvAllow }));
  const ids = value.adventurers.map((a) => a.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) fail(`duplicate adventurer id ${duplicate}`);
  return value;
}

// A roster file that does not exist yet is a new machine, not missing data: the board opens with no cards so
// the owner can add the first one. A roster that exists but is malformed still fails loudly.
export function loadRosterOrEmpty(file) {
  return fs.existsSync(file) ? loadRoster(file) : { adventurers: [] };
}

// A read must never brick the board: a card written before the deny policy grew a new prefix still loads,
// with its env left exactly as saved (see envPolicyViolation for the note and the dispatch refusal).
export function loadRoster(file) {
  if (!fs.existsSync(file)) fail(`no roster at ${file}; create one with "questboard roster import <old roster.json>" or write it by hand`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return fail(`cannot read ${file}: ${error.message}`);
  }
  return validateRoster(parsed, { lenientEnv: true });
}

export function saveRoster(file, roster, { lenientEnv = false, cardEnvAllow = [] } = {}) {
  writeJsonAtomic(file, validateRoster(roster, { lenientEnv, cardEnvAllow }));
  return roster;
}

// The entry being written is always checked in full (including its env); `lenientEnv: true` on the
// following whole-roster pass only means some OTHER, untouched card's already-saved env does not block
// this save — never the entry the caller is actually submitting. A caller without the project's
// policy.cardEnvAllow (the CLI) gets only the built-in allowed shapes: stricter, never looser.
export function upsertAdventurer(roster, entry, { cardEnvAllow = [] } = {}) {
  validateAdventurer(entry, 'adventurer', { cardEnvAllow });
  const exists = roster.adventurers.some((a) => a.id === entry.id);
  return validateRoster({
    ...roster,
    adventurers: exists ? roster.adventurers.map((a) => (a.id === entry.id ? { ...entry } : a)) : [...roster.adventurers, { ...entry }],
  }, { lenientEnv: true });
}
