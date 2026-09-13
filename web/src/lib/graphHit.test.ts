import { describe, expect, it } from 'vitest';
import { questAtPoint, type HitTestNode } from './graphHit';

describe('graphHit questAtPoint', () => {
  it('returns quest id when point is inside a quest node', () => {
    const nodes: HitTestNode[] = [
      {
        id: 'LOOK-3',
        type: 'quest',
        position: { x: 100, y: 100 },
        width: 180,
        height: 50,
      },
    ];

    expect(questAtPoint(nodes, { x: 150, y: 120 })).toBe('LOOK-3');
    // Boundaries (inclusive)
    expect(questAtPoint(nodes, { x: 100, y: 100 })).toBe('LOOK-3');
    expect(questAtPoint(nodes, { x: 280, y: 150 })).toBe('LOOK-3');
  });

  it('returns null when point is on empty canvas', () => {
    const nodes: HitTestNode[] = [
      {
        id: 'LOOK-3',
        type: 'quest',
        position: { x: 100, y: 100 },
        width: 180,
        height: 50,
      },
    ];

    expect(questAtPoint(nodes, { x: 50, y: 50 })).toBeNull();
    expect(questAtPoint(nodes, { x: 300, y: 200 })).toBeNull();
    expect(questAtPoint([], { x: 100, y: 100 })).toBeNull();
  });

  it('returns null when point is inside a card node', () => {
    const nodes: HitTestNode[] = [
      {
        id: 'luna-card',
        type: 'card',
        position: { x: 100, y: 100 },
        width: 180,
        height: 50,
      },
    ];

    expect(questAtPoint(nodes, { x: 150, y: 120 })).toBeNull();
  });

  it('uses fallback size (180x50) when width and height are missing', () => {
    const nodes: HitTestNode[] = [
      {
        id: 'RUN-6',
        type: 'quest',
        position: { x: 0, y: 0 },
      },
    ];

    // Inside fallback dimensions 180x50
    expect(questAtPoint(nodes, { x: 179, y: 49 })).toBe('RUN-6');
    // Outside fallback width
    expect(questAtPoint(nodes, { x: 181, y: 25 })).toBeNull();
    // Outside fallback height
    expect(questAtPoint(nodes, { x: 100, y: 51 })).toBeNull();

    // Supports measured property if present
    const measuredNode: HitTestNode = {
      id: 'MEASURED-1',
      type: 'quest',
      position: { x: 0, y: 0 },
      measured: { width: 220, height: 60 },
    };
    expect(questAtPoint([measuredNode], { x: 200, y: 55 })).toBe('MEASURED-1');
  });

  it('returns topmost overlapping node in array order (later in array = topmost)', () => {
    // Documented stacking choice: later elements in array order are rendered on top
    // (standard painter's algorithm / DOM stacking order). questAtPoint checks in reverse order,
    // so the later node in the array is returned as topmost.
    const nodes: HitTestNode[] = [
      {
        id: 'BOTTOM-QUEST',
        type: 'quest',
        position: { x: 50, y: 50 },
        width: 180,
        height: 50,
      },
      {
        id: 'TOP-QUEST',
        type: 'quest',
        position: { x: 70, y: 60 },
        width: 180,
        height: 50,
      },
    ];

    // Point { x: 80, y: 70 } is inside both BOTTOM-QUEST and TOP-QUEST
    expect(questAtPoint(nodes, { x: 80, y: 70 })).toBe('TOP-QUEST');

    // Point { x: 60, y: 55 } is only inside BOTTOM-QUEST
    expect(questAtPoint(nodes, { x: 60, y: 55 })).toBe('BOTTOM-QUEST');
  });
});
