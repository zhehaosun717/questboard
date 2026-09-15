import type { Verdict } from '../api/types';
import { isQueueOnly } from './board';

export interface DropVerdictInfo {
  /** Class names applied to the quest node/pin, matching the board wall's drop-ok/drop-queue/drop-no rule. */
  cls: string;
  /** The reason text to show before the drop: an accept hint, or the first refusal reason. Never blank. */
  message: string;
}

/**
 * The same verdict-to-class-and-text rule the board wall uses (QuestCard), so a drag over the map reads the
 * same as a drag over a card: queue-only reads as a refusal here too, since neither one opens a work order.
 */
export function dropVerdictInfo(verdict: Verdict | undefined, isOpen: boolean, isReview: boolean): DropVerdictInfo {
  if (verdict?.ok) {
    return { cls: 'drop-ok ok', message: isReview ? '放下：派去复核' : '放下：派去做' };
  }
  const isQueue = isOpen && isQueueOnly(verdict);
  const cls = isQueue ? 'drop-queue queue' : 'drop-no refused drop-refused';
  const reasons = verdict?.reasons ?? [];
  let message: string;
  if (reasons.length === 0) {
    message = '✗ 没有记录';
  } else {
    const firstReason = reasons[0];
    const extraCount = reasons.length - 1;
    message = `✗ ${firstReason?.message ?? '没有记录'}${extraCount > 0 ? `（还有 ${extraCount} 条）` : ''}`;
  }
  return { cls, message };
}

/** Only a fully accepted drop opens a paid work order: refused and queue-only both stop at the reason text. */
export function canOpenWorkOrder(verdict: Verdict | undefined): boolean {
  return Boolean(verdict?.ok);
}

/**
 * The HTML drag cursor for the quest currently under the pointer: 'none' (no-drop) over a quest that would
 * refuse the drop or only queue it, since neither opens a work order; 'move' everywhere else, including empty
 * canvas, where a drop always succeeds by placing the model there.
 */
export function dropEffectFor(hover: DropVerdictInfo | null): 'move' | 'none' {
  return hover && !hover.cls.includes('drop-ok') ? 'none' : 'move';
}
