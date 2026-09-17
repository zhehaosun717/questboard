// Opt-in, project-configured verification hooks. Hooks are deliberately separate from worker execution:
// they run only after a collector has accepted a delivery, never change quest status, and expose only a
// bounded text log plus the exact S2 evidence record.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendJsonLine, readJsonLines } from './jsonl.js';
import { realpathContainmentIssue } from './config.js';

const RECOVERY_NOTE = '看板重启，无法确认这次钩子的结果';

export const HOOK_LOG_MAX_BYTES = 2 * 1024 * 1024;
const HOOK_LOG_MARKER = '\n[questboard] 输出已截断（超过 2 MB）\n';
const HOOK_STATES = new Set(['queued', 'running', 'passed', 'failed', 'timedout', 'unknown']);
const HOOK_FIELDS = ['state', 'commandRef', 'startedAt', 'endedAt', 'exitCode', 'logPath', 'logDigest', 'attemptId'];
const HOOK_FIELD_SET = new Set(HOOK_FIELDS);
const DIGEST_RE = /^[0-9a-f]{16,128}$/i;

function normalizedHookDefinition(hook) {
  return {
    id: hook.id,
    command: [...hook.command],
    timeoutSeconds: hook.timeoutSeconds,
    cwd: hook.cwd,
    envKeys: [...hook.envKeys],
    kinds: [...hook.kinds],
    trigger: hook.trigger,
    enabled: hook.enabled === true,
  };
}

export function hookDefinitionDigest(hook) {
  return createHash('sha256').update(JSON.stringify(normalizedHookDefinition(hook))).digest('hex');
}

export function hookRunKey(attemptId, hook) {
  const digest = hookDefinitionDigest(hook);
  return `${attemptId}:${hook.id}:${digest}`;
}

export function hookLogRelativePath(config, questId, attemptId, hookId) {
  const file = path.join(config.paths.data, 'hooks', questId, `${questId}-${attemptId}-${hookId}.log`);
  return path.relative(config.paths.data, file).split(path.sep).join('/');
}

function recordKeys(value) {
  return Object.keys(value).sort();
}

function validRelativeDataPath(config, value) {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string' || !value || value === '.' || value.includes('\0') || value.includes(':')) return false;
  if (path.isAbsolute(value)) return false;
  const parts = value.split(/[\\/]/);
  if (parts.some((part) => part === '.' || part === '..' || !part)) return false;
  const absolute = path.resolve(config.paths.data, value);
  if (!fs.existsSync(config.paths.data)) return true;
  return realpathContainmentIssue(config.paths.data, absolute) === null;
}

export function validateHookRecord(config, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('verification hook record must be an object');
  if (recordKeys(value).length !== HOOK_FIELDS.length || recordKeys(value).some((key) => !HOOK_FIELD_SET.has(key))) {
    throw new Error('verification hook record has an unknown field');
  }
  if (!HOOK_STATES.has(value.state)) throw new Error('verification hook record.state is invalid');
  if (typeof value.commandRef !== 'string' || !value.commandRef || value.commandRef.length > 300 || /[\r\n]/.test(value.commandRef)) {
    throw new Error('verification hook record.commandRef is invalid');
  }
  for (const field of ['startedAt', 'endedAt']) {
    if (value[field] !== null && (typeof value[field] !== 'string' || !value[field].trim() || !Number.isFinite(Date.parse(value[field])))) {
      throw new Error(`verification hook record.${field} is invalid`);
    }
  }
  if (value.exitCode !== null && !Number.isInteger(value.exitCode)) throw new Error('verification hook record.exitCode is invalid');
  if (typeof value.logPath !== 'string' || !validRelativeDataPath(config, value.logPath)) throw new Error('verification hook record.logPath must stay inside data');
  if (value.logDigest !== null && (typeof value.logDigest !== 'string' || !DIGEST_RE.test(value.logDigest))) {
    throw new Error('verification hook record.logDigest is invalid');
  }
  if (typeof value.attemptId !== 'string' || !value.attemptId) throw new Error('verification hook record.attemptId is invalid');
  return value;
}

export function hookLogFile(config, relativePath) {
  if (!validRelativeDataPath(config, relativePath)) return null;
  const file = path.resolve(config.paths.data, relativePath);
  try {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
    return file;
  } catch {
    return null;
  }
}

