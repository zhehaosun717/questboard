// Who has said a quest is done, at each level. Three different claims looked alike on the board: a worker
// saying it finished, a reviewer's verdict, and the owner's acceptance — plus the project-wide test run,
// which belongs to no single quest. Each rung names who said it.
import type { Quest, Snapshot } from '../api/types';
import { isAwaitingSignOff, reviewsOf } from './questState';

export type ReviewVerdict = 'pass' | 'findings' | 'fail' | 'unknown';

export const VERDICT_LABEL: Record<ReviewVerdict, string> = {
  pass: '通过',
  findings: '通过但有问题',
  fail: '不通过',
  unknown: '没写结论',
};

// The review brief asks the reviewer to end with `VERDICT: PASS | PASS WITH FINDINGS | FAIL`. Only a line
// holding a single verdict counts — an echoed template line lists all three and must not read as PASS —
// and the last such line wins.
const VERDICT_LINE = /^\s*VERDICT:\s*(PASS WITH FINDINGS|PASS|FAIL)\s*$/gim;

export function parseVerdict(report: string): ReviewVerdict {
  const matches = [...report.matchAll(VERDICT_LINE)];
  const last = matches[matches.length - 1]?.[1]?.toUpperCase();
  if (last === 'PASS WITH FINDINGS') return 'findings';
  if (last === 'PASS') return 'pass';
  if (last === 'FAIL') return 'fail';
  return 'unknown';
}

export type RungState = 'done' | 'pending' | 'skipped' | 'bad';

export interface Rung {
  key: 'claimed' | 'reviewed' | 'accepted';
  label: string;
  state: RungState;
  note: string;
}

const CLAIMED = new Set<Quest['status']>(['delivered', 'reviewing', 'done']);
const REPORTED = new Set<Quest['status']>(['delivered', 'reviewing', 'done']);

/**
 * Reviews count only for the current round: one posted before the latest dispatch judged earlier work.
 */
export function currentReviews(quest: Quest, snap: Snapshot): Quest[] {
  const since = quest.dispatches[quest.dispatches.length - 1]?.at ?? '';
  return reviewsOf(snap, quest.id).filter((review) => review.createdAt >= since);
}

function claimedRung(quest: Quest, snap: Snapshot): Rung {
  const last = quest.dispatches[quest.dispatches.length - 1];
  const base = { key: 'claimed' as const, label: '冒险者交回' };
  if (!last) return { ...base, state: 'skipped', note: '还没派过冒险者' };
  const who = snap.roster.find((card) => card.id === last.adventurerId)?.name ?? last.model;
  if (CLAIMED.has(quest.status)) return { ...base, state: 'done', note: `${who} 说做完了——它自己说的，不算核实` };
  if (quest.status === 'dispatched') return { ...base, state: 'pending', note: `${who} 还在做` };
  return { ...base, state: 'pending', note: '还没交回' };
}

function reviewedRung(quest: Quest, snap: Snapshot): Rung {
  const base = { key: 'reviewed' as const, label: '审核结论' };
  const reviews = currentReviews(quest, snap);
  const latest = reviews[reviews.length - 1];
  if (!latest) return { ...base, state: 'skipped', note: '没有派审核' };
  if (!REPORTED.has(latest.status)) {
    return { ...base, state: 'pending', note: latest.assignee ? `${latest.id} 审核中` : `${latest.id} 还没派出去` };
  }
  const verdict = parseVerdict(latest.lastDetail ?? '');
  const state: RungState = verdict === 'fail' ? 'bad' : verdict === 'unknown' ? 'pending' : 'done';
  return { ...base, state, note: `${latest.id}：审核${VERDICT_LABEL[verdict]}` };
}

function acceptedRung(quest: Quest): Rung {
  const base = { key: 'accepted' as const, label: '你验收' };
  if (quest.status === 'done') {
    const onBoard = (quest.lastDetail ?? '').includes('验收通过');
    return { ...base, state: 'done', note: onBoard ? '你在看板上验收通过' : '已标成完成，不是在看板上验收的' };
  }
  if (quest.status === 'superseded' || quest.status === 'cancelled') return { ...base, state: 'skipped', note: '委托已不再需要' };
  return { ...base, state: 'pending', note: isAwaitingSignOff(quest) ? '等你验收' : '还没到这一步' };
}

/** The three rungs for dispatched work. A 你来 quest has no worker, and a review is judged on its parent. */
export function evidenceFor(quest: Quest, snap: Snapshot): Rung[] {
  if (quest.kind === 'owner' || quest.kind === 'review') return [];
  return [claimedRung(quest, snap), reviewedRung(quest, snap), acceptedRung(quest)];
}
