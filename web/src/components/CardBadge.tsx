import type { Card, CardStatus, Quest } from '../api/types';
import { cardLabel, formatMonthDay } from '../lib/board';
import { BILLING, CARD_STATUS } from '../lib/labels';

interface CardBadgeProps {
  card: Card;
  busyQuests: Quest[];
  isDragging: boolean;
  onEdit: (cardId: string) => void;
  onHover: (cardId: string | null) => void;
  onDragStart: (cardId: string) => void;
  onDragEnd: () => void;
}

const LED: Record<CardStatus, string> = {
  available: 'ok',
  limited: 'warn',
  broke: 'bad',
  paused: '',
  disabled: '',
};

export function CardBadge({
  card,
  busyQuests,
  isDragging,
  onEdit,
  onHover,
  onDragStart,
  onDragEnd,
}: CardBadgeProps) {
  const max = card.maxParallel || 1;
  const full = card.status === 'available' && busyQuests.length >= max;
  const label = cardLabel(card, busyQuests.length);
  const canDrag = card.status === 'available' && !full;

  const led =
    card.status !== 'available'
      ? LED[card.status]
      : full
        ? 'full run'
        : busyQuests.length > 0
          ? 'ok run'
          : 'ok';

  const handleDragStart = (e: React.DragEvent) => {
    if (!canDrag) return;
    e.dataTransfer.setData('text/plain', card.id);
    e.dataTransfer.effectAllowed = 'move';
    onDragStart(card.id);
  };

  const handleDragEnd = () => {
    onDragEnd();
  };

  const handleMouseEnter = () => {
    onHover(card.id);
  };

  const handleClick = () => {
    onEdit(card.id);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      onEdit(card.id);
    }
  };

  const classNames = [
    'adv',
    `st-${card.status}`,
    full ? 'full' : '',
    isDragging ? 'is-dragging' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <article
      className={classNames}
      data-adv={card.id}
      draggable={canDrag}
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onMouseEnter={handleMouseEnter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <i className={`led ${led}`} />
      <div className="a-top">
        <span className="a-name">{card.name}</span>
        <span className="a-st">{label}</span>
      </div>
      <div className="a-model">
        <span className="a-key">模型</span> {card.model}
        {card.variant ? ` · ${card.variant}` : ''}
      </div>
      <div className="a-meta">
        <span className="a-key">接入方式</span> {card.lane} · {card.provider} ·{' '}
        <span className={card.billing === 'payg' ? 'pay' : ''}>
          {BILLING[card.billing || ''] || card.billing || ''}
        </span>
      </div>
      {busyQuests.length > 0 ? (
        <div className="a-work">
          {busyQuests.map((q) => (
            <span key={q.id}>{q.id}</span>
          ))}
        </div>
      ) : null}
      {card.derived ? (
        <div className="a-note derived">
          ⟳ {card.derived.reason}（自动判断，限额过去后自动恢复）
        </div>
      ) : null}
      {card.status !== 'available' && !card.derived ? (
        <div className="a-note derived">
          {CARD_STATUS[card.status] || card.status}
          {card.statusSince ? ` · ${formatMonthDay(card.statusSince)} 起` : ''}
          {card.statusReason ? ` · ${card.statusReason}` : ''}
        </div>
      ) : null}
      {card.notes ? <div className="a-note">{card.notes}</div> : null}
    </article>
  );
}
