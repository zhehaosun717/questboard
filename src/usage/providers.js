// Usage providers. Each returns windows (percent used of a quota that resets), balances (money left), or a plan
// line; a provider that cannot be read says why in plain words.
import fs from 'node:fs';
import path from 'node:path';
import { CURRENCY_PATTERN, UsageError, getJson, isoOrNull, parseJsonDocuments, percent, safeLabel, toNumber, windowLabel } from './common.js';
import { createAntigravityProvider } from './antigravity.js';
import { readClaudeSnapshot } from './claudeStatusline.js';
import { CODEX_NOT_FOUND_NOTE, FALLBACK_NOTE, readCodexAppServer } from './codexAppServer.js';

export const KIMI_BASE_URL = 'https://api.kimi.com/coding/v1';

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));

// Codex CLI writes its live rate limits into each session log; the newest record is the current quota.
export const codex = {
  id: 'codex',
  name: 'OpenAI Codex',
  source: 'local-log',
  access: 'local-log',
  credentialType: 'codex-chatgpt-session',
  async fetch({ homedir, env, now = Date.now() } = {}) {
    const root = path.join(env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(homedir, '.codex'), 'sessions');
    if (!fs.existsSync(root)) return { ok: false, configured: false, code: 'no_sessions_dir' };
    const files = walk(root)
      .filter((file) => /rollout-.*\.jsonl$/.test(path.basename(file)))
      .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 20);
    for (const { file } of files) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (!lines[i].includes('"rate_limits"')) continue;
        let record;
        try { record = JSON.parse(lines[i]); } catch { continue; }
        const limits = record && record.payload && record.payload.rate_limits;
        if (!limits || typeof limits !== 'object') continue;
        const windows = [limits.primary, limits.secondary].filter((w) => w && typeof w === 'object').map((w) => {
          const resetsAt = isoOrNull(w.resets_at);
          const resetsAtMs = typeof w.resets_at === 'number' ? w.resets_at * 1000 : (resetsAt ? Date.parse(resetsAt) : null);
          const isPast = Number.isFinite(resetsAtMs) && resetsAtMs <= now;
          return {
            label: windowLabel(toNumber(w.window_minutes)),
            usedPercent: isPast ? null : toNumber(w.used_percent),
            resetsAt,
            ...(isPast ? { state: 'reset' } : {}),
          };
        });
        return { windows, asOf: isoOrNull(record.timestamp), note: '来自最近一次 Codex 会话，之后没用过就不会变' };
      }
    }
    return { ok: false, configured: true, code: 'no_rate_limit_data' };
  },
};

export const codexAppServer = {
  id: 'codex-app-server',
  name: 'OpenAI Codex app-server',
  source: 'official-cli',
  access: 'official-cli',
  credentialType: 'codex-chatgpt-session',
  async fetch({ env = process.env, homedir, now = Date.now(), ...options } = {}) {
    try {
      return await readCodexAppServer({ ...options, env, now });
    } catch (error) {
      let local = null;
      try { local = await codex.fetch({ env, homedir, now }); } catch { /* use the fixed fallback note */ }
      const usable = local && local.ok !== false && Array.isArray(local.windows) ? local : null;
      return {
        source: 'local-log',
        state: 'stale',
        stale: true,
        windows: usable ? local.windows : [],
        balances: usable && Array.isArray(local.balances) ? local.balances : [],
        plan: usable && typeof local.plan === 'string' ? local.plan : '',
        asOf: usable && typeof local.asOf === 'string' ? local.asOf : null,
        note: `${error?.code === 'not_found' ? `${CODEX_NOT_FOUND_NOTE}；` : ''}${FALLBACK_NOTE}${usable && local.note ? ` ${local.note}` : ' local-log 没有可用的额度快照。'}`,
      };
    }
  },
};

const MINUTES_PER_UNIT = { TIME_UNIT_MINUTE: 1, TIME_UNIT_HOUR: 60, TIME_UNIT_DAY: 1440 };

