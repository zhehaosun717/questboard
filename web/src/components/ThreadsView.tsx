import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { ThreadStatusFilter } from '../api/types';
import {
  MAX_THREAD_BULK_IDS,
  describeThreadError,
  isAtBulkCap,
  listThreads,
  pruneToVisible,
  selectAllVisible,
  toggleSelectedIds,
} from '../api/threadBatch';
import type { ThreadBulkAction, ThreadDetailWithTrash, ThreadWithTrash } from '../api/threadBatch';
import { formatClock } from '../lib/board';
import '../styles/thread-batch.css';
import { NewThreadModal } from './threads/NewThreadModal';
import { ThreadBulkBar } from './threads/ThreadBulkBar';
import { ThreadDetailPane } from './threads/ThreadDetailPane';
import { TrashConfirmDialog } from './threads/TrashConfirmDialog';
import type { ListScope } from './threads/threadAsyncGuards';
import {
  createGenerationTracker,
  isSameListScope,
  runIfCurrent,
  shouldCloseConfirmAfterPrune,
} from './threads/threadAsyncGuards';
import { MISSING_AUTHOR_REFUSAL, useThreadWriteOperations } from './threads/useThreadWriteOperations';

// A missing name never blocks a loading/refusal reason from showing: only clear the composer's own
// "type your name" nudge, so typing a name mid-switch cannot wipe the loading text out from under it.
const PROJECT_SWITCH_LOADING = '主题切换中，请稍候';

interface ThreadsViewProps {
  activeThreadId: string | null;
  onSelectThread: (threadId: string | null) => void;
  isNewModalOpen: boolean;
  onOpenNewModal: () => void;
  onCloseNewModal: () => void;
  // The stable project digest from the snapshot (Snapshot.project.id). A same-origin project switch
  // (dev fixture or a reused component) keeps this instance mounted, so selection must not be
  // assumed to die with a page load: when the id changes, the old selection points at another
  // project's threads and is cleared. Optional: an older server sends no id, and readers must not
  // fall back to the project name — same-name projects share one browser storage.
  projectId?: string;
}

function getStoredAuthor(): string {
  try {
    return localStorage.getItem('questboard.author') || '';
  } catch {
    return '';
  }
}

function setStoredAuthor(name: string): void {
  try {
    localStorage.setItem('questboard.author', name);
  } catch {}
}

function getStoredSeen(id: string): string | null {
  try {
    return localStorage.getItem(`questboard.seen.${id}`);
  } catch {
    return null;
  }
}

function setStoredSeen(id: string, stamp: string): void {
  try {
    localStorage.setItem(`questboard.seen.${id}`, stamp);
  } catch {}
}

