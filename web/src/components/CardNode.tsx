import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { Card } from '../api/types';

export interface CardNodeData extends Record<string, unknown> {
  card: Card;
}

export type CardNodeType = Node<CardNodeData, 'card'>;

export function CardNode({ data }: NodeProps<CardNodeType>) {
  const card = data.card;
  const shortModel = card.model.length > 24 ? card.model.slice(-24) : card.model;

  return (
    <div className="rf-card-node" data-adv={card.id}>
      <Handle
        type="source"
        position={Position.Right}
        style={{ opacity: 0, width: 1, height: 1 }}
      />
      <div className="rf-card-dot" />
      <div className="rf-card-body">
        <span className="rf-card-name g-sub">{card.name || card.id}</span>
        <span className="rf-card-model g-sub">{shortModel}</span>
      </div>
    </div>
  );
}
