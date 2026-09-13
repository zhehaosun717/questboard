import type { Card, Quest, Snapshot, Verdict } from '../api/types';
import { CARD_STATUS, type Column } from './labels';

export function questsInColumn(snap: Snapshot, column: Column): Quest[] {
  return snap.quests
    .filter((q) => column.statuses.includes(q.status))
    .sort((a, b) => (column.limit ? 0 : (a.priority || 2) - (b.priority || 2)) || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, column.limit || Infinity);
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

