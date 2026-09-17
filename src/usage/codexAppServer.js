import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { childEnvironment, safeLabel, toNumber } from './common.js';

export const CODEX_APP_SERVER_METHODS = Object.freeze([
  'initialize',
  'initialized',
  'account/read',
  'account/rateLimits/read',
]);

export const CODEX_APP_SERVER_DEFAULT_DEADLINE_MS = 10000;
export const CODEX_APP_SERVER_MAX_FRAME_BYTES = 64 * 1024;
export const CODEX_APP_SERVER_CLIENT_VERSION = '0.1.0';

const CODEX_WINDOWS_TARGETS = Object.freeze({
  x64: Object.freeze({ packageName: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc' }),
  arm64: Object.freeze({ packageName: '@openai/codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' }),
});
const WINDOWS_SHIM_PATTERN = /\.(?:cmd|bat)$/i;
const NOT_CHATGPT_NOTE = 'Codex 没有使用 ChatGPT 登录；API key 登录没有订阅额度。';
export const CODEX_NOT_FOUND_NOTE = '未找到 Codex 命令';
const RESET_UNIT_NOTE = 'reset 单位尚未由 owner 的 live handshake 确认。';
const RESET_MS_NOTE = '检测到大于 1e12 的 reset 值，已按毫秒解释；';
const FALLBACK_NOTE = '官方 app-server 未完成读取；本次由 local-log 路径回答，数据可能过期。';

export class CodexAppServerError extends Error {
  constructor(kind = 'protocol') {
    const messages = {
      not_found: CODEX_NOT_FOUND_NOTE,
      start: 'Codex app-server 无法启动',
      closed: 'Codex app-server 在读取完成前退出',
      deadline: 'Codex app-server 读取超时',
      protocol: 'Codex app-server 返回了无法读取的协议数据',
      write: 'Codex app-server 写入失败',
    };
    super(messages[kind] || messages.protocol);
    this.name = 'CodexAppServerError';
    this.code = kind;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
}

function hasOwn(value, key) {
  try { return Object.prototype.hasOwnProperty.call(value, key); } catch { return false; }
}

function valueOf(value, key) {
  return hasOwn(value, key) ? value[key] : undefined;
}

function safeNow(now) {
  try {
    const value = typeof now === 'function' ? now() : now;
    return typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
  } catch {
    return Date.now();
  }
}

function safeDeadline(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(value, 120000)
    : CODEX_APP_SERVER_DEFAULT_DEADLINE_MS;
}

function addUnique(values, value) {
  if (typeof value === 'string' && value && !values.includes(value)) values.push(value);
}

function pathEntries(env, pathApi) {
  const raw = typeof env?.PATH === 'string' ? env.PATH : env?.Path;
  return typeof raw === 'string'
    ? raw.split(pathApi.delimiter)
        .map((entry) => entry.trim())
        .filter((entry) => Boolean(entry) && pathApi.isAbsolute(entry))
    : [];
}

function packageRootsFor(entry, pathApi) {
  const roots = [];
  addUnique(roots, pathApi.join(entry, 'node_modules', '@openai', 'codex'));

  // This also handles a package-manager PATH entry that points inside the optional platform package.
  let current = entry;
  for (let depth = 0; depth < 10; depth += 1) {
    const name = pathApi.basename(current).toLowerCase();
    if (name === 'codex') addUnique(roots, current);
    if (name === 'codex-win32-x64' || name === 'codex-win32-arm64') {
      addUnique(roots, pathApi.join(pathApi.dirname(current), 'codex'));
    }
    const parent = pathApi.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

function defaultFileExists(candidate) {
  try { return fs.statSync(candidate).isFile(); } catch { return false; }
}

// Windows npm installs create a command shim, but Node refuses to spawn that target without enabling a shell.
// Locate the optional package's native binary instead. The filesystem check is injectable so the reader can
// prove resolution and absence without consulting or starting a real Codex installation.
export function resolveCodexExecutable({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  existsImpl = defaultFileExists,
} = {}) {
  if (platform !== 'win32') return 'codex';
  const target = CODEX_WINDOWS_TARGETS[arch];
  if (!target) return null;
  const pathApi = path.win32;
  const entries = pathEntries(env, pathApi);
  for (const root of [
    ...entries,
    ...(typeof env?.APPDATA === 'string' && pathApi.isAbsolute(env.APPDATA.trim()) ? [pathApi.join(env.APPDATA.trim(), 'npm')] : []),
    ...(typeof env?.LOCALAPPDATA === 'string' && pathApi.isAbsolute(env.LOCALAPPDATA.trim()) ? [pathApi.join(env.LOCALAPPDATA.trim(), 'npm'), pathApi.join(env.LOCALAPPDATA.trim(), 'pnpm')] : []),
  ]) {
    if (pathApi.isAbsolute(root)) addUnique(entries, root);
  }

  const candidates = [];
  for (const entry of entries) {
    addUnique(candidates, pathApi.join(entry, 'codex.exe'));
    for (const packageRoot of packageRootsFor(entry, pathApi)) {
      const vendorPath = (root) => pathApi.join(root, 'vendor', target.triple, 'bin', 'codex.exe');
      addUnique(candidates, vendorPath(packageRoot));
      addUnique(candidates, vendorPath(pathApi.join(packageRoot, 'node_modules', target.packageName)));
      addUnique(candidates, vendorPath(pathApi.join(pathApi.dirname(packageRoot), pathApi.basename(target.packageName))));
    }
  }

  for (const candidate of candidates) {
    if (WINDOWS_SHIM_PATTERN.test(candidate)) continue;
    try {
      if (existsImpl(candidate) === true) return candidate;
    } catch { /* an unreadable candidate is treated as absent */ }
  }
  return null;
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function protocolIdMatches(value, expected) {
  return value === expected || value === String(expected);
}

function windowLabel(windowDurationMins, limitId = null) {
  const minutes = toNumber(windowDurationMins);
  let duration = '额度窗口';
  if (Number.isFinite(minutes) && minutes > 0) {
    duration = minutes === 10080 ? '每周' : minutes === 300 ? '5 小时' : `${minutes} 分钟`;
  }
  // The duration alone cannot say what is limited when several limit ids share the same window; a known
  // limit id prefixes the label so the card tells them apart.
  return limitId ? `${limitId} · ${duration}` : duration;
}

function resetInfo(value, nowMs) {
  if (value === null || value === undefined) return { resetsAt: null, resetMs: null, resetUnitAssumed: false, past: false };
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { resetsAt: null, resetMs: null, resetUnitAssumed: false, past: false };
  }
  const resetUnitAssumed = value > 1e12;
  const resetMs = resetUnitAssumed ? value : value * 1000;
  if (!Number.isFinite(resetMs) || Math.abs(resetMs) > 8640000000000000) {
    return { resetsAt: null, resetMs: null, resetUnitAssumed, past: false };
  }
  try {
    const resetsAt = new Date(resetMs).toISOString();
    return { resetsAt, resetMs, resetUnitAssumed, past: resetMs <= nowMs };
  } catch {
    return { resetsAt: null, resetMs: null, resetUnitAssumed, past: false };
  }
}

function mapWindow(raw, nowMs, limitId = null) {
  if (!isPlainObject(raw)) return null;
  const usedRaw = valueOf(raw, 'usedPercent');
  const usedPercent = typeof usedRaw === 'number' && Number.isFinite(usedRaw) && usedRaw >= 0 ? usedRaw : null;
  const reset = resetInfo(valueOf(raw, 'resetsAt'), nowMs);
  return {
    label: windowLabel(valueOf(raw, 'windowDurationMins'), limitId),
    usedPercent: reset.past ? null : usedPercent,
    resetsAt: reset.resetsAt,
    ...(reset.past ? { state: 'reset' } : {}),
    ...(reset.resetUnitAssumed ? { resetUnitAssumed: true } : {}),
  };
}

function numericValue(value) {
  const parsed = toNumber(value);
  return parsed === null ? null : parsed;
}

function mapBalances(snapshot, windows, balances, limitId, nowMs) {
  if (!isPlainObject(snapshot)) return;
  const credits = valueOf(snapshot, 'credits');
  if (isPlainObject(credits)) {
    const amount = numericValue(valueOf(credits, 'balance'));
    if (amount !== null) balances.push({ currency: 'unknown', amount });
  }

  const individualLimit = valueOf(snapshot, 'individualLimit');
  if (!isPlainObject(individualLimit)) return;
  const limit = numericValue(valueOf(individualLimit, 'limit'));
  const used = numericValue(valueOf(individualLimit, 'used'));
  if (limit !== null && used !== null) {
    const amount = limit - used;
    if (Number.isFinite(amount) && amount >= 0) balances.push({ currency: 'unknown', amount });
    return;
  }
  // A lone remainingPercent is a percentage, not an amount of money: show it as a window (used = 100 -
  // remaining) so the card renders a percent bar, never a fabricated balance. A negative remaining is
  // unknown, not "more than 100% used" — it is dropped rather than shown as a burst that cannot happen.
  const remainingPercent = numericValue(valueOf(individualLimit, 'remainingPercent'));
  if (remainingPercent === null || remainingPercent < 0) return;
  const usedPercent = 100 - remainingPercent;
  if (!Number.isFinite(usedPercent) || usedPercent < 0) return;
  const reset = resetInfo(valueOf(individualLimit, 'resetsAt'), nowMs);
  windows.push({
    label: limitId ? `${limitId} · 额度` : '额度',
    usedPercent: reset.past ? null : usedPercent,
    resetsAt: reset.resetsAt,
    ...(reset.past ? { state: 'reset' } : {}),
    ...(reset.resetUnitAssumed ? { resetUnitAssumed: true } : {}),
  });
}

function snapshotEntries(source) {
  if (!isPlainObject(source)) return [];
  if (hasOwn(source, 'primary') || hasOwn(source, 'secondary') || hasOwn(source, 'credits') || hasOwn(source, 'individualLimit')) {
    return [{ id: safeLabel(valueOf(source, 'limitId')), snapshot: source }];
  }
  // A key that fails safeLabel (a space, too long, …) must still yield a distinct, human label: without one
  // its windows would be prefixed identically to every other unsafe key's and read as the same limit. The
  // positional fallback is generated, so two unsafe keys can never collide, and it can never look like a
  // real limit id (those are ASCII-only and pass safeLabel).
  return Object.keys(source).slice(0, 100)
    .map((key, index) => ({ id: safeLabel(key) ?? `限额 ${index + 1}`, snapshot: valueOf(source, key) }))
    .filter((entry) => isPlainObject(entry.snapshot));
}

function mapRateLimits(result, nowMs) {
  const byLimit = valueOf(result, 'rateLimitsByLimitId');
  const hasByLimit = isPlainObject(byLimit) && Object.keys(byLimit).length > 0;
  const source = hasByLimit ? byLimit : valueOf(result, 'rateLimits');
  const windows = [];
  const balances = [];
  let resetUnitAssumed = false;
  const entries = snapshotEntries(source);
  for (const { id, snapshot } of entries) {
    for (const key of ['primary', 'secondary']) {
      const window = mapWindow(valueOf(snapshot, key), nowMs, id);
      if (window) {
        windows.push(window);
        resetUnitAssumed = resetUnitAssumed || window.resetUnitAssumed === true;
      }
    }
    mapBalances(snapshot, windows, balances, id, nowMs);
  }
  const planType = entries
    .map(({ snapshot }) => safeLabel(valueOf(snapshot, 'planType')))
    .find(Boolean) || '';
  return { windows, balances, planType, resetUnitAssumed };
}

function responseReceipt(now) {
  const value = safeNow(now);
  try { return new Date(value).toISOString(); } catch { return new Date().toISOString(); }
}

function resultForAccount(accountResult, diagnostics, now) {
  const account = isPlainObject(valueOf(accountResult, 'account')) ? valueOf(accountResult, 'account') : null;
  const type = account ? valueOf(account, 'type') : null;
  if (type !== 'chatgpt') {
    return {
      source: 'official-cli',
      state: 'not_configured',
      windows: [],
      balances: [],
      plan: '',
      note: NOT_CHATGPT_NOTE,
      asOf: null,
      diagnostics,
    };
  }
  return {
    account,
    source: 'official-cli',
    state: 'ok',
    windows: [],
    balances: [],
    plan: safeLabel(valueOf(account, 'planType')) || '',
    note: RESET_UNIT_NOTE,
    asOf: null,
    diagnostics,
    now,
  };
}

function mapRateResult(accountResult, rateResult, diagnostics, now) {
  const mapped = mapRateLimits(rateResult, safeNow(now));
  const result = resultForAccount(accountResult, diagnostics, now);
  if (result.state === 'not_configured') return result;
  if (!result.plan && mapped.planType) result.plan = mapped.planType;
  result.windows = mapped.windows;
  result.balances = mapped.balances;
  result.asOf = responseReceipt(now);
  if (mapped.resetUnitAssumed) result.note = `${RESET_MS_NOTE}${RESET_UNIT_NOTE}`;
  delete result.account;
  delete result.now;
  return result;
}

function safeProtocolError() {
  return new CodexAppServerError('protocol');
}

export function readCodexAppServer({
  spawnImpl = nodeSpawn,
  resolveImpl = resolveCodexExecutable,
  env = process.env,
  deadlineMs = CODEX_APP_SERVER_DEFAULT_DEADLINE_MS,
  now = Date.now,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  return new Promise((resolve, reject) => {
    const diagnostics = { malformedFrames: 0, unknownFrames: 0, ignoredServerMessages: 0, oversizedFrames: 0 };
    let childEnv;
    try { childEnv = childEnvironment(env || process.env); } catch { reject(new CodexAppServerError('start')); return; }
    let child;
    let timer;
    let settled = false;
    let pendingId = 1;
    let stage = 'initialize';
    let accountResult;
    let buffer = '';
    let discardingOversized = false;

    const removeListener = (target, event, listener) => {
      try {
        if (target && typeof target.removeListener === 'function') target.removeListener(event, listener);
      } catch { /* cleanup must not surface child errors */ }
    };

    const killChild = () => {
      try {
        if (child && typeof child.kill === 'function') child.kill();
      } catch { /* the child is already gone */ }
    };

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeListener(child?.stdout, 'data', onStdout);
      removeListener(child, 'error', onError);
      removeListener(child, 'close', onClose);
      killChild();
      if (error) reject(error);
      else resolve(value);
    };

    const onError = () => finish(new CodexAppServerError('start'));
    const onClose = () => finish(new CodexAppServerError('closed'));

    const send = (message) => {
      try {
        if (!child?.stdin || typeof child.stdin.write !== 'function') throw new Error('missing stdin');
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch {
        finish(new CodexAppServerError('write'));
      }
    };

    const consume = (line) => {
      let message;
      try { message = JSON.parse(line); } catch { diagnostics.malformedFrames += 1; return; }
      if (!isPlainObject(message)) { diagnostics.unknownFrames += 1; return; }
      if (hasOwn(message, 'method')) {
        diagnostics.ignoredServerMessages += 1;
        return;
      }
      if (!hasOwn(message, 'id') || !protocolIdMatches(valueOf(message, 'id'), pendingId)) {
        diagnostics.unknownFrames += 1;
        return;
      }
      if (hasOwn(message, 'error')) {
        finish(safeProtocolError());
        return;
      }
      if (!hasOwn(message, 'result')) {
        diagnostics.unknownFrames += 1;
        return;
      }
      const result = valueOf(message, 'result');
      if (stage === 'initialize') {
        if (!isPlainObject(result)) { finish(safeProtocolError()); return; }
        send({ method: 'initialized' });
        stage = 'account';
        pendingId = 2;
        send({ id: 2, method: 'account/read', params: { refreshToken: false } });
        return;
      }
      if (stage === 'account') {
        if (!isPlainObject(result)) { finish(safeProtocolError()); return; }
        accountResult = result;
        const account = isPlainObject(valueOf(result, 'account')) ? valueOf(result, 'account') : null;
        if (valueOf(account, 'type') !== 'chatgpt') {
          finish(null, resultForAccount(result, diagnostics, now));
          return;
        }
        stage = 'rateLimits';
        pendingId = 3;
        send({ id: 3, method: 'account/rateLimits/read', params: null });
        return;
      }
      if (stage === 'rateLimits') {
        if (!isPlainObject(result)) { finish(safeProtocolError()); return; }
        finish(null, mapRateResult(accountResult, result, diagnostics, now));
      }
    };

    const onStdout = (chunk) => {
      if (settled) return;
      buffer += String(chunk);
      while (!settled) {
        if (discardingOversized) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) { buffer = ''; return; }
          buffer = buffer.slice(newline + 1);
          discardingOversized = false;
          diagnostics.oversizedFrames += 1;
        }
        const newline = buffer.indexOf('\n');
        if (newline < 0) {
          if (byteLength(buffer) > CODEX_APP_SERVER_MAX_FRAME_BYTES) {
            buffer = '';
            discardingOversized = true;
          }
          return;
        }
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (byteLength(line) > CODEX_APP_SERVER_MAX_FRAME_BYTES) diagnostics.oversizedFrames += 1;
        else consume(line);
      }
    };

    try {
      const command = resolveImpl({ platform, arch, env: childEnv });
      if (!command) {
        finish(new CodexAppServerError('not_found'));
        return;
      }
      if (typeof command !== 'string' || WINDOWS_SHIM_PATTERN.test(command)) {
        finish(new CodexAppServerError('start'));
        return;
      }
      child = spawnImpl(command, ['app-server'], {
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      if (!child || !child.stdout || typeof child.stdout.on !== 'function') throw new Error('missing stdout');
      if (typeof child.on === 'function') {
        child.on('error', onError);
        child.on('close', onClose);
      }
      child.stdout.on('data', onStdout);
      if (child.stderr && typeof child.stderr.on === 'function') child.stderr.on('data', () => {});
      timer = setTimeout(() => finish(new CodexAppServerError('deadline')), safeDeadline(deadlineMs));
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'questboard', version: CODEX_APP_SERVER_CLIENT_VERSION } } });
    } catch {
      finish(new CodexAppServerError('start'));
    }
  });
}

export { FALLBACK_NOTE };
