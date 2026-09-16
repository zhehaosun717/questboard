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

const OCCUPIED_STATUSES: QuestStatus[] = ['dispatched', 'stalled'];

/** Client-side mirror of src/core/rules.js holdsSlot — advisory only; the server re-checks on save. */
export function isQuestOccupied(quest: Quest): boolean {
  return Boolean(quest.assignee) && OCCUPIED_STATUSES.includes(quest.status);
}

export function occupiedReason(quest: Quest): string {
  if (quest.status === 'dispatched') {
    return '有冒险者正在做这个委托，先别改——等它交差，或者先取消这个委托。';
  }
  return '冒险者失联了但还没确认停止，这个委托还占着；到上面确认已停并释放后再改。';
}
