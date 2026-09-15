import { useRef, useState } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { Card } from '../api/types';
import { formatAgo } from '../lib/board';
import { EMPTY_CARD_ACTIVITY, type CardActivity } from '../lib/cardActivity';
import { CARD_STATUS, STATUS } from '../lib/labels';

export interface CardNodeData extends Record<string, unknown> {
  card: Card;
  isWorking?: boolean;
  /** Current/past quests and live report from the snapshot, for the keyboard/click-opened detail panel. */
  activity?: CardActivity;
  onSelectQuest?: (questId: string) => void;
}

export type CardNodeType = Node<CardNodeData, 'card'>;

export function CardNode({ data }: NodeProps<CardNodeType>) {
  const [open, setOpen] = useState(false);
  const tokenRef = useRef<HTMLDivElement>(null);
  const card = data.card;
  const isWorking = Boolean(data.isWorking);
  const activity = data.activity ?? EMPTY_CARD_ACTIVITY;
  const name = card.name || card.id;
  const letter = name.trim().charAt(0).toUpperCase() || '?';
  // The disambiguating identity (feedback: full name + model id + variant), carried as an accessible name on
  // the focusable control itself, not only as a native title tooltip on the tiny avatar.
  const identity = `${name} · ${card.model}${card.variant ? ` · ${card.variant}` : ''}`;

  const close = () => {
    setOpen(false);
    // Return focus to the trigger, the same as a standard dialog: Escape/a panel action must not strand focus
    // on an element that is about to disappear.
    tokenRef.current?.focus();
  };

  // No stopPropagation here: the click still bubbles to React Flow's own node handler, so clicking the
  // avatar opens the panel *and* selects the card, instead of one silently disabling the other.
  const toggle = () => setOpen((v) => !v);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    } else if (e.key === 'Escape' && open) {
      e.stopPropagation();
      close();
    }
  };

  // Escape must close the panel from any focused control inside it (a quest link), not only from the token:
  // otherwise it bubbles past this dialog to the app's own Escape handling and closes the wrong thing.
  const handlePanelKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };

  const selectQuest = (questId: string) => (e: React.MouseEvent) => {
    e.stopPropagation();
    data.onSelectQuest?.(questId);
  };

  const liveText = (live: CardActivity['current'][number]['live']) =>
    live ? ` · ${live.state} · ${formatAgo(live.elapsed)} · ${live.edits || 0} 处改动` : '';

  return (
    <div className={`rf-card-node ${isWorking ? 'working' : ''}`} data-adv={card.id}>
      <Handle
        type="source"
        position={Position.Right}
        style={{ top: 15, opacity: 0, width: 1, height: 1 }}
      />
      <div
        ref={tokenRef}
        // No nodrag here: the avatar is the model's drag handle onto a quest. React Flow's own
        // click-vs-drag pixel threshold (not this class) is what keeps a plain click from being mistaken for
        // the start of a drag.
        className={`token ${isWorking ? 'working' : ''}`}
        role="button"
        tabIndex={0}
        aria-label={identity}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={handleKeyDown}
      >
        {letter}
      </div>
      <span className="token-name" aria-hidden="true">
        {name}
      </span>
      {open ? (
        <div
          // nodrag/nowheel/nopan: dragging the scrollbar or a stray pointer move inside the panel must scroll
          // or click the panel, never drag the node or pan/zoom the canvas underneath it.
          className="rf-card-detail nodrag nowheel nopan"
          role="dialog"
          aria-label={`${name} 详情`}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={handlePanelKeyDown}
        >
          <div className="rf-card-detail-head">
            <strong>{name}</strong>
            <code className="mono">{card.id}</code>
          </div>
          <div className="rf-card-detail-model">
            {card.model}
            {card.variant ? ` · ${card.variant}` : ''}
          </div>
          <div className="rf-card-detail-status">{CARD_STATUS[card.status] ?? card.status}</div>
          {activity.current.length > 0 ? (
            <div className="rf-card-detail-section">
              <span className="rf-card-detail-label">正在做</span>
              <ul>
                {activity.current.map((a) => (
                  <li key={a.questId}>
                    <button type="button" className="link-btn" onClick={selectQuest(a.questId)}>
                      {a.questId} · {a.title}
                      {liveText(a.live)}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {activity.history.length > 0 ? (
            <div className="rf-card-detail-section">
              <span className="rf-card-detail-label">做过</span>
              <ul>
                {activity.history.map((a) => (
                  <li key={a.questId}>
                    <button type="button" className="link-btn" onClick={selectQuest(a.questId)}>
                      {a.questId} · {a.title}（{STATUS[a.status] ?? a.status}
                      {a.heldByOther ? '·现在换了别的冒险者' : ''}）
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {activity.current.length === 0 && activity.history.length === 0 ? (
            <div className="rf-card-detail-empty">还没有委托记录</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
