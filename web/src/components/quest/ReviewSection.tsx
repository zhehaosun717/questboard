import { useState } from 'react';
import { api } from '../../api/client';
import type { Quest, Snapshot } from '../../api/types';
import { boardAcceptanceDetail, parseVerdict, VERDICT_LABEL } from '../../lib/evidence';
import { acceptanceBy, STATUS } from '../../lib/labels';
import { isArchived, reviewsOf } from '../../lib/questState';
import { DrawerSection } from './DrawerSection';

interface ReviewSectionProps {
  quest: Quest;
  snap: Snapshot;
  draft: string;
  onDraftChange: (text: string) => void;
  onSelectQuest: (questId: string) => void;
  onAssignCard: (questId: string, cardId: string) => void;
  refresh: () => void;
  pushToast: (message: string) => void;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const REPORTED = new Set<Quest['status']>(['delivered', 'reviewing']);

// The controls for closing out returned work: accept, send back with a reason, or send a model to review it
// first (drag its card onto the quest, or pick one below — both open the same order). Code and tool work is
// the coordinator's to verify — but a board click is recorded as by=owner (src/server/questRoutes.js), so
// the accept note names the owner, never an assumed coordinator. Who *should* verify stays in the hints and
// column labels: expectation is not evidence. This is labelling, not access control — a local board has no
// login to fake.
export function ReviewSection({ quest, snap, draft, onDraftChange, onSelectQuest, onAssignCard, refresh, pushToast }: ReviewSectionProps) {
  const [busy, setBusy] = useState(false);
  const technical = acceptanceBy(quest.kind) === 'coordinator';
  const reviews = reviewsOf(snap, quest.id);
  const openReview = reviews.find((review) => !isArchived(review));
  const reviewers = openReview ? [] : snap.roster.filter((card) => snap.reviewEligibility?.[quest.id]?.[card.id]?.ok);

  const run = async (action: () => Promise<void>, failure: string) => {
    setBusy(true);
    try {
      await action();
    } catch (err) {
      pushToast(`${failure}：${errorText(err)}`);
    } finally {
      setBusy(false);
    }
  };

  // A decision on the work ends this round's reviews too, or they sit in 待验收 forever. A running review is
  // left alone. The report stays as the detail so its verdict remains readable afterwards.
  const closeReviews = async () => {
    for (const review of reviews) {
      if (isArchived(review) || review.status === 'dispatched') continue;
      await api.setQuestStatus(review.id, 'done', review.lastDetail ?? '');
    }
  };

  const accept = () => {
    if (!window.confirm(`${quest.id} 验收，标成已完成？`)) return;
    void run(async () => {
      const note = draft.trim();
      if (note) await api.rule(quest.id, `验收：${note}`);
      await api.setQuestStatus(quest.id, 'done', boardAcceptanceDetail(note));
      await closeReviews();
      onDraftChange('');
      pushToast(
        technical
          ? `${quest.id} 已验收：点的是你，记录写 owner；这类活的核验责任仍在 coordinator。`
          : `${quest.id} 已验收（owner）`,
      );
      refresh();
    }, '验收没成功');
  };

  const sendBack = () => {
    const reason = draft.trim();
    if (!reason) {
      pushToast('退回要写明哪里不对，下一个接手的冒险者要看');
      return;
    }
    if (!window.confirm(`把 ${quest.id} 退回委托板重做？`)) return;
    void run(async () => {
      await api.rule(quest.id, `退回重做：${reason}`);
      await api.setQuestStatus(quest.id, 'posted', `退回重做：${reason}`);
      await closeReviews();
      onDraftChange('');
      pushToast(`${quest.id} 已退回，回到委托板`);
      refresh();
    }, '退回没成功');
  };

  return (
    <DrawerSection en={technical ? 'TECHNICAL REVIEW' : 'SIGN-OFF'} zh={technical ? 'coordinator 核验' : '验收'}>
      <p className="hint owner-task-hint">
        {technical
          ? '这是技术活的交回档案：核验交回的东西、跑没跑过，归 coordinator，不用你在处理堆里等。下面的验收与退回本是 coordinator 的动作，由在管看板的人代按——按下去记录写的是 owner（点按钮的你），不是 coordinator。想先看一遍，把名册里的冒险者拖到这张委托上，或在下面挑一个——那只是请模型复核，不等于验收；能复核的亮绿，写过这份活的亮红。'
          : '先看下面的「证据」和「交回的东西」：没问题就验收；要改就写明哪里不对再退回。想先让模型复核，把名册里的冒险者拖到这张委托上——能复核的亮绿，写过这份活的亮红。'}
      </p>
      {reviews.length > 0 ? (
        <div className="review-links">
          {reviews.map((review) => {
            const reported = REPORTED.has(review.status) || isArchived(review);
            const verdict = parseVerdict(review.lastDetail ?? '');
            return (
              <div key={review.id} className="review-link">
                <div className="review-link-main">
                  <strong>{review.id}</strong>
                  <span className="review-link-status">{STATUS[review.status] ?? review.status}</span>
                  {reported ? (
                    <span className={`review-verdict review-verdict-${verdict}`}>复核{VERDICT_LABEL[verdict]}</span>
                  ) : null}
                  {reported && review.lastDetail ? (
                    <pre className="review-link-detail">{review.lastDetail}</pre>
                  ) : (
                    <div className="review-link-none">{reported ? '没有记录复核报告' : '还没有复核结论'}</div>
                  )}
                </div>
                <button className="btn" type="button" onClick={() => onSelectQuest(review.id)}>
                  打开
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
      {openReview ? null : (
        <details className="assign-details">
          <summary>
            {reviewers.length > 0 ? `也可以在这里挑冒险者复核（${reviewers.length} 个冒险者能复核）` : '现在没有能复核它的冒险者'}
          </summary>
          {reviewers.map((card) => (
            <div key={card.id} className="pick ok">
              <div>
                <strong>{card.name}</strong>
                <span className="a-model">模型 {card.model} · 接入方式 {card.lane}</span>
              </div>
              <button className="btn" type="button" onClick={() => onAssignCard(quest.id, card.id)}>
                派去复核
              </button>
            </div>
          ))}
        </details>
      )}
      <textarea
        rows={3}
        placeholder="验收备注（可不写）；退回时必须写原因"
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
      />
      <div className="row end">
        <button className="btn danger" type="button" disabled={busy} onClick={sendBack}>
          退回重做
        </button>
        <button className="btn primary" type="button" disabled={busy} onClick={accept}>
          验收
        </button>
      </div>
    </DrawerSection>
  );
}
