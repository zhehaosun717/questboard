import type { Quest, Snapshot } from '../api/types';
import { currentReviews, reviewVerdictOf } from './evidence';

export type QuestRank = 'S' | 'A' | 'B';

/**
 * Priority medallion rank:
 * 1 → S (wax red), 2 → A, 3 → B. Defaults to A (priority 2).
 */
export function rankOf(priority?: number): QuestRank {
  if (priority !== undefined && priority <= 1) return 'S';
  if (priority !== undefined && priority >= 3) return 'B';
  return 'A';
}

export type ReviewSealVerdict = 'pass' | 'findings' | 'fail';

export interface QuestSeal {
  verdict: ReviewSealVerdict;
  text: string;
  line1: string;
  line2: string;
}

const REPORTED_STATUSES = new Set<Quest['status']>(['delivered', 'reviewing', 'done']);

const SEAL_MAP: Record<ReviewSealVerdict, { text: string; line1: string; line2: string }> = {
  pass: { text: '复核通过', line1: '复核', line2: '通过' },
  findings: { text: '复核有问题', line1: '复核', line2: '有问题' },
  fail: { text: '复核没过', line1: '复核', line2: '没过' },
};

/**
 * Wax seal for a quest returning from a worker with a reported review.
 * Only shown when the latest reported review for this round has a verdict.
 */
export function sealFor(quest: Quest, snap: Snapshot): QuestSeal | null {
  const reviews = currentReviews(quest, snap);
  const latest = reviews[reviews.length - 1];
  if (!latest) return null;
  if (!REPORTED_STATUSES.has(latest.status)) return null;

  // A verified report wins here too (item 34/12 consistency): a truncated or `.out`-sourced report is
  // 'unknown' at capture time, so it never reaches this seal as a false 复核通过. The seal has no room to
  // carry a 未经核验 label (R2-1), so a tail-derived guess never seals at all — verified or nothing.
  const { verdict, verified } = reviewVerdictOf(latest);
  if (!verified) return null;
  if (verdict === 'pass' || verdict === 'findings' || verdict === 'fail') {
    return {
      verdict,
      ...SEAL_MAP[verdict],
    };
  }
  return null;
}
