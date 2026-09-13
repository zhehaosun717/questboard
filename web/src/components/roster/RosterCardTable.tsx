import type { Card } from '../../api/types';
import { formatMonthDay } from '../../lib/board';
import { BILLING, CARD_STATUS } from '../../lib/labels';

interface RosterCardTableProps {
  cards: Card[];
  onOpenStatus: (card: Card) => void;
  onEdit: (card: Card) => void;
  onDuplicate: (card: Card) => void;
  onDelete: (card: Card) => void;
}

export function RosterCardTable({
  cards,
  onOpenStatus,
  onEdit,
  onDuplicate,
  onDelete,
}: RosterCardTableProps) {
  if (cards.length === 0) {
    return <div className="empty">名册中暂无冒险者</div>;
  }

  return (
    <div className="roster-table-wrap">
      <table className="roster-table">
        <thead>
          <tr>
            <th>冒险者</th>
            <th>服务商</th>
            <th>通道</th>
            <th>模型 / 代理</th>
            <th>计费</th>
            <th>并发</th>
            <th>专长</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {cards.map((card) => {
            const isDerived = Boolean(card.derived);
            const billingLabel = card.billing
              ? BILLING[card.billing] ?? card.billing
              : '-';

            return (
              <tr key={card.id} className={isDerived ? 'row-derived' : ''}>
                <td>
                  <div className="adv-cell-name">
                    <strong>{card.name}</strong>
                    <code className="adv-cell-id">{card.id}</code>
                  </div>
                </td>
                <td>{card.provider}</td>
                <td>
                  <span className="lane-chip">{card.lane}</span>
                </td>
                <td>
                  <div className="adv-cell-model">
                    <span>
                      {card.model}
                      {card.variant ? ` · ${card.variant}` : ''}
                    </span>
                    {card.agent ? (
                      <span className="adv-agent-badge">{card.agent}</span>
                    ) : null}
                  </div>
                </td>
                <td>
                  <span className={card.billing === 'payg' ? 'pay' : ''}>
                    {billingLabel}
                  </span>
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
                      <i className={`led ${card.status === 'available' ? 'ok' : card.status === 'limited' ? 'warn' : 'bad'}`} />
                      <span className={`st-label st-${card.status}`}>
                        {CARD_STATUS[card.status] ?? card.status}
                      </span>
                    </div>
                    {card.statusSince ? (
                      <span className="status-since">
                        {formatMonthDay(card.statusSince)} 起
                      </span>
                    ) : null}
                    {card.statusReason ? (
                      <span className="status-reason" title={card.statusReason}>
                        {card.statusReason}
                      </span>
                    ) : null}
                    {isDerived ? (
                      <span className="derived-hint">
                        由通道数据推断，不在名册里
                      </span>
                    ) : null}
                  </div>
                </td>
                <td className="adv-cell-actions">
                  <div className="action-buttons">
                    <button
                      className="btn action-btn"
                      type="button"
                      onClick={() => onOpenStatus(card)}
                    >
                      改状态
                    </button>
                    <button
                      className="btn action-btn"
                      type="button"
                      disabled={isDerived}
                      title={isDerived ? '由通道数据推断，不在名册里' : undefined}
                      onClick={() => onEdit(card)}
                    >
                      编辑
                    </button>
                    <button
                      className="btn action-btn"
                      type="button"
                      disabled={isDerived}
                      title={isDerived ? '由通道数据推断，不在名册里' : '照这张工牌再开一张，只改要改的'}
                      onClick={() => onDuplicate(card)}
                    >
                      复制
                    </button>
                    <button
                      className="btn action-btn danger-text"
                      type="button"
                      disabled={isDerived}
                      title={isDerived ? '由通道数据推断，不在名册里' : undefined}
                      onClick={() => onDelete(card)}
                    >
                      删除
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
