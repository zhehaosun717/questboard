import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanesReport } from '../api/types';
import { startLanesPoll } from './historyLanesPoll';

const report: LanesReport = { packages: [], laneLimits: {}, verification: null, board: { openQuestions: 0 } };

function abortableHang(signal: AbortSignal): Promise<LanesReport> {
  // Behaves like a real fetch: rejects with AbortError once its own signal fires, otherwise never settles.
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
}

describe('startLanesPoll (revision 5 D2: bounded AbortController, one in-flight read)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reads immediately, then again on the next interval once the read settled', async () => {
    const calls: number[] = [];
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      calls.push(++n);
      return report;
    });
    const onSuccess = vi.fn();
    const stop = startLanesPoll(
      { onSuccess, onError: vi.fn(), onTimeout: vi.fn() },
      { intervalMs: 5000, timeoutMs: 8000, fetchImpl },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    stop();
  });

  it('never starts a second read while one is still outstanding, across several interval ticks', async () => {
    let release: (() => void) | null = null;
    const fetchImpl = vi.fn(
      () =>
        new Promise<LanesReport>((resolve) => {
          release = () => resolve(report);
        }),
    );
    const stop = startLanesPoll(
      { onSuccess: vi.fn(), onError: vi.fn(), onTimeout: vi.fn() },
      { intervalMs: 5000, timeoutMs: 8000, fetchImpl },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000); // one tick while still in flight
    await vi.advanceTimersByTimeAsync(5000); // a second tick, still in flight
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    release!();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000); // now it can recover
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    stop();
  });

  it('aborts a read past its own timeout, reports onTimeout once and never onError for that same abort', async () => {
    const fetchImpl = vi.fn((options: { signal?: AbortSignal } = {}) => abortableHang(options.signal!));
    const onTimeout = vi.fn();
    const onError = vi.fn();
    const stop = startLanesPoll({ onSuccess: vi.fn(), onError, onTimeout }, { intervalMs: 5000, timeoutMs: 8000, fetchImpl });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(8000); // the timeout fires and aborts the hung read
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    stop();
  });

  it('recovers on the next tick once the aborted read actually settles (release flight, then retry)', async () => {
    const fetchImpl = vi.fn((options: { signal?: AbortSignal } = {}) => abortableHang(options.signal!));
    const stop = startLanesPoll(
      { onSuccess: vi.fn(), onError: vi.fn(), onTimeout: vi.fn() },
      { intervalMs: 5000, timeoutMs: 8000, fetchImpl },
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(8000); // timeout fires, aborts, the mock rejects — flight releases
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000); // the remainder of the 5 s interval since the timeout fired
    expect(fetchImpl).toHaveBeenCalledTimes(2); // a fresh read started on its own, no manual nudge needed
    stop();
  });

  it('a mock that ignores the abort signal forever causes no pileup — no further reads ever start', async () => {
    // Deliberately non-conforming: never settles even after its own signal aborts. The real contract is
    // "no unbounded pileup", not "the hang eventually clears" — the flight simply never frees.
    const fetchImpl = vi.fn(() => new Promise<LanesReport>(() => {}));
    const onTimeout = vi.fn();
    const stop = startLanesPoll({ onSuccess: vi.fn(), onError: vi.fn(), onTimeout }, { intervalMs: 5000, timeoutMs: 8000, fetchImpl });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(8000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // still just the one read, honestly stuck, never duplicated
    stop();
  });

  it('stop() (unmount) aborts an in-flight read and ends the poll for good', async () => {
    let sawAbort = false;
    const fetchImpl = vi.fn((options: { signal?: AbortSignal } = {}) => {
      options.signal!.addEventListener('abort', () => {
        sawAbort = true;
      });
      return new Promise<LanesReport>(() => {});
    });
    const stop = startLanesPoll({ onSuccess: vi.fn(), onError: vi.fn(), onTimeout: vi.fn() }, { intervalMs: 5000, timeoutMs: 8000, fetchImpl });
    await vi.advanceTimersByTimeAsync(0);
    stop();
    expect(sawAbort).toBe(true);
    await vi.advanceTimersByTimeAsync(30000);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no further ticks after stop
  });

  it('reports a plain read failure through onError, unrelated to any abort', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('接口返回 500');
    });
    const onError = vi.fn();
    const stop = startLanesPoll({ onSuccess: vi.fn(), onError, onTimeout: vi.fn() }, { intervalMs: 5000, timeoutMs: 8000, fetchImpl });
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith('接口返回 500');
    stop();
  });
});
