import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider } from '@xyflow/react';
import { makeCard } from '../lib/testFixtures';
import { DEFAULT_LOCALE, setLocale } from '../lib/i18n';
import { CardNode, type CardNodeData } from './CardNode';
import { EMPTY_CARD_ACTIVITY } from '../lib/cardActivity';

// Renders the real CardNode.tsx (graph card detail panel). The detail panel only mounts once opened by a
// click, which static SSR markup cannot simulate — the "shows derived.reason and the base/effective split"
// requirement (feedback9 row 4) is exercised in the browser check instead. This guards what SSR can honestly
// verify: the closed token renders its identity and never leaks derived text before it is opened.

function render(data: CardNodeData) {
  return renderToStaticMarkup(
    <ReactFlowProvider>
      <CardNode
        id="n1"
        data={data}
        type="card"
        selected={false}
        isConnectable
        zIndex={0}
        dragging={false}
        selectable
        deletable
        draggable
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />
    </ReactFlowProvider>,
  );
}

describe('CardNode derived status (real JSX)', () => {
  it('carries the derived-limited card in its identity, but the closed token shows no derived text yet', () => {
    const card = makeCard('card-a', {
      name: 'Card A',
      status: 'limited',
      baseStatus: 'available',
      derived: { from: 'lanes', reason: 'codex 限额中，10:50 AM 恢复', at: '2026-09-16T08:00:00.000Z', resetsAt: '2099-01-01T00:00:00.000Z' },
    });
    const html = render({ card, activity: EMPTY_CARD_ACTIVITY });
    expect(html).toContain(`aria-label="Card A · ${card.model}"`);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('rf-card-detail-derived');
    expect(html).not.toContain('codex 限额中');
  });

  it('renders a plainly manual card the same way, with no derived markup', () => {
    const card = makeCard('card-a', { name: 'Card A', status: 'paused', baseStatus: 'paused' });
    const html = render({ card, activity: EMPTY_CARD_ACTIVITY });
    expect(html).toContain(`aria-label="Card A · ${card.model}"`);
    expect(html).not.toContain('rf-card-detail-derived');
  });
});

describe('CardNode language switch (item 38 follow-up)', () => {
  afterEach(() => {
    setLocale(DEFAULT_LOCALE);
  });

  // The detail panel only mounts once opened by a click (see the file header note above): this project has
  // no DOM test environment installed, so the panel's converted strings (正在做/做过/还没有委托记录/detail
  // aria-label) cannot be exercised via SSR here. What IS reachable is the closed token, which carries no
  // Chinese literal to convert in the first place (its identity string is built from plain `·` separators).
  it('the closed token carries no Chinese literal in English mode (the identity itself has none to translate)', () => {
    setLocale('en');
    const card = makeCard('card-a', { name: 'Card A', status: 'available', model: 'model-a' });
    const html = render({ card, activity: EMPTY_CARD_ACTIVITY });
    expect(html).toContain(`aria-label="Card A · ${card.model}"`);
    expect(html).not.toMatch(/[一-鿿]/);
    expect(html).not.toMatch(/[\u3000-\u303F\uFF00-\uFFEF]/);
  });
});
