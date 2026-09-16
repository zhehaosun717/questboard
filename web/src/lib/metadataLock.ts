// Advisory, read-only mirror of src/core/metadataUpdate.js's review-lineage lock, computed over the
// snapshot the drawer already has — never the final word. The server re-checks the same lock against its
// own live quest list on save (see questRoutes.js POST .../metadata, 400 with fields.parents), so getting
// this wrong here only ever costs a wasted click, never a silent bypass: it exists purely so the picker can
// go read-only and explain itself before the owner types anything, instead of failing only after a save.
import type { Quest } from '../api/types';

/** Every posted review's own ancestor walk, cycle-safely, exactly like the backend's findReviewAncestorLock. */
export function findReviewAncestorLock(targetId: string, quests: Quest[]): string | null {
  const byId = new Map(quests.map((q) => [q.id, q]));
  for (const candidate of quests) {
    if (candidate.kind !== 'review') continue;
    const seen = new Set<string>();
    const stack = [...(candidate.parents || [])];
    while (stack.length) {
      const id = stack.pop();
      if (id === undefined) continue;
      if (id === targetId) return candidate.id;
      if (seen.has(id)) continue;
      seen.add(id);
      const ancestor = byId.get(id);
      if (!ancestor) continue;
      stack.push(...(ancestor.parents || []));
    }
  }
  return null;
}

export interface ParentLock {
  reviewId: string;
  ownReview: boolean;
  message: string;
}

/** Non-null means the parents field must render read-only: either the quest is itself a posted review
 * (its own target is frozen), or some posted review's ancestor walk already reaches it. */
export function parentLock(quest: Quest, quests: Quest[]): ParentLock | null {
  if (quest.kind === 'review') {
    return {
      reviewId: quest.id,
      ownReview: true,
      message: `${quest.id} 本身是已发布的复核，它审的目标不能在这里清空或改指——取消 ${quest.id} 也不会解锁它；`
        + `要改指只能用新的编号重新发一个委托（需要的话再发一个新复核）。`,
    };
  }
  const reviewId = findReviewAncestorLock(quest.id, quests);
  if (!reviewId) return null;
  return {
    reviewId,
    ownReview: false,
    message: `已发布的复核 ${reviewId} 的溯源链接到了 ${quest.id}，前置委托在这里被锁定——取消 ${reviewId} 也不会解锁 ${quest.id}；`
      + `要改这条链，只能用新的编号重新发一个挂载正确的委托。`,
  };
}

/** Parent ids the current snapshot has no matching quest for — a legacy/broken reference, shown but not
 * silently dropped. Advisory: a quest the drawer simply has not loaded yet would also show here. */
export function missingParentIds(parents: string[], quests: Quest[]): string[] {
  const known = new Set(quests.map((q) => q.id));
  return parents.filter((id) => !known.has(id));
}

export function questTitle(id: string, quests: Quest[]): string | undefined {
  return quests.find((q) => q.id === id)?.title;
}
