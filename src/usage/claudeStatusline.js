import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { questboardHome } from '../core/home.js';

export const CLAUDE_SETUP_NOTE = '在 Claude Code 里运行 /usage，或按 examples/claude-usage-statusline.mjs 里的说明启用状态栏快照';
export const CLAUDE_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
export const MAX_SNAPSHOT_BYTES = 64 * 1024;

const ISO_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_RESET_SECONDS = 8.64e12; // Dates support |ms| <= 8.64e15, so seconds must stay under that bound
const FUTURE_SKEW_MS = 5 * 60 * 1000; // clock-skew allowance before a capture time counts as suspect

function daysInMonthUTC(year, month) {
  const probe = new Date(0);
  probe.setUTCFullYear(year, month, 0);
  return probe.getUTCDate();
}

// Strict calendar check: regex shape plus real month/day/time bounds, so 2026-02-31 is invalid.
function isValidIso(str) {
  if (typeof str !== 'string') return false;
  const match = ISO_DATETIME.exec(str);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonthUTC(year, month)) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  return Number.isFinite(Date.parse(str));
}

export function getClaudeSnapshotPath({ homedir, env = process.env } = {}) {
  // Everything goes through the shared questboard-home rule; homedir stays a test seam.
  const home = env?.QUESTBOARD_HOME
    ? questboardHome(env)
    : questboardHome({ QUESTBOARD_HOME: path.join(homedir || os.homedir(), '.questboard') });
  return path.join(home, 'usage', 'claude.json');
}

// Percent stays truthful: over 100 is real (a burst can pass the cap) and a negative is unknown, not 0.
function parseClaudeWindow(raw, label, now) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const usedRaw = raw.used_percentage;
  const used = typeof usedRaw === 'number' && Number.isFinite(usedRaw) ? usedRaw : null;

  const resetsRaw = raw.resets_at;
  const resetsAtMs = typeof resetsRaw === 'number' && Number.isInteger(resetsRaw) && Math.abs(resetsRaw) <= MAX_RESET_SECONDS
    ? resetsRaw * 1000
    : null;

  // A window with nothing numeric to show is no window at all.
  if (used === null && resetsAtMs === null) return null;

  const isPast = resetsAtMs !== null && resetsAtMs <= now;
  const resetsAt = resetsAtMs === null ? null : new Date(resetsAtMs).toISOString();
  const usedPercent = !isPast && used !== null && used >= 0 ? Math.round(used * 10) / 10 : null;

  return {
    label,
    usedPercent,
    resetsAt,
    ...(isPast ? { state: 'reset' } : {}),
  };
}

// Fixed, first-party failure codes and their one reviewed Chinese sentence each. This table IS the text: the
// reader builds `error` from it, and service.js imports the same table instead of keeping its own copy, so the
// reader's sentence and the sentence the board can render can no longer drift apart. A code with no sentence
// is a programming error and fails loudly rather than inventing an empty message.
export const CLAUDE_SNAPSHOT_ERROR_TEXT = Object.freeze({
  claude_snapshot_unreadable: '无法读取 Claude 状态栏快照文件',
  claude_snapshot_too_large: 'Claude 状态栏快照文件超出正常大小',
  claude_snapshot_read_failed: '读取 Claude 状态栏快照失败',
  claude_snapshot_corrupt: 'Claude 状态栏快照不是有效的 JSON',
  claude_snapshot_schema: 'Claude 状态栏快照版本不支持（必须为 schema 1）',
  claude_snapshot_timestamp: 'Claude 状态栏快照时间戳无效',
  claude_snapshot_no_rate_limits: 'Claude 状态栏快照缺少额度数据',
  claude_snapshot_no_windows: '快照里没有可用的额度数据',
});

function failedResult(code) {
  const error = CLAUDE_SNAPSHOT_ERROR_TEXT[code];
  if (typeof error !== 'string') throw new Error(`未知的 Claude 快照错误代码：${String(code)}`);
  return {
    ok: false,
    configured: true,
    state: 'failed',
    error,
    code,
    note: error,
    windows: [],
    balances: [],
    asOf: null,
  };
}

export function readClaudeSnapshot({
  homedir,
  env = process.env,
  now = Date.now(),
  staleThresholdMs = CLAUDE_STALE_THRESHOLD_MS,
} = {}) {
  const filePath = getClaudeSnapshotPath({ homedir, env });

  if (!fs.existsSync(filePath)) {
    return {
      ok: false,
      configured: false,
      state: 'not_configured',
      note: CLAUDE_SETUP_NOTE,
      windows: [],
      balances: [],
      asOf: null,
    };
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return failedResult('claude_snapshot_unreadable');
  }

  if (stat.size > MAX_SNAPSHOT_BYTES) {
    return failedResult('claude_snapshot_too_large');
  }

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return failedResult('claude_snapshot_read_failed');
  }

  let data;
  try {
    data = JSON.parse(content);
  } catch {
    return failedResult('claude_snapshot_corrupt');
  }

  if (!data || typeof data !== 'object' || Array.isArray(data) || data.schema !== 1) {
    return failedResult('claude_snapshot_schema');
  }

  if (!isValidIso(data.capturedAt)) {
    return failedResult('claude_snapshot_timestamp');
  }

  const capturedAt = data.capturedAt;
  const capturedMs = Date.parse(capturedAt);
  const isFuture = capturedMs > now + FUTURE_SKEW_MS;
  const isStale = isFuture || (now - capturedMs) > staleThresholdMs;

  const rawLimits = data.rate_limits;
  if (!rawLimits || typeof rawLimits !== 'object' || Array.isArray(rawLimits)) {
    return failedResult('claude_snapshot_no_rate_limits');
  }

  const windows = [];
  for (const [key, label] of [['five_hour', '5 小时'], ['seven_day', '每周'], ['spend_limit', '消费上限']]) {
    const window = parseClaudeWindow(rawLimits[key], label, now);
    if (window) windows.push(window);
  }

  // Present rate_limits with nothing usable inside is a failure, not an empty success.
  if (windows.length === 0) {
    return failedResult('claude_snapshot_no_windows');
  }

  let note = '';
  if (isFuture) {
    note = '快照时间戳晚于当前时间（请检查系统时钟）';
  } else if (isStale) {
    note = '快照数据已过期（超过 24 小时未更新）';
  }

  return {
    ok: true,
    state: 'ok',
    windows,
    balances: [],
    asOf: capturedAt,
    note,
    ...(isStale ? { stale: true } : {}),
  };
}
