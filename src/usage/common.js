// Shared pieces for usage providers: a safe error type, window labels, number parsing, and splitting CLI output
// that holds several JSON documents in a row.
import { execFile } from 'node:child_process';

// The only error whose message reaches the page. Messages are written here, never copied from a response
// body or a thrown network error (either could echo a URL, header or key).
export class UsageError extends Error {}

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
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value * 1000).toISOString();
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return null;
}

export async function getJson(fetchImpl, url, key, { timeoutMs = 15000 } = {}) {
  const host = new URL(url).host;
  let response;
  try {
    response = await fetchImpl(url, { headers: { authorization: `Bearer ${key}`, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new UsageError(error && error.name === 'TimeoutError' ? `${host} 超时没有回应` : `连不上 ${host}`);
  }
  if (!response.ok) throw new UsageError(`${host} 返回 HTTP ${response.status}${response.status === 401 || response.status === 403 ? '（key 无效或没有权限）' : ''}`);
  try {
    return await response.json();
  } catch {
    throw new UsageError(`${host} 返回的不是 JSON`);
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
        reject(new UsageError(missing ? `找不到 ${command} 命令` : `${command} 运行失败（退出码 ${error.code ?? '?'}）`));
        return;
      }
      resolve(String(stdout));
    });
  });
}
