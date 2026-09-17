// Pure draft/diff logic for the drawer's 修改委托 (correct-metadata) section. Mirrors the accepted backend
// contract (src/core/metadataUpdate.js METADATA_FIELDS): title/brief/parents/conflicts/allowedLanes/
// needsOwner are the only correctable fields, and a field the owner never touched is never sent — the
// backend already treats an absent key as "leave exactly as is" and re-saves nothing it does not have to.
import type { MetadataUpdateInput, Quest, QuestStatus } from '../api/types';

export interface MetadataDraft {
  title: string;
  brief: string;
  parents: string[];
  conflicts: string[];
  allowedLanes: string[];
  needsOwner: string;
}

export function draftFromQuest(quest: Quest): MetadataDraft {
  return {
    title: quest.title || '',
    brief: quest.brief || '',
    parents: [...(quest.parents || [])],
    conflicts: [...(quest.conflicts || [])],
    allowedLanes: [...(quest.allowedLanes || [])],
    needsOwner: quest.needsOwner || '',
  };
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Only a field whose draft differs from the baseline the section opened with is included — an untouched
 * field (even one already carrying a legacy issue) is left out entirely, exactly like the backend expects.
 * A field the owner deliberately cleared to blank/empty still counts as changed and is sent, so the clear
 * actually reaches the server instead of being mistaken for "never touched".
 */
export function diffDraft(baseline: MetadataDraft, draft: MetadataDraft): MetadataUpdateInput {
  const payload: MetadataUpdateInput = {};
  if (draft.title !== baseline.title) payload.title = draft.title;
  if (draft.brief !== baseline.brief) payload.brief = draft.brief;
  if (draft.needsOwner !== baseline.needsOwner) payload.needsOwner = draft.needsOwner;
  if (!sameList(draft.parents, baseline.parents)) payload.parents = draft.parents;
  if (!sameList(draft.conflicts, baseline.conflicts)) payload.conflicts = draft.conflicts;
  if (!sameList(draft.allowedLanes, baseline.allowedLanes)) payload.allowedLanes = draft.allowedLanes;
  return payload;
}

export function hasChanges(payload: MetadataUpdateInput): boolean {
  return Object.keys(payload).length > 0;
}

const FIELD_LABELS: Record<keyof MetadataDraft, string> = {
  title: '标题',
  brief: '简报路径',
  parents: '前置委托',
  conflicts: '不能同时做的委托',
  allowedLanes: '允许使用的工具',
  needsOwner: '需要你决定的事',
};

const ALL_FIELDS = Object.keys(FIELD_LABELS) as Array<keyof MetadataDraft>;

function fieldsDiffer(a: MetadataDraft, b: MetadataDraft, field: keyof MetadataDraft): boolean {
  const av = a[field];
  const bv = b[field];
  return Array.isArray(av) && Array.isArray(bv) ? !sameList(av, bv) : av !== bv;
}

/** Every field (draft field order) that differs between two drafts. */
export function changedFields(a: MetadataDraft, b: MetadataDraft): Array<keyof MetadataDraft> {
  return ALL_FIELDS.filter((field) => fieldsDiffer(a, b, field));
}

/** Human labels (draft field order) for every field that differs between two drafts — used to tell the
 * owner in Chinese what changed, never just "已更新". */
export function changedFieldLabels(a: MetadataDraft, b: MetadataDraft): string[] {
  return changedFields(a, b).map((field) => FIELD_LABELS[field]);
}

/**
 * Re-baselines a kept draft against newer server data (reopening a collapsed section after the quest
 * changed underneath it): a field the owner never touched — same definition diffDraft already uses, draft
 * vs. the baseline the section opened with — follows the server's newer value, but a field they changed
 * keeps exactly what they typed. The server's newer value for a touched field is not lost: it simply loses
 * to an in-progress edit instead of overwriting it, the same way a normal edit conflict would.
 */
export function rebaseDraft(oldBaseline: MetadataDraft, draft: MetadataDraft, serverDraft: MetadataDraft): MetadataDraft {
  const touched = diffDraft(oldBaseline, draft);
  return {
    title: 'title' in touched ? draft.title : serverDraft.title,
    brief: 'brief' in touched ? draft.brief : serverDraft.brief,
    parents: 'parents' in touched ? draft.parents : serverDraft.parents,
    conflicts: 'conflicts' in touched ? draft.conflicts : serverDraft.conflicts,
    allowedLanes: 'allowedLanes' in touched ? draft.allowedLanes : serverDraft.allowedLanes,
    needsOwner: 'needsOwner' in touched ? draft.needsOwner : serverDraft.needsOwner,
  };
}

export interface FieldConflict {
  server: MetadataDraft[keyof MetadataDraft];
  mine: MetadataDraft[keyof MetadataDraft];
}
export type ConflictMap = Partial<Record<keyof MetadataDraft, FieldConflict>>;

/**
 * F-2/F-3 (round 2 PM ruling): a field changed on both sides is a conflict, not a silent overwrite. A field
 * the owner touched (per diffDraft's own "touched" definition — the same baseline rebaseDraft uses) whose
 * server value also moved since that baseline is reported here; `rebaseDraft` still shows the owner's edit
 * for it (never the server's newer value — that would be the F-2 bug: claiming "已经显示最新内容" for a
 * field that isn't), but the caller must block saving and offer a per-field choice instead of re-baselining
 * silently.
 */
export function detectConflicts(oldBaseline: MetadataDraft, draft: MetadataDraft, serverDraft: MetadataDraft): ConflictMap {
  const touched = diffDraft(oldBaseline, draft);
  const conflicts: ConflictMap = {};
  (Object.keys(touched) as Array<keyof MetadataDraft>).forEach((field) => {
    if (fieldsDiffer(oldBaseline, serverDraft, field)) {
      conflicts[field] = { server: serverDraft[field], mine: draft[field] };
    }
  });
  return conflicts;
}

/**
 * The next baseline to diff future edits/server snapshots against. A conflicting field keeps the OLD
 * baseline value (never the server's newer one) — that is the "do NOT move the baseline revision for it"
 * ruling: the field stays flagged as changed-since-baseline (so a later snapshot or resolveConflict can
 * still reason about it) instead of quietly adopting the server's value the way F-2 did. Every other field
 * (untouched, or touched but the server didn't move it) follows the server as before.
 */
export function mergeConflictBaseline(oldBaseline: MetadataDraft, serverDraft: MetadataDraft, conflicts: ConflictMap): MetadataDraft {
  const merged = { ...serverDraft };
  (Object.keys(conflicts) as Array<keyof MetadataDraft>).forEach((field) => {
    (merged as Record<keyof MetadataDraft, MetadataDraft[keyof MetadataDraft]>)[field] = oldBaseline[field];
  });
  return merged;
}

/** Fields that changed on the server but are NOT conflicting — safe to say "已经显示最新内容" about, since
 * the draft really does show the server's latest value for them (rebaseDraft adopted it). */
export function adoptedFieldLabels(oldBaseline: MetadataDraft, serverDraft: MetadataDraft, conflicts: ConflictMap): string[] {
  return changedFields(oldBaseline, serverDraft)
    .filter((field) => !(field in conflicts))
    .map((field) => FIELD_LABELS[field]);
}

/**
 * F-4 (round 2 review): `applyServerSnapshot` runs both on reopen and on every later snapshot while the
 * section stays open, and the two callers need different wording — "在收起期间被更新了" is only true for a
 * reopen, and "你没保存的其他修改还留着" is only true when the new draft (rebased onto this snapshot) still
 * differs from the new baseline. Never reached with an empty `adopted` — callers only invoke this when there
 * is at least one field to name.
 */
export function snapshotToastMessage(
  questId: string,
  adopted: string[],
  context: { wasCollapsed: boolean; hasUnsavedChanges: boolean },
): string {
  const verb = context.wasCollapsed ? '在收起期间被更新了' : '刚刚被别人更新了';
  const tail = context.hasUnsavedChanges ? '，你没保存的其他修改还留着' : '';
  return `${questId} ${verb}（${adopted.join('、')}），已经显示最新内容${tail}`;
}

function formatFieldValue(value: MetadataDraft[keyof MetadataDraft]): string {
  if (Array.isArray(value)) return value.length > 0 ? value.join('、') : '（空）';
  return value || '（空）';
}

/** 「标题：服务器已改成 X，你这边是 Y」 — names the conflicting field and both values, never a bare
 * "已更新". */
export function describeConflict(field: keyof MetadataDraft, conflict: FieldConflict): string {
  return `${FIELD_LABELS[field]}：服务器已改成 ${formatFieldValue(conflict.server)}，你这边是 ${formatFieldValue(conflict.mine)}`;
}

/**
 * N-2 (round 2 review): `conflict.mine` is captured once, at the moment the conflict was detected. If the
 * owner keeps typing the conflicting field afterward, the banner must describe what 用我的 would actually
 * send right now (`applyConflictChoice` already uses the live `draft[field]`) — never the stale snapshot.
 */
export function liveConflict(field: keyof MetadataDraft, conflict: FieldConflict, draft: MetadataDraft): FieldConflict {
  return { ...conflict, mine: draft[field] };
}

/**
 * Applies the owner's per-field choice: 用服务器的 drops the edit (draft follows the server's value);
 * 用我的 keeps the owner's edit. Either way the baseline for this one field re-anchors to the server's
 * value that was just shown, so a further, later server change is judged against what the owner just saw
 * — not the original edit-start value — and 用我的 becomes the explicit, deliberate overwrite the ruling
 * asks for (the next save sends this field against the server's current revision).
 */
export function applyConflictChoice(
  draft: MetadataDraft,
  baselineDraft: MetadataDraft,
  field: keyof MetadataDraft,
  conflict: FieldConflict,
  choice: 'server' | 'mine',
): { draft: MetadataDraft; baseline: MetadataDraft } {
  const value = choice === 'server' ? conflict.server : draft[field];
  return {
    draft: { ...draft, [field]: value },
    baseline: { ...baselineDraft, [field]: conflict.server },
  };
}

// The server's own field/top-level error text (src/core/metadataUpdate.js, src/server/questRoutes.js) is
// honest but always in English. Every shape that route can actually produce today is matched here and
// rewritten into plain Chinese naming the id involved; anything this list has never seen (a future server
// message, or one of the review-lineage lock sentences) is shown verbatim, but never bare — prefixed so the
// owner can tell it came straight from the server rather than a translation this page chose to skip.
const KNOWN_SERVER_MESSAGES: Array<{ pattern: RegExp; toZh: (m: RegExpMatchArray) => string }> = [
  { pattern: /^quest not found$/, toZh: () => '这个委托已经不在看板上了' },
  { pattern: /^parent (\S+) not found;/, toZh: (m) => `前置委托 ${m[1]} 不存在，请先创建它，或者改成别的编号再试一次` },
  { pattern: /^(\S+) cannot be its own parent$/, toZh: (m) => `不能把 ${m[1]} 设成自己的前置委托` },
  { pattern: /^parents would create a cycle back to (\S+)$/, toZh: (m) => `这样连下去会绕回 ${m[1]}，形成循环依赖` },
  { pattern: /^parents must be package ids, got (.+)$/, toZh: (m) => `前置委托必须是委托编号，收到的是 ${m[1]}` },
  { pattern: /^(\S+) cannot conflict with itself$/, toZh: (m) => `不能把 ${m[1]} 设成和自己冲突` },
  { pattern: /^conflicts must be package ids, got (.+)$/, toZh: (m) => `冲突列表必须是委托编号，收到的是 ${m[1]}` },
  { pattern: /^unknown lane (\S+); this project defines (.+)$/, toZh: (m) => `没有这个工具：${m[1]}；这个项目里配置的工具是 ${m[2]}` },
  { pattern: /^brief is required$/, toZh: () => '简报路径不能为空' },
  { pattern: /^brief must be <dir>\/<file>\.md with <dir> one of (.+)$/, toZh: (m) => `简报路径格式不对，应该是 <目录>/<文件>.md，允许的目录是 ${m[1]}` },
];

export function translateServerMessage(raw: string): string {
  for (const { pattern, toZh } of KNOWN_SERVER_MESSAGES) {
    const match = raw.match(pattern);
    if (match) return toZh(match);
  }
  return `服务器说：${raw}`;
}

const OCCUPIED_STATUSES: QuestStatus[] = ['dispatched', 'stalled'];

/** Client-side mirror of src/core/rules.js holdsSlot — advisory only; the server re-checks on save. */
export function isQuestOccupied(quest: Quest): boolean {
  return Boolean(quest.assignee) && OCCUPIED_STATUSES.includes(quest.status);
}

export function occupiedReason(quest: Quest): string {
  if (quest.status === 'dispatched') {
    return '有 worker 正在做这个委托，先别改——等它交差，或者先取消这个委托。';
  }
  return 'worker 失联了，但还没确认它已停止，这个委托还占着；在上面确认它已停止并释放后再改。';
}
