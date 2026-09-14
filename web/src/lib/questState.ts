import type { Quest, Reason, Ruling, Snapshot, Verdict } from '../api/types';
import { COLUMNS } from './labels';

const ARCHIVED_STATUSES = COLUMNS.find((column) => column.key === 'done')?.statuses ?? [];
const CHECK_STATUSES = COLUMNS.find((column) => column.key === 'check')?.statuses ?? [];

export function isArchived(quest: Quest): boolean {
  return ARCHIVED_STATUSES.includes(quest.status);
}

/**
 * Delivered or under review: the work came back and waits for the owner to accept it or send it back.
 * A 你来 quest is the owner's own work, and a review quest's report is signed off on the work it reviews.
 */
export function isAwaitingSignOff(quest: Quest): boolean {
  return quest.kind !== 'owner' && quest.kind !== 'review' && CHECK_STATUSES.includes(quest.status);
}

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
 * locked), not to any one card, so the board says them once instead of under every card.
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
