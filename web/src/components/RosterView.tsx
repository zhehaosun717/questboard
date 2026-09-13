import { useState } from 'react';
import type { Card, Snapshot } from '../api/types';
import { CardModal } from './CardModal';
import { OmoSection } from './roster/OmoSection';
import { RosterCardFormModal } from './roster/RosterCardFormModal';
import { RosterCardTable } from './roster/RosterCardTable';
import { RosterDeleteModal } from './roster/RosterDeleteModal';

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

  const lanes = snap.project?.lanes ?? [];

  return (
    <div className="roster-view-container">
      <header className="roster-view-header">
        <div>
          <span className="eyebrow">ROSTER &amp; MODELS</span>
          <h2>冒险者与模型</h2>
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
          <h3>公会名册 ({snap.roster?.length ?? 0})</h3>
          <p className="hint">
            管理当前项目可派工的冒险者工牌。通道推断出的工牌不能直接编辑。
          </p>
        </div>

        <RosterCardTable
          cards={snap.roster ?? []}
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
