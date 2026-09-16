import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsageHttpError, USAGE_ERROR_TEXT, classifyFetchFailure, fetchUsageReport } from './usageClient';

// Every case here mocks `fetch` directly — this module is the only code allowed to call it for usage data,
// and none of these tests may touch a real network or a real board server (see the module's own comment).

function mockResponse(overrides: Partial<Response> & { jsonBody?: unknown; jsonRejects?: boolean } = {}): Response {
  const { jsonBody, jsonRejects, ...rest } = overrides;
  return {
    ok: true,
    status: 200,
    json: jsonRejects ? () => Promise.reject(new Error('bad json')) : () => Promise.resolve(jsonBody ?? {}),
    ...rest,
  } as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchUsageReport', () => {
  it('requests refresh=0 explicitly for a passive load, never omitting it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ jsonBody: { providers: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    await fetchUsageReport({ refresh: false, signal: controller.signal });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/usage?refresh=0');
  });

  it('requests refresh=1 for a manual/targeted refresh and includes the provider id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ jsonBody: { providers: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    await fetchUsageReport({ refresh: true, providerId: 'codex', signal: controller.signal });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/usage?refresh=1&provider=codex');
  });

  it('passes the given AbortSignal through to fetch so a caller-owned timeout actually aborts the request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ jsonBody: {} }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    await fetchUsageReport({ refresh: false, signal: controller.signal });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });

  it('throws UsageHttpError with the status and never reads the body of a non-OK response', async () => {
    const json = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 403, json } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    await expect(fetchUsageReport({ refresh: false, signal: controller.signal })).rejects.toMatchObject({
      status: 403,
    });
    // A 403 page can carry a Referer or other sensitive detail in its body — this module must never parse
    // it (see the module header comment).
    expect(json).not.toHaveBeenCalled();
  });

  it('resolves to null instead of throwing when the 200 body is not valid JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ jsonRejects: true }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    await expect(fetchUsageReport({ refresh: false, signal: controller.signal })).resolves.toBeNull();
  });
});

describe('classifyFetchFailure', () => {
  it('maps known HTTP statuses to their own fixed Chinese text', () => {
    expect(classifyFetchFailure(new UsageHttpError(401))).toBe('没有权限，请重新登录后再试');
    expect(classifyFetchFailure(new UsageHttpError(429))).toBe('请求过于频繁，请稍后再试');
    expect(classifyFetchFailure(new UsageHttpError(500))).toBe('服务器暂时出错，请稍后再试');
  });

  it('falls back to a generic status-only message for an unmapped HTTP status', () => {
    expect(classifyFetchFailure(new UsageHttpError(418))).toBe('请求失败（HTTP 418）');
  });

  it('classifies an AbortError (DOMException or a plain object) as a timeout', () => {
    expect(classifyFetchFailure(new DOMException('aborted', 'AbortError'))).toBe(USAGE_ERROR_TEXT.timeout);
    expect(classifyFetchFailure({ name: 'AbortError' })).toBe(USAGE_ERROR_TEXT.timeout);
  });

  it('classifies anything else, including the failure\'s own message, as a generic network error without ever surfacing it', () => {
    expect(classifyFetchFailure(new Error('ECONNREFUSED 127.0.0.1:9999'))).toBe(USAGE_ERROR_TEXT.network);
    expect(classifyFetchFailure('a plain string rejection')).toBe(USAGE_ERROR_TEXT.network);
    expect(classifyFetchFailure(null)).toBe(USAGE_ERROR_TEXT.network);
    expect(classifyFetchFailure(undefined)).toBe(USAGE_ERROR_TEXT.network);
  });
});
