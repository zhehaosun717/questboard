import type { Quest, Reason, Ruling, Snapshot, Verdict } from '../api/types';
import { COLUMNS, OPEN_STATUSES } from './labels';

export type QuestFlowKey = 'open' | 'blocked' | 'run' | 'owner' | 'other';

const RUN_STATUSES = COLUMNS.find((column) => column.key === 'run')?.statuses ?? [];
const OWNER_STATUSES = [
  ...(COLUMNS.find((column) => column.key === 'check')?.statuses ?? []),
  ...(COLUMNS.find((column) => column.key === 'owner')?.statuses ?? []),
];
const ARCHIVED_STATUSES = COLUMNS.find((column) => column.key === 'done')?.statuses ?? [];

export const QUEST_FLOW_LABEL: Record<QuestFlowKey, string> = {
  open: '可以派遣',
  blocked: '暂时派不了',
  run: '正在执行',
  owner: '等我处理',
  other: '',
};

export function isArchived(quest: Quest): boolean {
  return ARCHIVED_STATUSES.includes(quest.status);
}

const CHECK_STATUSES = COLUMNS.find((column) => column.key === 'check')?.statuses ?? [];

/** The verdict for dropping a card on this quest: returned work is judged as a review of it, not as more work. */
export function getDropVerdict(snap: Snapshot, quest: Quest, cardId: string): Verdict | undefined {
  return isAwaitingSignOff(quest)
    ? snap.reviewEligibility?.[quest.id]?.[cardId]
    : snap.eligibility[quest.id]?.[cardId];
}

/** Review quests posted for this quest, oldest first. */
export function reviewsOf(snap: Snapshot, questId: string): Quest[] {
  return snap.quests
    .filter((q) => q.kind === 'review' && q.parents.includes(questId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Delivered or under review: the work came back and waits for the owner to accept it or send it back. */
export function isAwaitingSignOff(quest: Quest): boolean {
  return quest.kind !== 'owner' && CHECK_STATUSES.includes(quest.status);
}

export function getQuestFlowKey(quest: Quest, snap: Snapshot): QuestFlowKey {
  if (isArchived(quest)) return 'other';
  // The rules refuse a 你来 quest to every card, so until it is archived it is always the owner's to do.
  if (quest.kind === 'owner' || quest.needsOwner.trim().length > 0 || OWNER_STATUSES.includes(quest.status)) {
    return 'owner';
  }
  if (RUN_STATUSES.includes(quest.status)) {
    return quest.assignee ? 'run' : 'other';
  }
  // An open quest no card can take (a file conflict, the lock) must not read as dispatchable.
  if (OPEN_STATUSES.includes(quest.status)) return hasEligibleCard(snap, quest.id) ? 'open' : 'blocked';
  return 'other';
}

export function getQuestVerdict(
  snap: Snapshot,
  questId: string,
  cardId: string,
): Verdict | undefined {
  return snap.eligibility[questId]?.[cardId];
}

export function hasEligibleCard(snap: Snapshot, questId: string): boolean {
  const verdicts = snap.eligibility[questId];
  return verdicts ? Object.values(verdicts).some((verdict) => verdict.ok) : false;
}

/**
 * The refusals every card shares: those belong to the quest (another quest holds its files, the tree is
 * locked), not to any one card, so the drawer says them once instead of under every card.
 */
export function sharedRefusals(snap: Snapshot, questId: string): Reason[] {
  const verdicts = Object.values(snap.eligibility[questId] ?? {});
  const first = verdicts[0];
  if (!first) return [];
  return first.reasons.filter((reason) =>
    verdicts.every((verdict) =>
      verdict.reasons.some((other) => other.code === reason.code && other.message === reason.message),
    ),
  );
}

export function getLatestRuling(quest: Quest): Ruling | undefined {
  const lastIndex = quest.rulings.length - 1;
  return lastIndex >= 0 ? quest.rulings[lastIndex] : undefined;
}
