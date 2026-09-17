import { useEffect, useMemo, useState } from 'react';
import type { Card } from '../../api/types';
import { groupByProvider } from '../../lib/rosterGroups';
import {
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
} from '../../lib/rosterFilter';
import { useT } from '../../lib/i18n';
import { RosterCardRow } from './RosterCardRow';

interface RosterCardTableProps {
  /** The full roster; the table applies the shared filter itself so folding and reveal see the same cards. */
  cards: Card[];
  filter: RosterFilterState;
  /** Saved fold choices are namespaced per project by this opaque id (Snapshot.project.id). '' = old server: folds are not remembered. */
  projectId: string;
  onOpenStatus: (card: Card) => void;
  onEdit: (card: Card) => void;
  onDuplicate: (card: Card) => void;
  onDelete: (card: Card) => void;
}

const COLUMN_COUNT = 8;
const groupAnchor = (index: number) => `roster-provider-${index}`;

// One section per provider: a flat list of 28 cards made one model hard to find. The chips jump to a section,
// the section header folds its rows away, and the fold choice is remembered per project (QB-FB-B). While a
// filter is up, toggling is a temporary display change only — the remembered list survives the search.
export function RosterCardTable({ cards, filter, projectId, onOpenStatus, onEdit, onDuplicate, onDelete }: RosterCardTableProps) {
  const t = useT();
  const [folded, setFolded] = useState<string[]>(() => loadFoldedProviders(foldStorage(), projectId));
  const [tempFolded, setTempFolded] = useState<string[]>([]);

  useEffect(() => {
    setFolded(loadFoldedProviders(foldStorage(), projectId));
    setTempFolded([]);
  }, [projectId]);

  const active = rosterFilterActive(filter);
  const visible = useMemo(() => filterRosterCards(cards, filter), [cards, filter]);
  const revealed = useMemo(() => revealGroups(cards, folded, filter), [cards, folded, filter]);
  // Clearing the search drops the temporary folds: the saved choices show through exactly as before.
  if (!active && tempFolded.length > 0) setTempFolded([]);
  const shownOpen = useMemo(() => openRevealedGroups(revealed, tempFolded), [revealed, tempFolded]);

  if (cards.length === 0) {
    return <div className="empty">{t('rosterTable.empty')}</div>;
  }
  if (visible.length === 0) {
    return <div className="empty">{t('rosterTable.noMatch', { count: cards.length })}</div>;
  }

  const groups = groupByProvider(visible);

  const toggle = (provider: string) => {
    const next = toggleGroupFold(provider, { filterActive: active, rememberedFolded: folded, tempFolded });
    setFolded(next.rememberedFolded);
    setTempFolded(next.tempFolded);
    if (next.persist) saveFoldedProviders(foldStorage(), projectId, next.rememberedFolded);
  };

  // Scroll first, then unfold: the section header is always rendered (folding hides only the rows below it),
  // and unfolding a section never moves its own header. The jump is instant on purpose — waiting a frame or
  // animating with behavior:'smooth' both did nothing in a window the browser was not repainting. While a
  // filter is up, jumping only clears this group's temporary fold — saved folds are nobody's business here.
  const jump = (provider: string, index: number) => {
    document.getElementById(groupAnchor(index))?.scrollIntoView({ block: 'start' });
    if (active) setTempFolded(tempFolded.filter((p) => p !== provider));
    else if (folded.includes(provider)) {
      const next = folded.filter((p) => p !== provider);
      setFolded(next);
      saveFoldedProviders(foldStorage(), projectId, next);
    }
  };

  return (
    <>
      <nav className="provider-jump" aria-label={t('rosterTable.jumpLabel')}>
        {groups.map((group, index) => (
          <button
            key={group.provider}
            type="button"
            className={group.available === 0 ? 'provider-chip none-free' : 'provider-chip'}
            title={t('rosterTable.chipTitle', {
              provider: group.provider,
              count: group.cards.length,
              available: group.available,
            })}
            onClick={() => jump(group.provider, index)}
          >
            {group.provider}
            <span>{group.cards.length}</span>
          </button>
        ))}
      </nav>

      <div className="roster-table-wrap">
        <table className="roster-table">
          <thead>
            <tr>
              <th>{t('rosterTable.colName')}</th>
              <th>{t('rosterTable.colLane')}</th>
              <th>{t('rosterTable.colModel')}</th>
              <th>{t('rosterTable.colBilling')}</th>
              <th>{t('rosterTable.colParallel')}</th>
              <th>{t('rosterTable.colStrengths')}</th>
              <th>{t('rosterTable.colStatus')}</th>
              <th>{t('rosterTable.colActions')}</th>
            </tr>
          </thead>
          {groups.map((group, index) => {
            // A live search opens every group that has a match; a temporary fold from the toggle sits on top;
            // the remembered fold returns unchanged when the search clears.
            const isFolded = !shownOpen.has(group.provider);
            return (
              <tbody key={group.provider} className="provider-group">
                <tr id={groupAnchor(index)} className="provider-row">
                  <th colSpan={COLUMN_COUNT}>
                    <button
                      type="button"
                      className="provider-toggle"
                      aria-expanded={!isFolded}
                      style={{ borderLeftColor: providerAccent(group.provider) }}
                      onClick={() => toggle(group.provider)}
                    >
                      <span className="provider-caret" aria-hidden="true">
                        {isFolded ? '▸' : '▾'}
                      </span>
                      <span
                        className="provider-mark"
                        style={{ color: providerAccent(group.provider) }}
                        aria-hidden="true"
                      >
                        {providerMark(group.provider)}
                      </span>
                      <span className="provider-name">{group.provider}</span>
                      <span className="provider-count">
                        {active && group.cards.length !== cards.length ? t('rosterTable.matchedPrefix') : ''}
                        {t('rosterTable.providerCount', { count: group.cards.length, available: group.available })}
                      </span>
                      <span className="provider-lanes">
                        {group.lanes.map((lane) => (
                          <span key={lane} className="lane-chip">
                            {lane}
                          </span>
                        ))}
                      </span>
                    </button>
                  </th>
                </tr>
                {isFolded
                  ? null
                  : group.cards.map((card) => (
                      <RosterCardRow
                        key={card.id}
                        card={card}
                        onOpenStatus={onOpenStatus}
                        onEdit={onEdit}
                        onDuplicate={onDuplicate}
                        onDelete={onDelete}
                      />
                    ))}
              </tbody>
            );
          })}
        </table>
      </div>
    </>
  );
}
