import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { DEFAULT_LOCALE, setLocale } from '../../lib/i18n';
import { bareReason, errorLine, loadReport, ReportPanel, restoreOpenerFocus } from './ReportPanel';

// SSR only: no DOM is installed here, so the fetch effect never fires (same approach as
// MetadataSection.test.tsx) — this just proves the initial shell and the pure error-formatting helpers.
describe('ReportPanel initial shell (real JSX, SSR)', () => {
  it('shows a loading note before any fetch can resolve', () => {
    const html = renderToStaticMarkup(<ReportPanel questId="A-1" projectId="proj-1" onClose={() => undefined} />);
    expect(html).toContain('完整报告');
    expect(html).toContain('读取中');
  });
});

// The report route's 404 reasons already say 报告不可用 for two of its three causes (src/server/
// questRoutes.js) but not the third (a moved/deleted file's own reason from readCapturedReport) — bareReason
// must strip the prefix only when it is actually there, never invent or duplicate it.
describe('bareReason', () => {
  it('strips an existing 报告不可用 prefix', () => {
    expect(bareReason('报告不可用：这次派遣没有留下报告引用')).toBe('这次派遣没有留下报告引用');
  });

  it('leaves a reason with no such prefix untouched', () => {
    expect(bareReason('这次派遣没有留下可读的报告：xyz')).toBe('这次派遣没有留下可读的报告：xyz');
  });
});

describe('errorLine', () => {
  it('labels a gone report as 报告不可用 without doubling an existing prefix', () => {
    expect(errorLine({ code: 'gone', message: '报告不可用：文件被删了' })).toBe('报告不可用：文件被删了');
  });

  it('shows the server message verbatim for a changed report', () => {
    const line = errorLine({ code: 'changed', message: '报告内容在记录之后被改过（内容摘要对不上），不敢当作同一份报告展示' });
    expect(line).toBe('报告内容在记录之后被改过（内容摘要对不上），不敢当作同一份报告展示');
  });

  it('falls back to a default note when a changed report carries no server message', () => {
    expect(errorLine({ code: 'changed', message: '' })).toBe('报告在记录之后变过，不再当作同一份显示');
  });

  it('labels a network failure distinctly from a server refusal', () => {
    expect(errorLine({ code: 'network', message: 'Failed to fetch' })).toContain('网络请求失败');
  });

  // M1 (round 2): an HTTP 500 (or any status other than 404/409) is the server's own failure, not the
  // browser's — it must read differently from a genuine network abort.
  it('labels a server error (e.g. HTTP 500) distinctly from a network failure', () => {
    const line = errorLine({ code: 'server', message: 'HTTP 500' });
    expect(line).toContain('服务器读取报告出错');
    expect(line).not.toContain('网络请求失败');
  });
});

