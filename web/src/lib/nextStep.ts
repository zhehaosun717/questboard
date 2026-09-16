// What happens next for a quest, in one place: who it is waiting on, what to do, what that leads to, and
// which controls to show. The card shows the title; the dossier opens on the whole step with its controls.
// Every entry point used to decide this on its own, which is how "等我处理" came to mean three things.
import type { Quest, QuestKind, Snapshot } from '../api/types';
import { currentReviews, recordedAcceptor, reviewVerdictOf, verdictLabel, type ReviewVerdict } from './evidence';
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
  you: '等你', coordinator: '等 coordinator', adventurer: '等冒险者', reviewer: '等复核的冒险者', nobody: '',
};

const REPORTED = new Set<Quest['status']>(['delivered', 'reviewing']);

const SIGN_OFF_ADVICE: Record<ReviewVerdict, string> = {
  pass: '复核的冒险者认为通过。看一眼交回的东西，就可以验收。',
  findings: '复核通过，但列了问题。看完决定验收还是退回。',
  fail: '复核的冒险者认为不通过。看完结论，多半要退回重做。',
  unknown: '复核报告里没写结论，自己看报告再定。',
};

/** A verdict only says a reviewer looked; it proves nothing about compiling, tests or acceptance. */
const VERDICT_CAUTION = '复核只是复核者的意见，不代表编译或测试跑过，也不算验收。';

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
    if (quest.kind === 'owner') detail = '你做完了。';
    else if (actor === 'coordinator') detail = 'coordinator 在看板上验收了。';
    else if (actor === 'unknown') detail = '在看板上验收了，但记录没写是谁。';
    else if (actor === 'owner') detail = '你在看板上验收了。';
    else detail = '已标成完成（不是在看板上验收的）。';
    return { who: 'nobody', tone: 'done', title: '已完成', detail, action: 'none' };
  }
  const title = quest.status === 'superseded' ? '已被取代' : '已取消';
  return { who: 'nobody', tone: 'waiting', title, detail: '这个委托不再需要做。', action: 'none' };
}

function signOffStep(quest: Quest, snap: Snapshot): NextStep {
  const technical = acceptanceBy(quest.kind) === 'coordinator';
  const reviews = currentReviews(quest, snap);
  const open = reviews.find((review) => !isArchived(review) && !REPORTED.has(review.status));
  if (open) {
    const detail = open.assignee
      ? `${cardName(snap, open.assignee.adventurerId, open.assignee.model)} 正在复核，`
      : `复核委托 ${open.id} 还没派出去，打开它派一个冒险者。`;
    const tail = open.assignee
      ? technical ? '结论回来后由 coordinator 核验处理。' : '结论回来后这里等你验收。'
      : '';
    return {
      who: 'reviewer', tone: 'working', title: `等复核的冒险者：${open.id}`,
      detail: `${detail}${tail}${technical ? '挑复核模型只是请它看一遍，不等于验收。' : '你也可以不等，直接验收或退回。'}`,
      action: 'sign-off', targetId: open.id,
    };
  }
  const reported = [...reviews].reverse().find((review) => REPORTED.has(review.status) || review.status === 'done');
  if (reported) {
    const info = reviewVerdictOf(reported);
    return technical
      ? {
        who: 'coordinator', tone: 'coordinator', title: `等 coordinator 验收 · 复核${verdictLabel(info)}`,
        detail: `复核结论已回，由 coordinator 核验后验收或退回。${VERDICT_CAUTION}`, action: 'sign-off', targetId: reported.id,
      }
      : {
        who: 'you', tone: 'you', title: `等你验收 · 复核${verdictLabel(info)}`,
        detail: SIGN_OFF_ADVICE[info.verdict], action: 'sign-off', targetId: reported.id,
      };
  }
  return technical
    ? {
      who: 'coordinator', tone: 'coordinator', title: '等 coordinator 核验',
      detail: '冒险者说做完了，还没人核实。代码和工具的核验归 coordinator：查交回的东西、跑测试，再验收或退回。要模型复核，把名册里的冒险者拖到这张委托上（那只是选复核者，不是验收）。',
      action: 'sign-off',
    }
    : {
      who: 'you', tone: 'you', title: '等你验收',
      detail: '冒险者说做完了，还没人核实。看完交回的东西，验收或退回；想先让模型复核，把冒险者拖到这张委托上。',
      action: 'sign-off',
    };
}

function deliveryNote(kind: QuestKind): string {
  if (kind === 'review') return '做完会把结论记回它复核的委托。';
  return acceptanceBy(kind) === 'coordinator' ? '做完会交差，由 coordinator 核验，不用你验收。' : '做完会交差等你验收。';
}

