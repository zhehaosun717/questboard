import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider } from '@xyflow/react';
import { makeCard } from '../lib/testFixtures';
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
