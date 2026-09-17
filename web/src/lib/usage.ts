import type { UsageProvider, UsageProviderState } from '../api/types';

export function usageColorClass(
  percent: number | null | undefined,
): 'green' | 'amber' | 'red' | 'unknown' {
  if (percent === null || percent === undefined || Number.isNaN(percent)) {
    return 'unknown';
  }
  if (percent < 70) {
    return 'green';
  }
  if (percent <= 90) {
    return 'amber';
  }
  return 'red';
}

export function formatBalance(amount: number, currency: string): string {
  const formatted = amount.toFixed(2);
  const cur = currency.toUpperCase();
  if (cur === 'CNY') {
    return `¥${formatted}`;
  }
  if (cur === 'USD') {
    return `$${formatted}`;
  }
  return `${formatted} ${currency}`;
}

export const formatCurrency = formatBalance;

export function formatUsageDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${m}-${d} ${h}:${min}`;
}

export const formatResetTime = formatUsageDate;

export const USAGE_SOURCE_LABEL: Record<string, string> = {
  'local-log': '本机记录',
  api: '接口',
  cli: '命令行',
  'local-app': '本机应用',
  'official-api': '官方接口',
  'official-cli': '官方命令行',
  'official-hook': '官方钩子',
  'undocumented-api': '未公开接口',
  manual: '手动查看',
};

export function formatSourceLabel(source: string): string {
  return USAGE_SOURCE_LABEL[source] ?? `未知来源（${source}）`;
}

/** Distinguishes "no reading yet" from an actual 0%: a percent of exactly 0 is a real, known number and
 * must never look the same as a source that has not answered. */
export function formatPercentOrUnknown(percent: number | null | undefined): string {
  return percent === null || percent === undefined ? '未知' : `${percent}%`;
}

/** Shown as a `title` hint on every per-card refresh button while the backend has not declared support for
 * a targeted refresh (see usageCache.ts USAGE_TARGETED_REFRESH_SUPPORTED): clicking it actually refreshes
 * every provider, sharing the one "refresh all" cooldown, rather than quietly re-reading every source 16
 * times for four quick clicks the way an old backend does under the hood. */
export const USAGE_TARGETED_REFRESH_UNSUPPORTED_HINT = '此版本仅支持刷新全部，点击将刷新所有服务商';

export function formatClockTime(at: number): string {
  const date = new Date(at);
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

const STATE_LABEL: Record<UsageProviderState, string> = {
  pending: '正在读取',
  fresh: '',
  stale: '数据已过期',
  unconfigured: '未接入',
  unavailable: '暂不支持',
  expired: '登录已过期',
  failed: '读取失败',
};

export interface UsageStateInfo {
  state: UsageProviderState;
  label: string;
  // 'data': real numbers may be shown (fresh or a stale-but-real last reading). 'pending': an attempt is
  // in flight and nothing has ever succeeded — show a neutral loading state, not "not configured".
  // 'neutral': no numbers exist and none are coming without the owner doing something (unconfigured /
  // unavailable / expired) — phrase this as next steps, not as an accusation of no quota. This is
  // deliberately a separate axis from "urgent" (see UsageProviderCard): expired/failed are both tone
  // 'neutral' here (no numbers exist) but rendered as an urgent warning tape there, because whether real
  // data exists and whether the owner needs to act are two different questions.
  tone: 'data' | 'pending' | 'neutral';
}

/** Reads the richer state machine when the backend sends it, and otherwise falls back to the legacy
 * ok/configured pair so this view keeps working against the accepted (pre-state-machine) contract.
 * `configured` is `boolean | null`: `false` means "known not configured", `null` means "not known yet" (a
 * first read still pending) — collapsing null into false, the way `!provider.configured` would, flashes a
 * false "not set up" message on every cold load. A provider that is
 * `configured: false` only because a first read has not completed yet (state 'pending') must likewise not
 * be classified as "not configured" when the richer `state` field is present and says otherwise. */
export function usageStateInfo(provider: UsageProvider): UsageStateInfo {
  if (provider.state) {
    const state = provider.state;
    const tone: UsageStateInfo['tone'] = state === 'pending' ? 'pending' : state === 'fresh' || state === 'stale' ? 'data' : 'neutral';
    return { state, label: STATE_LABEL[state], tone };
  }
  if (provider.configured === false) return { state: 'unconfigured', label: STATE_LABEL.unconfigured, tone: 'neutral' };
  if (provider.configured === null) return { state: 'pending', label: STATE_LABEL.pending, tone: 'pending' };
  if (!provider.ok) return { state: 'failed', label: STATE_LABEL.failed, tone: 'neutral' };
  return { state: 'fresh', label: '', tone: 'data' };
}

/** Fixed, page-owned copy per state — this is the only text a "no numbers" card ever shows. Each state
 * gets its own honest fallback: a provider that is merely `pending` or `stale` must never be told it looks
 * "unconfigured", and a real `failed` read must never be told to go set something up. */
const STATE_GUIDANCE_TEXT: Record<UsageProviderState, string> = {
  pending: '正在读取用量数据，请稍候',
  fresh: '',
  stale: '数据可能已过期，正在尝试更新',
  unconfigured: '未接入 / 未配置',
  unavailable: '暂不支持自动读取',
  expired: '登录已过期，请重新登录对应账号',
  failed: '读取失败，请稍后重试',
};

export const UNCONFIGURED_FALLBACK_TEXT = STATE_GUIDANCE_TEXT.unconfigured;

/** A small, closed vocabulary of `errorCode` values this page recognizes and has its own fixed text for.
 * Anything else — including the code itself — is never shown; an unrecognized code just falls back to the
 * state-based text above. This is the "safe codes" side of the trust boundary: a short allowlist of exact
 * matches, not a length or regex heuristic pretending to judge arbitrary text as "probably safe" (that
 * heuristic is exactly what let sentinels and Referer values through before). */
const KNOWN_ERROR_CODE_TEXT: Readonly<Record<string, string>> = {
  missing_key: '未找到对应的 API Key，请检查设置',
  login_expired: '登录已过期，请重新登录对应账号',
  not_supported: '这个来源暂不支持自动读取',
  rate_limited: '请求过于频繁，请稍后再试',
  upstream_error: '服务商接口暂时出错，请稍后再试',
  malformed_response: '返回的数据格式不正确',
  // Bundle J F1: the reader's fixed Claude snapshot codes. Each sentence starts from the reader's own
  // wording and adds the next step; the zh strings match the usageCode.* entries in lib/i18n.ts.
  claude_snapshot_unreadable: '无法读取 Claude 状态栏快照文件，请稍后重试',
  claude_snapshot_too_large: 'Claude 状态栏快照文件超出正常大小，请检查状态栏脚本写出的文件',
  claude_snapshot_read_failed: '读取 Claude 状态栏快照失败，请稍后重试',
  claude_snapshot_corrupt: 'Claude 状态栏快照不是有效的 JSON，请检查状态栏脚本写出的文件',
  claude_snapshot_schema: 'Claude 状态栏快照版本不支持（必须为 schema 1）',
  claude_snapshot_timestamp: 'Claude 状态栏快照时间戳无效，请检查系统时钟',
  claude_snapshot_no_rate_limits: 'Claude 状态栏快照缺少额度数据，请检查状态栏脚本写出的文件',
  claude_snapshot_no_windows: '快照里没有可用的额度数据，运行一次 Claude Code 后再刷新',
};

/** The only text a provider card shows for "no numbers, here's why". Never reads `provider.error`: that
 * field carries whatever an adapter or an old backend put there, unvalidated free text this page has no
 * trust basis for — sentinels and a 403's Referer have both leaked through it in the past. `errorCode`,
 * by contrast, is only ever used to look up one of this page's own
 * fixed strings above; an unrecognized or absent code just falls back to the state's generic text. */
export function providerGuidanceText(provider: UsageProvider): string {
  if (provider.errorCode) {
    const known = KNOWN_ERROR_CODE_TEXT[provider.errorCode];
    if (known) return known;
  }
  const { state } = usageStateInfo(provider);
  return STATE_GUIDANCE_TEXT[state] || UNCONFIGURED_FALLBACK_TEXT;
}

export const PROVIDER_STATE_LABEL: Record<string, string> = {
  ok: '正常',
  not_subscribed: '未订阅',
  unknown: '未知',
  manual_only: '手动查看',
};

export function formatProviderStateLabel(state: string): string {
  return PROVIDER_STATE_LABEL[state] ?? `未知状态（${state}）`;
}

export const WINDOW_STATE_LABEL: Record<string, string> = {
  reset: '已重置',
};

export function formatWindowStateLabel(state: string): string {
  return WINDOW_STATE_LABEL[state] ?? `未知状态（${state}）`;
}

/** Window text for a window the provider reports as reset: there is no reading until the next use, so the
 * card states that instead of drawing a bar (a 0-width bar next to a real 0% would be the same picture). */
export const WINDOW_RESET_REFRESH_TEXT = '已重置，等下次使用后更新';

/** Marks a time the server only derived/estimated rather than observed directly (resetDerived/asOfDerived). */
export const ESTIMATED_MARK = '（估算）';

/** Access labels reuse the source-label table: the same vocabulary (官方接口 / 官方命令行 / 未公开接口 /
 * 本机记录 / 本机应用 / 手动查看) already ships there, and an unrecognized access falls back to a plain
 * Chinese "unknown" phrase carrying the raw value, never the raw English itself. */
export function formatAccessLabel(access: string): string {
  return USAGE_SOURCE_LABEL[access] ?? `未知来源（${access}）`;
}

/** Reset hint for one window: '重置于 09:05（估算）' when the server derived the time, plain otherwise;
 * null when there is no usable time (nothing is shown). */
export function formatWindowResetLine(resetsAt: string | null, derived?: boolean): string | null {
  const time = formatUsageDate(resetsAt);
  if (!time) return null;
  return derived ? `重置于 ${time}${ESTIMATED_MARK}` : `重置于 ${time}`;
}

/** as-of line for the card's dim details; empty string when there is no usable time (nothing is shown). */
export function formatAsOfLine(asOf: string | null, derived?: boolean): string {
  const time = formatUsageDate(asOf);
  if (!time) return '';
  return derived ? `数据截至 ${time}${ESTIMATED_MARK}` : `数据截至 ${time}`;
}

/** Balance availability: undefined = the backend said nothing about it (show nothing); null = the backend
 * explicitly said "not known", which must render as 未知, never as a definite 不可用. */
export function formatBalanceAvailability(value: boolean | null | undefined): string | null {
  if (value === undefined) return null;
  if (value === null) return '未知';
  return value ? '可用' : '不可用';
}
