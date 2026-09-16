import { describe, expect, it } from 'vitest';
import {
  canReceiveFocus,
  createGenerationTracker,
  isFocusStillParked,
  isSameListScope,
  runIfCurrent,
  shouldCloseConfirmAfterPrune,
} from './threadAsyncGuards';

// A promise this test resolves/rejects on its own schedule, so resolution order can be controlled
// independently of call order — the same shape a real fetch race has.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('runIfCurrent', () => {
  it('applies the result when the guard is still true once the task settles', async () => {
    const d = deferred<string>();
    const applied: string[] = [];
    const run = runIfCurrent(() => d.promise, () => true, (v) => applied.push(v));
    d.resolve('ok');
    await run;
    expect(applied).toEqual(['ok']);
  });

  it('B1: a project switch mid-flight drops the response for the old project', async () => {
    const gen = createGenerationTracker();
    const applied: string[] = [];
    const tokenAtStart = gen.bump(); // project A
    const d = deferred<string>();
    const run = runIfCurrent(
      () => d.promise,
      () => tokenAtStart === gen.current(),
      (v) => applied.push(v),
    );
    gen.bump(); // owner switches to project B before the response arrives
    d.resolve('threads for A');
    await run;
    expect(applied).toEqual([]);
  });

  it('applies a fresh response and drops a stale one, whichever order they resolve in', async () => {
    const gen = createGenerationTracker();
    const applied: string[] = [];

    const tokenA = gen.bump();
    const reqA = deferred<string>();
    const runA = runIfCurrent(() => reqA.promise, () => tokenA === gen.current(), (v) => applied.push(v));

    const tokenB = gen.bump(); // switched again before A ever resolved
    const reqB = deferred<string>();
    const runB = runIfCurrent(() => reqB.promise, () => tokenB === gen.current(), (v) => applied.push(v));

    // A (the older request) resolves last — the classic out-of-order race.
    reqB.resolve('B');
    await runB;
    reqA.resolve('A');
    await runA;

    expect(applied).toEqual(['B']);
  });

  it('B2: an active-thread echo for an id the owner already navigated away from is dropped', async () => {
    const activeIdRef = { current: 'thread-A' };
    const applied: string[] = [];
    const targetId = activeIdRef.current;
    const d = deferred<{ id: string }>();
    const run = runIfCurrent(
      () => d.promise,
      () => activeIdRef.current === targetId,
      (v) => applied.push(v.id),
    );
    activeIdRef.current = 'thread-C'; // owner opened C before A's detail came back
    d.resolve({ id: 'thread-A' });
    await run;
    expect(applied).toEqual([]);
  });

  it('rethrows a rejection while still current, so the caller can show the error', async () => {
    const d = deferred<string>();
    const applied: string[] = [];
    const run = runIfCurrent(() => d.promise, () => true, (v) => applied.push(v));
    d.reject(new Error('boom'));
    await expect(run).rejects.toThrow('boom');
    expect(applied).toEqual([]);
  });

  it('swallows a rejection once stale — a dead run cannot surface a stray error banner', async () => {
    const gen = createGenerationTracker();
    const token = gen.bump();
    const d = deferred<string>();
    const run = runIfCurrent(() => d.promise, () => token === gen.current(), () => {});
    gen.bump();
    d.reject(new Error('boom'));
    await expect(run).resolves.toBeUndefined();
  });
});

describe('createGenerationTracker', () => {
  it('starts at 0 and increments on every bump, returned from bump itself', () => {
    const gen = createGenerationTracker();
    expect(gen.current()).toBe(0);
    expect(gen.bump()).toBe(1);
    expect(gen.bump()).toBe(2);
    expect(gen.current()).toBe(2);
  });
});

describe('canReceiveFocus', () => {
  it('rejects null, disconnected, and disabled targets', () => {
    expect(canReceiveFocus(null)).toBe(false);
    expect(canReceiveFocus(undefined)).toBe(false);
    expect(canReceiveFocus({ isConnected: false })).toBe(false);
    expect(canReceiveFocus({ isConnected: true, disabled: true })).toBe(false);
  });

  it('accepts a connected, enabled target', () => {
    expect(canReceiveFocus({ isConnected: true })).toBe(true);
    expect(canReceiveFocus({ isConnected: true, disabled: false })).toBe(true);
  });
});

describe('shouldCloseConfirmAfterPrune', () => {
  it('closes the confirm dialog only when the prune emptied the selection and it was open', () => {
    expect(shouldCloseConfirmAfterPrune(0, true)).toBe(true);
    expect(shouldCloseConfirmAfterPrune(0, false)).toBe(false);
    expect(shouldCloseConfirmAfterPrune(1, true)).toBe(false);
  });
});

describe('isSameListScope', () => {
  it('is false against a null committed scope (nothing has landed yet)', () => {
    expect(isSameListScope(null, { trashView: false, status: 'open', q: '' })).toBe(false);
  });

  it('is true only when the bin toggle, status filter and search text all match', () => {
    const committed = { trashView: false, status: 'open', q: '' };
    expect(isSameListScope(committed, { trashView: false, status: 'open', q: '' })).toBe(true);
    expect(isSameListScope(committed, { trashView: true, status: 'open', q: '' })).toBe(false);
    expect(isSameListScope(committed, { trashView: false, status: 'closed', q: '' })).toBe(false);
    expect(isSameListScope(committed, { trashView: false, status: 'open', q: '号' })).toBe(false);
  });

  it('D7: is false across a projectId mismatch even when the filters are unchanged — a same-commit '
    + 'project switch must not paint the old project\'s rows', () => {
    const committed = { trashView: false, status: 'open', q: '', projectId: 'proj-A' };
    expect(isSameListScope(committed, { trashView: false, status: 'open', q: '', projectId: 'proj-A' })).toBe(true);
    expect(isSameListScope(committed, { trashView: false, status: 'open', q: '', projectId: 'proj-B' })).toBe(false);
    expect(isSameListScope(committed, { trashView: false, status: 'open', q: '' })).toBe(false);
  });
});

describe('isFocusStillParked (D6/R14b)', () => {
  it('is true when nothing was parked (null parkedValue) — nothing to compare, go ahead', () => {
    expect(isFocusStillParked(null, 'anything')).toBe(true);
    expect(isFocusStillParked(null, null)).toBe(true);
  });

  it('is true when the parked value is unchanged — a legitimate settle may restore focus', () => {
    expect(isFocusStillParked('', '')).toBe(true);
    expect(isFocusStillParked('search text', 'search text')).toBe(true);
  });

  it('is false once the owner has typed into the parking spot — that is deliberate focus intent', () => {
    expect(isFocusStillParked('', 'A')).toBe(false);
    expect(isFocusStillParked('abc', 'abcd')).toBe(false);
  });
});
