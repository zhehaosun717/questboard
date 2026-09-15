import type { Card, Quest, Snapshot, Verdict } from '../api/types';
import { CARD_STATUS, type Column } from './labels';
import { nextStep } from './nextStep';

/**
 * Whether the quest itself carries an explicit open question for the owner. One trim() rule shared by the
 * column routing, the tray and the next step, so a whitespace-only question is no question anywhere.
 */
export function hasOwnerQuestion(quest: Quest): boolean {
  return Boolean(quest.needsOwner && quest.needsOwner.trim());
}

/**
 * Which column a returned quest stands in — by responsibility, not only by status. Work that came back
 * (delivered/reviewing) splits: the owner's calls (returned art, anything with an open question, playtest)
 * belong in 等会长; technical verification of code and tool work belongs in 交差核验. nextStep is the one
 * shared responsibility decision, so a quest cannot sit in one column and demand something else in the
 * tray. A review quest's verdict is read on the work it reviews, never as a second ask here, so it stays in
 * 交差核验 — unless it carries its own explicit question, which outranks the kind exactly as it does in
 * nextStep and the tray.
 */
export function returnedToOwner(snap: Snapshot, quest: Quest): boolean {
  if (quest.kind === 'review') return hasOwnerQuestion(quest);
  return nextStep(quest, snap).who === 'you';
}

function standsIn(snap: Snapshot, quest: Quest, column: Column): boolean {
  if (!column.statuses.includes(quest.status)) {
    // The owner column also holds returned work whose next step is the owner's, moved out of check.
    return column.key === 'owner'
      && (quest.status === 'delivered' || quest.status === 'reviewing')
      && returnedToOwner(snap, quest);
  }
  if (column.key === 'check' && (quest.status === 'delivered' || quest.status === 'reviewing')) {
    return !returnedToOwner(snap, quest);
  }
  return true;
}

// Every quest that belongs in the column, in display order, with no cap: a column's true size is its
// length. `column.limit` is a page-size hint for a folding column (see paginate below), never a ceiling
// on how many quests exist — capping here would make "已完成" or "等会长" undercount their own work.
export function questsInColumn(snap: Snapshot, column: Column): Quest[] {
  return snap.quests
    .filter((q) => standsIn(snap, q, column))
    .sort((a, b) => (column.limit ? 0 : (a.priority || 2) - (b.priority || 2)) || b.updatedAt.localeCompare(a.updatedAt));
}

// A browser-storage key namespaced to the current project, so two projects sharing a browser (same-name
// projects, or one port reused) never leak or overwrite each other's fold/page choices. Falls back to the
// bare key when an older server sends no project id, matching how other readers treat a missing id.
export function projectScopedKey(base: string, snap: Snapshot): string {
  return snap.project.id ? `${base}.${snap.project.id}` : base;
}

// Client-side search for a folded column's contents: matches the quest id or title, case-insensitively.
// An empty query returns every item unfiltered.
export function filterQuests(items: Quest[], query: string): Quest[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((quest) => quest.id.toLowerCase().includes(q) || quest.title.toLowerCase().includes(q));
}

export interface Page<T> {
  pageItems: T[];
  page: number;
  totalPages: number;
  total: number;
}

// Slices an already-sorted/filtered list into one page. `page` is clamped into range so a stale page
// number (search narrowed the list, or the list shrank) never renders empty by mistake.
export function paginate<T>(items: T[], page: number, pageSize: number): Page<T> {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const clamped = Math.min(Math.max(1, page), totalPages);
  const start = (clamped - 1) * pageSize;
  return { pageItems: items.slice(start, start + pageSize), page: clamped, totalPages, total };
}

export function busyQuests(snap: Snapshot, cardId: string): Quest[] {
  return snap.quests.filter(
    (q) => q.status === 'dispatched' && q.assignee?.adventurerId === cardId,
  );
}

export function cardLabel(card: Card, busyCount: number): string {
  const max = card.maxParallel || 1;
  const full = card.status === 'available' && busyCount >= max;
  if (card.status !== 'available') {
    return CARD_STATUS[card.status] ?? card.status;
  }
  return `${full ? '满员' : '空闲'} ${busyCount}/${max}`;
}

export function groupRefusals(verdicts: Record<string, Verdict>): {
  canTake: string[];
  refused: { message: string; cards: string[] }[];
} {
  const canTake: string[] = [];
  const reasonMap = new Map<string, string[]>();

  for (const [cardId, verdict] of Object.entries(verdicts)) {
    if (verdict.ok) {
      canTake.push(cardId);
    } else {
      const reasons = verdict.reasons.length > 0 ? verdict.reasons : [{ code: '', message: '不可用' }];
      for (const r of reasons) {
        const list = reasonMap.get(r.message);
        if (list) {
          if (!list.includes(cardId)) {
            list.push(cardId);
          }
        } else {
          reasonMap.set(r.message, [cardId]);
        }
      }
    }
  }

  const refused = Array.from(reasonMap.entries()).map(([message, cards]) => ({
    message,
    cards,
  }));

  return { canTake, refused };
}

export function isQueueOnly(verdict: Verdict | undefined | null): boolean {
  if (!verdict || verdict.ok) return false;
  if (!verdict.reasons || verdict.reasons.length === 0) return false;
  return verdict.reasons.every((r) => r.code === 'conflict_running');
}

export function relatedQuestIds(snap: Snapshot, questId: string): string[] {
  const questMap = new Map(snap.quests.map((q) => [q.id, q]));
  if (!questMap.has(questId)) return [];

  const keep = new Set<string>([questId]);

  const up = (qid: string) => {
    const q = questMap.get(qid);
    if (!q) return;
    for (const p of q.parents || []) {
      if (!keep.has(p)) {
        keep.add(p);
        up(p);
      }
    }
  };

  const down = (qid: string) => {
    for (const q of snap.quests) {
      if ((q.parents || []).includes(qid) && !keep.has(q.id)) {
        keep.add(q.id);
        down(q.id);
      }
    }
  };

  up(questId);
  down(questId);

  const target = questMap.get(questId);
  if (target?.conflicts) {
    for (const c of target.conflicts) {
      keep.add(c);
    }
  }

  for (const other of snap.quests) {
    if ((other.conflicts || []).includes(questId)) {
      keep.add(other.id);
    }
  }

  return Array.from(keep).filter((id) => questMap.has(id));
}

export function formatClock(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

export function formatAgo(ms: number | null | undefined): string {
  if (ms == null) return '';
  if (ms < 60000) return `${Math.round(ms / 1000)}秒`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}分`;
  return `${(ms / 3600000).toFixed(1)}时`;
}

export function formatMonthDay(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

export function isSafeReviewUrl(url: string | null | undefined): boolean {
  if (!url || typeof url !== 'string') return false;
  if (!url.startsWith('/review/')) return false;
  // Stricter than needed on purpose: any "..", backslash or encoded form of them is refused.
  try {
    const decoded = decodeURIComponent(url);
    return !decoded.includes('..') && !decoded.includes('\\');
  } catch {
    return false;
  }
}

