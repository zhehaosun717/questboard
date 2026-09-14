import { useState } from 'react';
import { ApiError, api } from '../api/client';
import type { Card, Quest } from '../api/types';
import { isAwaitingSignOff } from '../lib/questState';

interface WorkOrderModalProps {
  quest: Quest;
  card: Card;
  onClose: () => void;
  onSuccess: () => void;
}

// One order for every drop. A card dropped on returned work is sent to review that work: the board writes the
// review brief and dispatches the review in one step, so the owner never has to create a review quest first.
export function WorkOrderModal({
  quest,
  card,
  onClose,
  onSuccess,
}: WorkOrderModalProps) {
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const isReview = isAwaitingSignOff(quest);

  const handleConfirm = async () => {
    setSubmitting(true);
    setErrors([]);
    try {
      if (isReview) await api.requestReview(quest.id, note.trim(), card.id);
      else await api.assign(quest.id, card.id, quest.revision);
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
        <p className="eyebrow">{isReview ? 'REVIEW ORDER · 复核令' : 'WORK ORDER · 派出令'}</p>
        <h2 id="orderTitle">
          派 <em>{card.name}</em> 去{isReview ? '复核' : '做'} <em>{quest.id}</em>
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
            {isReview ? (
              <>
                看板写一份复核简报 <code>REVIEW-{quest.id}</code>，让它对照 <code>{quest.brief}</code> 逐条核对，只读不改
              </>
            ) : (
              <code>{quest.brief}</code>
            )}
          </dd>
        </dl>
        {isReview ? (
          <textarea
            className="order-note"
            rows={2}
            placeholder="想让它重点看什么（可不写，会写进复核简报）"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        ) : null}
        {card.billing === 'payg' && (
          <div className="warn-tape">⚠ 按量付费接入方式，会直接花钱</div>
        )}
        {quest.status === 'stalled' && (
          <div className="warn-tape">
            ⚠ 上一个冒险者失联了，但可能还在改文件。确认它已经停了再派出。
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
            {isReview ? '盖章派去复核' : '盖章派出'}
          </button>
        </div>
      </div>
    </div>
  );
}
