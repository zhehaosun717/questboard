import { useCallback, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { api } from '../../api/client';
import type { ThreadDetail } from '../../api/types';
import {
  MAX_THREAD_BULK_IDS,
  bulkThreads,
  describeBulkReport,
  describeThreadError,
} from '../../api/threadBatch';
import type { ThreadBulkAction, ThreadDetailWithTrash } from '../../api/threadBatch';
import type { createGenerationTracker, ListScope } from './threadAsyncGuards';
import { isSameListScope } from './threadAsyncGuards';
import { createOperationSlot, paneGeneration, projectGeneration } from './threadOperationController';
import { useBulkFocusRestore } from './useBulkFocusRestore';
import { t as tStatic, type I18nKey } from '../../lib/i18n';

export const MISSING_AUTHOR_REFUSAL_KEY: I18nKey = 'threadsWrite.missingAuthor';

type GenerationTracker = ReturnType<typeof createGenerationTracker>;

export interface ThreadWriteOperationsArgs {
  activeThread: ThreadDetailWithTrash | null;
  activeThreadId: string | null;
  activeIdRef: MutableRefObject<string | null>;
  aliveRef: MutableRefObject<boolean>;
  genRef: MutableRefObject<GenerationTracker>;
  // D1: shared with ThreadsView's detail-read ordering — bumped on every route change (including a
  // revisit, X→Y→X), so a write's pane-scoped op and a read's detail fetch always agree on what counts
  // as "the same visit" (threadOperationController.ts's write matrix names this "pane epoch").
  paneEpochRef: MutableRefObject<GenerationTracker>;
  author: string;
  replyBody: string;
  // R8: a plain `(body: string) => void` setter can't express "clear only if unchanged" — the functional
  // updater form is what lets a late send settle against the *current* draft instead of the one captured
  // in its own closure.
  setReplyBody: Dispatch<SetStateAction<string>>;
  setRefusalMessage: (msg: string | null) => void;
  onSelectThread: (id: string | null) => void;
  loadThreads: () => Promise<void>;
  loadActiveThread: (id: string) => Promise<void>;
  setSelected: Dispatch<SetStateAction<string[]>>;
  setBulkStatus: (status: string | null) => void;
  searchInputRef: MutableRefObject<HTMLInputElement | null>;
  // D5: read live at settle time, the same way loadThreads already reads filters from refs — a bulk/
  // restore result is scoped to the list scope it started under, not just the project generation, so a
  // late report/error from a since-abandoned bin/filter/search scope never appears under the new one.
  listScopeRef: MutableRefObject<ListScope>;
}

export interface ThreadWriteOperations {
  replySubmitting: boolean;
  // R5-3: 置顶/关闭 share one flag — both write the same pane and neither may race the other.
  writeBusy: boolean;
  bulkBusy: boolean;
  handleSendReply: () => Promise<void>;
  handleTogglePin: () => Promise<void>;
  handleToggleClose: () => Promise<void>;
  runBulk: (action: ThreadBulkAction, ids: string[]) => Promise<void>;
  handleRestoreActive: () => Promise<void>;
  // Called by ThreadsView's route-change effect, before it reloads the routed thread: bumps the pane
  // epoch (so any op already in flight for the pane the owner is leaving becomes a different, orphaned
  // scope — see threadOperationController.ts) and resets this hook's own busy flags for the new pane.
  resetForRouteChange: () => void;
  // Called by ThreadsView's project-switch effect. The project generation itself is bumped there (`genRef`
  // is owned by ThreadsView, shared with reads) — this only resets the write-side busy flags, since every
  // in-flight op's captured generation string already differs the instant that bump happens.
  resetForProjectSwitch: () => void;
  // R5-2: captured synchronously by NewThreadModal before its request goes out — never `activeThreadId`,
  // which has nothing to do with a thread that doesn't exist yet (create's scope is project-only).
  beginCreateEpoch: () => string;
  handleThreadCreated: (thread: ThreadDetail, epoch: string) => void;
}

// The write half of ThreadsView's scope guards (threadAsyncGuards.ts / runIfCurrent already cover reads).
// See threadOperationController.ts for the full read/write matrix and why "pane epoch" exists. Every
// handler here follows the same three-step shape:
//   1. `begin` synchronously, before any `await` — null means a same-task double-activation, bail out.
//   2. after the request settles, `isCurrent` gates every state write (draft, busy, reload, navigation).
//   3. `release` unconditionally in `finally` — a no-op once superseded, so a stale op can never clear a
//      newer op's slot (R5-1's "release only own op").
export function useThreadWriteOperations({
  activeThread,
  activeThreadId,
  activeIdRef,
  aliveRef,
  genRef,
  paneEpochRef,
  author,
  replyBody,
  setReplyBody,
  setRefusalMessage,
  onSelectThread,
  loadThreads,
  loadActiveThread,
  setSelected,
  setBulkStatus,
  searchInputRef,
  listScopeRef,
}: ThreadWriteOperationsArgs): ThreadWriteOperations {
  const [replySubmitting, setReplySubmitting] = useState(false);
  const [writeBusy, setWriteBusy] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  const replySlot = useRef(createOperationSlot('reply')).current;
  // Pin and close share a slot: both write the same pane, and the brief scopes them as one "pane write"
  // concern — a double click on either sends exactly one POST, and starting one while the other is still
  // in flight is refused the same way a same-task double click on one button is.
  const paneWriteSlot = useRef(createOperationSlot('pane-write')).current;
  // Bulk (toolbar) and pane-restore already shared one render-level busy flag before this revision; they
  // now share the synchronous slot too — both are "write many ids, reload the list" at project scope.
  const bulkSlot = useRef(createOperationSlot('bulk')).current;

  const bulkFocusOpenerRef = useBulkFocusRestore(bulkBusy, searchInputRef);
  // G4/X11b: 置顶/关闭 disable while `writeBusy`, so they need their own opener-capture/restore, exactly
  // like the bulk bar's — a second, independent instance of the same busy/disable-race hook.
  const paneWriteFocusOpenerRef = useBulkFocusRestore(writeBusy, searchInputRef);
  // D6/R15: 发送回复 disables while `replySubmitting` too — the same busy/disable race, its own instance.
  const replyFocusOpenerRef = useBulkFocusRestore(replySubmitting, searchInputRef);

  const resetForRouteChange = useCallback(() => {
    paneEpochRef.current.bump();
    setReplySubmitting(false);
    setWriteBusy(false);
  }, [paneEpochRef]);

  const resetForProjectSwitch = useCallback(() => {
    // The project generation itself already moved (ThreadsView bumps `genRef` before calling this), so
    // every token any of the three slots above still hold now names a generation nothing can match again.
    // Only the render-level busy flags need resetting here.
    setBulkBusy(false);
    setReplySubmitting(false);
    setWriteBusy(false);
  }, []);

  const handleSendReply = useCallback(async () => {
    if (!activeThread || activeThread.closed || activeThread.id !== activeIdRef.current) return;
    const targetId = activeThread.id;
    const gen = paneGeneration(genRef.current.current(), paneEpochRef.current.current());
    const token = replySlot.begin(gen);
    // X10: two Ctrl+Enter keydowns dispatched in the same task both reach here before either's state
    // update has flushed — `begin` is the synchronous check that tells them apart, not `replySubmitting`.
    if (!token) return;
    setRefusalMessage(null);

    const trimmedAuthor = author.trim();
    if (!trimmedAuthor) {
      replySlot.release(token);
      setRefusalMessage(tStatic(MISSING_AUTHOR_REFUSAL_KEY));
      return;
    }
    const trimmedBody = replyBody.trim();
    if (!trimmedBody) {
      replySlot.release(token);
      return;
    }
    // R8: the exact draft this send is for — captured now, so a success later clears only this version.
    // Text typed after the request went out (the composer stays editable while `replySubmitting`) is a
    // different string and must survive, not just be silently wiped because *a* send succeeded.
    const sentBody = replyBody;
    // D6/R15: capture whatever had focus right before the button disables, the same way bulk/pane-write
    // already do, so a settle can hand it back instead of stranding focus on <body>.
    replyFocusOpenerRef.current =
      typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    // Re-read at check time, never the `gen` captured above: a scope this op never itself superseded
    // (the owner navigated away and back but never sent again) must still read as stale once it settles —
    // comparing against `gen` again would trivially match itself (R5-1/X4/P1's exact regression).
    const isCurrent = () =>
      replySlot.isCurrent(token, paneGeneration(genRef.current.current(), paneEpochRef.current.current()));

    setReplySubmitting(true);
    try {
      await api.reply(targetId, { body: trimmedBody, author: trimmedAuthor });
      if (!aliveRef.current || !isCurrent()) return;
      void loadThreads();
      // R8/R5-1: only the pane this exact send targeted ever clears the draft, and only the sent version
      // of it — text entered after the send captured above is left exactly as the owner typed it.
      setReplyBody((current) => (current === sentBody ? '' : current));
      void loadActiveThread(targetId);
    } catch (err) {
      if (aliveRef.current && isCurrent()) {
        setRefusalMessage(describeThreadError(err));
      }
    } finally {
      // R5-1 "release only own op": check currency BEFORE releasing — release() itself always clears the
      // slot if it's still held by this token, but by then isCurrent would trivially read false either way.
      const stillCurrent = aliveRef.current && isCurrent();
      replySlot.release(token);
      if (stillCurrent) setReplySubmitting(false);
    }
  }, [
    activeThread,
    activeIdRef,
    aliveRef,
    genRef,
    paneEpochRef,
    author,
    replyBody,
    replySlot,
    replyFocusOpenerRef,
    loadThreads,
    loadActiveThread,
    setReplyBody,
    setRefusalMessage,
  ]);

  const togglePaneWrite = useCallback(
    async (apply: (id: string) => Promise<unknown>) => {
      if (!activeThread || activeThread.id !== activeIdRef.current) return;
      const targetId = activeThread.id;
      const gen = paneGeneration(genRef.current.current(), paneEpochRef.current.current());
      const token = paneWriteSlot.begin(gen);
      if (!token) return; // R5-3: a synchronous double click on 置顶/关闭 sends exactly one POST
      const isCurrent = () =>
        paneWriteSlot.isCurrent(token, paneGeneration(genRef.current.current(), paneEpochRef.current.current()));
      // G4: parking/return-focus for 置顶/关闭 — both newly disable while a write is in flight, so both
      // need the same opener-capture/restore the bulk bar and pane-restore button already had.
      paneWriteFocusOpenerRef.current =
        typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setWriteBusy(true);
      try {
        await apply(targetId);
        if (!aliveRef.current || !isCurrent()) return;
        void loadThreads();
        void loadActiveThread(targetId);
      } catch (err) {
        if (aliveRef.current && isCurrent()) {
          setRefusalMessage(describeThreadError(err));
        }
      } finally {
        const stillCurrent = aliveRef.current && isCurrent();
        paneWriteSlot.release(token);
        if (stillCurrent) setWriteBusy(false);
      }
    },
    [activeThread, activeIdRef, aliveRef, genRef, paneEpochRef, paneWriteSlot, paneWriteFocusOpenerRef, loadThreads, loadActiveThread, setRefusalMessage],
  );

  const handleTogglePin = useCallback(async () => {
    if (!activeThread) return;
    await togglePaneWrite((id) => api.pinThread(id, !activeThread.pinned));
  }, [activeThread, togglePaneWrite]);

  const handleToggleClose = useCallback(async () => {
    if (!activeThread) return;
    await togglePaneWrite((id) => api.closeThread(id, !activeThread.closed));
  }, [activeThread, togglePaneWrite]);

  const captureFocusOpener = () => {
    bulkFocusOpenerRef.current =
      typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  };

  const runBulk = useCallback(
    async (action: ThreadBulkAction, ids: string[]) => {
      if (ids.length === 0) {
        setBulkStatus(tStatic('threadsWrite.pickSome'));
        return;
      }
      if (ids.length > MAX_THREAD_BULK_IDS) {
        setBulkStatus(tStatic('threadsWrite.tooMany', { max: MAX_THREAD_BULK_IDS }));
        return;
      }
      const gen = projectGeneration(genRef.current.current());
      const token = bulkSlot.begin(gen);
      if (!token) return; // R5-3: a synchronous double click on a bulk-bar button sends exactly one POST
      // Re-read at check time — reusing the captured `gen` would trivially match itself even after a
      // project switch that never itself started a new bulk run (same bug as handleSendReply's above).
      const isCurrent = () => bulkSlot.isCurrent(token, projectGeneration(genRef.current.current()));
      // D5: the bin/filter/search scope this run started under — a late report or error is only ever
      // shown under the scope it actually describes, never under whatever bin/filter/search the owner has
      // since switched to (the mutation and list reload below still apply project-wide regardless; only
      // the *status line* is scoped).
      const startScope = listScopeRef.current;
      const isSameScope = () => isSameListScope(startScope, listScopeRef.current);
      const startedWithActiveId = activeThreadId;
      captureFocusOpener();
      setBulkBusy(true);
      setBulkStatus(null);
      try {
        const report = await bulkThreads(action, ids);
        if (!aliveRef.current || !isCurrent()) return;
        if (isSameScope()) setBulkStatus(describeBulkReport(report, ids));
        const okIds = new Set(report.results.filter((r) => r.ok).map((r) => r.id));
        if (okIds.size > 0) {
          setSelected((prev) => prev.filter((id) => !okIds.has(id)));
          if (
            startedWithActiveId &&
            okIds.has(startedWithActiveId) &&
            activeIdRef.current === startedWithActiveId
          ) {
            if (action === 'trash') {
              onSelectThread(null);
            } else {
              void loadActiveThread(startedWithActiveId);
            }
          }
        }
        void loadThreads();
      } catch (err) {
        if (aliveRef.current && isCurrent() && isSameScope()) setBulkStatus(describeThreadError(err));
      } finally {
        const stillCurrent = aliveRef.current && isCurrent();
        bulkSlot.release(token);
        if (stillCurrent) setBulkBusy(false);
      }
    },
    [activeThreadId, activeIdRef, aliveRef, genRef, bulkSlot, listScopeRef, loadThreads, loadActiveThread, onSelectThread, setSelected, setBulkStatus],
  );

  const handleRestoreActive = useCallback(async () => {
    if (!activeThread || activeThread.id !== activeIdRef.current) return;
    const targetId = activeThread.id;
    const gen = projectGeneration(genRef.current.current());
    const token = bulkSlot.begin(gen);
    if (!token) return; // R5-3/P4: shares the bulk slot — one POST per activation, same as the toolbar
    const isCurrent = () => bulkSlot.isCurrent(token, projectGeneration(genRef.current.current()));
    // D5: same list-scope gate as runBulk — a pane restore's status line belongs to the bin/filter/search
    // scope the owner was looking at when they clicked 还原, not whatever they've since switched to.
    const startScope = listScopeRef.current;
    const isSameScope = () => isSameListScope(startScope, listScopeRef.current);
    // Captured once, up front: whether this exact pane visit is still the one to reload once the restore
    // lands (R7: the report and list reload apply project-wide regardless; only the detail reload is
    // gated to the pane not having moved on since).
    const startPaneGen = paneGeneration(genRef.current.current(), paneEpochRef.current.current());
    captureFocusOpener();
    setBulkBusy(true);
    setBulkStatus(null);
    try {
      const report = await bulkThreads('restore', [targetId]);
      if (!aliveRef.current || !isCurrent()) return;
      if (isSameScope()) setBulkStatus(describeBulkReport(report, [targetId]));
      void loadThreads();
      if (paneGeneration(genRef.current.current(), paneEpochRef.current.current()) === startPaneGen) {
        void loadActiveThread(targetId);
      }
    } catch (err) {
      if (aliveRef.current && isCurrent() && isSameScope()) setBulkStatus(describeThreadError(err));
    } finally {
      const stillCurrent = aliveRef.current && isCurrent();
      bulkSlot.release(token);
      if (stillCurrent) setBulkBusy(false);
    }
  }, [activeThread, activeIdRef, aliveRef, genRef, paneEpochRef, bulkSlot, listScopeRef, loadThreads, loadActiveThread, setBulkStatus]);

  const beginCreateEpoch = useCallback(() => projectGeneration(genRef.current.current()), [genRef]);

  const handleThreadCreated = useCallback(
    (thread: ThreadDetail, epoch: string) => {
      if (!aliveRef.current || epoch !== projectGeneration(genRef.current.current())) return;
      void loadThreads();
      onSelectThread(thread.id);
    },
    [aliveRef, genRef, loadThreads, onSelectThread],
  );

  return {
    replySubmitting,
    writeBusy,
    bulkBusy,
    handleSendReply,
    handleTogglePin,
    handleToggleClose,
    runBulk,
    handleRestoreActive,
    resetForRouteChange,
    resetForProjectSwitch,
    beginCreateEpoch,
    handleThreadCreated,
  };
}
