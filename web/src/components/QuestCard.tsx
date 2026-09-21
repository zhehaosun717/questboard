import { useState } from 'react';
import type { Quest, Snapshot } from '../api/types';
import { formatAgo, isQueueOnly } from '../lib/board';
import { warningText } from '../lib/graphDrop';
import { KIND, OPEN_STATUSES, STATUS } from '../lib/labels';
import { useT } from '../lib/i18n';
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
  const t = useT();

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

  // Two materials, one card: parchment notices (the board) and dark wood counter plaques (the 交差柜台).
  // The tone of 下一步 is the one line that says who holds the quest up, so its colours are stated here
  // rather than as a pile of .q-next-* overrides.
  const TONE: Record<string, { paper: string; plate: string }> = {
    ready: { paper: 'border-pcb-dk text-pcb-dk', plate: 'border-pcb text-ready-lt' },
    working: { paper: 'border-cobalt text-cobalt', plate: 'border-cobalt text-travel-lt' },
    coordinator: { paper: 'border-cobalt text-cobalt', plate: 'border-cobalt text-travel-lt' },
    you: { paper: 'border-rust bg-[rgba(217,180,90,.24)] text-rust-dk shadow-[inset_0_0_0_1px_rgba(138,106,36,.24)]', plate: 'border-rust bg-black/30 text-cream' },
    done: { paper: 'border-pcb-dk text-pcb-dk', plate: 'border-pcb text-ready-lt' },
    waiting: { paper: 'border-grey text-ink-soft', plate: 'border-grey text-dim' },
  };
  const tone = (TONE[step.tone] ?? TONE.waiting) as { paper: string; plate: string };
  const inkText = isCounter ? 'text-cream' : 'text-ink';
  const softText = isCounter ? 'text-dim' : 'text-ink-soft';

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
        <div className={`flex min-w-0 items-center gap-2${seal && isCounter ? ' pr-12' : ''}`}>
          <span className="tape whitespace-nowrap">{KIND[quest.kind] ?? quest.kind}</span>
          <span
            className={`ml-auto inline-grid size-5 flex-none place-items-center rounded-full font-display text-[13px] font-bold leading-none shadow-[0_1px_2px_rgba(0,0,0,.4)] ${
              rank === 'S'
                ? 'bg-blood text-white'
                : isCounter
                  ? 'border border-rust/35 bg-black/45 text-cream'
                  : 'bg-ink text-tag'
            }`}
            title={`优先级 ${quest.priority || 2}`}
          >
            {rank}
          </span>
        </div>
        {/* The quest id gets its own line: squeezed beside the kind tape it truncated to a few characters,
            and the id is what the owner greps for. */}
        <div className={`mt-1.5 truncate whitespace-nowrap font-display text-[19px] leading-none tracking-[.03em] ${isCounter ? 'text-brass-lt' : 'text-ink'}`}>{quest.id}</div>
        <h3 className={`mb-[7px] mt-1.5 text-[14px] font-bold leading-[1.35] ${inkText}`}>{quest.title}</h3>
        {/* One line for what happens next; the dossier opens on the same step with its controls. */}
        <div
          className={`mb-[7px] mt-0.5 flex w-fit max-w-full items-center gap-[5px] border-l-[3px] py-0.5 pl-[5px] pr-[7px] text-[11px] font-bold leading-[1.35] ${isCounter ? tone.plate : tone.paper}`}
          title={step.detail}
        >
          <i aria-hidden="true" className="size-[7px] flex-none rounded-full bg-current" />
          {step.title}
        </div>
        <span className={`stamp${statusChanged ? ' thunk' : ''}`}>
          {STATUS[quest.status] ?? quest.status}
        </span>
        {showDetail ? <div className={`mt-1.5 line-clamp-2 font-mono text-[11px] leading-[1.45] ${softText}`}>{quest.lastDetail}</div> : null}
        {/* FB2-02 item 1: a redo dispatch says how many annotations it carries. */}
        {assignee?.annotationSnapshot?.count ? (
          <div className={`mt-1 text-[11px] font-bold ${softText}`}>
            {t('questCard.withAnnotations', { count: assignee.annotationSnapshot.count })}
          </div>
        ) : null}
        {quest.needsOwner ? (
          <div
            className={`mt-2 border-l-[3px] border-amber-dk px-2 py-[5px] text-[12px] ${
              isCounter
                ? 'bg-[repeating-linear-gradient(-45deg,rgba(201,162,74,.25)_0_9px,rgba(201,162,74,.12)_9px_18px)] text-cream'
                : 'bg-[repeating-linear-gradient(-45deg,rgba(217,180,90,.34)_0_9px,rgba(217,180,90,.2)_9px_18px)]'
            }`}
          >
            ❓ {quest.needsOwner}
          </div>
        ) : null}
        {quest.assignee ? (
          <div className={`mt-2 flex items-center gap-1.5 text-[12px] font-bold ${inkText}`}>
            <i className={`led ok${quest.status === 'dispatched' ? ' run' : ''}`} />
            <span>{adv ? adv.name : quest.assignee.model}</span>
            {live ? (
              <span className={`ml-auto font-mono text-[11px] font-normal ${softText}`}>
                {formatAgo(live.elapsed)} · {live.edits || 0} 改动
              </span>
            ) : null}
          </div>
        ) : null}
        {meta.length > 0 ? (
          <div className={`mt-1.5 flex flex-wrap gap-x-2.5 gap-y-1 font-mono text-[11px] ${softText}`}>
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
