import { useState } from 'react';
import { api } from '../../api/client';
import type { Card } from '../../api/types';
import { useT } from '../../lib/i18n';

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
  const t = useT();
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
        <p className="eyebrow">{t('rosterDelete.eyebrow')}</p>
        <h2 id="deleteTitle">{t('rosterDelete.title', { name: card.name })}</h2>
        <p className="delete-desc">
          {t('rosterDelete.bodyPrefix')}<code>{card.id}</code>{t('rosterDelete.bodySuffix')}
        </p>

        {error ? <div className="warn-tape delete-error">{error}</div> : null}

        <div className="row end">
          <button className="btn ghost" type="button" onClick={onClose}>
            {t('common.neverMind')}
          </button>
          <button
            className="btn danger confirm-delete-btn"
            type="button"
            disabled={submitting}
            onClick={handleDelete}
          >
            {submitting ? t('rosterDelete.submitting') : t('rosterDelete.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
