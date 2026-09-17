import type { Card, CardStatus, Quest } from '../api/types';
import type { RecentFailure } from '../api/failureTypes';
import { cardLabel, formatMonthDay } from '../lib/board';
import { BILLING, CARD_STATUS } from '../lib/labels';
import { cardProvider } from '../lib/rosterFilter';
import { t, useT } from '../lib/i18n';
import '../styles/failure-note.css';

interface CardBadgeProps {
  card: Card;
  busyQuests: Quest[];
  failure?: RecentFailure | null;
  isDragging: boolean;
  onEdit: (cardId: string) => void;
  onHover: (cardId: string | null) => void;
  onDragStart: (cardId: string) => void;
  onDragEnd: () => void;
}

// The backend's own reasonFor() already bakes a known reset time into `derived.reason` ("…，10:50 AM 恢
// 复"); this only supplies the closing clause, and only when the backend did not already give one. A passed
// reset means `derived.reason` is already the honest "限额窗口已过，尚未验证可用" — never editorialize on
// top of that (feedback9 row 4/CardBadge).
function derivedNote(derived: NonNullable<Card['derived']>): string {
  const resetsAt = derived.resetsAt;
  if (resetsAt && Date.parse(resetsAt) <= Date.now()) return derived.reason;
  if (!resetsAt) return `${derived.reason}${t('cardBadge.resetUnknownAuto')}`;
  return `${derived.reason}${t('cardBadge.autoRecovered')}`;
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
  failure,
  isDragging,
  onEdit,
  onHover,
  onDragStart,
  onDragEnd,
}: CardBadgeProps) {
  const t = useT();
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

  const initial = (card.name.trim()[0] || '?').toUpperCase();
  const provider = cardProvider(card);
  const busyIds = busyQuests.map((q) => q.id).join(t('common.listSeparator'));

  const classNames = [
    'adv',
    'plate',
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
      title={`${card.name} · ${card.id} · ${card.model}${card.variant ? t('rosterRow.variantSuffix', { variant: card.variant }) : ''} · ${provider} / ${card.lane} · ${label}${busyIds ? t('cardBadge.busyTitle', { ids: busyIds }) : ''}`}
      aria-label={t('cardBadge.ariaLabel', {
        id: card.id,
        name: card.name,
        model: card.model,
        variant: card.variant ? t('cardBadge.ariaVariant', { variant: card.variant }) : '',
        provider,
        lane: card.lane,
        status: label,
        busy: busyIds ? t('cardBadge.ariaBusy', { ids: busyIds }) : '',
      })}
      draggable={canDrag}
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onMouseEnter={handleMouseEnter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <i className={`led ${led}`} />
      <div className="adv-body">
        <div className="crest" aria-hidden="true">
          {initial}
        </div>
        <div className="adv-main">
          <div className="a-top">
            <span className="a-name">{card.name}</span>
            <span className="a-st">{label}</span>
          </div>
          <div className="a-model">
            <span className="a-key">{t('cardBadge.modelLabel')}</span> {card.model}
            {card.variant ? ` · ${card.variant}` : ''}
          </div>
          <div className="a-meta">
            <span className="a-key">{t('cardBadge.laneLabel')}</span> {card.lane} · {provider} ·{' '}
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
            <div className="a-note derived">⟳ {derivedNote(card.derived)}</div>
          ) : null}
          {card.status !== 'available' && !card.derived ? (
            <div className="a-note derived">
              {CARD_STATUS[card.status] || card.status}
              {card.statusSince ? t('cardBadge.sinceSuffix', { date: formatMonthDay(card.statusSince) }) : ''}
              {card.statusReason ? ` · ${card.statusReason}` : ''}
            </div>
          ) : null}
          {card.laneDiagnostics && card.laneDiagnostics.length > 0 ? (
            <div className="a-note">
              {/* N3: the collector can report the same diagnostic more than once (e.g. a repeated poll). */}
              {Array.from(new Set(card.laneDiagnostics.map((d) => d.message))).join(t('common.statementSeparator'))}
            </div>
          ) : null}
          {card.notes ? <div className="a-note">{card.notes}</div> : null}
          {failure ? (
            <div className="a-note fail-flag">{t('cardBadge.recentFailure', { questId: failure.questId })}</div>
          ) : null}
        </div>
      </div>
    </article>
  );
}
