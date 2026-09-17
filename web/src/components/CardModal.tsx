import { useState } from 'react';
import { api } from '../api/client';
import type { Card, CardStatus } from '../api/types';
import type { RecentFailure } from '../api/failureTypes';
import { formatClock, formatMonthDay } from '../lib/board';
import { CARD_STATUS } from '../lib/labels';
import { t, useT } from '../lib/i18n';
import '../styles/failure-note.css';

interface CardModalProps {
  card: Card;
  failure?: RecentFailure | null;
  onOpenQuest?: (questId: string) => void;
  onClose: () => void;
  onSuccess: () => void;
  onError: (msg: string) => void;
}

function failureTimeLabel(iso: string | null): string {
  if (iso === null) return t('cardModal.timeUnknown');
  if (!Number.isFinite(Date.parse(iso))) return iso.slice(0, 40);
  return `${formatMonthDay(iso)} ${formatClock(iso)}`;
}

function derivedTimeLabel(derived: NonNullable<Card['derived']>): string {
  const judged = derived.at ? t('cardModal.judgedAt', { date: formatMonthDay(derived.at), time: formatClock(derived.at) }) : '';
  const reset = derived.resetsAt
    ? t('cardModal.expectedReset', { date: formatMonthDay(derived.resetsAt), time: formatClock(derived.resetsAt) })
    : t('cardModal.resetUnknown');
  return [judged, reset].filter(Boolean).join(' · ');
}

const CONFIRM_RESTORED_REASON = '已手动确认额度恢复';

// A save is a genuine no-op (never written) only when nothing changed AND the owner did not just click the
// confirm action — otherwise a second 确认额度已恢复 after an earlier one (base is already `available` +
// the same fixed reason) would silently do nothing (review B1).
export function decideSave(
  current: { status: CardStatus; reason: string; confirmed: boolean },
  base: { status: CardStatus; reason: string },
): boolean {
  if (current.confirmed) return true;
  return current.status !== base.status || current.reason !== base.reason;
}

export function CardModal({ card, failure, onOpenQuest, onClose, onSuccess, onError }: CardModalProps) {
  const t = useT();
  // The manual layer, not the possibly-derived `status`/`statusReason` (feedback9: saving unchanged must
  // never persist a lane-derived "limited"). Older servers without baseStatus fall back to status, which is
  // equivalent whenever there is no derived overlay anyway.
  const baseStatus = card.baseStatus ?? card.status;
  const baseReason = card.baseReason ?? card.statusReason ?? '';
  const [status, setStatus] = useState<CardStatus>(baseStatus);
  const [reason, setReason] = useState<string>(baseReason);
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleStatusChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setStatus(e.target.value as CardStatus);
    setConfirmed(false);
  };

  const handleReasonChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setReason(e.target.value);
    setConfirmed(false);
  };

  const handleSave = async () => {
    if (!decideSave({ status, reason, confirmed }, { status: baseStatus, reason: baseReason })) {
      // Nothing the owner actually changed — never write a status here, derived or otherwise, and never
      // claim success for a write that never happened (N2).
      onClose();
      return;
    }
    setSaving(true);
    try {
      await api.setCardStatus(card.id, status, reason);
      onSuccess();
    } catch (err) {
      setSaving(false);
      const msg = err instanceof Error ? err.message : String(err);
      onError(t('cardModal.saveFailed', { error: msg }));
    }
  };

  const handleConfirmRestored = () => {
    setStatus('available');
    setReason(CONFIRM_RESTORED_REASON);
    setConfirmed(true);
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div
        className="order"
        role="dialog"
        aria-modal="true"
        aria-labelledby="idTitle"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="eyebrow">{t('cardModal.eyebrow')}</p>
        <h2 id="idTitle">{card.name}</h2>
        <dl className="order-lines">
          <dt>{t('cardModal.model')}</dt>
          <dd>
            <code>{card.model}</code>
          </dd>
          <dt>{t('cardModal.lane')}</dt>
          <dd>
            {card.provider} · {card.lane}
          </dd>
        </dl>
        {failure ? (
          <section className="fail-block" aria-label={t('cardModal.recentFailure')}>
            <p className="fail-title">{t('cardModal.recentFailure')}</p>
            <dl className="order-lines fail-lines">
              <dt>{t('cardModal.questLabel')}</dt>
              <dd>
                <code>{failure.questId}</code>
              </dd>
              <dt>{t('cardModal.timeLabel')}</dt>
              <dd>{failureTimeLabel(failure.at)}</dd>
            </dl>
            {failure.summary ? <p className="fail-summary">{failure.summary}</p> : null}
            {onOpenQuest ? (
              <button
                className="btn ghost fail-open"
                type="button"
                onClick={() => onOpenQuest(failure.questId)}
              >
                {t('cardModal.viewQuest')}
              </button>
            ) : null}
          </section>
        ) : null}
        {card.derived ? (
          // Reuses .a-note.derived (amber, tuned for the dark sidebar cards) but this note sits on the
          // .order paper's cream/cable gradient instead — amber-on-cream measures well under 4.5:1 there
          // (review B2). Override with the ink color already proven readable on this same paper (.order
          // .eyebrow, h2 em) rather than adding a rule to an unowned stylesheet.
          <div className="a-note derived" role="note" style={{ color: 'var(--ink)' }}>
            <p>{t('common.autoJudged', { reason: card.derived.reason })}</p>
            <p>{derivedTimeLabel(card.derived)}</p>
            <button className="btn ghost" type="button" onClick={handleConfirmRestored}>
              {t('cardModal.confirmRestored')}
            </button>
            <p>{t('cardModal.confirmNote')}</p>
          </div>
        ) : null}
        <label htmlFor="advStatus">{t('cardModal.statusLabel')}</label>
        <select id="advStatus" value={status} onChange={handleStatusChange}>
          {Object.entries(CARD_STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <label htmlFor="advNote">
          {t('cardModal.reasonLabel')}
        </label>
        <input id="advNote" maxLength={300} value={reason} onChange={handleReasonChange} />
        <div className="row end">
          <button className="btn ghost" type="button" onClick={onClose}>
            {t('common.neverMind')}
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={saving}
            onClick={handleSave}
            autoFocus
          >
            {t('rosterForm.submitSave')}
          </button>
        </div>
      </div>
    </div>
  );
}
