export interface HitTestNode {
  id: string;
  type?: string;
  position: { x: number; y: number };
  width?: number;
  height?: number;
  measured?: { width?: number; height?: number };
}

export interface HitPoint {
  x: number;
  y: number;
}

const DEFAULT_WIDTH = 180;
const DEFAULT_HEIGHT = 50;

/**
 * Given nodes and a point in flow coordinates, returns the id of the quest node
 * whose rectangle contains the point, or null.
 *
 * Stacking order decision:
 * Later nodes in array order are treated as topmost (standard painter's algorithm
 * where later array elements render above earlier elements). We therefore inspect
 * nodes in reverse array order.
 */
export function questAtPoint(
  nodes: readonly HitTestNode[],
  point: HitPoint,
): string | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (!node || node.type !== 'quest') continue;

    const width = node.measured?.width ?? node.width ?? DEFAULT_WIDTH;
    const height = node.measured?.height ?? node.height ?? DEFAULT_HEIGHT;
    const { x, y } = node.position;

    if (
      point.x >= x &&
      point.x <= x + width &&
      point.y >= y &&
      point.y <= y + height
    ) {
      return node.id;
    }
  }

  return null;
}