const KIMI_ISO_KEYS = ['reset_at', 'resetAt', 'reset_time', 'resetTime'];
const KIMI_REL_KEYS = ['reset_in', 'resetIn', 'ttl', 'window'];

function safeKimiLabel(value, key) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64 || /[\r\n]/.test(trimmed)) return null;
  if (key && typeof key === 'string' && key.trim() && trimmed.includes(key.trim())) return null;
  if (/sk-|bearer/i.test(trimmed)) return null;
  if (/[A-Za-z0-9+/=]{20,}/.test(trimmed)) return null;
  return /^[\p{L}\p{N}\p{P}\p{Z}]{1,64}$/u.test(trimmed) ? trimmed : null;
}

export function parseKimiWindowItem(item, { now = Date.now(), index, key } = {}) {
  if (!item || typeof item !== 'object') return null;
  const detail = item.detail && typeof item.detail === 'object' ? item.detail : null;
  const source = detail || item;

  const limit = toNumber(source.limit) ?? (detail ? toNumber(item.limit) : null);
  const remaining = toNumber(source.remaining) ?? (detail ? toNumber(item.remaining) : null);
  let used = toNumber(source.used) ?? (detail ? toNumber(item.used) : null);
  if (used === null && limit !== null && remaining !== null) {
    used = limit - remaining;
  }

  let resetsAt = null;
  let resetDerived = false;

  // Search ISO keys: source first, then item fallback
  for (const k of KIMI_ISO_KEYS) {
    const val = source[k];
    if (val !== undefined && val !== null) {
      try {
        resetsAt = isoOrNull(val);
      } catch {
        resetsAt = null;
      }
      if (resetsAt) break;
    }
  }
  if (!resetsAt && detail) {
    for (const k of KIMI_ISO_KEYS) {
      const val = item[k];
      if (val !== undefined && val !== null) {
        try {
          resetsAt = isoOrNull(val);
        } catch {
          resetsAt = null;
        }
        if (resetsAt) break;
      }
    }
  }

  // Search relative keys: source first, then item fallback
  if (!resetsAt) {
    for (const k of KIMI_REL_KEYS) {
      const val = source[k];
      if (val !== undefined && val !== null) {
        const sec = toNumber(val);
        if (sec !== null && sec >= 0) {
          const ms = now + sec * 1000;
          if (Math.abs(ms) <= 8.64e15) {
            try {
              resetsAt = new Date(ms).toISOString();
              resetDerived = true;
              break;
            } catch {
              // Ignore RangeError on huge numbers; drop this reset
            }
          }
        }
      }
    }
  }
  if (!resetsAt && detail) {
    for (const k of KIMI_REL_KEYS) {
      const val = item[k];
      if (val !== undefined && val !== null) {
        const sec = toNumber(val);
        if (sec !== null && sec >= 0) {
          const ms = now + sec * 1000;
          if (Math.abs(ms) <= 8.64e15) {
            try {
              resetsAt = new Date(ms).toISOString();
              resetDerived = true;
              break;
            } catch {
              // Ignore RangeError on huge numbers; drop this reset
            }
          }
        }
      }
    }
  }

  const isResetPast = resetsAt !== null && Date.parse(resetsAt) <= now;
  let usedPercent = null;
  let state = undefined;
  if (isResetPast) {
    state = 'reset';
    usedPercent = null;
  } else if (limit !== null && limit > 0 && used !== null) {
    usedPercent = percent(used, limit);
  } else {
    usedPercent = null;
  }

  // Label order per Report 885: name / title / scope, then duration+timeUnit (substring MINUTE/HOUR/DAY), then 额度 n
  const candidates = [
    source.name,
    detail ? item.name : null,
    source.title,
    detail ? item.title : null,
    source.scope,
    detail ? item.scope : null,
  ];
  let label = null;
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      const safe = safeKimiLabel(candidate, key);
      if (safe) {
        label = safe;
        break;
      }
    }
  }

  if (!label) {
    const win = (item.window && typeof item.window === 'object')
      ? item.window
      : (detail && detail.window && typeof detail.window === 'object' ? detail.window : {});
    const duration = toNumber(win.duration) ?? toNumber(source.duration) ?? (detail ? toNumber(item.duration) : null);
    const timeUnit = win.timeUnit ?? source.timeUnit ?? (detail ? item.timeUnit : null);
    let unitMinutes = null;
    if (typeof timeUnit === 'string') {
      const upper = timeUnit.toUpperCase();
      if (upper.includes('DAY')) unitMinutes = 1440;
      else if (upper.includes('HOUR')) unitMinutes = 60;
      else if (upper.includes('MINUTE')) unitMinutes = 1;
    }
    const minutes = (unitMinutes && duration !== null) ? duration * unitMinutes : null;
    if (minutes !== null) {
      label = windowLabel(minutes);
    }
  }

  if (!label) {
    if (typeof index === 'number') {
      label = `额度 ${index + 1}`;
    } else {
      label = '额度窗口';
    }
  }

  return {
    label,
    usedPercent,
    resetsAt,
    ...(resetDerived ? { resetDerived: true } : {}),
    ...(state ? { state } : {}),
  };
}

