import type { Node } from '@xyflow/react';

export type NodePositions = Readonly<Record<string, { x: number; y: number }>>;

export const GRAPH_POSITIONS_KEY = 'questboard.graphPositions';

/**
 * Quest positions the owner arranged by hand, as stored in this browser. This is a view preference, not board
 * data: an unreadable or hand-edited value is ignored rather than breaking the graph, and only entries with
 * two finite numbers survive.
 */
export function parsePositions(raw: string | null): NodePositions {
  if (!raw) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const positions: Record<string, { x: number; y: number }> = {};
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    const { x, y } = entry as { x?: unknown; y?: unknown };
    if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) {
      positions[id] = { x, y };
    }
  }
  return positions;
}

/** The nodes with the owner's positions laid over the automatic layout. The input nodes are not changed. */
export function applyPositions<T extends Node>(nodes: readonly T[], positions: NodePositions): T[] {
  return nodes.map((node) => {
    const moved = positions[node.id];
    return moved ? { ...node, position: { x: moved.x, y: moved.y } } : node;
  });
}

export function loadPositions(storage: Pick<Storage, 'getItem'> | null): NodePositions {
  if (!storage) return {};
  try {
    return parsePositions(storage.getItem(GRAPH_POSITIONS_KEY));
  } catch {
    return {}; // storage blocked: start from the automatic layout
  }
}

export function savePositions(storage: Pick<Storage, 'setItem' | 'removeItem'> | null, positions: NodePositions): void {
  if (!storage) return;
  try {
    if (Object.keys(positions).length === 0) storage.removeItem(GRAPH_POSITIONS_KEY);
    else storage.setItem(GRAPH_POSITIONS_KEY, JSON.stringify(positions));
  } catch {
    // storage full or blocked: the arrangement still holds until the page reloads
  }
}
