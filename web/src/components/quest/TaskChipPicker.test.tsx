import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { focusAfterRemoval, focusIndexAfterRemoval, focusMoveIndexForRemoval, TaskChipPicker } from './TaskChipPicker';

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

describe('focusIndexAfterRemoval (pure decision)', () => {
  it('moves to the chip that slid into the removed slot', () => {
    expect(focusIndexAfterRemoval(1, 3)).toBe(1); // removed index 1 of 4; 3 remain, chip that was at 2 is now at 1
  });

  it('moves to the previous chip when the last one was removed', () => {
    expect(focusIndexAfterRemoval(2, 2)).toBe(1); // removed the last of 3; 2 remain
  });

  it('signals the input once the only chip is gone', () => {
    expect(focusIndexAfterRemoval(0, 0)).toBeNull();
  });
});

// F-1 (round 2): the round-1 regression was that Backspace in the empty combobox went through the same
// removeAt as the ✕ button, so it also queued a focus move — even though the input never left the DOM and
// was already exactly where focus should stay. Only a ✕-button removal should move focus at all.
describe('focusMoveIndexForRemoval (F-1: a keyboard-started removal never moves focus)', () => {
  it('returns the removed index for a ✕-button removal, same as before the fix', () => {
    expect(focusMoveIndexForRemoval('button', 0)).toBe(0);
    expect(focusMoveIndexForRemoval('button', 2)).toBe(2);
  });

  it('returns null for a keyboard (Backspace) removal, so the effect below leaves focus alone', () => {
    expect(focusMoveIndexForRemoval('keyboard', 0)).toBeNull();
    expect(focusMoveIndexForRemoval('keyboard', 2)).toBeNull();
  });
});

// N2: removing a chip takes its own remove button out of the DOM. No DOM library is installed here (see
// MetadataSection.test.tsx's own note), so this hand-rolls the one behaviour these tests need from the real
// DOM: document.activeElement reflects whichever element's focus() was last called.
function makeFocusable(name: string, document: { activeElement: unknown }) {
  const el = { name, focus: () => { document.activeElement = el; } };
  return el;
}

describe('N2: focus after removing a chip never falls back to <body>', () => {
  it('moves focus to the chip that shifted into the removed slot', () => {
    const document = { activeElement: null as unknown };
    const remaining = [makeFocusable('chip-0', document), makeFocusable('chip-1', document), makeFocusable('chip-2', document)];
    const input = makeFocusable('input', document);
    focusAfterRemoval(2, remaining, input); // removed index 2 of an original 4; 3 remain
    expect(document.activeElement).toBe(remaining[2]);
  });

  it('moves focus to the previous chip when the last chip is removed', () => {
    const document = { activeElement: null as unknown };
    const remaining = [makeFocusable('chip-0', document), makeFocusable('chip-1', document)];
    const input = makeFocusable('input', document);
    focusAfterRemoval(2, remaining, input); // removed the last of an original 3; 2 remain
    expect(document.activeElement).toBe(remaining[1]);
  });

  it('moves focus to the picker input once the only chip is removed', () => {
    const document = { activeElement: null as unknown };
    const input = makeFocusable('input', document);
    focusAfterRemoval(0, [], input);
    expect(document.activeElement).toBe(input);
  });
});
