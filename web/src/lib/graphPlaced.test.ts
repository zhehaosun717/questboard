import { describe, expect, it } from 'vitest';
import type { Card } from '../api/types';
import {
  GRAPH_PLACED_KEY,
  loadPlacedCards,
  parsePlacedCards,
  placedCardNodes,
  placedStorageKey,
  type PlacedCard,
  savePlacedCards,
} from './graphPlaced';

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
    removeItem: (key: string) => {
      items.delete(key);
    },
  };
}

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

describe('placedStorageKey', () => {
  it('namespaces the base key by project id', () => {
    expect(placedStorageKey('proj-a')).toBe(`${GRAPH_PLACED_KEY}:proj-a`);
  });

  it('is null without a project id, never falling back to a shared key', () => {
    expect(placedStorageKey(null)).toBeNull();
    expect(placedStorageKey(undefined)).toBeNull();
    expect(placedStorageKey('')).toBeNull();
  });
});

describe('parsePlacedCards', () => {
  it('reads stored placements', () => {
    expect(parsePlacedCards('[{"cardId":"kimi-k3","x":1,"y":2}]')).toEqual([{ cardId: 'kimi-k3', x: 1, y: 2 }]);
  });

  it('ignores unreadable values and entries missing a card id or two finite numbers', () => {
    expect(parsePlacedCards(null)).toEqual([]);
    expect(parsePlacedCards('not json')).toEqual([]);
    expect(parsePlacedCards('{"cardId":"a","x":1,"y":2}')).toEqual([]); // not an array
    expect(
      parsePlacedCards(
        '[{"cardId":"","x":1,"y":2},{"cardId":"a","x":"1","y":2},{"cardId":"b"},{"cardId":"c","x":3,"y":4}]',
      ),
    ).toEqual([{ cardId: 'c', x: 3, y: 4 }]);
  });
});

describe('loadPlacedCards and savePlacedCards', () => {
  it('round trips through storage, namespaced by project, and removes the key when nothing is placed', () => {
    const storage = memoryStorage();
    savePlacedCards(storage, 'proj-a', [{ cardId: 'kimi-k3', x: 1, y: 2 }]);
    expect(loadPlacedCards(storage, 'proj-a')).toEqual([{ cardId: 'kimi-k3', x: 1, y: 2 }]);
    expect(storage.items.has(`${GRAPH_PLACED_KEY}:proj-a`)).toBe(true);
    savePlacedCards(storage, 'proj-a', []);
    expect(storage.items.has(`${GRAPH_PLACED_KEY}:proj-a`)).toBe(false);
  });

  it('keeps two projects isolated in the same storage', () => {
    const storage = memoryStorage();
    savePlacedCards(storage, 'proj-a', [{ cardId: 'X', x: 1, y: 1 }]);
    savePlacedCards(storage, 'proj-b', [{ cardId: 'X', x: 9, y: 9 }]);
    expect(loadPlacedCards(storage, 'proj-a')).toEqual([{ cardId: 'X', x: 1, y: 1 }]);
    expect(loadPlacedCards(storage, 'proj-b')).toEqual([{ cardId: 'X', x: 9, y: 9 }]);
  });

  it('never reads or writes any key when the project id is unknown, so it cannot leak into a shared bucket', () => {
    const storage = memoryStorage();
    savePlacedCards(storage, null, [{ cardId: 'X', x: 1, y: 1 }]);
    expect(storage.items.size).toBe(0);
    expect(loadPlacedCards(storage, null)).toEqual([]);
    expect(loadPlacedCards(storage, undefined)).toEqual([]);
  });

  it('falls back to nothing placed when storage is missing or throws', () => {
    expect(loadPlacedCards(null, 'proj-a')).toEqual([]);
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadPlacedCards(throwing, 'proj-a')).toEqual([]);
    expect(() => savePlacedCards(throwing, 'proj-a', [{ cardId: 'a', x: 1, y: 1 }])).not.toThrow();
  });
});
