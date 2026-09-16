import type { Snapshot } from './types';

/**
 * Project-specific context for the most recent failed execution of one card, projected read-only by the
 * server from quests already loaded for the snapshot. It is historical context, never a live availability
 * or quota state: on screen it says 最近一次执行失败, and it never pauses a card.
 */
export interface RecentFailure {
  questId: string;
  at: string;
  summary: string;
}

/**
 * The additive snapshot field. It lives in this module (not api/types.ts) so this slice does not rewrite
 * the shared type file other tabs import; a server that never sends the field simply shows nothing new.
 * Read it through recentFailuresOf(), not by casting a Snapshot inline.
 */
export interface SnapshotFailureFields {
  recentFailures?: Record<string, RecentFailure>;
}

/** The failure map from a snapshot, or an empty map for an old server / a not-yet-loaded board. */
export function recentFailuresOf(
  snap: Snapshot | null | undefined,
): Record<string, RecentFailure> {
  if (!snap) return {};
  const extra = snap as Snapshot & SnapshotFailureFields;
  const raw = extra.recentFailures;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw;
}

/**
 * The failure entry for exactly this card id, validated just enough to render: one malformed row from a
 * deviating server is ignored for that card instead of breaking the roster.
 */
export function failureForCard(
  snap: Snapshot | null | undefined,
  cardId: string,
): RecentFailure | null {
  if (!cardId) return null;
  const entry = recentFailuresOf(snap)[cardId];
  if (!entry || typeof entry !== 'object') return null;
  if (!entry.questId || typeof entry.questId !== 'string') return null;
  if (!entry.at || typeof entry.at !== 'string') return null;
  if (typeof entry.summary !== 'string') return null;
  return entry;
}

/**
 * Whether the failed quest is part of the currently loaded project, so the modal only offers to open a
 * drawer that can open here. A stale entry from another project finds no quest and shows no button.
 */
export function failureQuestExists(
  snap: Snapshot | null | undefined,
  failure: RecentFailure | null | undefined,
): boolean {
  if (!snap || !failure) return false;
  return snap.quests.some((q) => q.id === failure.questId);
}