function openStep(quest: Quest, snap: Snapshot): NextStep {
  if (hasEligibleCard(snap, quest.id)) {
    const count = Object.values(snap.eligibility[quest.id] ?? {}).filter((verdict) => verdict.ok).length;
    const again = quest.status === 'failed' ? '上次失败了。' : quest.status === 'bounced' || quest.status === 'lane_limited' ? '上次被限额退回。' : '';
    return {
      who: 'you', tone: 'ready', title: `可以派 · ${count} 个冒险者能接`,
      detail: `${again}把名册里的冒险者拖到这张委托上派它去做，${deliveryNote(quest.kind)}`, action: 'assign',
    };
  }
  const shared = sharedRefusals(snap, quest.id);
  const detail = shared.length > 0 ? shared.map((reason) => reason.message).join('；') : '每个冒险者各有原因，打开看。';
  return { who: 'nobody', tone: 'waiting', title: '暂时派不了', detail, action: 'assign' };
}

export function nextStep(quest: Quest, snap: Snapshot): NextStep {
  if (isArchived(quest)) return archivedStep(quest);

  // An open question outranks the kind — even a returned review: whoever owns the quest asks, and the owner
  // answers. This is what keeps a technical verdict from swallowing a real question.
  if (quest.needsOwner.trim() || quest.status === 'needs_owner') {
    const question = quest.needsOwner.trim() || '有一个问题等你拍板。';
    const after = quest.kind === 'owner' ? '拍板后写下决定，做完点「做完了」。' : '拍板后委托回到委托板，可以派冒险者。';
    return { who: 'you', tone: 'you', title: '等你拍板', detail: `${question}——${after}`, action: 'owner-task' };
  }

  if (quest.kind === 'review' && REPORTED.has(quest.status)) {
    const title = `复核结论：${verdictLabel(reviewVerdictOf(quest))}`;
    const by = reviewAcceptedBy(quest, snap);
    const parentId = quest.parents[0];
    if (by === 'coordinator' && parentId) {
      return {
        who: 'coordinator', tone: 'coordinator', title,
        detail: `复核报告交回来了。${parentId} 是技术活，核验和处置归 coordinator，不用你验收；结论就在报告里。`,
        action: 'none', targetId: parentId,
      };
    }
    if (by === 'unknown') {
      return {
        who: 'nobody', tone: 'waiting', title,
        detail: `复核报告交回来了，但${parentId ? `它复核的 ${parentId} 不在看板上` : '没记录它复核哪个委托'}，说不准该谁处理，找 coordinator 核实。`,
        action: 'none',
      };
    }
    // by === 'owner': the parent exists on the board (else it would be 'unknown'), and accepting art is
    // the owner's — the verdict is read and decided on the parent, never as a second request here.
    return { who: 'you', tone: 'you', title, detail: `复核报告交回来了。去 ${parentId} 看结论，决定验收还是退回。`, action: 'none', targetId: parentId };
  }

  if (quest.kind === 'owner') {
    const detail = quest.rulings.length > 0
      ? '你已经做过决定。没别的事就点「做完了」，委托标成已完成。'
      : '这件事不派给冒险者。想好写下来，做完点「做完了」，委托标成已完成。';
    return { who: 'you', tone: 'you', title: '等你亲自做', detail, action: 'owner-task' };
  }

  if (quest.status === 'owner_playtest') {
    return { who: 'you', tone: 'you', title: '等你试玩', detail: '试玩后把结论写下来，会记进裁决记录。', action: 'owner-task' };
  }

  if (isAwaitingSignOff(quest)) return signOffStep(quest, snap);

  if (quest.status === 'dispatched') {
    const assignee = quest.assignee;
    if (!assignee) {
      return { who: 'nobody', tone: 'waiting', title: '进行中，但没记录冒险者', detail: '看板对不上这个委托，找 coordinator 核实。', action: 'none' };
    }
    const after = quest.kind === 'review'
      ? '做完会自动交差，结论记回它复核的委托。'
      : acceptanceBy(quest.kind) === 'coordinator' ? '做完会自动交差，进入 coordinator 核验。' : '做完会自动交差，等你验收。';
    return {
      who: 'adventurer', tone: 'working', title: `${cardName(snap, assignee.adventurerId, assignee.model)} 在做`,
      detail: after, action: 'none',
    };
  }

  if (quest.status === 'stalled' && quest.assignee) {
    const name = cardName(snap, quest.assignee.adventurerId, quest.assignee.model);
    return {
      who: 'you', tone: 'you', title: '等你确认：冒险者没动静',
      detail: `${name}（编号 ${quest.assignee.name}）很久没输出，可能还在跑。确认它停了再释放，释放后才能重新派。`,
      action: 'release',
    };
  }

  if (OPEN_STATUSES.includes(quest.status)) return openStep(quest, snap);

  return { who: 'nobody', tone: 'waiting', title: '没有下一步', detail: `状态是「${quest.status}」，看板不知道接下来该谁做。`, action: 'none' };
}
