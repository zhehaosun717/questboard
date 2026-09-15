import { useMemo, useState } from 'react';
import type { Card, Snapshot } from '../api/types';
import {
  EMPTY_ROSTER_FILTER,
  buildRosterFilterOptions,
  filterRosterCards,
  rosterFilterActive,
  type RosterFilterState,
} from '../lib/rosterFilter';
import { CardModal } from './CardModal';
import { OmoSection } from './roster/OmoSection';
import { RosterCardFormModal } from './roster/RosterCardFormModal';
import { RosterCardTable } from './roster/RosterCardTable';
import { RosterDeleteModal } from './roster/RosterDeleteModal';
import { RosterFilters } from './roster/RosterFilters';

interface RosterViewProps {
  snap: Snapshot;
  refresh: () => void;
  pushToast: (msg: string) => void;
}

export function RosterView({ snap, refresh, pushToast }: RosterViewProps) {
  const [statusCard, setStatusCard] = useState<Card | null>(null);
  const [formModal, setFormModal] = useState<{
    isOpen: boolean;
    card?: Card;
    duplicate?: boolean;
  }>({ isOpen: false });
  const [deleteCard, setDeleteCard] = useState<Card | null>(null);
  const [filter, setFilter] = useState<RosterFilterState>(EMPTY_ROSTER_FILTER);

  const lanes = snap.project?.lanes ?? [];
  const roster = snap.roster ?? [];
  const options = useMemo(() => buildRosterFilterOptions(roster), [roster]);
  const visible = useMemo(() => filterRosterCards(roster, filter), [roster, filter]);
  const filterActive = rosterFilterActive(filter);

  return (
    <div className="roster-view-container">
      <header className="roster-view-header">
        <div>
          <span className="eyebrow">ROSTER (MODELS)</span>
          <h2>冒险者（模型）</h2>
        </div>
        <div>
          <button
            className="btn primary new-adv-btn"
            type="button"
            onClick={() => setFormModal({ isOpen: true })}
          >
            ＋ 新冒险者
          </button>
        </div>
      </header>

      <section className="roster-section-cards">
        <div className="roster-sec-title-row">
          <h3>公会名册 ({filterActive ? `筛出 ${visible.length} / 共 ${roster.length}` : roster.length})</h3>
          <p className="hint">
            管理当前项目可派工的冒险者。每位冒险者就是一个配置好的模型运行档（模型 + 变体 + 接入方式）。接入方式推断出的冒险者不能直接编辑。
          </p>
        </div>

        <RosterFilters
          idPrefix="roster"
          value={filter}
          options={options}
          total={roster.length}
          visible={visible.length}
          onChange={setFilter}
        />

        {!snap.project?.id ? (
          <p className="hint" role="status">
            服务器没有提供项目标识：折叠只影响本页，不会被记住，也不会和其他项目串用。
          </p>
        ) : null}

        <RosterCardTable
          cards={roster}
          filter={filter}
          projectId={snap.project?.id ?? ''}
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
          onClose={() => setStatusCard(null)}
          onSuccess={() => {
            setStatusCard(null);
            refresh();
            pushToast(`已更新「${statusCard.name}」状态`);
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
              formModal.card && !formModal.duplicate ? '已保存冒险者' : '已添加新冒险者',
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
            pushToast(`已除名「${deleteCard.name}」`);
          }}
        />
      ) : null}
    </div>
  );
}
