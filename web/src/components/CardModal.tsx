import { useState } from 'react';
import { api } from '../api/client';
import type { Card, CardStatus } from '../api/types';
import { CARD_STATUS } from '../lib/labels';

interface CardModalProps {
  card: Card;
  onClose: () => void;
  onSuccess: () => void;
  onError: (msg: string) => void;
}

export function CardModal({ card, onClose, onSuccess, onError }: CardModalProps) {
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
          <dt>通道</dt>
          <dd>
            {card.provider} · {card.lane}
          </dd>
        </dl>
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
          REASON 原因（会显示在工牌上，写明为什么、到什么时候）
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
