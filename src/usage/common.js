// Shared pieces for usage providers: a safe error type, window labels, number parsing, and splitting CLI output
// that holds several JSON documents in a row.
import { execFile } from 'node:child_process';

// A hostname shape only — never a full URL, path or query string, so nothing after the host can ride along.
// At least two labels (api.example.com, not a bare word): every real caller's host has a dot, and requiring
// one keeps a single alnum-and-hyphen secret (which a bare-label pattern would happily match) out of shape.
const HOST_PATTERN = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+(:\d{1,5})?$/;
// A CLI command or exe name: short, no whitespace or shell metacharacters.
const COMMAND_PATTERN = /^[A-Za-z0-9][\w.-]{0,63}$/;

const asHost = (v) => (typeof v === 'string' && HOST_PATTERN.test(v) ? v : null);
const asCommand = (v) => (typeof v === 'string' && COMMAND_PATTERN.test(v) ? v : null);
// A real HTTP response never carries a status outside this range; anything else is not a status code someone
// forgot to normalize, it is a value this module has no business displaying.
const asHttpStatus = (v) => (Number.isInteger(v) && v >= 100 && v <= 599 ? v : null);
// The exit code is only ever a real OS exit status or missing; a missing one renders as '?', it never fails
// validation (there is nothing unsafe about "we don't know the number").
const asExitCodeOrUnknown = (v) => (Number.isInteger(v) ? v : '?');
const asShortLabel = (v) => safeLabel(v);

// Fixed catalog of everything a UsageError may say. Each code names its parameters and how to validate them —
// an integer, a hostname shape, a short label from a closed pattern — never a free-text field copied from a
// response body, a header or a thrown network error. A param that fails validation makes the whole code
// unrenderable (service.js falls back to a generic label), it is never partially rendered.
//
// Both tables are built on `Object.create(null)`: a plain `{}` literal would let a code like `constructor`,
// `valueOf`, `toString`, `hasOwnProperty` or `isPrototypeOf` resolve to something inherited from
// Object.prototype instead of `undefined` — which used to render as `{}`, `"[object Object]"` or `false`
// instead of falling back to the generic label. With no prototype, `USAGE_ERROR_CODES[code]` is `undefined`
// for every name that was never actually assigned here, exactly like `RESULT_CODE_TEXT` below already checks
// for via `Object.hasOwn`.
const USAGE_ERROR_CODES = Object.assign(Object.create(null), {
  timeout: { host: asHost },
  unreachable: { host: asHost },
  http_status: { host: asHost, status: asHttpStatus },
  not_json: { host: asHost },
  command_missing: { command: asCommand },
  command_failed: { command: asCommand, exitCode: asExitCodeOrUnknown },
  local_http_status: { status: asHttpStatus },
  local_not_json: {},
  local_timeout: {},
  local_unreachable: {},
  no_listening_port: {},
  no_account_status: {},
  no_plan_info: {},
  plan_query_failed: {},
  // No parameters: the login name arkcli reports is external, format-checked text at best, so the message
  // never carries it — a fixed, neutral sentence either way (see USAGE_ERROR_RENDER.login_required).
  login_required: {},
  no_quota_data: { provider: asShortLabel },
  no_balance_data: { provider: asShortLabel },
});

const USAGE_ERROR_RENDER = Object.assign(Object.create(null), {
  timeout: (p) => `${p.host} 超时没有回应`,
  unreachable: (p) => `连不上 ${p.host}`,
  http_status: (p) => `${p.host} 返回 HTTP ${p.status}${p.status === 401 || p.status === 403 ? '（key 无效或没有权限）' : ''}`,
  not_json: (p) => `${p.host} 返回的不是 JSON`,
  command_missing: (p) => `找不到 ${p.command} 命令`,
  command_failed: (p) => `${p.command} 运行失败（退出码 ${p.exitCode}）`,
  local_http_status: (p) => `本机 Antigravity 服务返回 HTTP ${p.status}`,
  local_not_json: () => '本机 Antigravity 服务返回的不是 JSON',
  local_timeout: () => '本机 Antigravity 服务超时没有回应',
  local_unreachable: () => '连不上本机 Antigravity 服务',
  no_listening_port: () => 'Antigravity 的语言服务没有在监听端口',
  no_account_status: () => 'Antigravity 返回的数据里没有账户状态',
  no_plan_info: () => 'arkcli 没有返回套餐信息',
  plan_query_failed: () => 'arkcli 没能查到套餐（运行 arkcli usage plan 看原因）',
  login_required: () => '请先登录对应的账号',
  no_quota_data: (p) => `${p.provider} 返回的数据里没有额度`,
  no_balance_data: (p) => `${p.provider} 返回的数据里没有余额`,
});

function validateUsageErrorParams(code, params) {
  const validators = USAGE_ERROR_CODES[code];
  if (!validators) return null;
  const safe = {};
  for (const [name, validate] of Object.entries(validators)) {
    const value = validate(params ? params[name] : undefined);
    if (value === null || value === undefined) return null;
    safe[name] = value;
  }
  return safe;
}

// The only error whose text may reach the page — and only when it was built through a known code with
// validated parameters. `new UsageError(code, params)` is the supported form; a caller may still pass a
// single free-text string (kept for callers outside this file), but that form carries no code, so
// trustedUsageErrorText() below never renders it — a raw message survives only on `.message` for logs, and
// a forged `Object.create(UsageError.prototype, {message:{value:...}})` has neither `code` nor `params` at
// all, so it renders nothing either.
export class UsageError extends Error {
  constructor(code, params) {
    const safe = typeof code === 'string' ? validateUsageErrorParams(code, params) : null;
    const message = safe ? USAGE_ERROR_RENDER[code](safe) : (typeof code === 'string' ? code : '');
    super(message);
    this.code = safe ? code : null;
    this.params = safe;
  }
}

