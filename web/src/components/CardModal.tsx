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

function failureTimeLabel(iso: string): string {
  if (!Number.isFinite(Date.parse(iso))) return iso.slice(0, 40);
  return `${formatMonthDay(iso)} ${formatClock(iso)}`;
}

export function CardModal({ card, failure, onOpenQuest, onClose, onSuccess, onError }: CardModalProps) {
  const [status, setStatus] = useState<CardStatus>(card.status);
  const [reason, setReason] = useState<string>(card.statusReason || '');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
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
        <label htmlFor="advStatus">STATUS 状态</label>
        <select
          id="advStatus"
          value={status}
          onChange={(e) => setStatus(e.target.value as CardStatus)}
        >
          {Object.entries(CARD_STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <label htmlFor="advNote">
          REASON 原因（会显示在冒险者上，写明为什么、到什么时候）
        </label>
        <input
          id="advNote"
          maxLength={300}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
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
