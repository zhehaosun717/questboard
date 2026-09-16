import { useState } from 'react';
import type { Quest, Snapshot } from '../api/types';
import { formatAgo, isQueueOnly } from '../lib/board';
import { warningText } from '../lib/graphDrop';
import { KIND, OPEN_STATUSES, STATUS } from '../lib/labels';
import { nextStep } from '../lib/nextStep';
import { rankOf, sealFor } from '../lib/questLook';
import { getDropVerdict, isAwaitingSignOff } from '../lib/questState';

interface QuestCardProps {
  quest: Quest;
  index: number;
  snap: Snapshot;
  pickingCardId: string | null;
  isNew: boolean;
  statusChanged: boolean;
  onSelect: (questId: string) => void;
  onDropCard: (questId: string, cardId: string) => void;
}

export function QuestCard({
  quest,
  index,
  snap,
  pickingCardId,
  isNew,
  statusChanged,
  onSelect,
  onDropCard,
}: QuestCardProps) {
  const [isOver, setIsOver] = useState(false);

  const verdict = pickingCardId ? getDropVerdict(snap, quest, pickingCardId) : undefined;
  const isOpen = OPEN_STATUSES.includes(quest.status);
  const step = nextStep(quest, snap);
  const isCounter = quest.status === 'delivered' || quest.status === 'reviewing';
  const seal = isCounter ? sealFor(quest, snap) : null;
  const rank = rankOf(quest.priority);

  let dropClass = '';
  let refuseMessage = '';
  const dropWarning = pickingCardId && verdict?.ok ? warningText(verdict) : undefined;

  if (pickingCardId && verdict) {
    const isOk = verdict.ok;
    const isQueue = !verdict.ok && isOpen && isQueueOnly(verdict);
    const isNo = !verdict.ok && isOpen && !isQueue;

    if (isOk) dropClass = 'drop-ok';
    else if (isQueue) dropClass = 'drop-queue';
    else if (isNo) dropClass = 'drop-no';

    if (!verdict.ok) {
      if (verdict.reasons.length === 0) {
        refuseMessage = '✗ 没有记录';
      } else {
        const firstReason = verdict.reasons[0];
        const extraCount = verdict.reasons.length - 1;
        refuseMessage = `✗ ${firstReason?.message ?? '没有记录'}${
          extraCount > 0 ? `（还有 ${extraCount} 条）` : ''
        }`;
      }
    }
  }

  // Hoisted: narrowing on quest.assignee does not survive into the find() callback, because a property
  // access could change between the check and the call.
  const assignee = quest.assignee;
  const live = assignee ? snap.live[assignee.name] : null;
  const adv = assignee
    ? snap.roster.find((a) => a.id === assignee.adventurerId)
    : null;
  const threads = snap.threads[quest.id] || [];

  const meta: string[] = [];
  if (quest.parents && quest.parents.length > 0) {
    meta.push(`↑ ${quest.parents.join(' ')}`);
  }
  if (quest.conflicts && quest.conflicts.length > 0) {
    meta.push(`⚠ ${quest.conflicts.join(' ')}`);
  }
  if (threads.length > 0) {
    meta.push(`💬 ${threads.length}`);
  }
  if (quest.dispatches && quest.dispatches.length > 1) {
    meta.push(`第 ${quest.dispatches.length} 次`);
  }

  const showDetail =
    ['failed', 'bounced', 'stalled', 'delivered', 'lane_limited'].includes(quest.status) &&
    quest.lastDetail;

  const handleDragOver = (e: React.DragEvent) => {
    if (dropClass === 'drop-ok') {
      e.preventDefault();
      setIsOver(true);
    }
  };

  const handleDragLeave = () => {
    setIsOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    if (dropClass === 'drop-ok') {
      e.preventDefault();
      setIsOver(false);
      const cardId = e.dataTransfer.getData('text/plain') || pickingCardId;
      if (cardId) {
        onDropCard(quest.id, cardId);
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      onSelect(quest.id);
    }
  };

  const classNames = [
    'quest',
    isCounter ? 'counter' : 'notice',
    seal ? 'has-seal' : '',
    `k-${quest.kind}`,
    `s-${quest.status}`,
    isNew ? 'enter' : '',
    dropClass,
    isOver ? 'over' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <article
      className={classNames}
      style={{ '--i': index } as React.CSSProperties}
      data-quest={quest.id}
      tabIndex={0}
      onClick={() => onSelect(quest.id)}
      onKeyDown={handleKeyDown}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="tag">
        {seal ? (
          <span className={`seal seal-${seal.verdict}`}>
            {seal.line1}
            <br />
            {seal.line2}
          </span>
        ) : null}
        <div className="q-top">
          <span className="tape">{KIND[quest.kind] ?? quest.kind}</span>
          <span className="pid">{quest.id}</span>
          <span
            className={`rank${rank === 'S' ? ' s' : ''}`}
            title={`优先级 ${quest.priority || 2}`}
          >
            {rank}
          </span>
        </div>
        <h3>{quest.title}</h3>
        {/* One line for what happens next; the dossier opens on the same step with its controls. */}
        <div className={`q-next q-next-${step.tone}`} title={step.detail}>
          <i aria-hidden="true" />
          {step.title}
        </div>
        <span className={`stamp${statusChanged ? ' thunk' : ''}`}>
          {STATUS[quest.status] ?? quest.status}
        </span>
        {showDetail ? <div className="q-detail">{quest.lastDetail}</div> : null}
        {quest.needsOwner ? <div className="q-ask">❓ {quest.needsOwner}</div> : null}
        {quest.assignee ? (
          <div className="q-who">
            <i className={`led ok${quest.status === 'dispatched' ? ' run' : ''}`} />
            <span>{adv ? adv.name : quest.assignee.model}</span>
            {live ? (
              <span className="mono">
                {formatAgo(live.elapsed)} · {live.edits || 0} 改动
              </span>
            ) : null}
          </div>
        ) : null}
        {meta.length > 0 ? (
          <div className="q-meta">
            {meta.map((m, i) => (
              <span key={i}>{m}</span>
            ))}
          </div>
        ) : null}
        {/* The same drag means different things by status, so say which before the drop. */}
        {dropClass === 'drop-ok' ? (
          <>
            <div className="q-drop-hint">{isAwaitingSignOff(quest) ? '放下：派去复核' : '放下：派去做'}</div>
            {dropWarning ? <div className="q-drop-warning" role="note">⚠ {dropWarning}</div> : null}
          </>
        ) : (
          <div className="q-refuse">{refuseMessage}</div>
        )}
      </div>
    </article>
  );
}