export function readHookLog(config, relativePath) {
  const file = hookLogFile(config, relativePath);
  if (!file) return null;
  try {
    const raw = fs.readFileSync(file);
    if (raw.length <= HOOK_LOG_MAX_BYTES) return { body: raw, truncated: false };
    const marker = Buffer.from(HOOK_LOG_MARKER, 'utf8');
    return { body: Buffer.concat([raw.subarray(0, Math.max(0, HOOK_LOG_MAX_BYTES - marker.length)), marker]), truncated: true };
  } catch {
    return null;
  }
}

function appendReason(buffer, reason) {
  if (!reason) return buffer;
  const separator = buffer.length ? '\n' : '';
  return Buffer.concat([buffer, Buffer.from(`${separator}[questboard] ${reason}\n`, 'utf8')]);
}

function boundedBuffer(chunks, chunk, total) {
  const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
  if (total.truncated || total.bytes >= HOOK_LOG_MAX_BYTES) {
    total.truncated = true;
    return;
  }
  const remaining = HOOK_LOG_MAX_BYTES - total.bytes;
  if (value.length <= remaining) {
    chunks.push(value);
    total.bytes += value.length;
    return;
  }
  chunks.push(value.subarray(0, remaining));
  total.bytes += remaining;
  total.truncated = true;
}

function finishBuffer(chunks, total, reason) {
  let body = Buffer.concat(chunks);
  body = appendReason(body, reason);
  if (total.truncated || body.length > HOOK_LOG_MAX_BYTES) {
    const marker = Buffer.from(HOOK_LOG_MARKER, 'utf8');
    body = Buffer.concat([body.subarray(0, Math.max(0, HOOK_LOG_MAX_BYTES - marker.length)), marker]);
  }
  return body;
}

function safeNow() {
  return new Date().toISOString();
}

function currentAttempt(quest) {
  if (quest?.assignee?.attemptId) return quest.assignee;
  return [...(quest?.dispatches || [])].reverse().find((attempt) => attempt?.attemptId) || null;
}

function latestHookRecord(quest, attemptId, relativePath) {
  const attempt = quest?.assignee?.attemptId === attemptId
    ? quest.assignee
    : [...(quest?.dispatches || [])].reverse().find((row) => row?.attemptId === attemptId);
  return [...(attempt?.hooks || [])].reverse().find((record) => record?.logPath === relativePath) || null;
}

