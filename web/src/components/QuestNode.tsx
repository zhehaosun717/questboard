import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { Quest } from '../api/types';
import { KIND, NODE_COLORS, STATUS } from '../lib/labels';

export interface QuestNodeData extends Record<string, unknown> {
  quest: Quest;
  isFocus?: boolean;
  dropClass?: string;
  onSelect?: (questId: string) => void;
}

export type QuestNodeType = Node<QuestNodeData, 'quest'>;

export function QuestNode({ id, data }: NodeProps<QuestNodeType>) {
  const quest = data.quest;
  const isFocus = Boolean(data.isFocus);
  const dropClass = (data.dropClass as string) || '';
  const color = (quest && NODE_COLORS[quest.status]) || '#857b70';
  const shortTitle = quest ? (quest.title || '').slice(0, 11) : '';

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    data.onSelect?.(quest.id);
  };

  const classNames = [
    'rf-quest-node',
    isFocus ? 'focused' : '',
    dropClass,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={classNames}
      data-quest={quest.id}
      data-id={id}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          data.onSelect?.(quest.id);
        }
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        style={{ opacity: 0, width: 1, height: 1 }}
      />
      <div className="rf-quest-bar" style={{ backgroundColor: color }} />
      <div className="rf-quest-body">
        <span className="g-id">{quest.id}</span>
        <span className="g-sub">
          {KIND[quest.kind] || quest.kind} · {STATUS[quest.status] || quest.status} · {shortTitle}
        </span>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        style={{ opacity: 0, width: 1, height: 1 }}
      />
    </div>
  );
}
