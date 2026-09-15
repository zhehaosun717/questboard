import type { LiveWorker, QuestKind, QuestStatus, Snapshot } from '../api/types';

export interface CardQuestActivity {
  questId: string;
  title: string;
  kind: QuestKind;
  status: QuestStatus;
  /** The lane's own live report for this quest, when this card currently holds it. Never a guess. */
  live: LiveWorker | null;
  /**
   * Only on a history entry: true when the quest is currently held (dispatched or stalled) by a *different*
   * card. Without this, a status like "进行中" on a history entry reads as if this card were still doing it,
   * when another card has since taken the quest over. Absent (not merely false) everywhere else, so existing
   * exact-shape comparisons of a finished quest's history entry are unaffected.
   */
  heldByOther?: boolean;
}

export interface CardActivity {
  /** Quests this card holds right now: dispatched, or stalled (silence does not free a quest — it keeps its
   *  assignee, slot and reservations until `release`). */
  current: CardQuestActivity[];
  /** Quests this card was dispatched to before, distinct from current. */
  history: CardQuestActivity[];
}

export const EMPTY_CARD_ACTIVITY: CardActivity = { current: [], history: [] };

// A quest in one of these statuses still holds its assignee (CLAUDE.md: "silence does not free a quest").
const HOLDING_STATUSES: ReadonlySet<QuestStatus> = new Set(['dispatched', 'stalled']);

/**
 * What a card is actually doing, straight from the snapshot the board already has: no percent-complete or
 * invented status, only dispatch history, the quests it currently holds, and each current quest's own live
 * report (keyed by that dispatch's run name, not the card id, so two concurrent runs never share one report).
 */
export function cardActivity(snap: Snapshot, cardId: string): CardActivity {
  if (!cardId) return EMPTY_CARD_ACTIVITY;

  const current: CardQuestActivity[] = [];
  const history: CardQuestActivity[] = [];

  for (const quest of snap.quests) {
    // Held by assignee, not just "ever dispatched": a card can be the current assignee of a quest whose
    // dispatch record has not caught up yet, and that still counts as current, not as missing entirely.
    const holds = HOLDING_STATUSES.has(quest.status) && quest.assignee?.adventurerId === cardId;
    const everDispatched = (quest.dispatches || []).some((d) => d.adventurerId === cardId);
    if (!holds && !everDispatched) continue;

    const live = holds && quest.assignee ? (snap.live[quest.assignee.name] ?? null) : null;
    const entry: CardQuestActivity = {
      questId: quest.id,
      title: quest.title,
      kind: quest.kind,
      status: quest.status,
      live,
    };
    if (holds) {
      current.push(entry);
    } else {
      // A different card can hold this quest right now even though this card dispatched it before; that
      // card's status (e.g. dispatched/stalled) must not read as if this card is still the one doing it.
      if (HOLDING_STATUSES.has(quest.status) && quest.assignee && quest.assignee.adventurerId !== cardId) {
        entry.heldByOther = true;
      }
      history.push(entry);
    }
  }

  return { current, history };
}
