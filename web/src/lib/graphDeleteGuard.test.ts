import { describe, expect, it } from 'vitest';
import { isGraphDeleteKey, shouldSkipGraphDeleteKey, type DeleteGuardElement } from './graphDeleteGuard';

function el(
  props: Partial<DeleteGuardElement> & { classAttr?: string; role?: string } = {},
  parent: DeleteGuardElement | null = null,
): DeleteGuardElement {
  const attrs: Record<string, string> = {};
  if (props.classAttr) attrs.class = props.classAttr;
  if (props.role) attrs.role = props.role;
  return {
    tagName: props.tagName,
    isContentEditable: props.isContentEditable,
    parentElement: parent,
    getAttribute: (name) => attrs[name] ?? null,
  };
}

describe('isGraphDeleteKey', () => {
  it('accepts Delete and Backspace only', () => {
    expect(isGraphDeleteKey('Delete')).toBe(true);
    expect(isGraphDeleteKey('Backspace')).toBe(true);
    expect(isGraphDeleteKey('a')).toBe(false);
    expect(isGraphDeleteKey('Escape')).toBe(false);
  });
});

describe('shouldSkipGraphDeleteKey', () => {
  it('skips a non-delete key outright', () => {
    expect(
      shouldSkipGraphDeleteKey({ key: 'a', target: el({ tagName: 'DIV' }), isNodeDragActive: false }),
    ).toBe(true);
  });

  // FAIL N1: deleting a node while React Flow's own drag gesture is still in flight can leave
  // onNodeDragStop — and the dragPause it clears — stuck, so a delete mid-drag must be a no-op.
  it('skips Delete/Backspace while a node drag is active, even over a plain node target', () => {
    const target = el({ tagName: 'DIV' });
    expect(shouldSkipGraphDeleteKey({ key: 'Delete', target, isNodeDragActive: true })).toBe(true);
    expect(shouldSkipGraphDeleteKey({ key: 'Backspace', target, isNodeDragActive: true })).toBe(true);
  });

  it('does not skip a plain node-wrapper target when idle (deliberate selection still works)', () => {
    const target = el({ tagName: 'DIV' });
    expect(shouldSkipGraphDeleteKey({ key: 'Delete', target, isNodeDragActive: false })).toBe(false);
  });

  it('does not skip a role="button" node avatar (the selected node wrapper), so deliberate delete works', () => {
    const target = el({ tagName: 'DIV', role: 'button' });
    expect(shouldSkipGraphDeleteKey({ key: 'Delete', target, isNodeDragActive: false })).toBe(false);
  });

  // FAIL N2: text/editable targets.
  it('skips an input target', () => {
    const target = el({ tagName: 'INPUT' });
    expect(shouldSkipGraphDeleteKey({ key: 'Delete', target, isNodeDragActive: false })).toBe(true);
  });

  it('skips a textarea target', () => {
    const target = el({ tagName: 'TEXTAREA' });
    expect(shouldSkipGraphDeleteKey({ key: 'Backspace', target, isNodeDragActive: false })).toBe(true);
  });

  it('skips a contentEditable target', () => {
    const target = el({ tagName: 'DIV', isContentEditable: true });
    expect(shouldSkipGraphDeleteKey({ key: 'Delete', target, isNodeDragActive: false })).toBe(true);
  });

  // FAIL N2: links, zoom/layout/control buttons.
  it('skips a link target', () => {
    const target = el({ tagName: 'A' });
    expect(shouldSkipGraphDeleteKey({ key: 'Delete', target, isNodeDragActive: false })).toBe(true);
  });

  it('skips a control button target (zoom controls, layout/reset buttons, panel link buttons)', () => {
    const target = el({ tagName: 'BUTTON' });
    expect(shouldSkipGraphDeleteKey({ key: 'Delete', target, isNodeDragActive: false })).toBe(true);
  });

  // FAIL N2: details/summary can toggle without deleting the selected node.
  it('skips a summary target', () => {
    const target = el({ tagName: 'SUMMARY' });
    expect(shouldSkipGraphDeleteKey({ key: 'Delete', target, isNodeDragActive: false })).toBe(true);
  });

  it('skips a details target', () => {
    const target = el({ tagName: 'DETAILS' });
    expect(shouldSkipGraphDeleteKey({ key: 'Backspace', target, isNodeDragActive: false })).toBe(true);
  });

  // FAIL N2: ancestor interactive element and nested span targets, not only the direct target tag —
  // this mirrors a card's open detail panel, where the actual event.target is text/an icon span nested
  // a few levels inside a <button class="link-btn">.
  it('skips a nested span target whose ancestor is an interactive button', () => {
    const button = el({ tagName: 'BUTTON' });
    const inner = el({ tagName: 'SPAN' }, button);
    const target = el({ tagName: 'SPAN' }, inner);
    expect(shouldSkipGraphDeleteKey({ key: 'Delete', target, isNodeDragActive: false })).toBe(true);
  });

  // FAIL N2: role="dialog" landmark (a card's open detail panel) exempts its whole subtree, even plain
  // text/span content with no interactive tag of its own.
  it('skips a target nested inside a role="dialog" details panel with no interactive tag itself', () => {
    const dialog = el({ tagName: 'DIV', role: 'dialog' });
    const target = el({ tagName: 'SPAN' }, dialog);
    expect(shouldSkipGraphDeleteKey({ key: 'Delete', target, isNodeDragActive: false })).toBe(true);
  });

  // FAIL N2: the app's own nodrag convention for an interactive island inside a node.
  it('skips a target nested inside a nodrag-marked ancestor', () => {
    const island = el({ tagName: 'DIV', classAttr: 'rf-card-detail nodrag nowheel nopan' });
    const target = el({ tagName: 'SPAN' }, island);
    expect(shouldSkipGraphDeleteKey({ key: 'Delete', target, isNodeDragActive: false })).toBe(true);
  });

  it('does not skip a plain node target several ancestors deep with no interactive markers anywhere', () => {
    const grandparent = el({ tagName: 'DIV' });
    const parent = el({ tagName: 'DIV' }, grandparent);
    const target = el({ tagName: 'SPAN' }, parent);
    expect(shouldSkipGraphDeleteKey({ key: 'Delete', target, isNodeDragActive: false })).toBe(false);
  });

  it('treats a missing target as not interactive (does not skip)', () => {
    expect(shouldSkipGraphDeleteKey({ key: 'Delete', target: null, isNodeDragActive: false })).toBe(false);
    expect(shouldSkipGraphDeleteKey({ key: 'Delete', target: undefined, isNodeDragActive: false })).toBe(false);
  });
});
