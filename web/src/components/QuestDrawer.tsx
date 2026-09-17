import { api } from '../api/client';
import type { Quest, Snapshot } from '../api/types';
import { formatAgo, formatClock, isSafeReviewUrl, relatedQuestIds, reviewSourcePath } from '../lib/board';
import { evidenceFor } from '../lib/evidence';
import { KIND, STATUS } from '../lib/labels';
import { nextStep } from '../lib/nextStep';
import { isArchived } from '../lib/questState';
import { AssignSection } from './quest/AssignSection';
import { DrawerSection } from './quest/DrawerSection';
import { EvidenceLadder } from './quest/EvidenceLadder';
import { EvidenceSection } from './quest/EvidenceSection';
import { NextStepPanel } from './quest/NextStepPanel';
import { MetadataSection } from './quest/MetadataSection';
import { OwnerTaskSection } from './quest/OwnerTaskSection';
import { QuestReceipt } from './quest/QuestReceipt';
import { ReviewSection } from './quest/ReviewSection';
import { UpstreamEvidence } from './quest/UpstreamEvidence';
import { GraphView } from './GraphView';

// Display labels for cancellation codes and sources — the drawer shows these words, never the raw codes.
const CANCEL_RESULT: Record<string, string> = {
  pending: '停止请求已发出，还没收到确认',
  never_started: 'worker 还没启动',
  stopped_by_wrapper: '包装脚本已停下它直接启动的进程',
  stopped_by_api: '已通过通道接口停止',
  manual_required: '无法自动停止，需要手动处理',
  unknown: '不确定是否已停止',
};

const CANCEL_SOURCE: Record<string, string> = {
  ui: '看板',
  cli: '命令行',
  mcp: 'MCP',
  limit: '超限自动取消',
  unknown: '未知来源',
};

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

// A live dispatched attempt uses the cooperative cancellation request. A stalled attempt still owns its
// reservation, so its fallback status path needs the same explicit warning and reason prompt as RELEASE.
export function cancelActionFor(status: Quest['status']): 'request' | 'held-status' | 'status' {
  if (status === 'stalled') return 'held-status';
  return status === 'dispatched' ? 'request' : 'status';
}

