import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { bareReason, errorLine, ReportPanel } from './ReportPanel';

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

  it('labels a changed report distinctly from a gone one', () => {
    const line = errorLine({ code: 'changed', message: '报告内容在记录之后被改过（内容摘要对不上），不敢当作同一份报告展示' });
    expect(line).toContain('内容在记录之后变了');
    expect(line).toContain('不敢当作同一份报告展示');
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
