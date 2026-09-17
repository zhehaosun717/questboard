import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api/client';
import type { Quest, Snapshot } from '../../api/types';
import {
  adoptedFieldLabels, applyConflictChoice, changedFieldLabels, describeConflict, detectConflicts, diffDraft,
  draftFromQuest, hasChanges, isQuestOccupied, liveConflict, mergeConflictBaseline, occupiedReason, rebaseDraft,
  snapshotToastMessage, translateServerMessage, type ConflictMap, type MetadataDraft,
} from '../../lib/metadataForm';
import { missingParentIds, parentLock, questTitle } from '../../lib/metadataLock';
import { TaskChipPicker } from './TaskChipPicker';
import '../../styles/metadata.css';

interface MetadataSectionProps {
  quest: Quest;
  snap: Snapshot;
  refresh: () => void;
  pushToast: (message: string) => void;
}

interface Baseline {
  draft: MetadataDraft;
  revision?: number;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Exported so a plain unit test can prove the fix without mounting React: setup must put the ref back to
// `false` every time an effect runs, not only clear it on cleanup — otherwise StrictMode's simulated
// mount -> cleanup -> mount leaves it permanently `true` and every guarded branch below stays dead code.
export function unmountEffect(ref: { current: boolean }) {
  ref.current = false;
  return () => {
    ref.current = true;
  };
}

// The real 409 body (questRoutes.js) for a holds_slot refusal has no usable text in `err.message`
// ('refused') — the explanation lives only in `reasons`. Exported so a test can use the exact server shape.
export function holdsSlotMessage(err: ApiError): string {
  return err.reasons?.find((r) => r.code === 'holds_slot')?.message ?? err.message;
}

// Exported so a test can prove the focus target without mounting React (no DOM library is installed here —
// see the B1 note above). Cancel collapses the section, and the Cancel button that had focus is removed
// from the DOM with it; the summary — the section's own open/close toggle, the closest thing this UI has to
// an "edit" control — is what's left, so it is refocused explicitly rather than left to fall to `<body>`.
export function focusAfterCancel(summary: { focus: () => void } | null | undefined) {
  summary?.focus();
}

/**
 * Owner-facing correction of a posted quest's own title/brief/前置委托/不能同时做/允许工具/待裁决问题 —
 * never status, assignee or dispatch history (those live elsewhere in the drawer already). Mounted with a
 * project+quest key from QuestDrawer, so switching quest or project remounts this with fresh state instead
 * of leaking a draft or a busy flag between them; `unmountedRef` additionally stops a save started before
 * that remount from toasting success or refreshing on behalf of whatever is now shown.
 */
export function MetadataSection({ quest, snap, refresh, pushToast }: MetadataSectionProps) {
  const [open, setOpen] = useState(false);
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [draft, setDraft] = useState<MetadataDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [staleRevision, setStaleRevision] = useState<number | null>(null);
  const [conflicts, setConflicts] = useState<ConflictMap>({});
  const [awaitingReload, setAwaitingReload] = useState(false);
  const unmountedRef = useRef(false);
  const opRef = useRef(0);
  const busyRef = useRef(false);
  const summaryRef = useRef<HTMLElement>(null);
  const draftRef = useRef<MetadataDraft | null>(null);
  const baselineRef = useRef<Baseline | null>(null);

  useEffect(() => unmountEffect(unmountedRef), []);
  useEffect(() => { draftRef.current = draft; }, [draft]);
  useEffect(() => { baselineRef.current = baseline; }, [baseline]);

  const beginEdit = (from: Quest) => {
    const nextDraft = draftFromQuest(from);
    setBaseline({ draft: nextDraft, revision: from.revision });
    setDraft(nextDraft);
    setFieldErrors({});
    setStaleRevision(null);
    setConflicts({});
  };

  // Re-baseline onto the server's current values (R4), but a field the owner touched that the server ALSO
  // moved since the old baseline is a conflict (F-2/F-3 PM ruling), never a silent adopt: rebaseDraft still
  // shows the owner's edit for it, mergeConflictBaseline keeps the field's baseline at the OLD value (so it
  // stays flagged rather than quietly re-baselined), and the stale/conflict banner is never cleared while any
  // conflict remains — only the genuinely-adopted fields (server changed, owner never touched) get the
  // "已经显示最新内容" toast. Applied both on reopen and, via the effect below, on every later snapshot
  // while the section stays open — a plain collapse/reopen must not be a way around the guard. `wasCollapsed`
  // distinguishes the two callers for the toast's wording (F-4): only a reopen was actually "收起期间".
  const applyServerSnapshot = (serverQuest: Quest, wasCollapsed: boolean) => {
    const currentBaseline = baselineRef.current;
    const currentDraft = draftRef.current;
    if (!currentBaseline || !currentDraft) return;
    if (serverQuest.revision === currentBaseline.revision) return;
    const serverDraft = draftFromQuest(serverQuest);
    const fieldConflicts = detectConflicts(currentBaseline.draft, currentDraft, serverDraft);
    const stillConflicting = Object.keys(fieldConflicts).length > 0;
    const adopted = adoptedFieldLabels(currentBaseline.draft, serverDraft, fieldConflicts);
    const nextDraft = rebaseDraft(currentBaseline.draft, currentDraft, serverDraft);
    const nextBaselineDraft = mergeConflictBaseline(currentBaseline.draft, serverDraft, fieldConflicts);
    setDraft(nextDraft);
    setBaseline({
      draft: nextBaselineDraft,
      revision: stillConflicting ? currentBaseline.revision : serverQuest.revision,
    });
    setConflicts(fieldConflicts);
    if (!stillConflicting) setStaleRevision(null);
    setFieldErrors({});
    if (adopted.length > 0) {
      const hasUnsavedChanges = hasChanges(diffDraft(nextBaselineDraft, nextDraft));
      pushToast(snapshotToastMessage(serverQuest.id, adopted, { wasCollapsed, hasUnsavedChanges }));
    }
  };

  const onToggle = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    const isOpen = e.currentTarget.open;
    setOpen(isOpen);
    if (!isOpen) return;
    if (!baseline) { beginEdit(quest); return; }
    applyServerSnapshot(quest, true);
  };