export function cancelReasonPromptFor(action: ReturnType<typeof cancelActionFor>): string | null {
  if (action === 'request') return '请写明取消原因';
  if (action === 'held-status') return '请写明你怎么确认这个 worker 已经停了；这句话会记成手动释放的理由';
  return null;
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
  const reviewSource = reviewPage ? reviewSourcePath(reviewPage.url) : null;

  const step = nextStep(quest, snap);
  const rungs = evidenceFor(quest, snap);
  const archived = isArchived(quest);
  const limitStall = quest.status === 'stalled'
    && Boolean(quest.lastDetail && /超过消息上限|超过时长上限/.test(quest.lastDetail));
  // F3: each parent's revision (bumped on every server-side change to that quest), so UpstreamEvidence's
  // effect refetches the review's own upstream evidence when a parent is re-dispatched or redelivered while
  // this drawer stays open, instead of only on the next quest.id/reviewOverride change.
  const parentsKey = quest.parents.map((id) => `${id}:${snap.quests.find((q) => q.id === id)?.revision ?? ''}`).join(',');

  const handleCancel = async () => {
    const action = cancelActionFor(quest.status);
    const holdsWorker = Boolean(assignee && action !== 'status');
    const warning = holdsWorker
      ? `取消 ${quest.id}？它的 worker 可能还在改文件。取消只是发出停止请求，不代表 worker 已经停了。确定继续吗？`
      : `取消 ${quest.id}？`;
    if (!window.confirm(warning)) {
      return;
    }
    try {
      const reasonPrompt = cancelReasonPromptFor(action);
      const reason = reasonPrompt ? window.prompt(reasonPrompt)?.trim() : '在看板上手动取消';
      if (!reason) return;
      if (action === 'request') await api.cancelQuest(quest.id, reason);
      else await api.setQuestStatus(quest.id, 'cancelled', reason, holdsWorker);
      refresh();
    } catch (err) {
      pushToast(`取消失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const canResolve = Boolean(assignee && quest.cancelRequest
    && ['manual_required', 'stopped_by_wrapper', 'stopped_by_api', 'unknown'].includes(quest.cancelRequest.result));
  const handleResolve = async () => {
    const reason = window.prompt('请写明你怎么确认这个 worker 已经停了；这句话会记成手动释放的理由')?.trim();
    if (!reason) return;
    try {
      await api.resolveWorker(quest.id, reason);
      refresh();
    } catch (err) {
      pushToast(`手动释放失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleRelease = async () => {
    const name = assignee?.name ?? '';
    if (!window.confirm(`确认冒险者（编号 ${name}）已经停了？释放后这个委托可以重新派；如果它其实还在跑，会有两个冒险者同时改文件。`)) {
      return;
    }
    try {
      await api.releaseWorker(quest.id, `owner 在看板上确认冒险者 ${name} 已停止`);
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

      {quest.cancelRequest || limitStall ? (
        <DrawerSection en="CANCELLATION" zh="取消请求">
          <div className="rec">
            {quest.cancelRequest
              ? `${CANCEL_RESULT[quest.cancelRequest.result] ?? quest.cancelRequest.result} · 来自${CANCEL_SOURCE[quest.cancelRequest.bySource] ?? quest.cancelRequest.bySource} · ${quest.cancelRequest.reason}${quest.cancelRequest.detail ? ` · ${quest.cancelRequest.detail}` : ''}`
              : quest.lastDetail}
          </div>
          {quest.cancelRequest?.result === 'manual_required' || (!quest.cancelRequest && limitStall) ? (
            <p className="hint">无法自动停止，请手动处理</p>
          ) : null}
          {canResolve ? (
            <div className="row end">
              <button className="btn primary" type="button" onClick={handleResolve}>确认已停止，手动释放</button>
            </div>
          ) : null}
        </DrawerSection>
      ) : null}

      {quest.manualResolution ? (
        <DrawerSection en="RESOLUTION" zh="手动处理记录">
          <div className="rec">
            {CANCEL_SOURCE[quest.manualResolution.actorSource] ?? quest.manualResolution.actorSource} · {quest.manualResolution.reason} · {quest.manualResolution.time}
          </div>
        </DrawerSection>
      ) : null}

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

      <UpstreamEvidence
        key={`upstream:${snap.project.id ?? ''}:${quest.id}`}
        quest={quest}
        projectId={snap.project.id ?? ''}
        parentsKey={parentsKey}
        refresh={refresh}
        pushToast={pushToast}
      />

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

      <EvidenceSection key={`evidence:${snap.project.id ?? ''}:${quest.id}`} quest={quest} projectId={snap.project.id ?? ''} />

      <MetadataSection key={`${snap.project.id ?? ''}:${quest.id}`} quest={quest} snap={snap} refresh={refresh} pushToast={pushToast} />

      <DrawerSection en="RECEIPT" zh="交回的东西">
        <QuestReceipt quest={quest} snap={snap} />
      </DrawerSection>

      {assignee ? (
        <DrawerSection en="ON QUEST" zh={quest.status === 'dispatched' ? '正在做的冒险者' : '接手的冒险者'}>
          <div className="rec">
            ⚔ {assigneeName} · 模型 {assignee.model} · 编号 <code>{assignee.name}</code> · {formatClock(assignee.at)} 派出
            {live ? ` · ${live.state} · ${formatAgo(live.elapsed)}` : ''}
            {live?.heartbeat ? ` · 最近心跳：${Math.max(0, Math.floor(live.heartbeat.ageMs / 1000))} 秒前` : ''}
          </div>
          {live && live.lastText ? <pre>{live.lastText}</pre> : null}
        </DrawerSection>
      ) : null}

      <DrawerSection en="WIRING" zh="冒险地图">
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
              {reviewSource ? (
                <span className="rv-source">评审页文件：评审目录/{reviewSource}</span>
              ) : null}
            </a>
          ) : (
            <div className="rv">
              <span className="rv-title">{reviewPage.title}</span>
              <span className="rv-count">已批注 {reviewPage.answered}/{reviewPage.total}</span>
              {reviewSource ? (
                <span className="rv-source">评审页文件：评审目录/{reviewSource}</span>
              ) : null}
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
        <DrawerSection en="LOG" zh="派出记录">
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
