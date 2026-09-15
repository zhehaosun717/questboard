import type { Node } from '@xyflow/react';
import type { Snapshot } from '../api/types';

export type NodePositions = Readonly<Record<string, { x: number; y: number }>>;

export const GRAPH_POSITIONS_KEY = 'questboard.graphPositions';

/**
 * The snapshot's project id, read defensively: older servers (and a snapshot type mid-rollout) may not send
 * `project.id` at all, so this never invents one.
 */
export function projectIdOf(snap: Pick<Snapshot, 'project'> | null | undefined): string | null {
  const raw = snap ? (snap.project as { id?: unknown }).id : undefined;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * Storage key for one project's remembered layout. Without a known project id there is no safe key: writing
 * under a shared/global key would let two projects' layouts leak into each other, so callers get null and
 * skip persistence entirely rather than falling back to an unscoped key.
 */
export function positionsStorageKey(projectId: string | null | undefined): string | null {
  return projectId ? `${GRAPH_POSITIONS_KEY}:${projectId}` : null;
}

/**
 * A React `key` for the graph's inner component, distinct per project id (including the "no known id" case).
 * Changing the key forces a full remount, so every piece of state a project switch must not leak across
 * (moved/placed positions, the dagre layout ref, the last-fit-view ref) is recreated from scratch instead of
 * carrying the old project's arrangement into the new one.
 */
export function graphInstanceKey(projectId: string | null | undefined): string {
  return projectId || '__unknown-project__';
}

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

export function loadPositions(
  storage: Pick<Storage, 'getItem'> | null,
  projectId: string | null | undefined,
): NodePositions {
  const key = positionsStorageKey(projectId);
  if (!storage || !key) return {};
  try {
    return parsePositions(storage.getItem(key));
  } catch {
    return {}; // storage blocked: start from the automatic layout
  }
}

export function savePositions(
  storage: Pick<Storage, 'setItem' | 'removeItem'> | null,
  projectId: string | null | undefined,
  positions: NodePositions,
): void {
  const key = positionsStorageKey(projectId);
  if (!storage || !key) return;
  try {
    if (Object.keys(positions).length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(positions));
  } catch {
    // storage full or blocked: the arrangement still holds until the page reloads
  }
}

/**
 * Where a node dropped on a quest (accepted, queue-only or refused) should spring back to: the position the
 * owner actually moved it to, never the raw dagre slot underneath. A card or quest that was never moved has
 * no entry here, so it falls back to the automatic layout, which is the only sane starting point for it.
 */
export function positionAfterDrop(
  id: string,
  movedPositions: NodePositions,
  layoutPosition: { x: number; y: number } | undefined,
): { x: number; y: number } | undefined {
  return movedPositions[id] ?? layoutPosition;
}

/**
 * True for a `position` change that is a finished move worth remembering: not one of the many intermediate
 * updates a mouse drag emits while `dragging` is still true, and not a selection/dimension/remove change,
 * which carry no position at all. Both a keyboard arrow-key move and the final update of a mouse drag reach
 * `onNodesChange` this way; a mouse drag's own end is instead handled by `onNodeDragStop`, so callers must
 * still guard against handling the same move twice while a drag is in progress.
 */
export function isCommittedPositionChange(change: {
  type: string;
  dragging?: boolean;
  position?: unknown;
}): boolean {
  return change.type === 'position' && change.dragging !== true && change.position != null;
}
