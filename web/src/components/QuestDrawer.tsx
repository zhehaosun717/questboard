import { api } from '../api/client';
import type { Quest, Snapshot } from '../api/types';
import { formatAgo, formatClock, isSafeReviewUrl, relatedQuestIds, reviewSourcePath } from '../lib/board';
import { evidenceFor } from '../lib/evidence';
import { t } from '../lib/i18n';
import { KIND, STATUS } from '../lib/labels';
import { Button } from './ui/button';
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
// Getters keep them following the per-browser language switch; the zh strings are byte-identical.
const CANCEL_RESULT: Record<string, string> = {
  get pending() { return t('drawer.cancel.pending'); },
  get never_started() { return t('drawer.cancel.neverStarted'); },
  get stopped_by_wrapper() { return t('drawer.cancel.stoppedByWrapper'); },
  get stopped_by_api() { return t('drawer.cancel.stoppedByApi'); },
  get manual_required() { return t('drawer.cancel.manualRequired'); },
  get unknown() { return t('drawer.cancel.unknown'); },
};

const CANCEL_SOURCE: Record<string, string> = {
  get ui() { return t('drawer.cancel.source.ui'); },
  get cli() { return t('drawer.cancel.source.cli'); },
  get mcp() { return t('drawer.cancel.source.mcp'); },
  get limit() { return t('drawer.cancel.source.limit'); },
  get unknown() { return t('drawer.cancel.source.unknown'); },
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
  if (action === 'request') return t('drawer.cancel.reasonPrompt');
  if (action === 'held-status') return t('drawer.cancel.heldPrompt');
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
      ? t('drawer.cancel.warningHolds', { id: quest.id })
      : t('drawer.cancel.warning', { id: quest.id });
    if (!window.confirm(warning)) {
      return;
    }
    try {
      const reasonPrompt = cancelReasonPromptFor(action);
      const reason = reasonPrompt ? window.prompt(reasonPrompt)?.trim() : t('drawer.cancel.defaultReason');
      if (!reason) return;
      if (action === 'request') await api.cancelQuest(quest.id, reason);
      else await api.setQuestStatus(quest.id, 'cancelled', reason, holdsWorker);
      refresh();
    } catch (err) {
      pushToast(t('drawer.cancel.failedToast', { error: err instanceof Error ? err.message : String(err) }));
    }
  };

  const canResolve = Boolean(assignee && quest.cancelRequest
    && ['manual_required', 'stopped_by_wrapper', 'stopped_by_api', 'unknown'].includes(quest.cancelRequest.result));
  const handleResolve = async () => {
    const reason = window.prompt(t('drawer.cancel.heldPrompt'))?.trim();
    if (!reason) return;
    try {
      await api.resolveWorker(quest.id, reason);
      refresh();
    } catch (err) {
      pushToast(t('drawer.resolve.failedToast', { error: err instanceof Error ? err.message : String(err) }));
    }
  };

  const handleRelease = async () => {
    const name = assignee?.name ?? '';
    if (!window.confirm(t('drawer.release.confirm', { name }))) {
      return;
    }
    try {
      await api.releaseWorker(quest.id, t('drawer.release.detail', { name }));
      refresh();
    } catch (err) {
      pushToast(t('drawer.release.failedToast', { error: err instanceof Error ? err.message : String(err) }));
    }
  };

  return (
    <div id="drawer" className="drawer">
      <Button variant="ghost" size="xs" type="button" className="float-right" onClick={onClose}>
        ✕ {t('drawer.close')}
      </Button>
      <p className="eyebrow">{t('drawer.eyebrow')}</p>
      <div className="mt-2.5 flex items-center gap-2.5">
        <span className="font-display text-[30px] leading-none text-tag">{quest.id}</span>
        <span className={`tape k-${quest.kind}`}>{KIND[quest.kind] || quest.kind}</span>
        <span className={`stamp s-${quest.status} brightness-[1.6] [mix-blend-mode:normal]`}>{STATUS[quest.status] || quest.status}</span>
      </div>
      <h2 className="mb-1 mt-1.5 font-han text-[30px] font-normal leading-[1.15] tracking-[.03em] text-tag">{quest.title}</h2>
      <div className="text-[12px] text-dim">
        {t('drawer.postedBy', { name: quest.postedBy || '—' })}
        {quest.brief ? (
          <>
            {' '}
            · {t('drawer.briefLabel')} <code className="text-cable">{quest.brief}</code>
          </>
        ) : null}
      </div>

      <NextStepPanel step={step} onOpenQuest={onSelectQuest} />

      {quest.cancelRequest || limitStall ? (
        <DrawerSection en="CANCELLATION" zh="取消请求">
          <div className="text-[12px] leading-[1.55] text-dim [&+&]:mt-[3px]">
            {quest.cancelRequest
              ? `${CANCEL_RESULT[quest.cancelRequest.result] ?? quest.cancelRequest.result} · ${t('drawer.cancel.from')}${CANCEL_SOURCE[quest.cancelRequest.bySource] ?? quest.cancelRequest.bySource} · ${quest.cancelRequest.reason}${quest.cancelRequest.detail ? ` · ${quest.cancelRequest.detail}` : ''}`
              : quest.lastDetail}
          </div>
          {quest.cancelRequest?.result === 'manual_required' || (!quest.cancelRequest && limitStall) ? (
            <p className="hint">{t('drawer.cannotAutoStop')}</p>
          ) : null}
          {canResolve ? (
            <div className="row end">
              <button className="btn primary" type="button" onClick={handleResolve}>{t('drawer.resolve.button')}</button>
            </div>
          ) : null}
        </DrawerSection>
      ) : null}

      {quest.manualResolution ? (
        <DrawerSection en="RESOLUTION" zh="手动处理记录">
          <div className="text-[12px] leading-[1.55] text-dim [&+&]:mt-[3px]">
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
            {t('drawer.release.hint')}
          </p>
          <div className="row end">
            <button className="btn primary" type="button" onClick={handleRelease}>
              {t('drawer.release.button')}
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
          <div className="text-[12px] leading-[1.55] text-dim [&+&]:mt-[3px]">
            ⚔ {assigneeName} · {t('drawer.onQuest.model', { model: assignee.model })} · {t('drawer.onQuest.workerId', { name: assignee.name })} · {t('drawer.onQuest.dispatchedAt', { time: formatClock(assignee.at) })}
            {live ? ` · ${live.state} · ${formatAgo(live.elapsed)}` : ''}
            {live?.heartbeat ? ` · ${t('drawer.onQuest.heartbeat', { seconds: Math.max(0, Math.floor(live.heartbeat.ageMs / 1000)) })}` : ''}
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
              <span className="rv-count">{t('drawer.reviewPage.answered', { answered: reviewPage.answered, total: reviewPage.total })}</span>
              {reviewSource ? (
                <span className="rv-source">{t('drawer.reviewPage.source', { source: reviewSource })}</span>
              ) : null}
            </a>
          ) : (
            <div className="rv">
              <span className="rv-title">{reviewPage.title}</span>
              <span className="rv-count">{t('drawer.reviewPage.answered', { answered: reviewPage.answered, total: reviewPage.total })}</span>
              {reviewSource ? (
                <span className="rv-source">{t('drawer.reviewPage.source', { source: reviewSource })}</span>
              ) : null}
            </div>
          )}
        </DrawerSection>
      ) : null}

      {threads.length > 0 ? (
        <DrawerSection en="CHATTER" zh="留言板">
          {threads.map((thread) => (
            <div key={thread.id} className="text-[12px] leading-[1.55] text-dim [&+&]:mt-[3px]">
              <a href={`#/threads/${encodeURIComponent(thread.id)}`} onClick={onClose}>
                {thread.title}
              </a>{' '}
              · {t('drawer.chatter.messages', { count: thread.messageCount })}{thread.closed ? ` · ${t('drawer.chatter.closed')}` : ''}
            </div>
          ))}
        </DrawerSection>
      ) : null}

      {quest.dispatches && quest.dispatches.length > 0 ? (
        <DrawerSection en="LOG" zh="派出记录">
          {quest.dispatches.map((d, i) => (
            <div key={i} className="text-[12px] leading-[1.55] text-dim [&+&]:mt-[3px]">
              {new Date(d.at).toLocaleString('zh-CN')} · {d.model} · 编号 <code>{d.name}</code> · {d.by || ''}
            </div>
          ))}
        </DrawerSection>
      ) : null}

      {quest.rulings && quest.rulings.length > 0 ? (
        <DrawerSection en="RULINGS" zh="裁决记录">
          {quest.rulings.map((r, i) => (
            <div key={i} className="text-[12px] leading-[1.55] text-dim [&+&]:mt-[3px]">
              {new Date(r.at).toLocaleString('zh-CN')} · {t('drawer.rulings.question', { question: r.question || '' })} · {t('drawer.rulings.answer', { text: r.text })}
            </div>
          ))}
        </DrawerSection>
      ) : null}

      {!archived ? (
        <DrawerSection en="SCRAP" zh="取消">
          <button className="btn danger" type="button" onClick={handleCancel}>
            {t('drawer.scrap.button')}
          </button>
        </DrawerSection>
      ) : null}
    </div>
  );
}
