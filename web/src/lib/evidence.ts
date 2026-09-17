// Who has said a quest is done, at each level. Three different claims looked alike on the board: a worker
// saying it finished, a reviewer's verdict, and the acceptance — plus the project-wide test run, which
// belongs to no single quest. Each rung names who said it, and who is expected to say it: returned code and
// tools wait on the coordinator's technical review, art and 你来 work wait on the owner. Nothing here
// guesses an actor from a status: an unrecorded acceptance says it is unrecorded.
import type { AcceptanceEvidenceRef, Quest, ReportSource, Snapshot } from '../api/types';
import { isAwaitingSignOff, reviewsOf } from './questState';
import { acceptanceBy } from './labels';
import { t } from './i18n';

export type ReviewVerdict = 'pass' | 'findings' | 'fail' | 'unknown';

export const VERDICT_LABEL: Record<ReviewVerdict, string> = {
  get pass() { return t('evidence.verdict.pass'); },
  get findings() { return t('evidence.verdict.findings'); },
  get fail() { return t('evidence.verdict.fail'); },
  get unknown() { return t('evidence.verdict.unknown'); },
};

// Where a review's own captured report came from (src/core/reportEvidence.js ReportSource), shown next to
// its verdict wherever that verdict appears. Shared so the wording cannot drift between surfaces.
export const REPORT_SOURCE_LABEL: Record<ReportSource, string> = {
  get delivery() { return t('evidence.source.delivery'); },
  get 'exit-file'() { return t('evidence.source.exitFile'); },
  get summary() { return t('evidence.source.summary'); },
};

// The label every surface must show beside a raw, unverified `lastDetail` tail (M5/N1 — item 2 & 6): never
// printed bare next to a verdict, since it can hold an echoed review template or a mid-word cut that would
// otherwise read as if it were evidence for whatever verdict sits next to it — most sharply wrong right
// beside a verified 结论未识别, which this label now always accompanies. Shared so QuestReceipt's own tail
// block and the review row's cannot drift apart.
export function RAW_TAIL_LABEL(): string {
  return t('evidence.rawTailLabel');
}

// The review brief asks the reviewer to end with `VERDICT: PASS | PASS WITH FINDINGS | FAIL`. Only a line
// holding a single verdict counts — an echoed template line lists all three and must not read as PASS —
// and the last such line wins. Case-sensitive on purpose (item 3/N3): the backend's own extractVerdict
// (src/core/reportEvidence.js VERDICT_RE) only ever recognises the exact uppercase token, so a lowercase or
// mixed-case "verdict: pass" is not a genuine verdict line there either — this fallback must agree, or a
// review with no captured report could read a verdict here that the backend would call 'unknown'.
const VERDICT_LINE = /^\s*VERDICT:\s*(PASS WITH FINDINGS|PASS|FAIL)\s*$/gm;

export function parseVerdict(report: string): ReviewVerdict {
  const matches = [...report.matchAll(VERDICT_LINE)];
  const last = matches[matches.length - 1]?.[1];
  if (last === 'PASS WITH FINDINGS') return 'findings';
  if (last === 'PASS') return 'pass';
  if (last === 'FAIL') return 'fail';
  return 'unknown';
}

export interface ReviewVerdictInfo {
  verdict: ReviewVerdict;
  // true when this came from the review's own verified report (src/core/reportEvidence.js: a final report
  // read in full, never a truncated read or a `.out` transcript). false means a tail-parsed guess.
  verified: boolean;
  // Only ever set on a verified 'unknown' (the backend's reason a truncated/summary read gives no verdict).
  reason?: string;
}

/**
 * The one place a review quest's verdict is decided (item 12/34): a verified report wins when the review has
 * one — it is already gated at capture time, so a truncated or `.out`-sourced report is 'unknown' here too,
 * never a guessed PASS. Only a review with no captured report at all falls back to a tail parse, and that
 * fallback is always reported unverified so every surface that shows it can label it 未经核验.
 */
