import { useState } from 'react';
import { api } from '../../api/client';
import type { Card } from '../../api/types';

interface RosterDeleteModalProps {
  card: Card;
  onClose: () => void;
  onSuccess: () => void;
}

export function RosterDeleteModal({
  card,
  onClose,
  onSuccess,
}: RosterDeleteModalProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDelete = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await api.removeCard(card.id);
      onSuccess();
    } catch (err) {
      setSubmitting(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div
        className="order delete-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="deleteTitle"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="eyebrow">REMOVE CARD · 除名</p>
        <h2 id="deleteTitle">确认除名「{card.name}」？</h2>
        <p className="delete-desc">
          冒险者 <code>{card.id}</code> 将从名册中移除。
        </p>

        {error ? <div className="warn-tape delete-error">{error}</div> : null}

        <div className="row end">
          <button className="btn ghost" type="button" onClick={onClose}>
            算了
          </button>
          <button
            className="btn danger confirm-delete-btn"
            type="button"
            disabled={submitting}
            onClick={handleDelete}
          >
            {submitting ? '正在注销…' : '确认除名'}
          </button>
        </div>
      </div>
    </div>
  );
}
