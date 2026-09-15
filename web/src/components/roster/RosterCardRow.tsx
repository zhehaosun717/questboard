import type { Card } from '../../api/types';
import { formatMonthDay } from '../../lib/board';
import { BILLING, CARD_STATUS } from '../../lib/labels';

export interface RosterCardRowProps {
  card: Card;
  onOpenStatus: (card: Card) => void;
  onEdit: (card: Card) => void;
  onDuplicate: (card: Card) => void;
  onDelete: (card: Card) => void;
}

const DERIVED_HINT = '由接入方式数据推断，不在名册里';

export function RosterCardRow({ card, onOpenStatus, onEdit, onDuplicate, onDelete }: RosterCardRowProps) {
  const isDerived = Boolean(card.derived);
  const billingLabel = card.billing ? BILLING[card.billing] ?? card.billing : '-';
  const led = card.status === 'available' ? 'ok' : card.status === 'limited' ? 'warn' : 'bad';
  const fullModel = `${card.model}${card.variant ? ` · ${card.variant}` : ''}`;

  return (
    <tr className={isDerived ? 'row-derived' : ''}>
      <td>
        <div className="adv-cell-name">
          <strong title={`冒险者：${card.name}（${card.provider || '未填服务商'} · ${card.lane}）`}>{card.name}</strong>
          <code className="adv-cell-id" title={`编号：${card.id}`}>{card.id}</code>
        </div>
      </td>
      <td>
        <span className="lane-chip">{card.lane}</span>
      </td>
      <td>
        <div className="adv-cell-model" title={`模型标识：${fullModel}`}>
          <span title={`完整模型标识：${card.model}${card.variant ? `（变体 ${card.variant}）` : ''}`}>
            {card.model}
            {card.variant ? ` · ${card.variant}` : ''}
          </span>
          {card.agent ? <span className="adv-agent-badge">{card.agent}</span> : null}
        </div>
      </td>
      <td>
        <span className={card.billing === 'payg' ? 'pay' : ''}>{billingLabel}</span>
      </td>
      <td>{card.maxParallel ?? 1}</td>
      <td className="adv-cell-strengths">
        {card.strengths && card.strengths.length > 0 ? (
          <div className="strengths-tags">
            {card.strengths.map((s) => (
              <span key={s} className="tag-strength">
                {s}
              </span>
            ))}
          </div>
        ) : (
          <span className="muted">-</span>
        )}
      </td>
      <td>
        <div className="adv-cell-status">
          <div className="status-row">
            <i className={`led ${led}`} />
            <span className={`st-label st-${card.status}`}>{CARD_STATUS[card.status] ?? card.status}</span>
          </div>
          {card.statusSince ? <span className="status-since">{formatMonthDay(card.statusSince)} 起</span> : null}
          {card.statusReason ? (
            <span className="status-reason" title={card.statusReason}>
              {card.statusReason}
            </span>
          ) : null}
          {isDerived ? <span className="derived-hint">{DERIVED_HINT}</span> : null}
        </div>
      </td>
      <td className="adv-cell-actions">
        <div className="action-buttons">
          <button className="btn action-btn" type="button" onClick={() => onOpenStatus(card)}>
            改状态
          </button>
          <button
            className="btn action-btn"
            type="button"
            disabled={isDerived}
            title={isDerived ? DERIVED_HINT : undefined}
            onClick={() => onEdit(card)}
          >
            编辑
          </button>
          <button
            className="btn action-btn"
            type="button"
            disabled={isDerived}
            title={isDerived ? DERIVED_HINT : '照这位冒险者再开一位，只改要改的'}
            onClick={() => onDuplicate(card)}
          >
            复制
          </button>
          <button
            className="btn action-btn danger-text"
            type="button"
            disabled={isDerived}
            title={isDerived ? DERIVED_HINT : undefined}
            onClick={() => onDelete(card)}
          >
            删除
          </button>
        </div>
      </td>
    </tr>
  );
}
