import type { Node } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import {
  applyPositions,
  GRAPH_POSITIONS_KEY,
  loadPositions,
  parsePositions,
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

describe('loadPositions and savePositions', () => {
  it('round trips through storage and removes the key when nothing is moved', () => {
    const storage = memoryStorage();
    savePositions(storage, { 'ARC-2': { x: 1, y: 2 } });
    expect(loadPositions(storage)).toEqual({ 'ARC-2': { x: 1, y: 2 } });
    savePositions(storage, {});
    expect(storage.items.has(GRAPH_POSITIONS_KEY)).toBe(false);
  });

  it('falls back to the automatic layout when storage is missing or throws', () => {
    expect(loadPositions(null)).toEqual({});
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
    expect(loadPositions(throwing)).toEqual({});
    expect(() => savePositions(throwing, { a: { x: 1, y: 1 } })).not.toThrow();
  });
});