// Undocumented endpoint used by Kimi Code; limit/used/remaining arrive as numeric strings.
export const kimi = {
  id: 'kimi',
  name: 'Kimi for Coding',
  source: 'undocumented-api',
  access: 'undocumented-api',
  credentialType: 'kimi-code-api-key',
  keys: { envNames: ['KIMI_API_KEY'], openCodeIds: ['kimi-for-coding'] },
  async fetch({ fetchImpl, key, now = Date.now() } = {}) {
    const body = await getJson(fetchImpl, `${KIMI_BASE_URL}/usages`, key);
    const windows = [];
    const limits = Array.isArray(body.limits) ? body.limits : [];
    for (let i = 0; i < limits.length; i += 1) {
      const w = parseKimiWindowItem(limits[i], { now, index: i, key });
      if (w) windows.push(w);
    }
    if (body.usage && typeof body.usage === 'object') {
      const u = parseKimiWindowItem(body.usage, { now, key });
      if (u) {
        const usageRaw = [body.usage.name, body.usage.title, body.usage.scope].find(
          (v) => typeof v === 'string' && v.trim() && safeKimiLabel(v, key)
        );
        const usageLabel = (usageRaw ? safeKimiLabel(usageRaw, key) : null) || '本期总额度';
        windows.push({ ...u, label: usageLabel });
      }
    }
    if (!windows.length) throw new UsageError('no_quota_data', { provider: 'Kimi' });
    return { windows };
  },
};

export const deepseek = {
  id: 'deepseek',
  name: 'DeepSeek',
  source: 'official-api',
  access: 'official-api',
  credentialType: 'deepseek-api-key',
  keys: { envNames: ['DEEPSEEK_API_KEY'], openCodeIds: ['deepseek'] },
  async fetch({ fetchImpl, key }) {
    const body = await getJson(fetchImpl, 'https://api.deepseek.com/user/balance', key);
    const balances = (Array.isArray(body.balance_infos) ? body.balance_infos : [])
      .filter((b) => b && safeLabel(b.currency, CURRENCY_PATTERN) && (toNumber(b.total_balance) !== null || toNumber(b.granted_balance) !== null || toNumber(b.topped_up_balance) !== null))
      .map((b) => {
        const total = toNumber(b.total_balance);
        const granted = toNumber(b.granted_balance);
        const toppedUp = toNumber(b.topped_up_balance);
        return {
          currency: b.currency,
          ...(total !== null ? { amount: total } : {}),
          ...(granted !== null ? { granted } : {}),
          ...(toppedUp !== null ? { toppedUp } : {}),
        };
      });
    if (!balances.length) throw new UsageError('no_balance_data', { provider: 'DeepSeek' });
    const isAvailable = typeof body?.is_available === 'boolean' ? body.is_available : null;
    return { balances, isAvailable, note: body && body.is_available === false ? '余额不足，现在不能调用' : '' };
  },
};

