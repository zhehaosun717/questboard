import { describe, expect, it } from 'vitest';
import type { Card } from '../api/types';
import { type PlacedCard, placedCardNodes } from './graphPlaced';

function card(id: string, name = id): Card {
  return {
    id,
    name,
    provider: 'test',
    lane: 'codex',
    model: `${id}-model`,
    family: id,
    status: 'available',
    statusSince: null,
    statusReason: '',
    statusSetBy: null,
  };
}

const roster = [card('deepseek-v3'), card('codex-luna'), card('kimi-k3')];

function nodeAt(nodes: ReturnType<typeof placedCardNodes>, index: number) {
  const node = nodes[index];
  if (!node) throw new Error(`expected a node at ${index}`);
  return node;
}

describe('placedCardNodes', () => {
  it('makes a draggable card node at the point it was dropped', () => {
    const placed: PlacedCard[] = [{ cardId: 'kimi-k3', x: 120, y: -40 }];
    const nodes = placedCardNodes(placed, roster, new Set());

    expect(nodes).toHaveLength(1);
    const node = nodeAt(nodes, 0);
    expect(node.id).toBe('kimi-k3');
    expect(node.type).toBe('card');
    expect(node.draggable).toBe(true);
    expect(node.position).toEqual({ x: 120, y: -40 });
    expect((node.data as { card: Card }).card.name).toBe('kimi-k3');
  });

  it('drops a card the graph already draws, so no two nodes share an id', () => {
    const placed: PlacedCard[] = [
      { cardId: 'codex-luna', x: 0, y: 0 },
      { cardId: 'kimi-k3', x: 10, y: 10 },
    ];
    const nodes = placedCardNodes(placed, roster, new Set(['codex-luna', 'RUN-4']));

    expect(nodes.map((n) => n.id)).toEqual(['kimi-k3']);
  });

  it('drops a card that is no longer in the roster', () => {
    const nodes = placedCardNodes([{ cardId: 'removed-card', x: 0, y: 0 }], roster, new Set());
    expect(nodes).toEqual([]);
  });

  it('keeps only the newest placement when one card was placed twice', () => {
    const placed: PlacedCard[] = [
      { cardId: 'kimi-k3', x: 1, y: 1 },
      { cardId: 'kimi-k3', x: 99, y: 99 },
    ];
    const nodes = placedCardNodes(placed, roster, new Set());

    expect(nodes).toHaveLength(1);
    expect(nodeAt(nodes, 0).position).toEqual({ x: 1, y: 1 });
  });
});
