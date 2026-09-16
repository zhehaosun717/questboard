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
};

export function formatSourceLabel(source: string): string {
  return USAGE_SOURCE_LABEL[source] ?? source;
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
