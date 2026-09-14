import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { Quest } from '../api/types';
import { KIND } from '../lib/labels';
import { pinColor, questStatusLine } from '../lib/mapLook';

export interface QuestNodeData extends Record<string, unknown> {
  quest: Quest;
  isFocus?: boolean;
  /** Roster name of the adventurer working on it, when there is one. */
  adventurerName?: string;
  dropClass?: string;
  onSelect?: (questId: string) => void;
}

export type QuestNodeType = Node<QuestNodeData, 'quest'>;

export function QuestNode({ id, data }: NodeProps<QuestNodeType>) {
  const quest = data.quest;
  const isFocus = Boolean(data.isFocus);
  const dropClass = (data.dropClass as string) || '';
  const color = quest ? pinColor(quest.status) : '#9a8b72';
  const statusLine = quest ? questStatusLine(quest, data.adventurerName) : '';

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
      <div
        className="map-pin"
        style={{ backgroundColor: color }}
        title={`${quest.id} (${quest.status})`}
      />
      <div className="place">
        <span className="id mono">
          {quest.id}
          {quest.kind ? ` · ${KIND[quest.kind] || quest.kind}` : ''}
        </span>
        <b className="title" title={quest.title}>
          {quest.title}
        </b>
        <span className="status-line">{statusLine}</span>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        style={{ opacity: 0, width: 1, height: 1 }}
      />
    </div>
  );
}
