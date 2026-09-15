import type { Node } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../api/types';
import {
  applyPositions,
  GRAPH_POSITIONS_KEY,
  graphInstanceKey,
  isCommittedPositionChange,
  loadPositions,
  parsePositions,
  positionAfterDrop,
  positionsStorageKey,
  projectIdOf,
  savePositions,
} from './graphPositions';

function node(id: string, x: number, y: number): Node {
  return { id, type: 'quest', position: { x, y }, data: {} };
}

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

describe('parsePositions', () => {
  it('reads stored positions', () => {
    expect(parsePositions('{"ARC-2":{"x":10,"y":-20}}')).toEqual({ 'ARC-2': { x: 10, y: -20 } });
  });

  it('ignores unreadable values and entries without two finite numbers', () => {
    expect(parsePositions(null)).toEqual({});
    expect(parsePositions('not json')).toEqual({});
    expect(parsePositions('[1,2]')).toEqual({});
    expect(parsePositions('{"a":{"x":1},"b":{"x":"1","y":2},"c":null,"d":{"x":3,"y":4}}')).toEqual({ d: { x: 3, y: 4 } });
  });
});

describe('applyPositions', () => {
  it('moves only the nodes the owner placed and leaves the input untouched', () => {
    const nodes = [node('ARC-2', 0, 0), node('LOOK-3', 100, 0)];
    const result = applyPositions(nodes, { 'LOOK-3': { x: 5, y: 6 } });
    expect(result.map((n) => n.position)).toEqual([{ x: 0, y: 0 }, { x: 5, y: 6 }]);
    expect(nodes[1]?.position).toEqual({ x: 100, y: 0 });
    expect(result[0]).toBe(nodes[0]);
  });
});

// The web build can be newer than the running server (or the id field is still mid-rollout), so a fixture
// must be able to represent "project with an id" without that field existing on Snapshot['project'] yet.
function projectSnap(id: unknown): Pick<Snapshot, 'project'> {
  return { project: { name: 'x', lanes: [], ...(id === undefined ? {} : { id }) } as Snapshot['project'] };
}

describe('projectIdOf', () => {
  it('reads a string project id', () => {
    expect(projectIdOf(projectSnap('abc123'))).toBe('abc123');
  });

  it('is null when the id is missing, empty, or not a string (older server, or field mid-rollout)', () => {
    expect(projectIdOf({ project: { name: 'x', lanes: [] } })).toBeNull();
    expect(projectIdOf(projectSnap(''))).toBeNull();
    expect(projectIdOf(projectSnap(42))).toBeNull();
    expect(projectIdOf(null)).toBeNull();
    expect(projectIdOf(undefined)).toBeNull();
  });
});

describe('positionsStorageKey', () => {
  it('namespaces the base key by project id', () => {
    expect(positionsStorageKey('abc123')).toBe(`${GRAPH_POSITIONS_KEY}:abc123`);
  });

  it('is null without a project id, never falling back to a shared key', () => {
    expect(positionsStorageKey(null)).toBeNull();
    expect(positionsStorageKey(undefined)).toBeNull();
    expect(positionsStorageKey('')).toBeNull();
  });
});

describe('graphInstanceKey', () => {
  it('differs for two known project ids', () => {
    expect(graphInstanceKey('proj-a')).not.toBe(graphInstanceKey('proj-b'));
  });

  it('is stable and distinct for the unknown-id case, so two unknown snapshots do not remount each other', () => {
    expect(graphInstanceKey(null)).toBe(graphInstanceKey(undefined));
    expect(graphInstanceKey(null)).toBe(graphInstanceKey(''));
    expect(graphInstanceKey(null)).not.toBe(graphInstanceKey('proj-a'));
  });
});

describe('loadPositions and savePositions', () => {
  it('round trips through storage, namespaced by project, and removes the key when nothing is moved', () => {
    const storage = memoryStorage();
    savePositions(storage, 'proj-a', { 'ARC-2': { x: 1, y: 2 } });
    expect(loadPositions(storage, 'proj-a')).toEqual({ 'ARC-2': { x: 1, y: 2 } });
    expect(storage.items.has(`${GRAPH_POSITIONS_KEY}:proj-a`)).toBe(true);
    savePositions(storage, 'proj-a', {});
    expect(storage.items.has(`${GRAPH_POSITIONS_KEY}:proj-a`)).toBe(false);
  });

  it('keeps two projects isolated in the same storage', () => {
    const storage = memoryStorage();
    savePositions(storage, 'proj-a', { X: { x: 1, y: 1 } });
    savePositions(storage, 'proj-b', { X: { x: 9, y: 9 } });
    expect(loadPositions(storage, 'proj-a')).toEqual({ X: { x: 1, y: 1 } });
    expect(loadPositions(storage, 'proj-b')).toEqual({ X: { x: 9, y: 9 } });
  });

  it('never reads or writes any key when the project id is unknown, so it cannot leak into a shared bucket', () => {
    const storage = memoryStorage();
    savePositions(storage, null, { X: { x: 1, y: 1 } });
    expect(storage.items.size).toBe(0);
    expect(loadPositions(storage, null)).toEqual({});
    expect(loadPositions(storage, undefined)).toEqual({});
  });

  it('falls back to the automatic layout when storage is missing or throws', () => {
    expect(loadPositions(null, 'proj-a')).toEqual({});
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
    expect(loadPositions(throwing, 'proj-a')).toEqual({});
    expect(() => savePositions(throwing, 'proj-a', { a: { x: 1, y: 1 } })).not.toThrow();
  });
});

describe('positionAfterDrop', () => {
  it('springs back to the position the owner actually moved the node to, not the raw dagre slot', () => {
    const moved = { A: { x: 40, y: 50 } };
    expect(positionAfterDrop('A', moved, { x: 0, y: 0 })).toEqual({ x: 40, y: 50 });
  });

  it('falls back to the automatic layout position when the node was never moved', () => {
    expect(positionAfterDrop('B', {}, { x: 7, y: 8 })).toEqual({ x: 7, y: 8 });
  });

  it('is undefined when neither a moved position nor a layout position is known', () => {
    expect(positionAfterDrop('C', {}, undefined)).toBeUndefined();
  });
});

describe('isCommittedPositionChange', () => {
  it('is true for a finished move (dragging false or absent) that carries a position', () => {
    expect(isCommittedPositionChange({ type: 'position', dragging: false, position: { x: 1, y: 1 } })).toBe(true);
    expect(isCommittedPositionChange({ type: 'position', position: { x: 1, y: 1 } })).toBe(true);
  });

  it('is false for an in-progress drag update, so intermediate positions are never persisted', () => {
    expect(isCommittedPositionChange({ type: 'position', dragging: true, position: { x: 1, y: 1 } })).toBe(false);
  });

  it('is false for a position change with no position, or a change that is not about position at all', () => {
    expect(isCommittedPositionChange({ type: 'position', dragging: false })).toBe(false);
    expect(isCommittedPositionChange({ type: 'select', dragging: false, position: { x: 1, y: 1 } })).toBe(false);
    expect(isCommittedPositionChange({ type: 'remove' })).toBe(false);
  });
});
