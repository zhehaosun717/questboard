import { useState } from 'react';
import { ApiError, api } from '../api/client';
import type { Card, Quest } from '../api/types';

interface WorkOrderModalProps {
  quest: Quest;
  card: Card;
  onClose: () => void;
  onSuccess: () => void;
}

export function WorkOrderModal({
  quest,
  card,
  onClose,
  onSuccess,
}: WorkOrderModalProps) {
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const handleConfirm = async () => {
    setSubmitting(true);
    setErrors([]);
    try {
      await api.assign(quest.id, card.id);
      onSuccess();
    } catch (err) {
      setSubmitting(false);
      if (err instanceof ApiError && err.reasons.length > 0) {
        setErrors(err.reasons.map((r) => r.message));
      } else if (err instanceof Error) {
        setErrors([err.message]);
      } else {
        setErrors([String(err)]);
      }
    }
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div
        className="order"
        role="dialog"
        aria-modal="true"
        aria-labelledby="orderTitle"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="eyebrow">WORK ORDER · 派遣令</p>
        <h2 id="orderTitle">
          派 <em>{card.name}</em> 去做 <em>{quest.id}</em>
        </h2>
        <dl className="order-lines">
          <dt>委托</dt>
          <dd>{quest.title}</dd>
          <dt>冒险者</dt>
          <dd>
            {card.provider} · {card.lane}
          </dd>
          <dt>模型</dt>
          <dd>
            <code>
              {card.model}
              {card.variant ? ` · ${card.variant}` : ''}
            </code>
          </dd>
          <dt>BRIEF</dt>
          <dd>
            <code>{quest.brief}</code>
          </dd>
        </dl>
        {card.billing === 'payg' && (
          <div className="warn-tape">⚠ 按量付费通道，会直接花钱</div>
        )}
        {quest.status === 'stalled' && (
          <div className="warn-tape">
            ⚠ 上一个 worker 卡住了，但可能还在改文件。确认它已经停了再派。
          </div>
        )}
        {errors.length > 0 && (
          <div id="assignError">
            <ul className="reasons">
              {errors.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="row end">
          <button className="btn ghost" type="button" onClick={onClose}>
            算了
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={submitting}
            onClick={handleConfirm}
            autoFocus
          >
            盖章派遣
          </button>
        </div>
      </div>
    </div>
  );
}
