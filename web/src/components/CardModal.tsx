import { useState } from 'react';
import { api } from '../api/client';
import type { Card, CardStatus } from '../api/types';
import type { RecentFailure } from '../api/failureTypes';
import { formatClock, formatMonthDay } from '../lib/board';
import { CARD_STATUS } from '../lib/labels';
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
  if (iso === null) return '时间未知';
  if (!Number.isFinite(Date.parse(iso))) return iso.slice(0, 40);
  return `${formatMonthDay(iso)} ${formatClock(iso)}`;
}

function derivedTimeLabel(derived: NonNullable<Card['derived']>): string {
  const judged = derived.at ? `${formatMonthDay(derived.at)} ${formatClock(derived.at)} 判断` : '';
  const reset = derived.resetsAt
    ? `预计 ${formatMonthDay(derived.resetsAt)} ${formatClock(derived.resetsAt)} 恢复`
    : '重置时间未知';
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
      onError(`保存失败：${msg}`);
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
        <p className="eyebrow">ID CARD · 冒险者档案</p>
        <h2 id="idTitle">{card.name}</h2>
        <dl className="order-lines">
          <dt>模型</dt>
          <dd>
            <code>{card.model}</code>
          </dd>
          <dt>接入方式</dt>
          <dd>
            {card.provider} · {card.lane}
          </dd>
        </dl>
        {failure ? (
          <section className="fail-block" aria-label="最近一次执行失败">
            <p className="fail-title">最近一次执行失败</p>
            <dl className="order-lines fail-lines">
              <dt>任务</dt>
              <dd>
                <code>{failure.questId}</code>
              </dd>
              <dt>时间</dt>
              <dd>{failureTimeLabel(failure.at)}</dd>
            </dl>
            {failure.summary ? <p className="fail-summary">{failure.summary}</p> : null}
            {onOpenQuest ? (
              <button
                className="btn ghost fail-open"
                type="button"
                onClick={() => onOpenQuest(failure.questId)}
              >
                查看任务
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
            <p>自动判断：{card.derived.reason}</p>
            <p>{derivedTimeLabel(card.derived)}</p>
            <button className="btn ghost" type="button" onClick={handleConfirmRestored}>
              确认额度已恢复
            </button>
            <p>只是登记，不会向服务商核实额度是否真的恢复。</p>
          </div>
        ) : null}
        <label htmlFor="advStatus">STATUS 状态</label>
        <select id="advStatus" value={status} onChange={handleStatusChange}>
          {Object.entries(CARD_STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <label htmlFor="advNote">
          REASON 原因（会显示在冒险者上，写明为什么、到什么时候）
        </label>
        <input id="advNote" maxLength={300} value={reason} onChange={handleReasonChange} />
        <div className="row end">
          <button className="btn ghost" type="button" onClick={onClose}>
            算了
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={saving}
            onClick={handleSave}
            autoFocus
          >
            盖章保存
          </button>
        </div>
      </div>
    </div>
  );
}
