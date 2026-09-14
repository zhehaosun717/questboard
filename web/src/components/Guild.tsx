import { useMemo } from 'react';
import type { Card, CardStatus, Snapshot } from '../api/types';
import { busyQuests } from '../lib/board';
import { CardBadge } from './CardBadge';

interface GuildProps {
  roster: Card[];
  snap: Snapshot;
  draggingCardId: string | null;
  onEditCard: (cardId: string) => void;
  onHoverCard: (cardId: string | null) => void;
  onDragStart: (cardId: string) => void;
  onDragEnd: () => void;
}

const STATUS_ORDER: Record<CardStatus, number> = {
  available: 0,
  limited: 1,
  broke: 2,
  paused: 3,
  disabled: 4,
};

export function Guild({
  roster,
  snap,
  draggingCardId,
  onEditCard,
  onHoverCard,
  onDragStart,
  onDragEnd,
}: GuildProps) {
  const groups = useMemo(() => {
    const map = new Map<string, Card[]>();
    for (const a of roster) {
      const list = map.get(a.provider) || [];
      list.push(a);
      map.set(a.provider, list);
    }

    return Array.from(map.entries())
      .map(([provider, members]) => {
        const sorted = [...members].sort(
          (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status],
        );
        // Groups are by provider, so only name a lane when every card in the group really uses it.
        const firstLane = sorted[0]?.lane;
        const sameLane = firstLane !== undefined && sorted.every((m) => m.lane === firstLane);
        return { provider, members: sorted, lane: sameLane ? firstLane : '' };
      })
      .sort((a, b) => {
        const firstA = a.members[0];
        const firstB = b.members[0];
        const rankA = firstA ? STATUS_ORDER[firstA.status] : 0;
        const rankB = firstB ? STATUS_ORDER[firstB.status] : 0;
        return rankA - rankB;
      });
  }, [roster]);

  return (
    <aside
      className="guild roster"
      aria-labelledby="guildTitle"
      onMouseLeave={() => onHoverCard(null)}
    >
      <header className="sec-head">
        <span className="eyebrow">ROSTER</span>
        <h2 id="guildTitle">冒险者公会</h2>
      </header>
      <p className="hint">
        拖动或悬停一位冒险者：能接的委托会亮起，不能接的会写明原因。点冒险者改状态。
      </p>
      <div id="guild">
        {groups.map((group) => (
          <div key={group.provider}>
            <h4 className="guild-group">
              {group.provider}
              {group.lane ? <span>{group.lane}</span> : null}
            </h4>
            {group.members.map((card) => (
              <CardBadge
                key={card.id}
                card={card}
                busyQuests={busyQuests(snap, card.id)}
                isDragging={draggingCardId === card.id}
                onEdit={onEditCard}
                onHover={onHoverCard}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
              />
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}
