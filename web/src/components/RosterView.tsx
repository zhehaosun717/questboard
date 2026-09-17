import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import type { Card, Snapshot } from '../api/types';
import { failureForCard, failureQuestExists } from '../api/failureTypes';
import {
  EMPTY_ROSTER_FILTER,
  buildRosterFilterOptions,
  cardProvider,
  filterRosterCards,
  foldedProvidersFromTable,
  foldStorage,
  loadFoldedProviders,
  rosterFilterActive,
  type RosterFilterState,
} from '../lib/rosterFilter';
import { useT } from '../lib/i18n';
import { CardModal } from './CardModal';
import { BulkActions } from './roster/BulkActions';
import { OmoSection } from './roster/OmoSection';
import { RosterCardFormModal } from './roster/RosterCardFormModal';
import { RosterCardTable } from './roster/RosterCardTable';
import { RosterDeleteModal } from './roster/RosterDeleteModal';
import { RosterFilters } from './roster/RosterFilters';

interface RosterViewProps {
  snap: Snapshot;
  refresh: () => void;
  pushToast: (msg: string) => void;
  onOpenQuest?: (questId: string) => void;
}

export function RosterView({ snap, refresh, pushToast, onOpenQuest }: RosterViewProps) {
  const t = useT();
  const [statusCard, setStatusCard] = useState<Card | null>(null);
  const [formModal, setFormModal] = useState<{
    isOpen: boolean;
    card?: Card;
    duplicate?: boolean;
  }>({ isOpen: false });
  const [deleteCard, setDeleteCard] = useState<Card | null>(null);
  const [filter, setFilter] = useState<RosterFilterState>(EMPTY_ROSTER_FILTER);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const lanes = snap.project?.lanes ?? [];
  const roster = snap.roster ?? [];
  const projectId = snap.project?.id ?? '';
  const rosterSource = useMemo(() => JSON.stringify({ projectId: projectId || null, roster }), [projectId, roster]);
  const [selectionSource, setSelectionSource] = useState(rosterSource);
  const options = useMemo(() => buildRosterFilterOptions(roster), [roster]);
  const visible = useMemo(() => filterRosterCards(roster, filter), [roster, filter]);
  const filterActive = rosterFilterActive(filter);
  const [foldedState, setFoldedState] = useState<{ projectId: string; providers: string[] }>(() => ({
    projectId,
    providers: loadFoldedProviders(foldStorage(), projectId),
  }));
  const foldedProviders = foldedState.projectId === projectId ? foldedState.providers : [];
  const visibleRows = useMemo(
    () => visible.filter((card) => !foldedProviders.includes(cardProvider(card))),
    [foldedProviders, visible],
  );
  // Do not let the one render between a new snapshot and the clearing effect expose the old selection.
  const currentSelection = selectionSource === rosterSource ? selectedIds : [];

  // The selection is a view of one exact roster source. A project switch or any refreshed source snapshot
  // clears it, so a delayed preview cannot silently act on a card the owner is no longer looking at.
  useEffect(() => {
    setSelectedIds([]);
    setSelectionSource(rosterSource);
  }, [rosterSource]);

  // The table persists its own fold click synchronously, but the same-tab storage event never fires.
  // Read the rendered provider buttons after their click so the bulk bar follows the exact groups the
  // owner can currently see, including temporary folds while a filter is active.
  useEffect(() => {
    setFoldedState({ projectId, providers: filterActive ? [] : loadFoldedProviders(foldStorage(), projectId) });
  }, [filterActive, projectId]);

  useEffect(() => {
    const onStorage = () => {
      if (!filterActive) setFoldedState({ projectId, providers: loadFoldedProviders(foldStorage(), projectId) });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [filterActive, projectId]);

  const syncFoldedProvidersFromTable = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (typeof Element === 'undefined' || !(target instanceof Element) || !target.closest('button.provider-toggle, button.provider-chip')) return;
    const container = event.currentTarget;
    window.setTimeout(() => {
      const providers = foldedProvidersFromTable([...container.querySelectorAll<HTMLButtonElement>('button.provider-toggle')].map((button) => ({
        provider: button.querySelector('.provider-name')?.textContent?.trim() ?? '',
        expanded: button.getAttribute('aria-expanded') === 'true',
      })));
      setFoldedState({ projectId, providers });
    }, 0);
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };
  const selectVisible = () => {
    // Use the same live fold state that drives the visible-row count. A fold is a display choice, not a
    // reason to silently include the hidden rows.
    const cards = visible.filter((card) => !foldedProviders.includes(cardProvider(card)));
    setSelectedIds((current) => [...new Set([...current, ...cards.map((card) => card.id)])]);
  };
  const selectMatching = () => {
    setSelectedIds((current) => [...new Set([...current, ...visible.map((card) => card.id)])]);
  };

  // The recent-failure note is offered only for the card being opened, and the drawer link only when
  // that quest is part of this project — an entry from another project opens nothing.
  const statusFailure = statusCard ? failureForCard(snap, statusCard.id) : null;
  const canOpenStatusFailure = failureQuestExists(snap, statusFailure);

  return (
    <div className="roster-view-container" onClick={syncFoldedProvidersFromTable}>
      <header className="roster-view-header">
        <div>
          <span className="eyebrow">{t('roster.eyebrow')}</span>
          <h2>{t('roster.title')}</h2>
        </div>
        <div>
          <button
            className="btn primary new-adv-btn"
            type="button"
            onClick={() => setFormModal({ isOpen: true })}
          >
            {t('roster.new')}
          </button>
        </div>
      </header>

      <section className="roster-section-cards">
        <div className="roster-sec-title-row">
          <h3>
            {t('roster.heading')}{' '}
            ({filterActive
              ? t('roster.headingFiltered', { visible: visible.length, total: roster.length })
              : roster.length})
          </h3>
          <p className="hint">{t('roster.hint')}</p>
        </div>

        <RosterFilters
          idPrefix="roster"
          value={filter}
          options={options}
          total={roster.length}
          visible={visible.length}
          onChange={setFilter}
        />

        <BulkActions
          sourceToken={rosterSource}
          matchingCards={visible}
          visibleCards={visibleRows}
          selectedIds={currentSelection}
          onToggle={toggleSelected}
          onSelectPage={selectVisible}
          onSelectAllMatching={selectMatching}
          onClear={() => setSelectedIds([])}
          refresh={refresh}
          pushToast={pushToast}
        />

        {!snap.project?.id ? (
          <p className="hint" role="status">
            {t('roster.noProject')}
          </p>
        ) : null}

        <RosterCardTable
          cards={roster}
          filter={filter}
          projectId={projectId}
          onOpenStatus={setStatusCard}
          onEdit={(card) => setFormModal({ isOpen: true, card })}
          onDuplicate={(card) => setFormModal({ isOpen: true, card, duplicate: true })}
          onDelete={setDeleteCard}
        />
      </section>

      <section className="roster-section-omo">
        <OmoSection pushToast={pushToast} />
      </section>

      {statusCard ? (
        <CardModal
          card={statusCard}
          failure={statusFailure}
          onOpenQuest={
            onOpenQuest && canOpenStatusFailure
              ? (questId) => {
                  setStatusCard(null);
                  onOpenQuest(questId);
                }
              : undefined
          }
          onClose={() => setStatusCard(null)}
          onSuccess={() => {
            setStatusCard(null);
            refresh();
            pushToast(t('roster.toast.statusUpdated', { name: statusCard.name }));
          }}
          onError={pushToast}
        />
      ) : null}

      {formModal.isOpen ? (
        <RosterCardFormModal
          card={formModal.card}
          duplicate={formModal.duplicate}
          lanes={lanes}
          onClose={() => setFormModal({ isOpen: false })}
          onSuccess={() => {
            setFormModal({ isOpen: false });
            refresh();
            pushToast(
              formModal.card && !formModal.duplicate ? t('roster.toast.saved') : t('roster.toast.added'),
            );
          }}
        />
      ) : null}

      {deleteCard ? (
        <RosterDeleteModal
          card={deleteCard}
          onClose={() => setDeleteCard(null)}
          onSuccess={() => {
            setDeleteCard(null);
            refresh();
            pushToast(t('roster.toast.removed', { name: deleteCard.name }));
          }}
        />
      ) : null}
    </div>
  );
}
