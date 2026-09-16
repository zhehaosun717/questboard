import { describe, expect, it } from 'vitest';
import { createOperationSlot, paneGeneration, projectGeneration } from './threadOperationController';

describe('createOperationSlot: synchronous same-task double activation', () => {
  it('X10-style: a second begin() for the same generation, before the first releases, is refused', () => {
    const slot = createOperationSlot('reply');
    const first = slot.begin('p1:e1');
    expect(first).not.toBeNull();
    const second = slot.begin('p1:e1');
    expect(second).toBeNull();
  });

  it('P3/P4/P5-style: releasing frees the slot for the next activation of the same generation', () => {
    const slot = createOperationSlot('bulk');
    const first = slot.begin('p1');
    expect(slot.begin('p1')).toBeNull();
    slot.release(first!);
    expect(slot.begin('p1')).not.toBeNull();
  });
});

describe('createOperationSlot: a different generation is never blocked by a stale holder', () => {
  it('P1/P2-style: X→Y→X — a new pane visit can start even while the old visit\'s op is still held', () => {
    const slot = createOperationSlot('reply');
    const staleToken = slot.begin(paneGeneration(1, 1)); // send on the first visit to A
    expect(staleToken).not.toBeNull();
    // owner navigates to B (epoch 2) and back to A (epoch 3) without the first send ever resolving
    const freshToken = slot.begin(paneGeneration(1, 3));
    expect(freshToken).not.toBeNull();
    expect(freshToken!.opId).not.toBe(staleToken!.opId);
    // a *third* attempt on the same (fresh) visit, while #2 is still pending, is refused
    expect(slot.begin(paneGeneration(1, 3))).toBeNull();
  });

  it('a project switch (new project generation) is never blocked by an old project\'s stale holder', () => {
    const slot = createOperationSlot('bulk');
    slot.begin(projectGeneration(1));
    expect(slot.begin(projectGeneration(2))).not.toBeNull();
  });
});

describe('createOperationSlot: isCurrent drops a response once its scope has moved on', () => {
  it('R5-1: a stale send is not current once a fresh one has taken the slot, even before it releases', () => {
    const slot = createOperationSlot('reply');
    const stale = slot.begin(paneGeneration(1, 1))!;
    slot.begin(paneGeneration(1, 3)); // fresh send supersedes it
    expect(slot.isCurrent(stale, paneGeneration(1, 1))).toBe(false);
  });

  it('is current only while its own token still holds its own generation', () => {
    const slot = createOperationSlot('pin');
    const token = slot.begin(paneGeneration(1, 1))!;
    expect(slot.isCurrent(token, paneGeneration(1, 1))).toBe(true);
    expect(slot.isCurrent(token, paneGeneration(1, 2))).toBe(false); // route moved on before it settled
  });
});

describe('createOperationSlot: release only own token', () => {
  it("R5-1/P2: a stale op's finally cannot clear a newer op's hold", () => {
    const slot = createOperationSlot('reply');
    const stale = slot.begin(paneGeneration(1, 1))!;
    const fresh = slot.begin(paneGeneration(1, 3))!;
    slot.release(stale); // the old send's finally runs after the new one has already begun
    expect(slot.isHeld(paneGeneration(1, 3))).toBe(true); // the fresh op's hold survives
    expect(slot.isCurrent(fresh, paneGeneration(1, 3))).toBe(true);
  });

  it('releasing an already-released token is a harmless no-op', () => {
    const slot = createOperationSlot('close');
    const token = slot.begin('p1')!;
    slot.release(token);
    expect(() => slot.release(token)).not.toThrow();
    expect(slot.isHeld('p1')).toBe(false);
  });
});

describe('isHeld', () => {
  it('reads busy only for the exact generation currently holding the slot', () => {
    const slot = createOperationSlot('bulk');
    expect(slot.isHeld('p1')).toBe(false);
    slot.begin('p1');
    expect(slot.isHeld('p1')).toBe(true);
    expect(slot.isHeld('p2')).toBe(false);
  });
});

describe('projectGeneration / paneGeneration', () => {
  it('never collide across a digit boundary (e.g. gen 1/pane 23 vs gen 12/pane 3)', () => {
    expect(paneGeneration(1, 23)).not.toBe(paneGeneration(12, 3));
  });

  it('projectGeneration and paneGeneration never collide with each other', () => {
    expect(projectGeneration(1)).not.toBe(paneGeneration(1, 0));
  });

  it('is a pure function of its inputs', () => {
    expect(paneGeneration(2, 5)).toBe(paneGeneration(2, 5));
    expect(projectGeneration(3)).toBe(projectGeneration(3));
  });
});