  // The drawer keeps polling while the section stays open; a snapshot that lands mid-edit must be judged the
  // same way a reopen is (same function), not skipped until the next collapse/reopen. Skipped while a reload
  // was explicitly requested (awaitingReload): that flow already owns the next revision change below and does
  // a full reset, not a per-field merge — running both would fire a "你没保存的其他修改还留着" toast for
  // edits the reload is about to discard.
  useEffect(() => {
    if (open && !awaitingReload) applyServerSnapshot(quest, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quest.revision]);

  // A reload was requested while a stale banner was up: wait for the drawer's own quest prop to actually
  // carry a newer revision (refresh() is fire-and-forget, not awaitable) before resyncing, so this never
  // resyncs to the very same stale snapshot that caused the conflict.
  useEffect(() => {
    if (awaitingReload && baseline && quest.revision !== baseline.revision) {
      // R4: never just "已更新到第 N 版" — the stale 409 already told the owner they lost this round of
      // typing (they confirmed the "放弃这次修改" prompt in resolveStale to get here), so this reload names
      // what the server actually changed while they still remember what they typed.
      const changed = changedFieldLabels(baseline.draft, draftFromQuest(quest));
      beginEdit(quest);
      setAwaitingReload(false);
      const revisionNote = quest.revision == null ? '已更新' : `已更新到第 ${quest.revision} 版`;
      pushToast(changed.length > 0 ? `${quest.id} ${revisionNote}（改了：${changed.join('、')}）` : `${quest.id} ${revisionNote}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quest.revision, awaitingReload]);

  if (!open || !draft || !baseline) {
    return (
      <details className="d-sec meta-details" open={open} onToggle={onToggle}>
        <summary ref={summaryRef}>
          <span>EDIT ORDER</span>
          修改委托
        </summary>
      </details>
    );
  }

  const occupied = isQuestOccupied(quest);
  const lock = parentLock(quest, snap.quests);
  const missing = missingParentIds(draft.parents, snap.quests);
  const fieldsDisabled = occupied || busy;
  const conflictFields = Object.keys(conflicts) as Array<keyof MetadataDraft>;
  const hasConflicts = conflictFields.length > 0;

  const chipLabel = (id: string) => {
    if (missing.includes(id)) return `未找到：${id}`;
    const title = questTitle(id, snap.quests);
    return title ? `${id} · ${title}` : id;
  };

  const questSuggestions = snap.quests.filter((q) => q.id !== quest.id).map((q) => ({ id: q.id, title: q.title }));
  const laneSuggestions = snap.project.lanes.map((id) => ({ id }));

  const update = <K extends keyof MetadataDraft>(field: K, value: MetadataDraft[K]) => {
    setDraft((prev) => (prev ? { ...prev, [field]: value } : prev));
  };

  const cancelEdit = () => {
    if (hasChanges(diffDraft(baseline.draft, draft)) && !window.confirm('放弃这次没保存的修改？')) return;
    setOpen(false);
    // Unlike a plain collapse (onToggle), Cancel means the owner chose to discard: clear the baseline so the
    // next open re-reads the quest fresh instead of showing the very draft just discarded.
    setBaseline(null);
    setDraft(null);
    setConflicts({});
    // The Cancel button itself is about to be removed from the DOM along with the rest of the body; without
    // this the browser drops focus to <body>.
    focusAfterCancel(summaryRef.current);
  };

  const resolveStale = (reload: boolean) => {
    if (!window.confirm(reload ? '放弃这次修改，重新读取最新内容？' : '放弃这次没保存的修改？')) return;
    if (reload) {
      setAwaitingReload(true);
      refresh();
    } else {
      beginEdit(quest);
    }
  };

  // The owner's per-field choice for a conflicting field (PM ruling): 用服务器的 drops the edit, 用我的
  // keeps it as a deliberate overwrite. Either way the field's baseline re-anchors to the server value just
  // shown, and once no conflict remains the held-back revision (F-2's fix: never bumped while conflicting)
  // catches up so a save can actually go through again.
  const resolveConflict = (field: keyof MetadataDraft, choice: 'server' | 'mine') => {
    const conflict = conflicts[field];
    if (!conflict) return;
    const { draft: nextDraft, baseline: nextBaselineDraft } = applyConflictChoice(draft, baseline.draft, field, conflict, choice);
    const nextConflicts = { ...conflicts };
    delete nextConflicts[field];
    const stillConflicting = Object.keys(nextConflicts).length > 0;
    setDraft(nextDraft);
    setBaseline({ draft: nextBaselineDraft, revision: stillConflicting ? baseline.revision : quest.revision });
    setConflicts(nextConflicts);
    if (!stillConflicting) setStaleRevision(null);
  };

  const save = async () => {
    // A ref, not the `busy` state: two click() calls inside one JS task both close over the same pre-update
    // `busy` value, so the state check alone lets both through. The ref is written synchronously, so the
    // second call always sees the first one's guard.
    if (busyRef.current) return;
    const payload = diffDraft(baseline.draft, draft);
    if (!hasChanges(payload)) {
      pushToast('没有改动，不用保存');
      return;
    }
    if (occupied) {
      pushToast(occupiedReason(quest));
      return;
    }
    if (hasConflicts) {
      pushToast('有字段两边都改过，先在上面选用服务器的还是用我的');
      return;
    }
    const myOp = (opRef.current += 1);
    busyRef.current = true;
    setBusy(true);
    setFieldErrors({});
    try {
      // A legacy row with no `revision` (pre-dates the field) still gets a stale guard: the server treats a
      // missing ifRevision the same as 0.
      const { quest: updated } = await api.updateMetadata(quest.id, payload, baseline.revision ?? 0);
      if (unmountedRef.current || opRef.current !== myOp) return;
      setBaseline({ draft: draftFromQuest(updated), revision: updated.revision });
      setDraft(draftFromQuest(updated));
      setConflicts({});
      pushToast(`${quest.id} 的委托信息已保存`);
      refresh();
    } catch (err) {
      if (unmountedRef.current || opRef.current !== myOp) return;
      if (err instanceof ApiError) {
        if (err.fields && Object.keys(err.fields).length > 0) {
          setFieldErrors(
            Object.fromEntries(Object.entries(err.fields).map(([field, message]) => [field, translateServerMessage(message)])),
          );
        } else if (err.reasons?.some((r) => r.code === 'stale_revision')) {
          setStaleRevision(err.revision ?? null);
        } else if (err.reasons?.some((r) => r.code === 'holds_slot')) {
          pushToast(holdsSlotMessage(err));
        } else if (err.message === 'not found') {
          pushToast('这个看板不支持修改委托，或者委托已经不在了');
        } else {
          pushToast(`没保存成功：${translateServerMessage(errorText(err))}`);
        }
      } else {
        pushToast(`没保存成功：${errorText(err)}`);
      }
    } finally {
      if (opRef.current === myOp) busyRef.current = false;
      if (!unmountedRef.current && opRef.current === myOp) setBusy(false);
    }
  };

  return (
    <details className="d-sec meta-details" open={open} onToggle={onToggle}>
      <summary ref={summaryRef}>
        <span>EDIT ORDER</span>
        修改委托
      </summary>
      <div className="meta-body">
        {occupied ? <p className="meta-banner meta-banner-block">{occupiedReason(quest)}</p> : null}
        {staleRevision !== null || conflictFields.length > 0 ? (
          <div className="meta-banner meta-banner-stale">
            {staleRevision !== null ? (
              <p>委托已被更新，请先查看最新内容（现在是第 {staleRevision} 版）。</p>
            ) : null}
            {conflictFields.map((field) => (
              <div key={field} className="meta-conflict-field">
                <p>{describeConflict(field, liveConflict(field, conflicts[field]!, draft))}</p>
                <div className="row">
                  <button type="button" className="btn" onClick={() => resolveConflict(field, 'server')}>
                    用服务器的
                  </button>
                  <button type="button" className="btn" onClick={() => resolveConflict(field, 'mine')}>
                    用我的
                  </button>
                </div>
              </div>
            ))}
            <div className="row">
              <button type="button" className="btn" onClick={() => resolveStale(true)}>
                重新读取最新内容
              </button>
              <button type="button" className="btn" onClick={() => resolveStale(false)}>
                放弃这次修改
              </button>
            </div>
          </div>
        ) : null}

        <label className="meta-field">
          <span>标题</span>
          <input type="text" value={draft.title} disabled={fieldsDisabled} onChange={(e) => update('title', e.target.value)} />
          {fieldErrors.title ? <p className="meta-err">{fieldErrors.title}</p> : null}
        </label>

        <label className="meta-field">
          <span>简报路径</span>
          <input type="text" className="mono" value={draft.brief} disabled={fieldsDisabled} onChange={(e) => update('brief', e.target.value)} />
          {fieldErrors.brief ? <p className="meta-err">{fieldErrors.brief}</p> : null}
        </label>

        <div className="meta-field">
          <span>前置委托（先完成哪些）</span>
          {lock ? (
            <div className="meta-locked">
              <p className="meta-hint">{lock.message}</p>
              {draft.parents.length > 0 ? (
                <ul className="meta-chips">
                  {draft.parents.map((id) => (
                    <li key={id} className="meta-chip meta-chip-readonly">
                      <span>{chipLabel(id)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : (
            <>
              {missing.length > 0 ? (
                <p className="meta-hint">看板上已经没有这些编号了（历史记录里的旧数据），可以直接移除或换成别的。</p>
              ) : null}
              <TaskChipPicker
                ariaLabel="前置委托（先完成哪些）"
                values={draft.parents}
                onChange={(next) => update('parents', next)}
                suggestions={questSuggestions}
                placeholder="搜索委托编号或标题，回车加入"
                disabled={fieldsDisabled}
                formatChip={chipLabel}
                idPrefix="meta-parents"
              />
            </>
          )}
          {fieldErrors.parents ? <p className="meta-err">{fieldErrors.parents}</p> : null}
        </div>

        <div className="meta-field">
          <span>不能同时做的委托</span>
          <p className="meta-hint">这里只是手动标注；实际的文件冲突保护不会因为在这里移除而消失。</p>
          <TaskChipPicker
            ariaLabel="不能同时做的委托"
            values={draft.conflicts}
            onChange={(next) => update('conflicts', next)}
            suggestions={questSuggestions}
            placeholder="搜索委托编号或标题，回车加入"
            disabled={fieldsDisabled}
            formatChip={chipLabel}
            idPrefix="meta-conflicts"
          />
          {fieldErrors.conflicts ? <p className="meta-err">{fieldErrors.conflicts}</p> : null}
        </div>

        <div className="meta-field">
          <span>允许使用的工具</span>
          <p className="meta-hint">留空 = 不限制</p>
          <TaskChipPicker
            ariaLabel="允许使用的工具"
            values={draft.allowedLanes}
            onChange={(next) => update('allowedLanes', next)}
            suggestions={laneSuggestions}
            placeholder="搜索工具名，回车加入"
            disabled={fieldsDisabled}
            idPrefix="meta-lanes"
          />
          {fieldErrors.allowedLanes ? <p className="meta-err">{fieldErrors.allowedLanes}</p> : null}
        </div>

        <label className="meta-field">
          <span>需要你决定的事</span>
          <textarea rows={2} value={draft.needsOwner} disabled={fieldsDisabled} onChange={(e) => update('needsOwner', e.target.value)} />
          {fieldErrors.needsOwner ? <p className="meta-err">{fieldErrors.needsOwner}</p> : null}
        </label>

        <div className="row end meta-actions">
          <button type="button" className="btn" disabled={busy} onClick={cancelEdit}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || occupied || staleRevision !== null || hasConflicts}
            onClick={() => void save()}
          >
            {busy ? '保存中…' : '保存修改'}
          </button>
        </div>
      </div>
    </details>
  );
}
