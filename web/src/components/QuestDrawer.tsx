import { api } from '../api/client';
import type { Quest, Snapshot } from '../api/types';
import { formatAgo, formatClock, isSafeReviewUrl, relatedQuestIds } from '../lib/board';
import { KIND, STATUS } from '../lib/labels';
import { getQuestFlowKey, isArchived, isAwaitingSignOff } from '../lib/questState';
import { AssignSection } from './quest/AssignSection';
import { ReviewSection } from './quest/ReviewSection';
import { DrawerSection } from './quest/DrawerSection';
import { OwnerTaskSection } from './quest/OwnerTaskSection';
import { GraphView } from './GraphView';
import { QuestReceipt } from './quest/QuestReceipt';

export interface QuestDrawerProps {
  quest: Quest;
  snap: Snapshot;
  draft: string;
  onDraftChange: (text: string) => void;
  onClose: () => void;
  onSelectQuest: (questId: string) => void;
  onAssignCard: (questId: string, cardId: string) => void;
  refresh: () => void;
  pushToast: (message: string) => void;
  setDragging: (dragging: boolean) => void;
}

export function QuestDrawer({
  quest,
  snap,
  draft,
  onDraftChange,
  onClose,
  onSelectQuest,
  onAssignCard,
  refresh,
  pushToast,
  setDragging,
}: QuestDrawerProps) {
  const live = quest.assignee ? snap.live[quest.assignee.name] : null;
  const threads = snap.threads[quest.id] || [];
  const reviewPage = quest.reviewPage
    ? (snap.reviewPages || []).find((p) => p.page === quest.reviewPage)
    : null;

  const flowKey = getQuestFlowKey(quest, snap);
  const archived = isArchived(quest);
  const isOwnerQuest = quest.kind === 'owner';

  const handleCancel = async () => {
    if (!window.confirm(`取消 ${quest.id}？已经在跑的 worker 不会被停止。`)) {
      return;
    }
    try {
      await api.setQuestStatus(quest.id, 'cancelled', 'owner 在任务板上取消');
      refresh();
    } catch (err) {
      pushToast(`取消失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleRelease = async () => {
    const name = quest.assignee?.name ?? '';
    if (!window.confirm(`确认 worker ${name} 已经停了？释放后这个委托可以重新派；如果它其实还在跑，会有两个 worker 同时改文件。`)) {
      return;
    }
    try {
      await api.releaseWorker(quest.id, `owner 在任务板上确认 worker ${name} 已停止`);
      refresh();
    } catch (err) {
      pushToast(`释放失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div id="drawer" className="drawer">
      <button className="close" type="button" onClick={onClose}>
        ✕ 关闭
      </button>
      <p className="eyebrow">DOSSIER · 委托档案</p>
      <div className="d-head">
        <span className="pid">{quest.id}</span>
        <span className={`tape k-${quest.kind}`}>
          {KIND[quest.kind] || quest.kind}
        </span>
        <span className={`stamp s-${quest.status}`}>
          {STATUS[quest.status] || quest.status}
        </span>
      </div>
      <h2>{quest.title}</h2>
      <div className="d-meta">
        发布者 {quest.postedBy || '—'}
        {quest.brief ? (
          <>
            {' '}
            · brief <code>{quest.brief}</code>
          </>
        ) : null}
      </div>

      {flowKey === 'owner' ? (
        <div className="drawer-attention">
          <span>等我处理</span>
          {quest.needsOwner ? ` · ${quest.needsOwner}` : ''}
        </div>
      ) : null}

      {!archived && (isOwnerQuest || quest.needsOwner) ? (
        <OwnerTaskSection
          quest={quest}
          draft={draft}
          onDraftChange={onDraftChange}
          refresh={refresh}
          pushToast={pushToast}
        />
      ) : null}

      <DrawerSection en="RECEIPT" zh="交付回执">
        <QuestReceipt quest={quest} snap={snap} />
      </DrawerSection>

      {isAwaitingSignOff(quest) ? (
        <ReviewSection
          quest={quest}
          snap={snap}
          draft={draft}
          onDraftChange={onDraftChange}
          onSelectQuest={onSelectQuest}
          refresh={refresh}
          pushToast={pushToast}
        />
      ) : null}

      {quest.assignee && (
        <DrawerSection en="IN THE PIT" zh={quest.status === 'dispatched' ? '正在做' : '接手的人'}>
          <div className="rec">
            ⚔ {quest.assignee.model} · worker <code>{quest.assignee.name}</code>{' '}
            · {formatClock(quest.assignee.at)} 派出
            {live ? ` · ${live.state} · ${formatAgo(live.elapsed)}` : ''}
          </div>
          {live && live.lastText ? <pre>{live.lastText}</pre> : null}
        </DrawerSection>
      )}

      {quest.lastDetail ? (
        <DrawerSection en="LAST WORD" zh="最近结果">
          <pre>{quest.lastDetail}</pre>
        </DrawerSection>
      ) : null}

      {/* Returned work is signed off or sent back, not assigned again: a send-back reopens assignment. */}
      {!archived && !isOwnerQuest && !isAwaitingSignOff(quest) ? (
        <AssignSection quest={quest} snap={snap} onAssignCard={onAssignCard} />
      ) : null}

      <DrawerSection en="WIRING" zh="关系图">
        <div className="graph-wrap" style={{ minHeight: 0, height: 260 }}>
          <GraphView
            snap={snap}
            questIds={relatedQuestIds(snap, quest.id)}
            focusId={quest.id}
            compact
            onSelectQuest={onSelectQuest}
            onOpenWorkOrder={onAssignCard}
            setDragging={setDragging}
          />
        </div>
      </DrawerSection>

      {reviewPage && (
        <DrawerSection en="INSPECTION" zh="评审页">
          {isSafeReviewUrl(reviewPage.url) ? (
            <a
              className="rv"
              href={reviewPage.url}
              target="_blank"
              rel="noreferrer"
            >
              <span className="rv-title">{reviewPage.title}</span>
              <span className="rv-count">
                已批注 {reviewPage.answered}/{reviewPage.total}
              </span>
            </a>
          ) : (
            <div className="rv">
              <span className="rv-title">{reviewPage.title}</span>
              <span className="rv-count">
                已批注 {reviewPage.answered}/{reviewPage.total}
              </span>
            </div>
          )}
        </DrawerSection>
      )}

      {threads.length > 0 && (
        <DrawerSection en="CHATTER" zh="留言板">
          {threads.map((t) => (
            <div key={t.id} className="rec">
              <a
                href={`#/threads/${encodeURIComponent(t.id)}`}
                onClick={onClose}
              >
                {t.title}
              </a>{' '}
              · {t.messageCount} 条{t.closed ? ' · 已关闭' : ''}
            </div>
          ))}
        </DrawerSection>
      )}

      {quest.dispatches && quest.dispatches.length > 0 && (
        <DrawerSection en="LOG" zh="派遣记录">
          {quest.dispatches.map((d, i) => (
            <div key={i} className="rec">
              {new Date(d.at).toLocaleString('zh-CN')} · {d.model} ·{' '}
              <code>{d.name}</code> · {d.by || ''}
            </div>
          ))}
        </DrawerSection>
      )}

      {quest.rulings && quest.rulings.length > 0 && (
        <DrawerSection en="RULINGS" zh="裁决记录">
          {quest.rulings.map((r, i) => (
            <div key={i} className="rec">
              {new Date(r.at).toLocaleString('zh-CN')} · 问：{r.question || ''}{' '}
              · 答：{r.text}
            </div>
          ))}
        </DrawerSection>
      )}

      {!archived && (
        <DrawerSection en="SCRAP" zh="操作">
          {quest.status === 'stalled' && quest.assignee && (
            <p className="hint">
              worker {quest.assignee.name} 没动静了，但可能还在跑。它的位置和文件仍被占着，释放之前不能重新派。
            </p>
          )}
          {quest.status === 'stalled' && quest.assignee && (
            <button className="btn" type="button" onClick={handleRelease} style={{ marginRight: 8 }}>
              确认已停，释放 worker
            </button>
          )}
          <button className="btn danger" type="button" onClick={handleCancel}>
            取消这个委托
          </button>
        </DrawerSection>
      )}
    </div>
  );
}