export const openrouter = {
  id: 'openrouter',
  name: 'OpenRouter',
  source: 'official-api',
  access: 'official-api',
  credentialType: 'openrouter-api-key',
  keys: { envNames: ['OPENROUTER_API_KEY'], openCodeIds: ['openrouter'] },
  async fetch({ fetchImpl, key }) {
    const body = await getJson(fetchImpl, 'https://openrouter.ai/api/v1/credits', key);
    const credits = toNumber(body && body.data && body.data.total_credits);
    const usage = toNumber(body && body.data && body.data.total_usage);
    if (credits === null || usage === null) throw new UsageError('no_balance_data', { provider: 'OpenRouter' });
    return { balances: [{ currency: 'USD', amount: Math.round((credits - usage) * 100) / 100 }] };
  },
};

const VOLCANO_PERIOD_MAP = {
  session: '5 小时',
  weekly: '每周',
  monthly: '每月',
  custom: '额度窗口',
};

// arkcli reports the subscription and quota periods. Its first document describes the account (ids, names):
// only the plan item is kept; viewer and seat_id are dropped entirely.
export const volcano = {
  id: 'volcano',
  name: '火山方舟 Coding Plan',
  source: 'official-cli',
  access: 'official-cli',
  credentialType: 'arkcli-profile',
  async fetch({ exec, now = Date.now() } = {}) {
    const docs = parseJsonDocuments(await exec('arkcli', ['usage', 'plan', '--product', 'coding-plan', '--format', 'json']));
    const items = docs.flatMap((doc) => (doc && Array.isArray(doc.items) ? doc.items : []));
    const item = items.find((i) => i && i.product === 'coding-plan') || items[0];
    if (!item) throw new UsageError('no_plan_info');
    if (typeof item.error === 'string' && item.error.trim()) {
      const needsLogin = /arkcli auth login [\w-]+/.test(item.error);
      throw new UsageError(needsLogin ? 'login_required' : 'plan_query_failed');
    }

    const edition = safeLabel(item.edition) || '未知版本';
    let asOf = null;
    let asOfDerived = false;
    if (typeof item.updated_at === 'number' && Number.isFinite(item.updated_at) && Math.abs(item.updated_at) <= 8.64e15) {
      try {
        asOf = new Date(item.updated_at).toISOString();
      } catch {
        asOf = null;
      }
    }
    if (!asOf) {
      try {
        asOf = new Date(now).toISOString();
      } catch {
        asOf = new Date().toISOString();
      }
      asOfDerived = true;
    }

    if (item.subscribed === false) {
      return {
        plan: `${edition} · 未订阅`,
        windows: [],
        asOf,
        ...(asOfDerived ? { asOfDerived: true } : {}),
        state: 'not_subscribed',
      };
    }

    if (item.subscribed !== true) {
      return {
        plan: `${edition} · 订阅状态未知`,
        windows: [],
        asOf,
        ...(asOfDerived ? { asOfDerived: true } : {}),
        state: 'unknown',
      };
    }

    const periods = Array.isArray(item.periods) ? item.periods : [];
    if (periods.length === 0) {
      return {
        plan: `${edition} · 已订阅`,
        windows: [],
        asOf,
        ...(asOfDerived ? { asOfDerived: true } : {}),
        state: 'unknown',
      };
    }

    const windows = periods.map((p) => {
      if (!p || typeof p !== 'object') return null;
      const label = VOLCANO_PERIOD_MAP[p.label] || safeLabel(p.label) || '额度窗口';
      let resetsAt = null;
      if (p.reset_at) {
        try {
          resetsAt = isoOrNull(p.reset_at);
        } catch {
          resetsAt = null;
        }
      }
      const resetsAtMs = resetsAt ? Date.parse(resetsAt) : null;
      const isPast = Number.isFinite(resetsAtMs) && resetsAtMs <= now;
      const usedPercent = isPast ? null : toNumber(p.percent);
      return {
        label,
        usedPercent,
        resetsAt,
        ...(isPast ? { state: 'reset' } : {}),
      };
    }).filter(Boolean);

    return {
      plan: `${edition} · 已订阅`,
      windows,
      asOf,
      ...(asOfDerived ? { asOfDerived: true } : {}),
      state: 'ok',
    };
  },
};

