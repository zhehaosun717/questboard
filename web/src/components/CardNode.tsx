import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { Card } from '../api/types';

export interface CardNodeData extends Record<string, unknown> {
  card: Card;
  isWorking?: boolean;
}

export type CardNodeType = Node<CardNodeData, 'card'>;

export function CardNode({ data }: NodeProps<CardNodeType>) {
  const card = data.card;
  const isWorking = Boolean(data.isWorking);
  const name = card.name || card.id;
  const letter = name.trim().charAt(0).toUpperCase() || '?';

  return (
    <div
      className={`rf-card-node ${isWorking ? 'working' : ''}`}
      data-adv={card.id}
    >
      <Handle
        type="source"
        position={Position.Right}
        style={{ top: 15, opacity: 0, width: 1, height: 1 }}
      />
      <div
        className={`token ${isWorking ? 'working' : ''}`}
        title={`${name} (${card.model})`}
      >
        {letter}
      </div>
      <span className="token-name" title={name}>
        {name}
      </span>
    </div>
  );
}
