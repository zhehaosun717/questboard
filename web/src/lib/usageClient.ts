/**
 * The only code that issues `GET /api/usage`. Deliberately does not go through api/client.ts's shared
 * `call()`: that helper builds an Error message straight from a response body's `error` field (see
 * ApiError), which is exactly the trust-boundary problem this view must not repeat — a legacy adapter can
 * put a raw upstream error (sentinels, a stray Referer, an arbitrarily long body) into that field, and this
 * page must never echo it back (see lib/usage.ts providerGuidanceText). It also owns its own bounded
 * timeout via AbortController, which call() has none of.
 *
 * This module is intentionally scoped to /api/usage only — it must not become a second general-purpose
 * HTTP helper. Everything else in the app keeps using api/client.ts.
 */

export class UsageHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`usage_http_${status}`);
    this.name = 'UsageHttpError';
    this.status = status;
  }
}

export type UsageFetcher = (opts: {
  refresh: boolean;
  providerId?: string;
  signal: AbortSignal;
}) => Promise<unknown>;

/** Returns the parsed body as `unknown` — lib/usageValidation.ts is the only code allowed to interpret it.
 * A non-OK response throws before the body is ever read, so a 403/500 page's text can't reach any caller. */
export const fetchUsageReport: UsageFetcher = async ({ refresh, providerId, signal }) => {
  const params = new URLSearchParams();
  // Sent explicitly (never omitted) so a legacy backend that only checks `refresh === '1'` sees an
  // unambiguous "use your cache" signal from the auto-refresh timer, distinct from a manual click.
  params.set('refresh', refresh ? '1' : '0');
  if (providerId) params.set('provider', providerId);
  const response = await fetch(`/api/usage?${params.toString()}`, {
    signal,
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new UsageHttpError(response.status);
  return response.json().catch(() => null);
};

const HTTP_STATUS_TEXT: Readonly<Record<number, string>> = {
  401: '没有权限，请重新登录后再试',
  403: '没有权限，请重新登录后再试',
  404: '接口不存在（版本可能不匹配）',
  429: '请求过于频繁，请稍后再试',
  500: '服务器暂时出错，请稍后再试',
  502: '服务器暂时出错，请稍后再试',
  503: '服务器暂时出错，请稍后再试',
  504: '服务器暂时出错，请稍后再试',
};

export const USAGE_ERROR_TEXT = {
  timeout: '请求超时，请稍后重试',
  malformed: '返回的数据格式不正确',
  network: '网络请求失败，请检查网络连接',
} as const;

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException) return err.name === 'AbortError';
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

/** Always returns one of this module's own fixed Chinese strings — never the failure's own `message`,
 * which for a generic network/parse error can carry a URL or other detail this page has no trust basis
 * for. An HTTP status code is not response content (just the status line), so keying a fixed
 * message off it is safe. */
export function classifyFetchFailure(err: unknown): string {
  if (err instanceof UsageHttpError) return HTTP_STATUS_TEXT[err.status] ?? `请求失败（HTTP ${err.status}）`;
  if (isAbortError(err)) return USAGE_ERROR_TEXT.timeout;
  return USAGE_ERROR_TEXT.network;
}
