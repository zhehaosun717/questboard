import { useState } from 'react';
import { api } from '../../api/client';
import type { Quest, Snapshot } from '../../api/types';
import { parseVerdict, VERDICT_LABEL } from '../../lib/evidence';
import { STATUS } from '../../lib/labels';
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

// The controls for signing off returned work: accept, send back with a reason, or send a model to review it
// first (drag its card onto the quest, or pick one below — both open the same order).
export function ReviewSection({ quest, snap, draft, onDraftChange, onSelectQuest, onAssignCard, refresh, pushToast }: ReviewSectionProps) {
  const [busy, setBusy] = useState(false);
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
    if (!window.confirm(`${quest.id} 验收通过，标成已完成？`)) return;
    void run(async () => {
      const note = draft.trim();
      if (note) await api.rule(quest.id, `验收通过：${note}`);
      await api.setQuestStatus(quest.id, 'done', note ? `owner 验收通过：${note}` : 'owner 验收通过');
      await closeReviews();
      onDraftChange('');
      pushToast(`${quest.id} 已验收`);
      refresh();
    }, '验收没成功');
  };

  const sendBack = () => {
    const reason = draft.trim();
    if (!reason) {
      pushToast('打回要写明哪里不对，下一个接手的冒险者要看');
      return;
    }
    if (!window.confirm(`把 ${quest.id} 打回悬赏中重做？`)) return;
    void run(async () => {
      await api.rule(quest.id, `打回重做：${reason}`);
      await api.setQuestStatus(quest.id, 'posted', `打回重做：${reason}`);
      await closeReviews();
      onDraftChange('');
      pushToast(`${quest.id} 已打回，回到悬赏中`);
      refresh();
    }, '打回没成功');
  };

  return (
    <DrawerSection en="SIGN-OFF" zh="验收">
      <p className="hint owner-task-hint">
        先看下面的「证据」和「交回的东西」：没问题就验收通过；要改就写明哪里不对再打回。想先让模型审，把名册里的工牌拖到这张委托上——能审的亮绿，写过这份活的亮红。
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
                    <span className={`review-verdict review-verdict-${verdict}`}>审核{VERDICT_LABEL[verdict]}</span>
                  ) : null}
                  {reported && review.lastDetail ? (
                    <pre className="review-link-detail">{review.lastDetail}</pre>
                  ) : (
                    <div className="review-link-none">{reported ? '没有记录审核报告' : '还没有审核结论'}</div>
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
            {reviewers.length > 0 ? `也可以在这里挑冒险者审核（${reviewers.length} 张工牌能审）` : '现在没有能审核它的工牌'}
          </summary>
          {reviewers.map((card) => (
            <div key={card.id} className="pick ok">
              <div>
                <strong>{card.name}</strong>
                <span className="a-model">模型 {card.model} · 通道 {card.lane}</span>
              </div>
              <button className="btn" type="button" onClick={() => onAssignCard(quest.id, card.id)}>
                派去审核
              </button>
            </div>
          ))}
        </details>
      )}
      <textarea
        rows={3}
        placeholder="验收备注（可不写）；打回时必须写原因"
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
      />
      <div className="row end">
        <button className="btn danger" type="button" disabled={busy} onClick={sendBack}>
          打回重做
        </button>
        <button className="btn primary" type="button" disabled={busy} onClick={accept}>
          验收通过
        </button>
      </div>
    </DrawerSection>
  );
}
