import type { Node } from '@xyflow/react';
import type { Card } from '../api/types';

/** A model the owner dropped onto empty canvas, with where they dropped it (flow coordinates). */
export interface PlacedCard {
  cardId: string;
  x: number;
  y: number;
}

export const GRAPH_PLACED_KEY = 'questboard.graphPlaced';

/**
 * Storage key for one project's placed models, namespaced the same way graphPositions namespaces moved
 * positions: without a known project id there is no safe key, so callers get null and skip persistence
 * rather than writing under a key two different projects could share.
 */
export function placedStorageKey(projectId: string | null | undefined): string | null {
  return projectId ? `${GRAPH_PLACED_KEY}:${projectId}` : null;
}

/**
 * Placed models as stored in this browser. This is a view preference, not board data: an unreadable or
 * hand-edited value is ignored rather than breaking the graph, and only entries with a non-empty card id and
 * two finite numbers survive. `placedCardNodes` is still responsible for dropping an entry whose card no
 * longer exists in the roster, or that the graph now draws for another reason (dispatched since it was
 * placed) — this only validates the stored shape.
 */
export function parsePlacedCards(raw: string | null): PlacedCard[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const placed: PlacedCard[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const { cardId, x, y } = entry as { cardId?: unknown; x?: unknown; y?: unknown };
    if (
      typeof cardId === 'string' &&
      cardId.length > 0 &&
      typeof x === 'number' &&
      typeof y === 'number' &&
      Number.isFinite(x) &&
      Number.isFinite(y)
    ) {
      placed.push({ cardId, x, y });
    }
  }
  return placed;
}

export function loadPlacedCards(
  storage: Pick<Storage, 'getItem'> | null,
  projectId: string | null | undefined,
): PlacedCard[] {
  const key = placedStorageKey(projectId);
  if (!storage || !key) return [];
  try {
    return parsePlacedCards(storage.getItem(key));
  } catch {
    return []; // storage blocked: start with nothing placed
  }
}

export function savePlacedCards(
  storage: Pick<Storage, 'setItem' | 'removeItem'> | null,
  projectId: string | null | undefined,
  placed: readonly PlacedCard[],
): void {
  const key = placedStorageKey(projectId);
  if (!storage || !key) return;
  try {
    if (placed.length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(placed));
  } catch {
    // storage full or blocked: the placement still holds until the page reloads
  }
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