export function ThreadsView({
  activeThreadId,
  onSelectThread,
  isNewModalOpen,
  onOpenNewModal,
  onCloseNewModal,
  projectId,
}: ThreadsViewProps) {
  const [threads, setThreads] = useState<ThreadWithTrash[]>([]);
  // G1: the scope (bin toggle + status filter + search text) that produced the `threads` currently in
  // state — not necessarily what the owner is looking at right now. `null` until the first list lands.
  const [threadsScope, setThreadsScope] = useState<ListScope | null>(null);
  const [statusFilter, setStatusFilter] = useState<ThreadStatusFilter>('open');
  const [searchQuery, setSearchQuery] = useState('');
  const [listError, setListError] = useState<string | null>(null);

  // Bulk state lives here and nowhere else: a list of ids the owner can see right now.
  const [trashView, setTrashView] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkStatus, setBulkStatus] = useState<string | null>(null);
  const [confirmTrash, setConfirmTrash] = useState(false);

  const [activeThread, setActiveThread] = useState<ThreadDetailWithTrash | null>(null);
  const [activeError, setActiveError] = useState<string | null>(null);

  const [author, setAuthor] = useState(getStoredAuthor);
  const [replyBody, setReplyBody] = useState('');
  const [refusalMessage, setRefusalMessage] = useState<string | null>(null);

  const [activeThreadProjectId, setActiveThreadProjectId] = useState<string | undefined>(undefined);

  // B1: bumped whenever `projectId` changes. Every async response captures the generation it started
  // under and checks it again once it settles — a response for a project the owner already switched
  // away from is dropped instead of overwriting the new project's UI. This does not abort the
  // underlying fetch; it only decides whether the response gets to write any state.
  const genRef = useRef(createGenerationTracker());
  // D1: bumped on every route change, including a revisit to an id already visited (X→Y→X) — two visits
  // to the same thread are not the same "pane generation" even though the id string is unchanged. Shared
  // with useThreadWriteOperations (threadOperationController.ts's write matrix) so a write's pane-scoped
  // op and a detail read always agree on what counts as "this exact visit".
  const paneEpochRef = useRef(createGenerationTracker());
  // B2: the route's current active thread id, kept in a ref so an in-flight response can tell whether
  // it still targets the thread the owner is actually looking at.
  const activeIdRef = useRef(activeThreadId);
  // Unmount guard: every async apply and every navigating callback checks this first, so a response
  // that lands after the view is gone can neither write state nor call onSelectThread.
  const aliveRef = useRef(true);
  // Every in-flight list request gets its own id; only the most recently issued one is allowed to
  // write `threads` once it settles, so a superseded query (an older filter, an older poll tick) can
  // never overwrite a newer one even within the same project generation.
  const listCallRef = useRef(0);
  // D1: same idea as `listCallRef`, for detail reads — a monotonic id across every `loadActiveThread`
  // call regardless of target id. Only the most recently *issued* call may write state once it settles,
  // so an older post-pin reload can never overwrite a newer post-close reload even when it resolves
  // later (R3), and a first visit's late detail read can never replace an X→Y→X revisit's (R2).
  const detailCallRef = useRef(0);
  // Filters read live at request time (not from the closure loadThreads was created with), so a reload
  // kicked off from a stale closure — after an await inside runBulk, for instance — still asks for
  // whatever the owner is looking at right now instead of the filter that was current when that
  // closure was made.
  const statusFilterRef = useRef(statusFilter);
  const searchQueryRef = useRef(searchQuery);
  const trashViewRef = useRef(trashView);
  // D1/D7: read live the same way, so a request captures the project it was actually issued for even
  // though the callback that issues it (`loadActiveThread`, `loadThreads`) is a stable, empty-deps
  // useCallback that never closes over a fresh `projectId`.
  const projectIdRef = useRef(projectId);
  statusFilterRef.current = statusFilter;
  searchQueryRef.current = searchQuery;
  trashViewRef.current = trashView;
  projectIdRef.current = projectId;
  // D5: the live list scope useThreadWriteOperations reads at settle time to decide whether a bulk/
  // restore status line still describes what the owner is looking at.
  const listScopeRef = useRef<ListScope>({ trashView, status: statusFilter, q: searchQuery, projectId });
  listScopeRef.current = { trashView, status: statusFilter, q: searchQuery, projectId };
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // D6: the "+ 新主题" button (or whatever else had focus when it was clicked/keyed) — handed to the
  // modal so it can return focus there on close, unless the owner has since moved it themselves.
  const newThreadOpenerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    activeIdRef.current = activeThreadId;
  }, [activeThreadId]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const handleAuthorChange = (val: string) => {
    setAuthor(val);
    setStoredAuthor(val);
    // Only the "type your name" nudge is this field's own to clear — a loading/refusal reason set by an
    // in-flight switch or write is not about the author field and must survive typing here.
    if (val.trim()) {
      setRefusalMessage((prev) => (prev === MISSING_AUTHOR_REFUSAL ? null : prev));
    }
  };

  // Stable identity: every call reads project generation, list-call ordering and filters from refs, so
  // a stale closure calling this after an await (e.g. runBulk's post-write reload) still behaves exactly
  // like a fresh call. `runIfCurrent`'s `isCurrent` is re-checked once the response lands.
  const loadThreads = useCallback(async () => {
    const gen = genRef.current.current();
    const callId = (listCallRef.current += 1);
    // Minor/P12: a request starting is itself the freshest signal that a previous scope's error no
    // longer describes the current attempt — clear it now, synchronously, not only on success. Without
    // this, a failed load left `listError` on screen through every later poll tick that never actually
    // re-ran the request that produced it, and a scope change (bin/filter/search — a fresh loadThreads
    // call either way) kept showing the old scope's error under the new one while it loaded.
    setListError(null);
    // G1/D7: the scope this exact request was issued for — captured now, from the same live refs the
    // request itself reads, so it describes what the *response* will actually be for even if the owner
    // changes the filter again before it lands. `projectId` is part of that identity: on the very commit
    // a project switch lands, this ref already reflects the new value (assigned every render, above) even
    // though `genRef` hasn't bumped yet (that happens in a passive effect, after this render).
    const scope: ListScope = {
      trashView: trashViewRef.current,
      status: statusFilterRef.current,
      q: searchQueryRef.current,
      projectId: projectIdRef.current,
    };
    await runIfCurrent(
      () => listThreads({ status: statusFilterRef.current, q: scope.q, trash: scope.trashView }),
      () => aliveRef.current && gen === genRef.current.current() && callId === listCallRef.current,
      (res) => {
        setListError(null);
        setThreads(res.threads);
        setThreadsScope(scope);
      },
    ).catch((err) => {
      if (aliveRef.current && callId === listCallRef.current) {
        setListError(describeThreadError(err));
      }
    });
  }, []);

  const loadActiveThread = useCallback(async (id: string) => {
    // D1: this call's ownership — project generation, pane epoch (route-change granularity) and a
    // strictly monotonic call id (same-epoch granularity, e.g. a post-pin reload vs a post-close reload)
    // — captured together, re-checked together after the await, and again before the `finally`-equivalent
    // (there is none here; both the success and error branches redo the same check).
    const gen = genRef.current.current();
    const epoch = paneEpochRef.current.current();
    const callId = (detailCallRef.current += 1);
    const scopeProjectId = projectIdRef.current;
    const isCurrent = () =>
      aliveRef.current &&
      gen === genRef.current.current() &&
      epoch === paneEpochRef.current.current() &&
      activeIdRef.current === id &&
      callId === detailCallRef.current;
    await runIfCurrent(
      () => api.thread(id),
      isCurrent,
      (detail) => {
        setActiveError(null);
        setRefusalMessage(null);
        setActiveThread(detail as ThreadDetailWithTrash);
        setActiveThreadProjectId(scopeProjectId);
        setStoredSeen(
          detail.id,
          detail.lastMessageAt || detail.updatedAt || new Date().toISOString(),
        );
      },
    ).catch((err) => {
      if (isCurrent()) {
        setActiveError(describeThreadError(err));
      }
    });
  }, []);

  const {
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
  } = useThreadWriteOperations({
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
  });

  // A filter, search or recycle-bin switch is a new scope for the *selection* only: the old ticks
  // pointed at rows the owner may no longer see. It must not touch the active pane — the owner is still
  // looking at whatever thread the route points to, filters or not.
  useEffect(() => {
    setSelected([]);
    setBulkStatus(null);
    setConfirmTrash(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a filter/search/recycle switch clears the on-screen selection only
  }, [statusFilter, searchQuery, trashView]);

  // A same-origin project switch (dev fixture or a reused component) is a full scope change: the rows,
  // the error line, the selection, the busy flag, the reply draft and the pane all belonged to the
  // previous project's store. B1: bumping the generation here, before the load effect below runs
  // (declaration order — React fires effects top-to-bottom within one commit), means the very first
  // load for the new project, and any load this same switch retriggers, captures the new generation
  // rather than the one just retired.
  //
  // The route's thread id does not necessarily change with the project (the id is project-scoped, but
  // the URL is not) — reload it explicitly here rather than depending on `activeThreadId`, since that
  // effect will not refire when the id string itself is unchanged. Skip that reload on the very first
  // run (mount, before any project is known): the detail-load effect below already covers a deep link
  // or reload on first mount, and reloading twice for the same id is only wasted work, never a fix.
  useEffect(() => {
    const gen = genRef.current.bump();
    setSelected([]);
    setBulkStatus(null);
    setConfirmTrash(false);
    setThreads([]);
    // G1: the retired project's rows are gone; so is any claim about what scope produced them.
    setThreadsScope(null);
    setListError(null);
    setActiveThread(null);
    setActiveThreadProjectId(undefined);
    setActiveError(null);
    setReplyBody('');
    // G2/R5-1..3: every in-flight write's captured generation already differs from `gen` the instant it
    // was bumped above — this only resets the render-level busy flags for the retired project.
    resetForProjectSwitch();
    if (gen > 1 && activeIdRef.current) {
      // G3: the routed thread reloads for the new project — say so, the same way a same-project route
      // change already does, instead of leaving the pane looking like nothing is selected.
      setRefusalMessage(PROJECT_SWITCH_LOADING);
      void loadActiveThread(activeIdRef.current);
    } else {
      setRefusalMessage(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a real project switch resets everything and reloads the routed thread
  }, [projectId]);

  useEffect(() => {
    void loadThreads();
    const interval = setInterval(() => void loadThreads(), 10000);
    return () => clearInterval(interval);
    // Re-triggers on every filter/search/recycle/project change so the reload starts immediately
    // instead of waiting out the rest of the previous 10s tick; `loadThreads` itself is stable.
  }, [statusFilter, searchQuery, trashView, projectId, loadThreads]);

  // B2/R4: the pane is cleared the instant the route's thread id changes — before the new detail has
  // even been requested — so a route change never leaves the old thread's write controls (pin/close/
  // restore/reply) clickable while a different id is loading. `refusalMessage` doubles as the loading
  // explanation here (ThreadDetailPane shows it in place of the empty-state copy): the pane looks
  // inactive because it is mid-switch, not because nothing is selected, and that reason is visible
  // exactly like any other refusal.
  useEffect(() => {
    // R5-1: a route change — even back to a thread already visited (X→Y→X) — is a new pane generation,
    // so any write still in flight for the pane the owner is leaving can never be mistaken for current
    // again, no matter what it later resolves to. This must run before `loadActiveThread` below.
    resetForRouteChange();
    // R8: a route change always opens on an empty composer — the previous thread's draft (typed or
    // still in flight as a pending reply) never carries into the next one.
    setReplyBody('');
    if (activeThreadId) {
      setActiveThread(null);
      setActiveThreadProjectId(undefined);
      setActiveError(null);
      setRefusalMessage(PROJECT_SWITCH_LOADING);
      void loadActiveThread(activeThreadId);
    } else {
      setActiveThread(null);
      setActiveThreadProjectId(undefined);
      setActiveError(null);
      setRefusalMessage(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resetForRouteChange/loadActiveThread are stable; this reacts to the route id only
  }, [activeThreadId]);

  // Polling can drop a row (trashed or closed out of the current filter, changed elsewhere). Keep only
  // ids still on screen, so a bulk run never quietly touches what the owner cannot see.
  useEffect(() => {
    const next = pruneToVisible(
      selected,
      threads.map((thread) => thread.id),
    );
    if (next.length === selected.length) return;
    setSelected(next);
    // F5(b): the whole selection vanishing (e.g. everything ticked was just trashed elsewhere) makes an
    // open trash-confirm dialog stale too; closing it means the next checkbox tick opens a fresh one
    // instead of resurrecting this one unsolicited. The dialog is about to unmount from under the owner
    // without a click of their own, so focus is moved to a stable, always-present control right here —
    // not left to the dialog's own unmount cleanup, whose timing relative to this same commit is not
    // guaranteed the way a click-triggered close's is.
    if (shouldCloseConfirmAfterPrune(next.length, confirmTrash)) {
      setConfirmTrash(false);
      searchInputRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to `threads` only, using latest selection/confirm from this render
  }, [threads]);

  const handleSelect = (id: string) => {
    onSelectThread(id);
    setStoredSeen(id, new Date().toISOString());
  };

  // F2: at the cap an extra checkbox never joins, and the refusal is said out loud instead of the
  // click vanishing. A successful toggle clears the previous run's now-stale result line.
  const handleToggleSelect = (id: string) => {
    if (!selected.includes(id) && isAtBulkCap(selected)) {
      setBulkStatus(`一次最多选择 ${MAX_THREAD_BULK_IDS} 个主题，已达上限，请先取消部分勾选`);
      return;
    }
    setSelected((prev) => toggleSelectedIds(prev, id));
    setBulkStatus(null);
  };

  const handleBulkAction = (action: ThreadBulkAction) => {
    // 删除 always goes through the confirm dialog first: the count, the ids, and what「回收站」means.
    if (action === 'trash') {
      setConfirmTrash(true);
      return;
    }
    void runBulk(action, selected);
  };

  const handleConfirmTrash = () => {
    setConfirmTrash(false);
    void runBulk('trash', selected);
  };

  const selectedSet = new Set(selected);
  const selectedThreads = selected
    .map((id) => threads.find((thread) => thread.id === id))
    .filter((thread): thread is ThreadWithTrash => thread !== undefined);

  // G1/D7: `threads` only renders as the current list when its provenance matches what the owner is
  // looking at right now — `projectId` included, compared straight against the live prop rather than the
  // generation ref (see the comment on `scope` above in `loadThreads`). A same-scope reload (the 10s poll,
  // most often) keeps showing the old rows while it is in flight — only an actual scope change (bin/
  // filter/search/project) hides them, until the matching response lands and moves `threadsScope` forward.
  const isListCurrent = isSameListScope(threadsScope, {
    trashView,
    status: statusFilter,
    q: searchQuery,
    projectId,
  });
  const visibleThreads = isListCurrent ? threads : [];

  // Minor/D7: a route change (or a project switch) lands its new prop in the same commit that still
  // renders the *previous* `activeThread` — the effects that clear it (above) are passive and only run
  // after that paint. Without this guard the old thread's title, pin state and write controls flash on
  // screen for one frame under the new route/project before the effect catches up ("one-paint stale
  // pane"). `activeThreadProjectId` is captured alongside `activeThread` in `loadActiveThread` and
  // compared straight against the live `projectId` prop here — not a generation ref, which (same reason
  // as `isListCurrent` above) hasn't bumped yet on the very commit a project switch lands. Deriving the
  // rendered pane from provenance here, the same way `visibleThreads` already does for the list, closes
  // that window at render time instead of relying on the click guards inside each write handler to catch
  // it after the fact.
  const isPaneCurrent =
    activeThread !== null && activeThread.id === activeThreadId && activeThreadProjectId === projectId;
  const paneThread = isPaneCurrent ? activeThread : null;

  return (
    <div className="threads-view">
      <aside className="threads-sidebar">
        <div className="threads-sidebar-head">
          <div className="head-row">
            <span className="eyebrow">TOPICS</span>
            <button
              className="btn primary"
              type="button"
              onClick={(e) => {
                // D6: captured here, not read back from `document.activeElement` later — a click always
                // focuses its own target first, so this is exactly what should get focus back once the
                // modal closes (unless the owner has since moved it themselves).
                newThreadOpenerRef.current = e.currentTarget;
                onOpenNewModal();
              }}
            >
              + 新主题
            </button>
          </div>
          <div className="filters-grid">
            <input
              ref={searchInputRef}
              type="search"
              placeholder="搜索主题..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {trashView ? (
              // F1: the bin always lists every status (closed question threads were the common case —
              // filtering them hid them behind a falsely empty 回收站). No selector here to mislead.
              <span className="tb-status-locked" role="note">
                回收站显示全部状态
              </span>
            ) : (
              <select
                value={statusFilter}
                onChange={(e) =>
                  setStatusFilter(e.target.value as ThreadStatusFilter)
                }
              >
                <option value="open">开放</option>
                <option value="all">全部</option>
                <option value="closed">已关闭</option>
              </select>
            )}
          </div>
          <div className="th-count-row">
            <span>{trashView ? '回收站（可还原）' : '主题列表'}</span>
            <span className="count">{visibleThreads.length}</span>
          </div>
          <div className="tb-view-row">
            <button
              type="button"
              className={`tb-btn${trashView ? ' on' : ''}`}
              aria-pressed={trashView}
              onClick={() => setTrashView((v) => !v)}
            >
              {trashView ? '返回主题列表' : '打开回收站'}
            </button>
          </div>
        </div>

        <ThreadBulkBar
          visibleCount={visibleThreads.length}
          selectedCount={selected.length}
          trashView={trashView}
          busy={bulkBusy}
          status={bulkStatus}
          onSelectVisible={() => setSelected((prev) => selectAllVisible(visibleThreads, prev))}
          onClear={() => setSelected([])}
          onAction={handleBulkAction}
        />

        {listError && <div className="th-error-line">{listError}</div>}

        <div className="threads-list">
          {!isListCurrent && !listError ? (
            // G1/G3: the rows on screen belonged to a bin/filter/search scope the owner has since left —
            // hiding them (instead of leaving them clickable) is what stops a stale tick from reaching
            // the server as a write for a row the owner can no longer even see, and this loading copy is
            // never confused with a genuinely empty list.
            <div className="empty" role="status" aria-live="polite">
              加载中…
            </div>
          ) : !isListCurrent && listError ? (
            // Minor/P12: nothing is actually pending here — the current scope's only attempt so far
            // failed, and the next one waits for the 10s poll. 加载中 would be a lie, and 还没有主题 would
            // mask the failure as an empty list (the error line above already says what happened).
            <div className="empty" aria-hidden="true" />
          ) : visibleThreads.length === 0 ? (
            <div className="empty">
              {trashView ? '回收站是空的' : '还没有主题'}
            </div>
          ) : (
            visibleThreads.map((t) => {
              const lastSeen = getStoredSeen(t.id);
              const unread = Boolean(
                t.lastMessageAt && (!lastSeen || t.lastMessageAt > lastSeen),
              );
              const isActive = t.id === activeThreadId;

              return (
                <div key={t.id} className="tb-thread-row">
                  <input
                    type="checkbox"
                    className="tb-check"
                    checked={selectedSet.has(t.id)}
                    onChange={() => handleToggleSelect(t.id)}
                    disabled={bulkBusy}
                    aria-label={`选择主题：${t.title}`}
                  />
                  <button
                    type="button"
                    className={`thread-item${isActive ? ' on' : ''}${unread ? ' unread' : ''}`}
                    onClick={() => handleSelect(t.id)}
                  >
                    <div className="th-item-top">
                      {t.pinned && <span className="pin-mark">●</span>}
                      <strong className="th-item-title">{t.title}</strong>
                      {unread && <span className="unread-dot" title="有新消息" />}
                    </div>
                    <div className="th-item-meta">
                      <span>
                        {t.author} · {formatClock(t.updatedAt)}
                      </span>
                      <span className="mono">{t.messageCount} 条</span>
                    </div>
                    {t.tags.length > 0 && (
                      <div className="th-item-tags">
                        {t.tags.map((tag) => (
                          <span key={tag} className="chip">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </aside>

      <section className="threads-content">
        <ThreadDetailPane
          activeThread={paneThread}
          activeError={activeError}
          author={author}
          onAuthorChange={handleAuthorChange}
          replyBody={replyBody}
          onReplyBodyChange={setReplyBody}
          refusalMessage={refusalMessage}
          replySubmitting={replySubmitting}
          onTogglePin={handleTogglePin}
          onToggleClose={handleToggleClose}
          onSendReply={handleSendReply}
          trashed={Boolean(paneThread?.trashed)}
          onRestoreFromTrash={handleRestoreActive}
          restoreBusy={bulkBusy}
          writeBusy={writeBusy}
        />
      </section>

      {isNewModalOpen && (
        <NewThreadModal
          author={author}
          onAuthorChange={handleAuthorChange}
          onClose={onCloseNewModal}
          beginCreateEpoch={beginCreateEpoch}
          onCreated={handleThreadCreated}
          restoreFocusRef={newThreadOpenerRef}
        />
      )}

      {confirmTrash && selectedThreads.length > 0 && (
        <TrashConfirmDialog
          selected={selectedThreads}
          onConfirm={handleConfirmTrash}
          onCancel={() => setConfirmTrash(false)}
          onFallbackFocus={() => searchInputRef.current?.focus()}
        />
      )}
    </div>
  );
}
