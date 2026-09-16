// Board data: the snapshot, the live event stream, and receipt toasts. Components read from here and call
// api.* for writes; after a write, call refresh().
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, subscribe } from '../api/client';
import type { Snapshot } from '../api/types';
import { describeEvent } from '../lib/labels';
import { observeBoard, observeBoardEvent } from '../lib/notifications';

export interface Toast {
  id: number;
  at: string;
  text: string;
}

export interface BoardState {
  snap: Snapshot | null;
  connected: boolean;
  error: string | null;
  toasts: Toast[];
  refresh: () => void;
  pushToast: (text: string) => void;
  // While the owner drags a card, every refresh (poll, live event, write) is held back so drop targets are
  // not re-rendered mid-drag; one refresh runs when the drag ends.
  setDragging: (dragging: boolean) => void;
}

const POLL_MS = 10000;
const TOAST_MS = 6500;
const REFRESH_DEBOUNCE_MS = 250;

export function useBoard(): BoardState {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const alive = useRef(true);
  const dragging = useRef(false);
  const pending = useRef(false);
  const requestSeq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const nextToast = useRef(1);

  const load = useCallback(async () => {
    if (dragging.current) { pending.current = true; return; }
    const seq = ++requestSeq.current;
    try {
      const next = await api.snapshot();
      // Drop a response that arrives after unmount, after a newer request, or during a drag that began meanwhile.
      if (!alive.current || seq !== requestSeq.current) return;
      if (dragging.current) { pending.current = true; return; }
      setSnap(next);
      setError(null);
    } catch (reason) {
      if (!alive.current || seq !== requestSeq.current) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  const refresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; void load(); }, REFRESH_DEBOUNCE_MS);
  }, [load]);

  const pushToast = useCallback((text: string) => {
    if (!alive.current) return;
    const toast = { id: nextToast.current++, at: new Date().toISOString(), text };
    setToasts((current) => [...current, toast]);
    const handle = setTimeout(() => {
      toastTimers.current.delete(handle);
      if (alive.current) setToasts((current) => current.filter((t) => t.id !== toast.id));
    }, TOAST_MS);
    toastTimers.current.add(handle);
  }, []);

  useEffect(() => {
    alive.current = true;
    const pendingToasts = toastTimers.current;
    void load();
    const close = subscribe({
      onOpen: () => { setConnected(true); refresh(); },
      onError: () => setConnected(false),
      onEvent: (event) => { observeBoardEvent(event); pushToast(describeEvent(event)); refresh(); },
    });
    const poll = setInterval(() => { void load(); }, POLL_MS);
    return () => {
      alive.current = false;
      close();
      clearInterval(poll);
      if (timer.current) clearTimeout(timer.current);
      for (const handle of pendingToasts) clearTimeout(handle);
      pendingToasts.clear();
    };
  }, [load, refresh, pushToast]);

  // The notification center follows the same snapshot the board renders: the project scope picks the stored
  // preference and the seq baseline, and the quest list is what its notifications are titled from.
  useEffect(() => {
    observeBoard(snap);
  }, [snap]);

  const setDragging = useCallback((value: boolean) => {
    dragging.current = value;
    if (!value && pending.current) {
      pending.current = false;
      refresh();
    }
  }, [refresh]);

  return { snap, connected, error, toasts, refresh, pushToast, setDragging };
}