export function createVerificationHookRunner({ config, store, spawnImpl = spawn, now = safeNow, instanceId = randomUUID() } = {}) {
  if (!config?.paths?.data || !store?.list || !store?.recordHook) {
    return { onDelivered() {}, cancel() { return false; }, getHandle() { return null; } };
  }
  const active = new Map();
  const attemptsInFlight = new Set();
  const runsFile = path.join(config.paths.data, 'hooks', 'runs.jsonl');
  const runs = new Map();

  try {
    for (const row of readJsonLines(runsFile)) if (row?.key) runs.set(row.key, row);
  } catch {
    // A damaged optional idempotency ledger must not take delivery down. Existing evidence remains readable;
    // a new run will be recorded again only when the hook itself has no durable record for this key.
  }

  function remember(key, state, extra = {}) {
    const row = { at: now(), key, state, instanceId, ...extra };
    runs.set(key, row);
    try { appendJsonLine(runsFile, row); } catch { /* the hook record is the authoritative safe boundary */ }
    return row;
  }

  // The idempotency ledger doubles as the only durable record of which board instance last touched a given
  // quest/attempt/hook: the hook record contract itself (HOOK_FIELDS) is frozen and has no room for it. A
  // definition change mid-flight moves a run to a new key, so ownership is looked up by identity, not key.
  function lastOwnerRow(questId, attemptId, hookId) {
    let best = null;
    for (const row of runs.values()) {
      if (row.quest !== questId || row.attemptId !== attemptId || row.hookId !== hookId) continue;
      if (!best || String(row.at) > String(best.at)) best = row;
    }
    return best;
  }

  function hookRecord(state, hook, attempt, logPath, patch = {}) {
    return {
      state,
      commandRef: hook.id,
      startedAt: null,
      endedAt: null,
      exitCode: null,
      logPath,
      logDigest: null,
      attemptId: attempt.attemptId,
      ...patch,
    };
  }

  function appendRecord(questId, attempt, record) {
    try {
      validateHookRecord(config, record);
      return store.recordHook(questId, attempt, record);
    } catch {
      return null;
    }
  }

  function emitHookEvent(questId, attempt, hookId, event, state, exitCode, logPath) {
    try {
      const quest = store.get(questId);
      if (!quest) return;
      store.emitEvent(quest, event, {
        by: 'board',
        detail: '',
        hookEvent: { quest: questId, attemptId: attempt.attemptId, hookId, state, exitCode, logPath },
      });
    } catch {
      // Event telemetry is best effort; it must never change the hook result or delivery status.
    }
  }

  function existingForKey(quest, attempt, hook, logPath, key) {
    const meta = runs.get(key);
    if (meta && ['queued', 'running', 'passed', 'failed', 'timedout', 'unknown'].includes(meta.state)) return true;
    const record = latestHookRecord(quest, attempt.attemptId, logPath);
    // If an older board wrote the exact slot but not the optional ledger, conservatively refuse a duplicate.
    return Boolean(record && record.commandRef === hook.id && record.attemptId === attempt.attemptId);
  }

  function spawnHook(quest, attempt, hook, key, logPath) {
    const file = hook.command[0] === 'node' ? process.execPath : hook.command[0];
    const args = hook.command[0] === 'node' ? hook.command.slice(1) : hook.command.slice(1);
    const env = {};
    for (const name of hook.envKeys) if (Object.prototype.hasOwnProperty.call(process.env, name)) env[name] = process.env[name];
    let child;
    try {
      child = spawnImpl(file, args, {
        cwd: hook.cwdPath,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      return Promise.resolve({ state: 'unknown', exitCode: null, reason: '验证钩子无法启动，状态未知' });
    }

    const chunks = [];
    const total = { bytes: 0, truncated: false };
    child.stdout?.on('data', (chunk) => boundedBuffer(chunks, chunk, total));
    child.stderr?.on('data', (chunk) => boundedBuffer(chunks, chunk, total));

    return new Promise((resolve) => {
      let settled = false;
      let timedOut = false;
      let cancelled = false;
      let errorSeen = false;
      let timeoutTimer;
      let killTimer;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        clearTimeout(killTimer);
        active.delete(key);
        resolve({ ...result, body: finishBuffer(chunks, total, result.reason) });
      };
      const onExit = (code) => {
        if (cancelled) { finish({ state: 'unknown', exitCode: null, reason: '验证钩子已取消，子进程状态未知' }); return; }
        if (timedOut) { finish({ state: 'timedout', exitCode: Number.isInteger(code) ? code : null, reason: '验证钩子超时，已停止子进程' }); return; }
        if (errorSeen) { finish({ state: 'unknown', exitCode: null, reason: '验证钩子进程状态未知' }); return; }
        finish({ state: code === 0 ? 'passed' : 'failed', exitCode: Number.isInteger(code) ? code : null });
      };
      const onError = () => {
        errorSeen = true;
        finish({ state: 'unknown', exitCode: null, reason: '验证钩子进程状态未知' });
      };
      child.once?.('exit', onExit);
      child.once?.('close', onExit);
      child.once?.('error', onError);
      const handle = { child, key, questId: quest.id, attemptId: attempt.attemptId, hookId: hook.id };
      active.set(key, handle);
      const stopByHandle = (reason, timedOutStop = false) => {
        if (settled) return;
        timedOut = timedOutStop;
        cancelled = !timedOutStop;
        let stopped = false;
        try { stopped = child.kill(); } catch { stopped = false; }
        if (!stopped && child.exitCode === null) {
          finish({ state: 'unknown', exitCode: null, reason });
          return;
        }
        killTimer = setTimeout(() => finish({ state: 'unknown', exitCode: null, reason }), 1000);
        killTimer.unref?.();
      };
      handle.cancel = () => stopByHandle('验证钩子已取消，子进程状态未知');
      timeoutTimer = setTimeout(() => stopByHandle('验证钩子超时，已请求停止子进程', true), hook.timeoutSeconds * 1000);
      timeoutTimer.unref?.();
    });
  }

  // Returns the hook record actually appended (or null if the store refused it, e.g. a stale attempt) so a
  // sequential run can tell the caller what state this hook finished in without re-reading the quest.
  async function runOne(quest, attempt, hook, key, logPath) {
    let queued = appendRecord(quest.id, attempt, hookRecord('queued', hook, attempt, logPath));
    if (!queued) {
      active.delete(key);
      remember(key, 'unknown', { quest: quest.id, attemptId: attempt.attemptId, hookId: hook.id });
      return null;
    }
    remember(key, 'queued', { quest: quest.id, attemptId: attempt.attemptId, hookId: hook.id });
    const startedAt = now();
    const running = appendRecord(quest.id, attempt, hookRecord('running', hook, attempt, logPath, { startedAt }));
    if (!running) {
      active.delete(key);
      remember(key, 'unknown', { quest: quest.id, attemptId: attempt.attemptId, hookId: hook.id });
      return null;
    }
    emitHookEvent(quest.id, attempt, hook.id, 'hook_started', 'running', null, logPath);
    remember(key, 'running', { quest: quest.id, attemptId: attempt.attemptId, hookId: hook.id });
    const result = await spawnHook(quest, attempt, hook, key, logPath);
    let body = result.body;
    let logDigest = null;
    try {
      const absolute = hookLogFile(config, logPath) || path.resolve(config.paths.data, logPath);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      if (realpathContainmentIssue(config.paths.data, absolute)) throw new Error('outside data');
      fs.writeFileSync(absolute, body, 'utf8');
      logDigest = createHash('sha256').update(body).digest('hex');
    } catch {
      result.state = 'unknown';
      result.exitCode = null;
      body = Buffer.from('[questboard] 验证钩子日志无法保存，状态未知\n', 'utf8');
    }
    const finalValue = hookRecord(result.state, hook, attempt, logPath, {
      startedAt,
      endedAt: now(),
      exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null,
      logDigest,
    });
    const final = appendRecord(quest.id, attempt, finalValue);
    if (!final) {
      remember(key, 'unknown', { quest: quest.id, attemptId: attempt.attemptId, hookId: hook.id });
      return null;
    }
    remember(key, result.state, { quest: quest.id, attemptId: attempt.attemptId, hookId: hook.id });
    emitHookEvent(quest.id, attempt, hook.id, 'hook_finished', result.state, Number.isInteger(result.exitCode) ? result.exitCode : null, logPath);
    return finalValue;
  }

  function attemptTailRecord(quest, attemptId) {
    const attempt = quest?.assignee?.attemptId === attemptId
      ? quest.assignee
      : (quest?.dispatches || []).find((row) => row?.attemptId === attemptId);
    const hooks = attempt?.hooks || [];
    return hooks[hooks.length - 1] || null;
  }

  // PM decision (B1, option b): an attempt's enabled hooks run one after another, never in parallel, so two
  // children never race to write the log or the ledger for the same attempt. Once the last one finishes, if
  // any hook in the sequence did not pass, the tail of the array must still show that — S2 (and S3's review
  // gate) only ever look at the last element, so a later passing hook can never bury an earlier failure.
  async function runSequence(quest, attempt, hooks) {
    const results = [];
    for (const hook of hooks) {
      const logPath = hookLogRelativePath(config, quest.id, attempt.attemptId, hook.id);
      const key = hookRunKey(attempt.attemptId, hook);
      const current = store.get(quest.id) || quest;
      if (existingForKey(current, attempt, hook, logPath, key)) {
        const prior = latestHookRecord(current, attempt.attemptId, logPath);
        if (prior) results.push({ hook, record: prior });
        continue;
      }
      active.set(key, { key, questId: quest.id, attemptId: attempt.attemptId, hookId: hook.id, starting: true });
      const record = await runOne(current, attempt, hook, key, logPath);
      if (record) results.push({ hook, record });
    }
    const worst = results.find((entry) => entry.record.state !== 'passed');
    if (!worst) return;
    const quest2 = store.get(quest.id);
    if (!quest2) return;
    const tail = attemptTailRecord(quest2, attempt.attemptId);
    if (!tail || tail.state !== 'passed') return;
    // The tail currently shows a later hook's pass, hiding the worst outcome above it. Append a copy of the
    // failing hook's own final record — not a new event, this is a display fixup, not a new hook run.
    appendRecord(quest.id, attempt, { ...worst.record });
  }

  function onDelivered(quest) {
    const attempt = quest?.assignee;
    if (!attempt?.attemptId) return;
    const hooks = (config.verification?.hooks || []).filter((hook) => hook.enabled && hook.trigger === 'delivered' && hook.kinds.includes(quest.kind));
    if (!hooks.length || attemptsInFlight.has(attempt.attemptId)) return;
    attemptsInFlight.add(attempt.attemptId);
    void runSequence(quest, attempt, hooks)
      .catch(() => {})
      .finally(() => attemptsInFlight.delete(attempt.attemptId));
  }

  function cancel(attemptId, hookId) {
    const row = [...active.values()].find((entry) => entry.attemptId === attemptId && entry.hookId === hookId && entry.cancel);
    if (row) row.cancel();
    return Boolean(row);
  }

  // Writes the Chinese recovery note into the hook's own log (appended if a partial log already exists,
  // created fresh otherwise) so a reader of GET /hooks/:hookId/log sees why the result is unknown, then
  // records the terminal `unknown` element and remembers it under the run's original ledger key when one is
  // known, so a later onDelivered for this same attempt/hook never starts a duplicate child.
  function finalizeUnknownTail(quest, attempt, record, hookId, hook, owner) {
    const logPath = record.logPath;
    let logDigest = record.logDigest || null;
    try {
      const absolute = path.resolve(config.paths.data, logPath);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      if (realpathContainmentIssue(config.paths.data, absolute)) throw new Error('outside data');
      const existing = fs.existsSync(absolute) ? fs.readFileSync(absolute) : Buffer.alloc(0);
      const body = appendReason(existing, RECOVERY_NOTE);
      fs.writeFileSync(absolute, body, 'utf8');
      logDigest = createHash('sha256').update(body).digest('hex');
    } catch {
      // Best effort: the state change to `unknown` is what matters; a log write failure here must not
      // block it or throw into recovery.
    }
    const unknown = hookRecord('unknown', hook || { id: hookId }, attempt, logPath, {
      startedAt: record.startedAt,
      endedAt: now(),
      exitCode: null,
      logDigest,
    });
    const recovered = appendRecord(quest.id, attempt, unknown);
    const key = owner?.key || (hook ? hookRunKey(attempt.attemptId, hook) : `${attempt.attemptId}:${hookId}:recovered`);
    remember(key, 'unknown', { quest: quest.id, attemptId: attempt.attemptId, hookId });
    if (recovered) emitHookEvent(quest.id, attempt, hookId, 'hook_finished', 'unknown', null, logPath);
  }

  function recheckTail(questId, attemptId, hookId) {
    const quest = store.get(questId);
    if (!quest) return;
    const attempt = (quest.dispatches || []).find((row) => row.attemptId === attemptId);
    if (!attempt) return;
    const hooks = attempt.hooks || [];
    const record = hooks[hooks.length - 1];
    if (!record || record.state !== 'running' || record.commandRef !== hookId) return;
    const owner = lastOwnerRow(questId, attemptId, hookId);
    if (owner && active.has(owner.key)) return;
    const hook = (config.verification?.hooks || []).find((candidate) => candidate.id === hookId) || null;
    finalizeUnknownTail(quest, attempt, record, hookId, hook, owner);
  }

  // F1: a fresh board instance can never legitimately own a queued/running record it finds at startup — it
  // has not called onDelivered yet. Since a sequential run (B1) leaves at most one hook mid-flight per
  // attempt, only the tail of each attempt's array can possibly be non-terminal; every earlier record is
  // already queued/running/terminal from a completed prior hook and needs no attention.
  function finalizeAttemptTail(quest, attempt) {
    const hooks = attempt.hooks || [];
    const record = hooks[hooks.length - 1];
    if (!record || (record.state !== 'queued' && record.state !== 'running')) return;
    const hookId = record.commandRef;
    const hook = (config.verification?.hooks || []).find((candidate) => candidate.id === hookId) || null;
    const owner = lastOwnerRow(quest.id, attempt.attemptId, hookId);
    const sameInstance = Boolean(owner) && owner.instanceId === instanceId;
    if (record.state === 'queued' || !sameInstance) {
      finalizeUnknownTail(quest, attempt, record, hookId, hook, owner);
      return;
    }
    // A running record genuinely owned by this same instance: if it is still tracked as active, its own
    // completion will finalize it. Otherwise, wait for its timeout to elapse and re-check then, rather than
    // guessing now — "young running records of the same instance are re-checked after their timeout".
    if (active.has(owner.key)) return;
    const timeoutMs = hook ? hook.timeoutSeconds * 1000 : 0;
    const age = Number.isFinite(Date.parse(record.startedAt)) ? Date.now() - Date.parse(record.startedAt) : Infinity;
    if (!hook || age >= timeoutMs) {
      finalizeUnknownTail(quest, attempt, record, hookId, hook, owner);
      return;
    }
    const timer = setTimeout(() => recheckTail(quest.id, attempt.attemptId, hookId), Math.max(0, timeoutMs - age) + 50);
    timer.unref?.();
  }

  function recover() {
    for (const quest of store.list()) {
      for (const attempt of quest.dispatches || []) {
        finalizeAttemptTail(quest, attempt);
      }
    }
  }

  recover();
  return { onDelivered, cancel, getHandle: (key) => active.get(key) || null };
}
