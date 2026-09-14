import { useState } from 'react';
import type { Card } from '../../api/types';
import { groupByProvider } from '../../lib/rosterGroups';
import { RosterCardRow } from './RosterCardRow';

interface RosterCardTableProps {
  cards: Card[];
  onOpenStatus: (card: Card) => void;
  onEdit: (card: Card) => void;
  onDuplicate: (card: Card) => void;
  onDelete: (card: Card) => void;
}

const COLUMN_COUNT = 8;
const groupAnchor = (index: number) => `roster-provider-${index}`;

// One section per provider: a flat list of 28 cards made one model hard to find. The chips jump to a section,
// and a section header folds its rows away.
export function RosterCardTable({ cards, onOpenStatus, onEdit, onDuplicate, onDelete }: RosterCardTableProps) {
  const [folded, setFolded] = useState<readonly string[]>([]);

  if (cards.length === 0) {
    return <div className="empty">名册中暂无冒险者</div>;
  }

  const groups = groupByProvider(cards);

  const toggle = (provider: string) =>
    setFolded((prev) => (prev.includes(provider) ? prev.filter((p) => p !== provider) : [...prev, provider]));

  // Scroll first, then unfold: the section header is always rendered (folding hides only the rows below it),
  // and unfolding a section never moves its own header. The jump is instant on purpose — waiting a frame or
  // animating with behavior:'smooth' both did nothing in a window the browser was not repainting.
  const jump = (provider: string, index: number) => {
    document.getElementById(groupAnchor(index))?.scrollIntoView({ block: 'start' });
    setFolded((prev) => (prev.includes(provider) ? prev.filter((p) => p !== provider) : prev));
  };

  return (
    <>
      <nav className="provider-jump" aria-label="按服务商跳转">
        {groups.map((group, index) => (
          <button
            key={group.provider}
            type="button"
            className={group.available === 0 ? 'provider-chip none-free' : 'provider-chip'}
            title={`跳到 ${group.provider}：${group.cards.length} 张，空闲 ${group.available}`}
            onClick={() => jump(group.provider, index)}
          >
            {group.provider}
            <span>{group.cards.length}</span>
          </button>
        ))}
      </nav>

      <div className="roster-table-wrap">
        <table className="roster-table">
          <thead>
            <tr>
              <th>冒险者</th>
              <th>接入方式</th>
              <th>模型 / 代理</th>
              <th>计费</th>
              <th>并发</th>
              <th>专长</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          {groups.map((group, index) => {
            const isFolded = folded.includes(group.provider);
            return (
              <tbody key={group.provider} className="provider-group">
                <tr id={groupAnchor(index)} className="provider-row">
                  <th colSpan={COLUMN_COUNT}>
                    <button
                      type="button"
                      className="provider-toggle"
                      aria-expanded={!isFolded}
                      onClick={() => toggle(group.provider)}
                    >
                      <span className="provider-caret" aria-hidden="true">
                        {isFolded ? '▸' : '▾'}
                      </span>
                      <span className="provider-name">{group.provider}</span>
                      <span className="provider-count">
                        {group.cards.length} 张 · 空闲 {group.available}
                      </span>
                      <span className="provider-lanes">
                        {group.lanes.map((lane) => (
                          <span key={lane} className="lane-chip">
                            {lane}
                          </span>
                        ))}
                      </span>
                    </button>
                  </th>
                </tr>
                {isFolded
                  ? null
                  : group.cards.map((card) => (
                      <RosterCardRow
                        key={card.id}
                        card={card}
                        onOpenStatus={onOpenStatus}
                        onEdit={onEdit}
                        onDuplicate={onDuplicate}
                        onDelete={onDelete}
                      />
                    ))}
              </tbody>
            );
          })}
        </table>
      </div>
    </>
  );
}
