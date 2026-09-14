import { useState } from 'react';
import { api } from '../../api/client';
import type { Quest, Snapshot } from '../../api/types';
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

// Returned work: accept it, send it back with a reason, or have a model review it first. Sending a model to
// review works like any dispatch — drag its card onto this quest, or pick it below — and opens the same order.
// A review's verdict is shown here, and the owner still decides.
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

  const accept = () => {
    if (!window.confirm(`${quest.id} 验收通过，标成已完成？`)) return;
    void run(async () => {
      const note = draft.trim();
      if (note) await api.rule(quest.id, `验收通过：${note}`);
      await api.setQuestStatus(quest.id, 'done', note ? `owner 验收通过：${note}` : 'owner 验收通过');
      onDraftChange('');
      pushToast(`${quest.id} 已验收`);
      refresh();
    }, '验收没成功');
  };

  const sendBack = () => {
    const reason = draft.trim();
    if (!reason) {
      pushToast('打回要写明哪里不对，下一个接手的人要看');
      return;
    }
    if (!window.confirm(`把 ${quest.id} 打回悬赏中重做？`)) return;
    void run(async () => {
      await api.rule(quest.id, `打回重做：${reason}`);
      await api.setQuestStatus(quest.id, 'posted', `打回重做：${reason}`);
      onDraftChange('');
      pushToast(`${quest.id} 已打回，回到悬赏中`);
      refresh();
    }, '打回没成功');
  };

  return (
    <DrawerSection en="SIGN-OFF" zh="验收">
      <p className="hint owner-task-hint">
        看完上面的交付回执：没问题就验收通过；要改就写明哪里不对再打回。想让模型先审一遍，就把名册里的工牌拖到这张委托上——能审的会亮绿，写过这份活的模型会亮红。
      </p>
      {reviews.length > 0 ? (
        <div className="review-links">
          {reviews.map((review) => (
            <div key={review.id} className="review-link">
              <div className="review-link-main">
                <strong>{review.id}</strong>
                <span className="review-link-status">{STATUS[review.status] ?? review.status}</span>
                {review.status === 'delivered' || isArchived(review) ? (
                  review.lastDetail ? (
                    <pre className="review-link-detail">{review.lastDetail}</pre>
                  ) : (
                    <div className="review-link-none">没有记录审核结论</div>
                  )
                ) : (
                  <div className="review-link-none">还没有审核结论</div>
                )}
              </div>
              <button className="btn" type="button" onClick={() => onSelectQuest(review.id)}>
                打开
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {openReview ? null : (
        <details className="assign-details">
          <summary>
            {reviewers.length > 0 ? `也可以在这里挑模型审核（${reviewers.length} 张工牌能审）` : '现在没有能审核它的工牌'}
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
