import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReviewPage } from '../api/types';
import { REVIEW_NO_MANIFEST_ERROR } from '../lib/reviewList';
import { ReviewView } from './ReviewView';

// Renders the real ReviewView.tsx (not a stand-in), so a wrong condition on which category/label/message
// shows is caught the same way a human clicking through the review tab would catch it. Interactive behavior
// (keyboard navigation, scroll-into-view, click flows) needs a real DOM/browser and is covered separately by
// the portable browser harness — this file only exercises the initial render for a given prop combination.

const generated = (opts: { path: string; id: string; title: string; answered: number; total: number }): ReviewPage => ({
  page: opts.id,
  title: opts.title,
  url: `/review/${opts.path}`,
  total: opts.total,
  answered: opts.answered,
});

const legacy = (path: string): ReviewPage => ({
  page: null,
  title: path,
  url: `/review/${path}`,
  total: 0,
  answered: 0,
  error: REVIEW_NO_MANIFEST_ERROR,
});

const unrecognisedError = (path: string, rawError: string): ReviewPage => ({
  page: null,
  title: path,
  url: `/review/${path}`,
  total: 0,
  answered: 0,
  error: rawError,
});

function render(props: Partial<Parameters<typeof ReviewView>[0]> = {}) {
  return renderToStaticMarkup(
    <ReviewView reviewPages={[]} selectedUrl={null} onSelectPage={() => {}} {...props} />,
  );
}

describe('ReviewView (real render)', () => {
  it('empty board shows its own message, not a false "all done"', () => {
    const html = render({ reviewPages: [] });
    expect(html).toContain('暂无评审页');
    expect(html).not.toContain('都处理完了');
  });

  it('mixed generated + legacy pages: unknown stats stay neutral, never "手工页面" and never a red 0/0', () => {
    const pages = [
      generated({ path: 'art/charA/final.html', id: 'p1', title: '角色A 最终稿', answered: 1, total: 2 }),
      legacy('notes/handoff.html'),
    ];
    const html = render({ reviewPages: pages });
    expect(html).toContain('角色A 最终稿');
    expect(html).toContain('统计不可用 · 仅查看页面');
    // The old legacy label must never leak into a row. (The redo slice adds its own '手工页面，没有可绑定的
    // 页面编号' note under manual rows — a different string with its own meaning — so anchor on the exact
    // legacy error text instead of the bare substring.)
    expect(html).not.toContain(REVIEW_NO_MANIFEST_ERROR);
    expect(html).not.toContain('已批注 0 / 共 0');
  });

  it('a non-legacy raw server error never leaks into the page, and gets the fixed safe label', () => {
    const pages = [unrecognisedError('bad/page.html', 'ENOENT: no such file, open C:/Users/A/secret/x.html')];
    const html = render({ reviewPages: pages });
    expect(html).toContain('页面信息无法读取');
    expect(html).not.toContain('ENOENT');
    expect(html).not.toContain('secret');
  });

  it('a valid zero-section manifest shows 0/0 without claiming 100%', () => {
    const pages = [generated({ path: 'art/empty.html', id: 'p1', title: '空清单', answered: 0, total: 0 })];
    const html = render({ reviewPages: pages });
    expect(html).toContain('已批注 0 / 共 0');
    expect(html).not.toContain('width:100%');
  });

  it('duplicate filenames in different folders are distinguishable', () => {
    const pages = [legacy('art/charA/final.html'), legacy('art/charB/final.html')];
    const html = render({ reviewPages: pages });
    expect(html).toContain('art/charA');
    expect(html).toContain('art/charB');
  });

  it('all-known-complete with no unknown pages says 都处理完了', () => {
    const pages = [
      generated({ path: 'a.html', id: 'a', title: 'A', answered: 2, total: 2 }),
      generated({ path: 'b.html', id: 'b', title: 'B', answered: 1, total: 1 }),
    ];
    const html = render({ reviewPages: pages });
    expect(html).toContain('都处理完了');
  });

  it('all-known-complete but an unknown page remains must not claim 都处理完了', () => {
    const pages = [
      generated({ path: 'a.html', id: 'a', title: 'A', answered: 2, total: 2 }),
      legacy('b.html'),
    ];
    const html = render({ reviewPages: pages });
    expect(html).not.toContain('都处理完了');
    expect(html).toContain('统计不可用');
  });

  it('an unsafe URL is never clickable, never an iframe target, and never rendered as a link', () => {
    const pages = [
      { page: null, title: 'evil', url: 'https://evil.example/x', total: 0, answered: 0, error: REVIEW_NO_MANIFEST_ERROR } as ReviewPage,
    ];
    const html = render({ reviewPages: pages, selectedUrl: 'https://evil.example/x' });
    expect(html).not.toContain('<iframe');
    expect(html).not.toMatch(/<a[^>]*href="https:\/\/evil\.example/);
  });

  it('the toolbar header shows the selected page\'s title', () => {
    const pages = [
      generated({ path: 'a.html', id: 'a', title: 'A', answered: 0, total: 1 }),
    ];
    const html = render({ reviewPages: pages, selectedUrl: '/review/a.html' });
    expect(html).toContain('<h2>A</h2>');
  });

  it('manifest pages offer 发起重做委托, manual pages say why no redo can be bound', () => {
    const pages = [
      generated({ path: 'a.html', id: 'a', title: 'A', answered: 0, total: 1 }),
      legacy('b.html'),
    ];
    const html = render({ reviewPages: pages });
    expect(html).toContain('发起重做委托');
    expect(html).toContain('这是手写的页面，没有页面编号，没法从这里发起重做');
  });

  it('a manual page gets no redo action at all', () => {
    const html = render({ reviewPages: [legacy('only.html')] });
    expect(html).not.toContain('发起重做委托');
    expect(html).toContain('这是手写的页面，没有页面编号，没法从这里发起重做');
  });

  it('row action names its page in the aria-label (L1)', () => {
    const pages = [generated({ path: 'a.html', id: 'art/page-9', title: 'A', answered: 0, total: 1 })];
    const html = render({ reviewPages: pages });
    expect(html).toContain('aria-label="为 art/page-9 发起重做委托"');
  });

  it('no redo dialog is rendered until the row action is used', () => {
    const pages = [generated({ path: 'a.html', id: 'a', title: 'A', answered: 0, total: 1 })] as ReviewPage[];
    const html = render({ reviewPages: pages });
    expect(html).not.toContain('redo-overlay');
    expect(html).not.toContain('将要提交的内容');
  });
});
