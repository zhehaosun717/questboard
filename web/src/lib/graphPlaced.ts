import type { Node } from '@xyflow/react';
import type { Card } from '../api/types';

/** A model the owner dropped onto empty canvas, with where they dropped it (flow coordinates). */
export interface PlacedCard {
  cardId: string;
  x: number;
  y: number;
}

/**
 * buildGraph only knows cards that have already dispatched one of the shown quests, so a model that has
 * never worked has no node to drag onto a quest. These are the nodes the owner placed by hand.
 *
 * A placed card is dropped from the result when the graph already draws it (it was dispatched since it was
 * placed, and two nodes may not share an id) or when it is no longer in the roster (it was removed).
 */
export function placedCardNodes(
  placed: readonly PlacedCard[],
  roster: readonly Card[],
  graphNodeIds: ReadonlySet<string>,
): Node[] {
  const byId = new Map(roster.map((card) => [card.id, card]));
  const seen = new Set<string>();
  const nodes: Node[] = [];

  for (const entry of placed) {
    if (graphNodeIds.has(entry.cardId) || seen.has(entry.cardId)) continue;
    const card = byId.get(entry.cardId);
    if (!card) continue;

    seen.add(entry.cardId);
    nodes.push({
      id: entry.cardId,
      type: 'card',
      position: { x: entry.x, y: entry.y },
      draggable: true,
      data: { card },
    });
  }

  return nodes;
}
