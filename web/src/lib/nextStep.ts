// What happens next for a quest, in one place: who it is waiting on, what to do, what that leads to, and
// which controls to show. The card shows the title; the dossier opens on the whole step with its controls.
// Every entry point used to decide this on its own, which is how "等我处理" came to mean three things.
import type { Quest, QuestKind, Snapshot } from '../api/types';
import { currentReviews, recordedAcceptor, reviewVerdictOf, verdictLabel, type ReviewVerdict } from './evidence';
import { t } from './i18n';
import { acceptanceBy, OPEN_STATUSES } from './labels';
import { hasEligibleCard, isArchived, isAwaitingSignOff, sharedRefusals } from './questState';

export type StepWho = 'you' | 'coordinator' | 'adventurer' | 'reviewer' | 'nobody';
export type StepTone = 'you' | 'coordinator' | 'working' | 'ready' | 'waiting' | 'done';
export type StepAction = 'assign' | 'owner-task' | 'sign-off' | 'release' | 'none';

export interface NextStep {
  who: StepWho;
  tone: StepTone;
  title: string;
  detail: string;
  action: StepAction;
  /** Another quest this step waits on or points to: an open review, or the work a review belongs to. */
  targetId?: string;
}

export const WHO_LABEL: Record<StepWho, string> = {
  get you() { return t('step.who.you'); },
  get coordinator() { return t('step.who.coordinator'); },
  get adventurer() { return t('step.who.adventurer'); },
  get reviewer() { return t('step.who.reviewer'); },
  get nobody() { return ''; },
};

const REPORTED = new Set<Quest['status']>(['delivered', 'reviewing']);

const SIGN_OFF_ADVICE: Record<ReviewVerdict, string> = {
  get pass() { return t('step.advice.pass'); },
  get findings() { return t('step.advice.findings'); },
  get fail() { return t('step.advice.fail'); },
  get unknown() { return t('step.advice.unknown'); },
};

/** A verdict only says a reviewer looked; it proves nothing about compiling, tests or acceptance. */
function verdictCaution(): string {
  return t('step.verdictCaution');
}

function cardName(snap: Snapshot, adventurerId: string, fallback: string): string {
  return snap.roster.find((card) => card.id === adventurerId)?.name ?? fallback;
}

/**
 * A review is judged on the work it reviews: its verdict is the coordinator's business when that work is
 * code or tool work, the owner's when it is art. No parent found means no answer found — said plainly.
 */
function reviewAcceptedBy(quest: Quest, snap: Snapshot): 'owner' | 'coordinator' | 'unknown' {
  const parentId = quest.parents[0];
  const parent = parentId ? snap.quests.find((q) => q.id === parentId) : undefined;
  return parent ? acceptanceBy(parent.kind) : 'unknown';
}

function archivedStep(quest: Quest): NextStep {
  if (quest.status === 'done') {
    const actor = recordedAcceptor(quest.lastDetail ?? '');
    let detail: string;
    if (quest.kind === 'owner') detail = t('step.archived.ownerDone');
    else if (actor === 'coordinator') detail = t('step.archived.coordinatorDone');
    else if (actor === 'unknown') detail = t('step.archived.unknownDone');
    else if (actor === 'owner') detail = t('step.archived.ownerAccepted');
    else detail = t('step.archived.notOnBoard');
    return { who: 'nobody', tone: 'done', title: t('step.archived.done'), detail, action: 'none' };
  }
  const title = quest.status === 'superseded' ? t('step.archived.superseded') : t('step.archived.cancelled');
  return { who: 'nobody', tone: 'waiting', title, detail: t('step.archived.notNeeded'), action: 'none' };
}

function signOffStep(quest: Quest, snap: Snapshot): NextStep {
  const technical = acceptanceBy(quest.kind) === 'coordinator';
  const reviews = currentReviews(quest, snap);
  const open = reviews.find((review) => !isArchived(review) && !REPORTED.has(review.status));
  if (open) {
    const detail = open.assignee
      ? t('step.reviewing', { name: cardName(snap, open.assignee.adventurerId, open.assignee.model) })
      : t('step.reviewUnassigned', { id: open.id });
    const tail = open.assignee
      ? technical ? t('step.reviewTail.coordinator') : t('step.reviewTail.owner')
      : '';
    return {
      who: 'reviewer', tone: 'working', title: t('step.reviewTitle', { id: open.id }),
      detail: `${detail}${tail}${technical ? t('step.reviewPickCaution.coordinator') : t('step.reviewPickCaution.owner')}`,
      action: 'sign-off', targetId: open.id,
    };
  }
  const reported = [...reviews].reverse().find((review) => REPORTED.has(review.status) || review.status === 'done');
  if (reported) {
    const info = reviewVerdictOf(reported);
    return technical
      ? {
        who: 'coordinator', tone: 'coordinator', title: t('step.coordinatorTitle', { verdict: verdictLabel(info) }),
        detail: t('step.coordinatorVerdictBack', { caution: verdictCaution() }), action: 'sign-off', targetId: reported.id,
      }
      : {
        who: 'you', tone: 'you', title: t('step.ownerTitle', { verdict: verdictLabel(info) }),
        detail: SIGN_OFF_ADVICE[info.verdict], action: 'sign-off', targetId: reported.id,
      };
  }
  return technical
    ? {
      who: 'coordinator', tone: 'coordinator', title: t('step.coordinatorWaitTitle'),
      detail: t('step.coordinatorWaitDetail'),
      action: 'sign-off',
    }
    : {
      who: 'you', tone: 'you', title: t('step.ownerWaitTitle'),
      detail: t('step.ownerWaitDetail'),
      action: 'sign-off',
    };
}

