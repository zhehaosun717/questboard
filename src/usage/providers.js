// Usage providers. Each returns windows (percent used of a quota that resets), balances (money left), or a plan
// line; a provider that cannot be read says why in plain words.
import fs from 'node:fs';
import path from 'node:path';
import { UsageError, getJson, isoOrNull, parseJsonDocuments, percent, toNumber, windowLabel } from './common.js';

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));

// Codex CLI writes its live rate limits into each session log; the newest record is the current quota.
export const codex = {
  id: 'codex',
  name: 'OpenAI Codex',
  source: 'local-log',
  async fetch({ homedir, env }) {
    const root = path.join(env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(homedir, '.codex'), 'sessions');
    if (!fs.existsSync(root)) return { ok: false, configured: false, error: '没有找到 Codex 会话记录（~/.codex/sessions）' };
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
        const windows = [limits.primary, limits.secondary].filter((w) => w && typeof w === 'object').map((w) => ({
          label: windowLabel(toNumber(w.window_minutes)),
          usedPercent: toNumber(w.used_percent),
          resetsAt: isoOrNull(w.resets_at),
        }));
        return { windows, asOf: isoOrNull(record.timestamp), note: '来自最近一次 Codex 会话，之后没用过就不会变' };
      }
    }
    return { ok: false, configured: true, error: 'Codex 会话记录里还没有额度信息' };
  },
};

const MINUTES_PER_UNIT = { TIME_UNIT_MINUTE: 1, TIME_UNIT_HOUR: 60, TIME_UNIT_DAY: 1440 };

// Undocumented endpoint used by Kimi Code; limit/used/remaining arrive as numeric strings.
export const kimi = {
  id: 'kimi',
  name: 'Kimi for Coding',
  source: 'api',
  keys: { envNames: ['KIMI_API_KEY'], openCodeIds: ['kimi-for-coding'] },
  async fetch({ fetchImpl, key }) {
    const body = await getJson(fetchImpl, 'https://api.kimi.com/coding/v1/usages', key);
    const windows = [];
    for (const item of Array.isArray(body.limits) ? body.limits : []) {
      const window = item && item.window ? item.window : {};
      const detail = item && item.detail ? item.detail : {};
      const limit = toNumber(detail.limit);
      const remaining = toNumber(detail.remaining);
      const unit = MINUTES_PER_UNIT[window.timeUnit];
      const minutes = unit && toNumber(window.duration) !== null ? toNumber(window.duration) * unit : null;
      if (limit !== null && remaining !== null) windows.push({ label: windowLabel(minutes), usedPercent: percent(limit - remaining, limit), resetsAt: isoOrNull(detail.resetTime) });
    }
    const usage = body.usage || {};
    const used = percent(toNumber(usage.used), toNumber(usage.limit));
    if (used !== null) windows.push({ label: '本期总额度', usedPercent: used, resetsAt: isoOrNull(usage.resetTime) });
    if (!windows.length) throw new UsageError('Kimi 返回的数据里没有额度');
    return { windows };
  },
};

export const deepseek = {
  id: 'deepseek',
  name: 'DeepSeek',
  source: 'api',
  keys: { envNames: ['DEEPSEEK_API_KEY'], openCodeIds: ['deepseek'] },
  async fetch({ fetchImpl, key }) {
    const body = await getJson(fetchImpl, 'https://api.deepseek.com/user/balance', key);
    const balances = (Array.isArray(body.balance_infos) ? body.balance_infos : [])
      .filter((b) => b && typeof b.currency === 'string' && toNumber(b.total_balance) !== null)
      .map((b) => ({ currency: b.currency, amount: toNumber(b.total_balance) }));
    if (!balances.length) throw new UsageError('DeepSeek 返回的数据里没有余额');
    return { balances, note: body.is_available === false ? '余额不足，现在不能调用' : '' };
  },
};

export const openrouter = {
  id: 'openrouter',
  name: 'OpenRouter',
  source: 'api',
  keys: { envNames: ['OPENROUTER_API_KEY'], openCodeIds: ['openrouter'] },
  async fetch({ fetchImpl, key }) {
    const body = await getJson(fetchImpl, 'https://openrouter.ai/api/v1/credits', key);
    const credits = toNumber(body && body.data && body.data.total_credits);
    const usage = toNumber(body && body.data && body.data.total_usage);
    if (credits === null || usage === null) throw new UsageError('OpenRouter 返回的数据里没有余额');
    return { balances: [{ currency: 'USD', amount: Math.round((credits - usage) * 100) / 100 }] };
  },
};

// arkcli reports the subscription, not the numbers. Its first document describes the account (ids, names):
// only the plan item is kept.
export const volcano = {
  id: 'volcano',
  name: '火山方舟 Coding Plan',
  source: 'cli',
  async fetch({ exec }) {
    const docs = parseJsonDocuments(await exec('arkcli', ['usage', 'plan', '--product', 'coding-plan', '--format', 'json']));
    const items = docs.flatMap((doc) => (doc && Array.isArray(doc.items) ? doc.items : []));
    const item = items.find((i) => i && i.product === 'coding-plan') || items[0];
    if (!item) throw new UsageError('arkcli 没有返回套餐信息');
    // With an error the subscribed flag is not an answer (arkcli reports false when it could not ask), so say
    // what arkcli needs instead of "not subscribed".
    if (typeof item.error === 'string' && item.error.trim()) {
      const login = item.error.match(/arkcli auth login [\w-]+/);
      throw new UsageError(login ? `arkcli 需要先登录：在终端运行 ${login[0]}` : 'arkcli 没能查到套餐（运行 arkcli usage plan 看原因）');
    }
    return { plan: `${item.edition || '未知版本'} · ${item.subscribed ? '已订阅' : '未订阅'}`, note: 'arkcli 只给订阅状态，不给用量数字' };
  },
};

// Cursor's own usage endpoint, read with the OAuth token OpenCode already stores — Cursor's local database is
// never touched. Counts are per model against a monthly request cap.
export const cursor = {
  id: 'cursor',
  name: 'Cursor',
  source: 'api',
  oauth: { openCodeIds: ['cursor'] },
  async fetch({ fetchImpl, key }) {
    const body = await getJson(fetchImpl, 'https://api2.cursor.sh/auth/usage', key);
    const windows = [];
    for (const [model, info] of Object.entries(body || {})) {
      if (!info || typeof info !== 'object' || model === 'startOfMonth') continue;
      const used = toNumber(info.numRequests);
      const limit = toNumber(info.maxRequestUsage);
      if (used !== null && limit !== null && limit > 0) windows.push({ label: `${model}（本月请求）`, usedPercent: percent(used, limit), resetsAt: null });
    }
    if (!windows.length) throw new UsageError('Cursor 没有返回带上限的用量');
    const start = typeof body.startOfMonth === 'string' ? body.startOfMonth.slice(0, 10) : '';
    return { windows, note: start ? `本月从 ${start} 起算` : '' };
  },
};

export const siliconflow = {
  id: 'siliconflow',
  name: '硅基流动',
  source: 'api',
  unavailable: '硅基流动 2026-08-14 下线了查余额的接口，新接口还没公布',
};

const later = (id, name) => ({ id, name, source: 'local-app', unavailable: '还没接入（下一步做：读本机登录信息，只在内存里用）' });

export const PROVIDERS = [codex, kimi, deepseek, openrouter, cursor, volcano, siliconflow, later('agy', 'Antigravity（agy）'), later('mimo', '小米 MiMo')];