// Item 7/M6: the async fetch, and its 404/409 mapping, driven with a stubbed `api.report` — never a real
// fetch, never a browser. This is what `loadReport` was pulled out of the effect for (see its own comment):
// with no DOM test environment installed here, a real mount is out of reach, but the state-transition logic
// itself — loading → ready, or loading → one of the four error codes — is real production code and fully
// reachable this way.
describe('loadReport (item 7: async, 404 and 409 paths with a stubbed API)', () => {
  it('stays pending (the loading state) until the stubbed api settles', async () => {
    let settle!: (value: { text: string; truncated: boolean; digest: string | null }) => void;
    const pending = new Promise<{ text: string; truncated: boolean; digest: string | null }>((resolve) => { settle = resolve; });
    const stub = { report: () => pending };
    let settled = false;
    const run = loadReport(stub, 'A-1').then((next) => { settled = true; return next; });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    settle({ text: 'hello', truncated: false, digest: 'abc' });
    const result = await run;
    expect(settled).toBe(true);
    expect(result).toEqual({ status: 'ready', text: 'hello', truncated: false });
  });

  it('returns ready with the text and truncated flag on success', async () => {
    const stub = { report: async () => ({ text: '完整报告正文', truncated: true, digest: 'abc123' }) };
    await expect(loadReport(stub, 'A-1')).resolves.toEqual({ status: 'ready', text: '完整报告正文', truncated: true });
  });

  // The missing-report path (404): the server's ApiError status maps to code 'gone'.
  it('maps a 404 ApiError to a gone error, carrying the server message', async () => {
    const stub = { report: async () => { throw new ApiError('报告不可用：文件被删了', undefined, undefined, undefined, 404); } };
    await expect(loadReport(stub, 'A-1')).resolves.toEqual({ status: 'error', code: 'gone', message: '报告不可用：文件被删了' });
  });

  // The changed-report path (409): the digest no longer matches what was recorded.
  it('maps a 409 ApiError to a changed error, carrying the server message', async () => {
    const stub = { report: async () => { throw new ApiError('报告内容在记录之后被改过（内容摘要对不上），不敢当作同一份报告展示', undefined, undefined, undefined, 409); } };
    await expect(loadReport(stub, 'A-1')).resolves.toEqual({
      status: 'error',
      code: 'changed',
      message: '报告内容在记录之后被改过（内容摘要对不上），不敢当作同一份报告展示',
    });
  });

  it('maps any other ApiError status (e.g. HTTP 500) to a server error', async () => {
    const stub = { report: async () => { throw new ApiError('HTTP 500', undefined, undefined, undefined, 500); } };
    await expect(loadReport(stub, 'A-1')).resolves.toEqual({ status: 'error', code: 'server', message: 'HTTP 500' });
  });

  it('maps a non-ApiError failure (a genuine network abort) to a network error', async () => {
    const stub = { report: async () => { throw new Error('Failed to fetch'); } };
    await expect(loadReport(stub, 'A-1')).resolves.toEqual({ status: 'error', code: 'network', message: 'Failed to fetch' });
  });
});

// Item 4/M2: after 收起, focus goes to the toggle button, never `<body>`. `restoreOpenerFocus` is the whole
// decision ReportPanel's unmount effect makes with `document.activeElement` captured at mount — this project
// has no DOM test environment installed (see QuestReceipt.test.tsx's own note on the same gap, and the brief
// for this fix bars installing one), so a literal mounted-panel assertion against a real `document.
// activeElement` is not reachable from vitest here. What is reachable, and is the actual fix, is this
// function: duck-typed exactly like threadAsyncGuards.test.ts's canReceiveFocus, so it is provable with a
// plain object standing in for the toggle button, never a stand-in for the behaviour itself.
describe('restoreOpenerFocus (item 4/M2)', () => {
  it('refocuses a still-connected, enabled opener (e.g. the receipt toggle button)', () => {
    const opener = { isConnected: true, disabled: false, focus: vi.fn() };
    restoreOpenerFocus(opener);
    expect(opener.focus).toHaveBeenCalledTimes(1);
  });

  it('does nothing for an opener the panel outlived (removed from the document)', () => {
    const opener = { isConnected: false, focus: vi.fn() };
    restoreOpenerFocus(opener);
    expect(opener.focus).not.toHaveBeenCalled();
  });

  it('does nothing for a disabled opener', () => {
    const opener = { isConnected: true, disabled: true, focus: vi.fn() };
    restoreOpenerFocus(opener);
    expect(opener.focus).not.toHaveBeenCalled();
  });

  it('does nothing, and never throws, when nothing was captured', () => {
    expect(() => restoreOpenerFocus(null)).not.toThrow();
  });
});

describe('ReportPanel language switch (item 38 follow-up)', () => {
  afterEach(() => {
    setLocale(DEFAULT_LOCALE);
  });

  it('renders the initial shell in English', () => {
    setLocale('en');
    const html = renderToStaticMarkup(<ReportPanel questId="A-1" projectId="proj-1" onClose={() => undefined} />);
    expect(html).toContain('Full report');
    expect(html).toContain('Reading…');
    expect(html).toContain('Collapse');
    expect(html).not.toMatch(/[一-鿿]/);
  });

  it('errorLine composes every error branch in English', () => {
    setLocale('en');
    expect(errorLine({ code: 'gone', message: '报告不可用：文件被删了' })).toBe('Report unavailable: 文件被删了');
    expect(errorLine({ code: 'changed', message: '' })).toBe(
      'The report changed after it was recorded; it is no longer treated as the same one.',
    );
    expect(errorLine({ code: 'server', message: 'HTTP 500' })).toContain('The server failed to read the report');
    expect(errorLine({ code: 'network', message: 'Failed to fetch' })).toContain('network request failed');
  });
});
