import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { Quest } from '../api/types';
import { KIND } from '../lib/labels';
import { kindShape, pinColor, questStatusLine } from '../lib/mapLook';

export interface QuestNodeData extends Record<string, unknown> {
  quest: Quest;
  isFocus?: boolean;
  /** Roster name of the adventurer working on it, when there is one. */
  adventurerName?: string;
  dropClass?: string;
  /** The refusal reason, or the accept hint, shown before a drop lands — the same text the board wall shows. */
  dropHint?: string;
  onSelect?: (questId: string) => void;
}

export type QuestNodeType = Node<QuestNodeData, 'quest'>;

export function QuestNode({ id, data }: NodeProps<QuestNodeType>) {
  const quest = data.quest;
  const isFocus = Boolean(data.isFocus);
  const dropClass = (data.dropClass as string) || '';
  const dropHint = (data.dropHint as string) || '';
  const color = quest ? pinColor(quest.status) : '#9a8b72';
  const statusLine = quest ? questStatusLine(quest, data.adventurerName) : '';
  const kindLabel = quest.kind ? KIND[quest.kind] || quest.kind : '';

  const openQuest = () => data.onSelect?.(quest.id);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    openQuest();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openQuest();
    }
  };

  const classNames = [
    'rf-quest-node',
    isFocus ? 'focused' : '',
    dropClass,
  ]
    .filter(Boolean)
    .join(' ');

  // The visible id/kind/title/status text already carries this, but a screen reader landing on the node
  // announces it in one pass instead of stitching several child elements together.
  const ariaLabel = `${quest.id}${kindLabel ? ` ${kindLabel}` : ''}：${quest.title}${statusLine ? `，${statusLine}` : ''}`;

  return (
    <div
      className={classNames}
      data-quest={quest.id}
      data-id={id}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
    >
      <Handle
        type="target"
        position={Position.Left}
        style={{ opacity: 0, width: 1, height: 1 }}
      />
      <div
        className="map-pin"
        style={{ backgroundColor: color }}
        aria-hidden="true"
      />
      <div className="place">
        <span className="id mono">
          {/* Colour already carries status; the kind needs its own shape so it does not ride on colour alone. */}
          <span className={`kind-icon kind-icon-${kindShape(quest.kind)}`} aria-hidden="true" />
          {quest.id}
          {kindLabel ? ` · ${kindLabel}` : ''}
        </span>
        <b className="title" title={quest.title}>
          {quest.title}
        </b>
        <span className="status-line">{statusLine}</span>
        {/* The same reason text the board wall shows before a drop, so a queue-only or refused drop reads
            the same here as it does there, instead of only a colour the drop then contradicts. Always
            rendered (map.css reserves its line height) so the hint appearing/disappearing during a drag
            never grows the node and covers whatever sits below it. */}
        <span className={`drop-hint ${dropClass}`}>{dropHint}</span>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        style={{ opacity: 0, width: 1, height: 1 }}
      />
    </div>
  );
}