export function reviewVerdictOf(review: Quest): ReviewVerdictInfo {
  const report = review.report;
  if (report) {
    const verdict: ReviewVerdict =
      report.verdict === 'PASS' ? 'pass' : report.verdict === 'FAIL' ? 'fail' : report.verdict === 'findings' ? 'findings' : 'unknown';
    return { verdict, verified: true, ...(report.verdictReason ? { reason: report.verdictReason } : {}) };
  }
  return { verdict: parseVerdict(review.lastDetail ?? ''), verified: false };
}

/**
 * The Chinese verdict word, with an honest 未经核验 tag appended whenever it is not from a verified report.
 * A verified 'unknown' (a truncated read, a `.out` transcript, or a report with no recognisable VERDICT line)
 * reads 结论未识别 instead of the tail-parse fallback's 没写结论 (R2-2) — "没写结论" claims the reviewer wrote
 * nothing, which is untrue for a report the board could not finish reading or could not read a verdict out of.
 */
export function verdictLabel(info: ReviewVerdictInfo): string {
  if (!info.verified) return `${VERDICT_LABEL[info.verdict]}${t('evidence.verdict.unverifiedSuffix')}`;
  if (info.verdict === 'unknown') return t('evidence.verdict.unknownVerified');
  return VERDICT_LABEL[info.verdict];
}

export type RungState = 'done' | 'pending' | 'skipped' | 'bad';

export interface Rung {
  key: 'claimed' | 'reviewed' | 'accepted';
  label: string;
  state: RungState;
  note: string;
  // Feedback 15: present only on the accepted rung of a quest with a structured acceptance record — the
  // evidence items it named, for a short "kind + digest" display (EvidenceLadder.tsx).
  refs?: AcceptanceEvidenceRef[];
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
  const base = { key: 'claimed' as const, label: t('rung.claimed') };
  if (!last) return { ...base, state: 'skipped', note: t('rung.notDispatched') };
  // A dispatch row without a resolvable card is reported as unknown, never dressed up as a known worker.
  const who = snap.roster.find((card) => card.id === last.adventurerId)?.name ?? (last.model.trim() || t('rung.noWorkerName'));
  const named = snap.roster.some((card) => card.id === last.adventurerId) || last.model.trim() !== '';
  if (CLAIMED.has(quest.status)) return { ...base, state: 'done', note: named ? t('rung.claimedDone', { who }) : t('rung.claimedUnknown') };
  if (quest.status === 'dispatched') return { ...base, state: 'pending', note: named ? t('rung.claimedWorking', { who }) : t('rung.claimedWorkingUnknown') };
  return { ...base, state: 'pending', note: t('rung.notHandedIn') };
}

function reviewedRung(quest: Quest, snap: Snapshot): Rung {
  const base = { key: 'reviewed' as const, label: t('rung.reviewed') };
  const reviews = currentReviews(quest, snap);
  const latest = reviews[reviews.length - 1];
  if (!latest) return { ...base, state: 'skipped', note: t('rung.noReview') };
  if (!REPORTED.has(latest.status)) {
    return { ...base, state: 'pending', note: latest.assignee ? t('rung.reviewing', { id: latest.id }) : t('rung.reviewNotDispatched', { id: latest.id }) };
  }
  const info = reviewVerdictOf(latest);
  const state: RungState = info.verdict === 'fail' ? 'bad' : info.verdict === 'unknown' ? 'pending' : 'done';
  return { ...base, state, note: t('rung.reviewedNote', { id: latest.id, verdict: verdictLabel(info) }) };
}

/**
 * Did this acceptance note come from the board? Anchored like recordedAcceptor: only a note that *begins*
 * with an acceptance wording counts. A report or ruling that merely quotes one must not look like a board
 * acceptance — the ladder and the 已验收 mark follow the record, never a substring search.
 */
