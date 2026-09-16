import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TaskChipPicker } from './TaskChipPicker';

const baseProps = {
  ariaLabel: '前置委托（先完成哪些）',
  suggestions: [
    { id: 'A-1', title: '修好登录页' },
    { id: 'A-2', title: '加缓存' },
  ],
  placeholder: '搜索委托编号或标题，回车加入',
  idPrefix: 'meta-parents',
  onChange: () => undefined,
};

describe('TaskChipPicker (real JSX, SSR)', () => {
  it('renders a chip with a real, labelled remove button per selected id', () => {
    const html = renderToStaticMarkup(<TaskChipPicker {...baseProps} values={['A-1']} />);
    expect(html).toContain('A-1 · 修好登录页');
    expect(html).toContain('aria-label="移除 A-1 · 修好登录页"');
    expect(html).toContain('role="combobox"');
  });

  it('shows an id with no matching suggestion as-is (a raw/legacy entry)', () => {
    const html = renderToStaticMarkup(<TaskChipPicker {...baseProps} values={['GHOST-9']} />);
    expect(html).toContain('>GHOST-9<');
  });

  it('honours a custom formatChip (e.g. 未找到：ID for an unresolved legacy parent)', () => {
    const html = renderToStaticMarkup(
      <TaskChipPicker {...baseProps} values={['GHOST-9']} formatChip={(id) => `未找到：${id}`} />,
    );
    expect(html).toContain('未找到：GHOST-9');
  });

  it('disabled mode hides remove buttons and the add input entirely', () => {
    const html = renderToStaticMarkup(<TaskChipPicker {...baseProps} values={['A-1']} disabled />);
    expect(html).toContain('A-1 · 修好登录页');
    expect(html).not.toContain('meta-chip-remove');
    expect(html).not.toContain('role="combobox"');
    expect(html).toContain('aria-disabled="true"');
  });

  it('an empty picker shows no chip list, just the search input', () => {
    const html = renderToStaticMarkup(<TaskChipPicker {...baseProps} values={[]} />);
    expect(html).not.toContain('meta-chips');
    expect(html).toContain('role="combobox"');
  });
});
