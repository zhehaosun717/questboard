import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ReviewPage, UnpostedBrief } from '../../api/types';
import { RedoArtDialog, buildRedoRequest, isRedoDraftReady } from './RedoArtDialog';

const manifestPage = (overrides: Partial<ReviewPage> = {}): ReviewPage => ({
  page: 'art/page-1',
  title: '角色 A 重绘',
  url: '/review/art/charA/final.html',
  total: 4,
  answered: 1,
  ...overrides,
});

const shelfBrief = (overrides: Partial<UnpostedBrief> = {}): UnpostedBrief => ({
  package: 'qb-art-redo-1',
  brief: 'docs/briefs/art-redo.md',
  title: '重绘简报',
  writtenAt: '2026-09-16T00:00:00.000Z',
  ...overrides,
});

const render = (props: Partial<Parameters<typeof RedoArtDialog>[0]> = {}) =>
  renderToStaticMarkup(
    <RedoArtDialog page={manifestPage()} onClose={() => undefined} onPosted={() => undefined} {...props} />,
  );

describe('isRedoDraftReady', () => {
  it('三个字段都填了才算可提交', () => {
    expect(
      isRedoDraftReady({ packageId: 'pkg-1', brief: 'docs/briefs/x.md', reviewPage: 'art/page-1' }),
    ).toBe(true);
    expect(
      isRedoDraftReady({ packageId: '  ', brief: 'docs/briefs/x.md', reviewPage: 'art/page-1' }),
    ).toBe(false);
    expect(
      isRedoDraftReady({ packageId: 'pkg-1', brief: '  ', reviewPage: 'art/page-1' }),
    ).toBe(false);
    expect(isRedoDraftReady({ packageId: 'pkg-1', brief: 'docs/briefs/x.md', reviewPage: '' })).toBe(
      false,
    );
  });
});

describe('buildRedoRequest', () => {
  it('去掉首尾空白并固定 kind 为 art', () => {
    expect(
      buildRedoRequest({ packageId: ' pkg-1 ', brief: ' docs/briefs/x.md ', reviewPage: 'art/page-1' }),
    ).toEqual({
      package: 'pkg-1',
      brief: 'docs/briefs/x.md',
      kind: 'art',
      reviewPage: 'art/page-1',
    });
  });
});

describe('RedoArtDialog', () => {
  it('明确展示目标页面、批注统计与绑定来源', () => {
    const html = render({ briefs: [shelfBrief()] });
    expect(html).toContain('发起重做委托');
    expect(html).toContain('页面编号');
    expect(html).toContain('art/page-1');
    expect(html).toContain('角色 A 重绘');
    expect(html).toContain('/review/art/charA/final.html');
    expect(html).toContain('共 4 处，已批注 1 处');
    expect(html).toContain('评审目录/art/charA/final.html');
    expect(html).toContain('将要提交的内容');
    expect(html).toContain('美术（art）');
  });

  it('列出未发布简报，初始不选中也不自动填委托包', () => {
    const html = render({ briefs: [shelfBrief()] });
    expect(html).toContain('type="radio"');
    expect(html).toContain('qb-art-redo-1');
    expect(html).toContain('重绘简报');
    expect(html).toContain('docs/briefs/art-redo.md');
    expect(html).not.toContain('checked');
    expect(html).toContain('未选择');
    expect(html).toContain('未填写');
  });

  it('未选好简报前确认按钮不可点', () => {
    const html = render({ briefs: [shelfBrief()] });
    expect(html).toContain('确认发起重做');
    expect(html).toContain('取消');
    expect(html).toMatch(/redo-confirm[^>]*disabled/);
  });

  it('对话框里没有提交按钮，确认键只响应点击（F3）', () => {
    const html = render({ briefs: [shelfBrief()] });
    expect(html).toMatch(/redo-confirm[^>]*type="button"/);
    expect(html).not.toContain('type="submit"');
  });

  it('没有未发布简报时提示直接输入路径', () => {
    const html = render({ briefs: [] });
    expect(html).toContain('当前没有未发布的简报，请直接输入简报路径。');
    expect(html).toContain('或输入简报路径');
  });

  it('旧服务缺少未发布简报列表时提示可以直接输入路径', () => {
    const html = render();
    expect(html).toContain('当前看板没有提供未发布简报列表（可能是旧版本），请直接输入简报路径。');
    expect(html).toContain('或输入简报路径');
  });

  it('没有页面编号时不渲染任何内容', () => {
    expect(render({ page: manifestPage({ page: null }) })).toBe('');
  });
});