export function acceptedOnBoard(detail: string): boolean {
  return recordedAcceptor(detail) !== null;
}

/**
 * Who the acceptance note actually records — 'unknown' when it says 验收 without naming anyone. Never
 * inferred, and never found by a loose substring: a coordinator note that quotes "owner 验收" inside a
 * sentence must not read as the owner having accepted. The acceptance wording has to head the note.
 */
export function recordedAcceptor(detail: string): 'owner' | 'coordinator' | 'unknown' | null {
  const head = detail.trimStart();
  if (head.startsWith('owner 验收')) return 'owner';
  if (head.startsWith('coordinator 验收')) return 'coordinator';
  if (head.startsWith('验收通过')) return 'unknown';
  return null;
}

/**
 * The honest note the board writes when someone clicks 验收. This board has no login: the server records
 * every board click as by=owner (src/server/questRoutes.js), so the note says owner whatever the kind —
 * even for code and tool work, where verifying is the coordinator's expected job. Expected responsibility
 * is shown by the hints, not written into the evidence as an actor who never clicked.
 */
export function boardAcceptanceDetail(note: string): string {
  const trimmed = note.trim();
  return trimmed ? `owner 验收：${trimmed}` : 'owner 验收';
}

function acceptedRung(quest: Quest): Rung {
  const by = acceptanceBy(quest.kind);
  const base = { key: 'accepted' as const, label: by === 'coordinator' ? t('rung.accepted.coordinator') : t('rung.accepted.you') };
  if (quest.status === 'done') {
    // Feedback 15: a structured acceptance record is authoritative — actor and the evidence it named, never
    // guessed from the note text. A done quest from before this field existed (or an older server) has none
    // and falls back to the legacy text-sniffed actor below.
    const record = quest.acceptance;
    if (record) {
      const label = record.actor === 'owner' ? 'owner 验收' : 'coordinator 验收';
      const mismatch = record.actor === 'owner' && by === 'coordinator'
        ? t('rung.mismatch.coordinator')
        : record.actor === 'coordinator' && by === 'owner'
          ? t('rung.mismatch.owner')
          : '';
      return { ...base, label, state: 'done', note: `${label}${mismatch}`, ...(record.evidenceRefs.length ? { refs: record.evidenceRefs } : {}) };
    }
    const actor = recordedAcceptor(quest.lastDetail ?? '');
    // A completed quest is labelled by who the record actually names. An owner clicking 验收 on technical
    // work stays the owner's click — the rung must not quietly hand the coordinator credit for it.
    if (actor === 'owner') {
      return { ...base, label: 'owner 验收', state: 'done', note: by === 'coordinator' ? t('rung.ownerBoardAccept.technical') : t('rung.ownerBoardAccept') };
    }
    if (actor === 'coordinator') {
      return { ...base, label: 'coordinator 验收', state: 'done', note: by === 'coordinator' ? t('rung.coordinatorBoardAccept') : t('rung.coordinatorBoardAccept.mismatch') };
    }
    const note = actor === 'unknown' ? t('rung.acceptedUnknownActor') : t('rung.doneNotOnBoard');
    return { ...base, label: actor === 'unknown' ? t('rung.acceptedUnknownLabel') : base.label, state: 'done', note };
  }
  if (quest.status === 'superseded' || quest.status === 'cancelled') return { ...base, state: 'skipped', note: t('rung.superseded') };
  const waiting = by === 'coordinator' ? t('rung.waitCoordinator') : t('rung.waitYou');
  return { ...base, state: 'pending', note: isAwaitingSignOff(quest) ? waiting : t('rung.notThereYet') };
}

/** The three rungs for dispatched work. A 你来 quest has no worker, and a review is judged on its parent. */
export function evidenceFor(quest: Quest, snap: Snapshot): Rung[] {
  if (quest.kind === 'owner' || quest.kind === 'review') return [];
  return [claimedRung(quest, snap), reviewedRung(quest, snap), acceptedRung(quest)];
}
