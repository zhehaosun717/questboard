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
  refresh: () => void;
  pushToast: (message: string) => void;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Returned work: accept it, send it back with a reason, or have a model review it first. A model review is
// its own review quest (the board writes its brief); choosing the model happens on that quest, where the
// rules already keep the work's author off it. Its verdict is shown here, and the owner still decides.
export function ReviewSection({ quest, snap, draft, onDraftChange, onSelectQuest, refresh, pushToast }: ReviewSectionProps) {
  const [busy, setBusy] = useState(false);
  const reviews = reviewsOf(snap, quest.id);
  const openReview = reviews.find((review) => !isArchived(review));

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

  const requestReview = () => {
    void run(async () => {
      const { review } = await api.requestReview(quest.id, draft.trim());
      onDraftChange('');
      pushToast(`已发布审核委托 ${review.id}，给它选一个模型派出去`);
      refresh();
      onSelectQuest(review.id);
    }, '派模型审核没成功');
  };

  return (
    <DrawerSection en="SIGN-OFF" zh="验收">
      <p className="hint owner-task-hint">
        看完上面的交付回执：没问题就验收通过；要改就写明哪里不对再打回；想让模型先审一遍就派模型审核（写过这份活的模型不会被派去审它）。
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
      <textarea
        rows={3}
        placeholder="验收备注（可不写）；打回时必须写原因；派模型审核时会写进审核简报"
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
      />
      <div className="row end">
        {openReview ? null : (
          <button
            className="btn"
            type="button"
            disabled={busy}
            title="写一份审核简报、发布审核委托，再给它选模型"
            onClick={requestReview}
          >
            派模型审核
          </button>
        )}
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
