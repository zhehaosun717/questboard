import { useEffect, useMemo, useState } from 'react';
import type { Card, CardStatus, Snapshot } from '../api/types';
import { busyQuests } from '../lib/board';
import { failureForCard } from '../api/failureTypes';
import {
  EMPTY_ROSTER_FILTER,
  buildRosterFilterOptions,
  cardProvider,
  filterRosterCards,
  foldStorage,
  loadFoldedProviders,
  openRevealedGroups,
  providerAccent,
  providerMark,
  revealGroups,
  rosterFilterActive,
  saveFoldedProviders,
  toggleGroupFold,
  type RosterFilterState,
} from '../lib/rosterFilter';
import { useT } from '../lib/i18n';
import { CardBadge } from './CardBadge';
import { RosterFilters } from './roster/RosterFilters';

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
  const t = useT();

  // The opaque project id from the server namespaces saved folds; a name is never a safe key. No id (an
  // old server) means folds are not remembered — the owner sees that below instead of a false promise.
  const projectId = snap.project?.id ?? '';
  const [filter, setFilter] = useState<RosterFilterState>(EMPTY_ROSTER_FILTER);
  const [folded, setFolded] = useState<string[]>(() => loadFoldedProviders(foldStorage(), projectId));
  const [tempFolded, setTempFolded] = useState<string[]>([]);
  // FB2-07 item 5: which provider groups currently show their unproven imported cards (default: none).
  const [unprovenOpenGroups, setUnprovenOpenGroups] = useState<Set<string>>(new Set());
  const toggleUnproven = (provider: string) => {
    setUnprovenOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(provider)) next.delete(provider);
      else next.add(provider);
      return next;
    });
  };

  useEffect(() => {
    setFolded(loadFoldedProviders(foldStorage(), projectId));
    setTempFolded([]);
  }, [projectId]);

  const options = useMemo(() => buildRosterFilterOptions(roster), [roster]);
  const visible = useMemo(() => filterRosterCards(roster, filter), [roster, filter]);
  const active = rosterFilterActive(filter);
  const revealed = useMemo(() => revealGroups(roster, folded, filter), [roster, folded, filter]);
  // Temporary folds only exist while the filter is up: clearing it drops them and the saved list shows
  // through untouched, exactly as the owner left it before searching.
  if (!active && tempFolded.length > 0) setTempFolded([]);
  const shownOpen = useMemo(() => openRevealedGroups(revealed, tempFolded), [revealed, tempFolded]);

  // Same grouping and ordering as before (members by status, groups by their best member), only over the
  // cards the filter leaves visible. groupByProvider keeps the roster's own order inside each provider.
  const groups = useMemo(() => {
    const grouped = new Map<string, Card[]>();
    for (const card of visible) {
      const provider = cardProvider(card);
      const list = grouped.get(provider);
      if (list) list.push(card);
      else grouped.set(provider, [card]);
    }
    return Array.from(grouped.entries())
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
  }, [visible]);

  const totalByProvider = useMemo(() => {
    const counts = new Map<string, number>();
    for (const card of roster) {
      const provider = cardProvider(card);
      counts.set(provider, (counts.get(provider) ?? 0) + 1);
    }
    return counts;
  }, [roster]);

  const toggleFold = (provider: string) => {
    const next = toggleGroupFold(provider, { filterActive: active, rememberedFolded: folded, tempFolded });
    setFolded(next.rememberedFolded);
    setTempFolded(next.tempFolded);
    if (next.persist) saveFoldedProviders(foldStorage(), projectId, next.rememberedFolded);
  };

  return (
    <aside
      className="guild roster"
      aria-labelledby="guildTitle"
      onMouseLeave={() => onHoverCard(null)}
    >
      <header className="sec-head">
        <span className="eyebrow">ROSTER</span>
        <h2 id="guildTitle">{t('guild.title')}</h2>
      </header>
      <p className="hint">
        {t('guild.hint')}
      </p>
      <RosterFilters
        idPrefix="guild"
        compact
        value={filter}
        options={options}
        total={roster.length}
        visible={visible.length}
        onChange={setFilter}
      />
      {!projectId ? (
        <p className="hint" role="status">
          {t('roster.noProject')}
        </p>
      ) : null}
      <div id="guild">
        {visible.length === 0 && active ? (
          <p className="guild-empty">
            {t('guild.empty', { count: roster.length })}
          </p>
        ) : null}
        {groups.map((group) => {
          const open = shownOpen.has(group.provider);
          const total = totalByProvider.get(group.provider) ?? group.members.length;
          return (
            <div key={group.provider}>
              <h4 className="guild-group">
                <button
                  type="button"
                  className="guild-group-toggle"
                  aria-expanded={open}
                  style={{ borderLeftColor: providerAccent(group.provider) }}
                  title={active
                    ? (open ? t('guild.tempCollapse') : t('guild.tempExpand'))
                    : (open ? t('guild.collapse', { provider: group.provider }) : t('guild.expand', { provider: group.provider }))}
                  onClick={() => toggleFold(group.provider)}
                >
                  <span className="guild-fold-caret" aria-hidden="true">
                    {open ? '▾' : '▸'}
                  </span>
                  <span
                    className="provider-mark"
                    style={{ color: providerAccent(group.provider) }}
                    aria-hidden="true"
                  >
                    {providerMark(group.provider)}
                  </span>
                  <span className="guild-group-name" title={group.provider}>
                    {group.provider}
                  </span>
                  {group.lane ? <span>{group.lane}</span> : null}
                  <span className="guild-group-count">
                    {active
                      ? t('guild.countFiltered', { visible: group.members.length, total })
                      : t('rosterFilters.count', { total })}
                  </span>
                </button>
              </h4>
              {open
                ? (() => {
                    // FB2-07 item 5: batch-imported cards that never delivered fold behind a per-group
                    // subsection by default; the owner expands it explicitly to drag one.
                    const unproven = group.members.filter((member) => member.importedFrom && member.neverDelivered);
                    const proven = group.members.filter((member) => !(member.importedFrom && member.neverDelivered));
                    const renderCard = (member: Card) => (
                      <CardBadge
                        key={member.id}
                        card={member}
                        busyQuests={busyQuests(snap, member.id)}
                        failure={failureForCard(snap, member.id)}
                        isDragging={draggingCardId === member.id}
                        onEdit={onEditCard}
                        onHover={onHoverCard}
                        onDragStart={onDragStart}
                        onDragEnd={onDragEnd}
                      />
                    );
                    const unprovenOpen = unprovenOpenGroups.has(group.provider);
                    return (
                      <>
                        {proven.map(renderCard)}
                        {unproven.length ? (
                          <div className="guild-unproven">
                            <button
                              type="button"
                              className="guild-unproven-toggle"
                              aria-expanded={unprovenOpen}
                              onClick={() => toggleUnproven(group.provider)}
                            >
                              <span className="guild-fold-caret" aria-hidden="true">{unprovenOpen ? '▾' : '▸'}</span>
                              {t('guild.unproven', { count: unproven.length })}
                            </button>
                            {unprovenOpen ? unproven.map(renderCard) : null}
                          </div>
                        ) : null}
                      </>
                    );
                  })()
                : null}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
