import { api } from '../api/client';
import type { Quest, Snapshot } from '../api/types';
import { formatAgo, formatClock, isSafeReviewUrl, relatedQuestIds } from '../lib/board';
import { evidenceFor } from '../lib/evidence';
import { KIND, STATUS } from '../lib/labels';
import { nextStep } from '../lib/nextStep';
import { isArchived } from '../lib/questState';
import { AssignSection } from './quest/AssignSection';
import { DrawerSection } from './quest/DrawerSection';
import { EvidenceLadder } from './quest/EvidenceLadder';
import { NextStepPanel } from './quest/NextStepPanel';
import { OwnerTaskSection } from './quest/OwnerTaskSection';
import { QuestReceipt } from './quest/QuestReceipt';
import { ReviewSection } from './quest/ReviewSection';
import { GraphView } from './GraphView';

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

// The dossier opens on 下一步 with that step's controls right under it, then the evidence and what came back.
// Everything after that is record. Controls no longer depend on which section a state happened to add them to.
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
  const assignee = quest.assignee;
  const live = assignee ? snap.live[assignee.name] : null;
  const assigneeName = assignee
    ? snap.roster.find((card) => card.id === assignee.adventurerId)?.name ?? assignee.model
    : '';
  const threads = snap.threads[quest.id] || [];
  const reviewPage = quest.reviewPage
    ? (snap.reviewPages || []).find((p) => p.page === quest.reviewPage)
    : null;

  const step = nextStep(quest, snap);
  const rungs = evidenceFor(quest, snap);
  const archived = isArchived(quest);

  const handleCancel = async () => {
    if (!window.confirm(`取消 ${quest.id}？已经在跑的冒险者不会被停止。`)) {
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
    const name = assignee?.name ?? '';
    if (!window.confirm(`确认冒险者（编号 ${name}）已经停了？释放后这个委托可以重新派；如果它其实还在跑，会有两个冒险者同时改文件。`)) {
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
        <span className={`tape k-${quest.kind}`}>{KIND[quest.kind] || quest.kind}</span>
        <span className={`stamp s-${quest.status}`}>{STATUS[quest.status] || quest.status}</span>
      </div>
      <h2>{quest.title}</h2>
      <div className="d-meta">
        发布者 {quest.postedBy || '—'}
        {quest.brief ? (
          <>
            {' '}
            · 委托书 <code>{quest.brief}</code>
          </>
        ) : null}
      </div>

      <NextStepPanel step={step} onOpenQuest={onSelectQuest} />

      {step.action === 'owner-task' ? (
        <OwnerTaskSection quest={quest} draft={draft} onDraftChange={onDraftChange} refresh={refresh} pushToast={pushToast} />
      ) : null}

      {step.action === 'sign-off' ? (
        <ReviewSection
          quest={quest}
          snap={snap}
          draft={draft}
          onDraftChange={onDraftChange}
          onSelectQuest={onSelectQuest}
          onAssignCard={onAssignCard}
          refresh={refresh}
          pushToast={pushToast}
        />
      ) : null}

      {step.action === 'assign' ? <AssignSection quest={quest} snap={snap} onAssignCard={onAssignCard} /> : null}

      {step.action === 'release' && assignee ? (
        <DrawerSection en="RELEASE" zh="确认冒险者已停">
          <p className="hint owner-task-hint">
            它的位置和文件仍被占着。确认它真的停了再释放：如果它其实还在跑，释放后会有两个冒险者同时改文件。
          </p>
          <div className="row end">
            <button className="btn primary" type="button" onClick={handleRelease}>
              确认已停，释放
            </button>
          </div>
        </DrawerSection>
      ) : null}

      {rungs.length > 0 ? (
        <DrawerSection en="EVIDENCE" zh="证据：谁说做完了">
          <EvidenceLadder rungs={rungs} />
        </DrawerSection>
      ) : null}

      <DrawerSection en="RECEIPT" zh="交回的东西">
        <QuestReceipt quest={quest} snap={snap} />
      </DrawerSection>

      {assignee ? (
        <DrawerSection en="ON QUEST" zh={quest.status === 'dispatched' ? '正在做的冒险者' : '接手的冒险者'}>
          <div className="rec">
            ⚔ {assigneeName} · 模型 {assignee.model} · 编号 <code>{assignee.name}</code> · {formatClock(assignee.at)} 派出
            {live ? ` · ${live.state} · ${formatAgo(live.elapsed)}` : ''}
          </div>
          {live && live.lastText ? <pre>{live.lastText}</pre> : null}
        </DrawerSection>
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

      {reviewPage ? (
        <DrawerSection en="INSPECTION" zh="评审页">
          {isSafeReviewUrl(reviewPage.url) ? (
            <a className="rv" href={reviewPage.url} target="_blank" rel="noreferrer">
              <span className="rv-title">{reviewPage.title}</span>
              <span className="rv-count">已批注 {reviewPage.answered}/{reviewPage.total}</span>
            </a>
          ) : (
            <div className="rv">
              <span className="rv-title">{reviewPage.title}</span>
              <span className="rv-count">已批注 {reviewPage.answered}/{reviewPage.total}</span>
            </div>
          )}
        </DrawerSection>
      ) : null}

      {threads.length > 0 ? (
        <DrawerSection en="CHATTER" zh="留言板">
          {threads.map((t) => (
            <div key={t.id} className="rec">
              <a href={`#/threads/${encodeURIComponent(t.id)}`} onClick={onClose}>
                {t.title}
              </a>{' '}
              · {t.messageCount} 条{t.closed ? ' · 已关闭' : ''}
            </div>
          ))}
        </DrawerSection>
      ) : null}

      {quest.dispatches && quest.dispatches.length > 0 ? (
        <DrawerSection en="LOG" zh="派遣记录">
          {quest.dispatches.map((d, i) => (
            <div key={i} className="rec">
              {new Date(d.at).toLocaleString('zh-CN')} · {d.model} · 编号 <code>{d.name}</code> · {d.by || ''}
            </div>
          ))}
        </DrawerSection>
      ) : null}

      {quest.rulings && quest.rulings.length > 0 ? (
        <DrawerSection en="RULINGS" zh="裁决记录">
          {quest.rulings.map((r, i) => (
            <div key={i} className="rec">
              {new Date(r.at).toLocaleString('zh-CN')} · 问：{r.question || ''} · 答：{r.text}
            </div>
          ))}
        </DrawerSection>
      ) : null}

      {!archived ? (
        <DrawerSection en="SCRAP" zh="取消">
          <button className="btn danger" type="button" onClick={handleCancel}>
            取消这个委托
          </button>
        </DrawerSection>
      ) : null}
    </div>
  );
}