// Cursor's own usage endpoint, read with the OAuth token OpenCode already stores — Cursor's local database is
// never touched. Counts are per model against a monthly request cap.
export const cursor = {
  id: 'cursor',
  name: 'Cursor',
  source: 'undocumented-api',
  access: 'undocumented-api',
  credentialType: 'cursor-oauth-session',
  oauth: { openCodeIds: ['cursor'] },
  async fetch({ fetchImpl, key }) {
    const body = await getJson(fetchImpl, 'https://api2.cursor.sh/auth/usage', key);
    const windows = [];
    let uncapped = 0;
    for (const [model, info] of Object.entries(body || {})) {
      if (!info || typeof info !== 'object' || model === 'startOfMonth' || !safeLabel(model)) continue;
      const used = toNumber(info.numRequests);
      const limit = toNumber(info.maxRequestUsage);
      if (used === null) continue;
      if (limit !== null && limit > 0) windows.push({ label: `${model}（本月请求）`, usedPercent: percent(used, limit), resetsAt: null });
      else uncapped += used;
    }
    const start = typeof body.startOfMonth === 'string' ? body.startOfMonth.slice(0, 10) : '';
    const from = start ? `本月从 ${start} 起算` : '';
    // A usage-based plan reports counts with no cap; show the count instead of a bar rather than call it an error.
    if (!windows.length) return { windows, note: [`本月已用 ${uncapped} 次请求（这个套餐没有请求上限）`, from].filter(Boolean).join('，') };
    return { windows, note: from };
  },
};

export const siliconflow = {
  id: 'siliconflow',
  name: '硅基流动',
  source: 'official-api',
  access: 'official-api',
  credentialType: 'siliconflow-api-key',
  unavailable: '硅基流动 2026-08-14 下线了查余额的接口，新接口还没公布',
};

export const antigravity = createAntigravityProvider();

// The balance page calls an endpoint that does report the Token Plan, but it authenticates with the browser
// login cookie — not the API key — and the board does not read browser cookies, so say that rather than
// claiming no endpoint exists.
export const mimo = {
  id: 'mimo',
  name: '小米 MiMo',
  source: 'undocumented-api',
  access: 'undocumented-api',
  credentialType: 'browser-cookie',
  unavailable: '小米 MiMo 要用浏览器登录的 cookie 才能查，API key 查不了；看板还没有接这个来源',
};

// Claude Code subscription status-line snapshot reader (opt-in on the Claude Code side: the owner adds the
// statusLine command to their own settings; the board never edits that file and never chains a status line).
// The card is always shown: with a snapshot it carries the live windows, without one it shows the setup step
// as its note (state manual_only, no numbers invented), which is the honest thing a reader of the card needs.
export const claudeSubscription = {
  id: 'claude-subscription',
  name: 'Claude 订阅',
  source: 'official-hook',
  access: 'official-hook',
  credentialType: 'claude-ai-subscription',
  docsUrl: 'https://code.claude.com/docs/en/statusline',
  async fetch({ homedir, env, now = Date.now() } = {}) {
    const res = readClaudeSnapshot({ homedir, env, now });
    if (!res.ok && res.state === 'not_configured') {
      return {
        windows: [],
        balances: [],
        plan: '',
        note: res.note,
        manual_only: true,
        state: 'manual_only',
        asOf: null,
      };
    }
    return res;
  },
};

export const EXPERIMENTAL_PROVIDERS = [codexAppServer];

export const PROVIDERS = [codex, kimi, deepseek, openrouter, cursor, antigravity, volcano, siliconflow, mimo, claudeSubscription];
