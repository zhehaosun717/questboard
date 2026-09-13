import { useState } from 'react';
import type { Quest, Snapshot } from '../api/types';
import { formatAgo, isQueueOnly } from '../lib/board';
import { KIND, OPEN_STATUSES, STATUS } from '../lib/labels';

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

  const verdict = pickingCardId ? snap.eligibility[quest.id]?.[pickingCardId] : undefined;
  const isOpen = OPEN_STATUSES.includes(quest.status);

  let dropClass = '';
  let refuseMessage = '';

  if (pickingCardId && verdict) {
    const isOk = verdict.ok;
    const isQueue = !verdict.ok && isOpen && isQueueOnly(verdict);
    const isNo = !verdict.ok && isOpen && !isQueue;

    if (isOk) dropClass = 'drop-ok';
    else if (isQueue) dropClass = 'drop-queue';
    else if (isNo) dropClass = 'drop-no';

    if (!verdict.ok && verdict.reasons.length > 0) {
      const firstReason = verdict.reasons[0];
      const extraCount = verdict.reasons.length - 1;
      refuseMessage = `✗ ${firstReason ? firstReason.message : ''}${
        extraCount > 0 ? `（还有 ${extraCount} 条）` : ''
      }`;
    }
  }

  const live = quest.assignee ? snap.live[quest.assignee.name] : null;
  const adv = quest.assignee
    ? snap.roster.find((a) => a.id === quest.assignee!.adventurerId)
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

  const heat = 4 - (quest.priority || 2);
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
        <div className="q-top">
          <span className="tape">{KIND[quest.kind] ?? quest.kind}</span>
          <span className="pid">{quest.id}</span>
          <span className="pips" title={`优先级 ${quest.priority || 2}`}>
            {[1, 2, 3].map((n) => (
              <i key={n} className={n <= heat ? 'on' : ''} />
            ))}
          </span>
        </div>
        <h3>{quest.title}</h3>
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
        <div className="q-refuse">{refuseMessage}</div>
      </div>
    </article>
  );
}