// Re-validates on read rather than trusting `.code`/`.params` were set safely: even an object that manages to
// carry look-alike own properties can only ever render bounded, catalog-shaped text (a hostname pattern, an
// integer, a closed short label) — never an arbitrary string.
export function trustedUsageErrorText(error) {
  let code;
  let params;
  try { ({ code, params } = error || {}); } catch { return null; }
  if (typeof code !== 'string' || !USAGE_ERROR_CODES[code]) return null;
  const safe = validateUsageErrorParams(code, params);
  return safe ? USAGE_ERROR_RENDER[code](safe) : null;
}

// Fixed Chinese text for a provider's own `{ ok:false, code }` result — never the provider's free-text
// `error` field. A code not in this table (or missing) falls back to a generic message named by the caller.
export const RESULT_CODE_TEXT = {
  no_sessions_dir: '没有找到 Codex 会话记录（~/.codex/sessions）',
  no_rate_limit_data: 'Codex 会话记录里还没有额度信息',
  windows_only: '目前只在 Windows 上读 Antigravity（用 PowerShell 找进程）',
  process_not_found: '没找到 Antigravity 的语言服务进程（agy 或 Antigravity 没在跑）',
};

export function trustedResultText(code, fallback) {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(RESULT_CODE_TEXT, code) ? RESULT_CODE_TEXT[code] : fallback;
}

export function windowLabel(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return '额度窗口';
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

export function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

export function percent(used, limit) {
  if (used === null || limit === null || limit <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((used / limit) * 1000) / 10));
}

// Strings copied from a response or a CLI into the page must look like the thing they claim to be; anything
// else (a token echoed by a proxy, a long error) is dropped.
export const CURRENCY_PATTERN = /^[A-Z]{3}$/;
// One word, at most 32 characters: model ids and plan names fit, tokens and sentences do not.
export const SHORT_LABEL_PATTERN = /^[A-Za-z0-9][\w.\-]{0,31}$/;

export function safeLabel(value, pattern = SHORT_LABEL_PATTERN) {
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

export function isoOrNull(value) {
  try {
    if (typeof value === 'number' && Number.isFinite(value)) {
      const ms = value * 1000;
      if (Math.abs(ms) > 8.64e15) return null;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    if (typeof value === 'string') {
      const ms = Date.parse(value);
      if (Number.isFinite(ms) && Math.abs(ms) <= 8.64e15) {
        const d = new Date(ms);
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
      }
    }
  } catch {
    return null;
  }
  return null;
}

export async function getJson(fetchImpl, url, key, { timeoutMs = 15000 } = {}) {
  // Trust boundary: `url` is always a constant literal written into an adapter in this file's own source
  // (never a response body, a header, or anything a provider's answer could influence), and `URL#host` never
  // includes userinfo, path, query or fragment — so the host shown in an error can only ever be the fixed
  // address this codebase itself dials, not something an attacker-controlled response could redirect it to.
  const host = new URL(url).host;
  let response;
  try {
    response = await fetchImpl(url, { headers: { authorization: `Bearer ${key}`, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new UsageError(error && error.name === 'TimeoutError' ? 'timeout' : 'unreachable', { host });
  }
  if (!response.ok) throw new UsageError('http_status', { host, status: response.status });
  try {
    return await response.json();
  } catch {
    throw new UsageError('not_json', { host });
  }
}

export function parseJsonDocuments(text) {
  const docs = [];
  const source = String(text);
  let index = 0;
  while (index < source.length) {
    const offset = source.slice(index).search(/[[{]/);
    if (offset < 0) break;
    index += offset;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let j = index; j < source.length; j += 1) {
      const c = source[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === '{' || c === '[') depth += 1;
      else if (c === '}' || c === ']') {
        depth -= 1;
        if (depth === 0) { end = j; break; }
      }
    }
    if (end < 0) break;
    try { docs.push(JSON.parse(source.slice(index, end + 1))); } catch { /* not JSON after all; keep scanning */ }
    index = end + 1;
  }
  return docs;
}

// The child gets only what it needs to find its own config and binaries — never the API keys that may sit in
// this process's environment, so a chatty CLI cannot echo them into output we parse.
const CHILD_ENV_NAMES = new Set(['PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'USERNAME', 'SHELL', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']);

export function childEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => CHILD_ENV_NAMES.has(name.toUpperCase())));
}

// Runs a fixed CLI command (never user input). On Windows npm installs CLIs as .cmd shims, which need cmd.exe.
// A failed command yields nothing: partial output is not trusted.
export function runCommand(command, args, { timeoutMs = 30000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const windows = process.platform === 'win32';
    const file = windows ? env.ComSpec || 'cmd.exe' : command;
    // Verbatim on Windows: Node would otherwise re-quote the joined line and cmd.exe would run something else.
    // `/s` makes cmd strip exactly the outer quotes we add here.
    const argv = windows ? ['/d', '/s', '/c', `"${[command, ...args].join(' ')}"`] : args;
    const options = { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, env: childEnvironment(env), windowsVerbatimArguments: windows };
    execFile(file, argv, options, (error, stdout, stderr) => {
      if (error) {
        const missing = error.code === 'ENOENT' || /not recognized|not found|不是内部或外部命令/i.test(String(stderr));
        reject(missing ? new UsageError('command_missing', { command }) : new UsageError('command_failed', { command, exitCode: error.code }));
        return;
      }
      resolve(String(stdout));
    });
  });
}