function deliveryNote(kind: QuestKind): string {
  if (kind === 'review') return t('step.delivery.review');
  return acceptanceBy(kind) === 'coordinator' ? t('step.delivery.coordinator') : t('step.delivery.owner');
}

function openStep(quest: Quest, snap: Snapshot): NextStep {
  if (hasEligibleCard(snap, quest.id)) {
    const count = Object.values(snap.eligibility[quest.id] ?? {}).filter((verdict) => verdict.ok).length;
    const again = quest.status === 'failed' ? t('step.open.failed') : quest.status === 'bounced' || quest.status === 'lane_limited' ? t('step.open.limited') : '';
    return {
      who: 'you', tone: 'ready', title: t('step.open.title', { count }),
      detail: t('step.open.detail', { again, delivery: deliveryNote(quest.kind) }), action: 'assign',
    };
  }
  const shared = sharedRefusals(snap, quest.id);
  const detail = shared.length > 0 ? shared.map((reason) => reason.message).join('；') : t('step.open.eachOwnReason');
  return { who: 'nobody', tone: 'waiting', title: t('step.open.titleBlocked'), detail, action: 'assign' };
}

export function nextStep(quest: Quest, snap: Snapshot): NextStep {
  if (isArchived(quest)) return archivedStep(quest);

  // An open question outranks the kind — even a returned review: whoever owns the quest asks, and the owner
  // answers. This is what keeps a technical verdict from swallowing a real question.
  if (quest.needsOwner.trim() || quest.status === 'needs_owner') {
    const question = quest.needsOwner.trim() || t('step.ownerQuestion');
    const after = quest.kind === 'owner' ? t('step.ownerQuestionAfter.owner') : t('step.ownerQuestionAfter.dispatch');
    return { who: 'you', tone: 'you', title: t('step.ownerQuestionTitle'), detail: `${question}——${after}`, action: 'owner-task' };
  }

  if (quest.kind === 'review' && REPORTED.has(quest.status)) {
    const title = t('step.reviewVerdictTitle', { verdict: verdictLabel(reviewVerdictOf(quest)) });
    const by = reviewAcceptedBy(quest, snap);
    const parentId = quest.parents[0];
    if (by === 'coordinator' && parentId) {
      return {
        who: 'coordinator', tone: 'coordinator', title,
        detail: t('step.reviewBack.coordinator', { parent: parentId }),
        action: 'none', targetId: parentId,
      };
    }
    if (by === 'unknown') {
      return {
        who: 'nobody', tone: 'waiting', title,
        detail: t('step.reviewBack.unknown', { reason: parentId ? t('step.reviewBack.unknownParentGone', { parent: parentId }) : t('step.reviewBack.unknownNoParent') }),
        action: 'none',
      };
    }
    // by === 'owner': the parent exists on the board (else it would be 'unknown'), and accepting art is
    // the owner's — the verdict is read and decided on the parent, never as a second request here.
    return { who: 'you', tone: 'you', title, detail: t('step.reviewBack.owner', { parent: parentId ?? '' }), action: 'none', targetId: parentId };
  }

  if (quest.kind === 'owner') {
    const detail = quest.rulings.length > 0
      ? t('step.ownerRuledDetail')
      : t('step.ownerTodoDetail');
    return { who: 'you', tone: 'you', title: t('step.ownerTodoTitle'), detail, action: 'owner-task' };
  }

  if (quest.status === 'owner_playtest') {
    return { who: 'you', tone: 'you', title: t('step.playtestTitle'), detail: t('step.playtestDetail'), action: 'owner-task' };
  }

  // FB2-02: both are coordinator holds — the send-back asked for it, or the owner's saved verdicts
  // wait to be imported. Neither is draggable (rules.js refuses and says why).
  if (quest.status === 'needs_coordinator') {
    return { who: 'coordinator', tone: 'coordinator', title: t('step.needsCoordinatorTitle'), detail: t('step.needsCoordinatorDetail'), action: 'none' };
  }
  if (quest.status === 'owner_ruled') {
    return { who: 'coordinator', tone: 'coordinator', title: t('step.ruledTitle'), detail: quest.kind === 'art' ? t('step.ruledArtDetail') : t('step.ruledDetail'), action: 'none' };
  }
  if (isAwaitingSignOff(quest)) return signOffStep(quest, snap);

  if (quest.status === 'dispatched') {
    const assignee = quest.assignee;
    if (!assignee) {
      return { who: 'nobody', tone: 'waiting', title: t('step.dispatchedNoRecordTitle'), detail: t('step.dispatchedNoRecordDetail'), action: 'none' };
    }
    const after = quest.kind === 'review'
      ? t('step.dispatchedReviewAfter')
      : acceptanceBy(quest.kind) === 'coordinator' ? t('step.dispatchedCoordinatorAfter') : t('step.dispatchedOwnerAfter');
    return {
      who: 'adventurer', tone: 'working', title: t('step.dispatchedTitle', { name: cardName(snap, assignee.adventurerId, assignee.model) }),
      detail: after, action: 'none',
    };
  }

  if (quest.status === 'stalled' && quest.assignee) {
    const name = cardName(snap, quest.assignee.adventurerId, quest.assignee.model);
    return {
      who: 'you', tone: 'you', title: t('step.stalledTitle'),
      detail: t('step.stalledDetail', { name, worker: quest.assignee.name }),
      action: 'release',
    };
  }

  if (OPEN_STATUSES.includes(quest.status)) return openStep(quest, snap);

  return { who: 'nobody', tone: 'waiting', title: t('step.noneTitle'), detail: t('step.noneDetail', { status: quest.status }), action: 'none' };
}
