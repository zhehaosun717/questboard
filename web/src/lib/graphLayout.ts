import type { Edge, Node } from '@xyflow/react';
import * as dagre from 'dagre';
import type { Card, Quest, Snapshot } from '../api/types';

export interface GraphData {
  nodes: Node[];
  edges: Edge[];
}

const NODE_WIDTH = 180;
const NODE_HEIGHT = 50;

export function buildGraph(
  snap: Snapshot,
  questIds: string[],
  focusId?: string | null,
): GraphData {
  const questsById = new Map<string, Quest>(snap.quests.map((q) => [q.id, q]));
  const relevantQuests = questIds
    .map((id) => questsById.get(id))
    .filter((q): q is Quest => Boolean(q));
  const relevantQuestIds = new Set<string>(relevantQuests.map((q) => q.id));

  // Collect distinct cards that dispatched any of these quests
  const cardIdsSet = new Set<string>();
  for (const q of relevantQuests) {
    for (const d of q.dispatches || []) {
      if (d.adventurerId) {
        cardIdsSet.add(d.adventurerId);
      }
    }
  }
  const cardIds = Array.from(cardIdsSet);
  const rosterMap = new Map<string, Card>(snap.roster.map((c) => [c.id, c]));

  // Setup dagre graph
  const d = (dagre as { default?: typeof dagre }).default ?? dagre;
  const g = new d.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 20, ranksep: 50 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const q of relevantQuests) {
    g.setNode(q.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  for (const cardId of cardIds) {
    g.setNode(cardId, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  // Parent -> Child edges in dagre (parents before children)
  for (const q of relevantQuests) {
    for (const p of q.parents || []) {
      if (p !== q.id && relevantQuestIds.has(p)) {
        g.setEdge(p, q.id);
      }
    }
  }

  // Card -> Quest edges in dagre (cards that dispatched placed before it)
  for (const q of relevantQuests) {
    for (const d of q.dispatches || []) {
      if (d.adventurerId && cardIdsSet.has(d.adventurerId)) {
        g.setEdge(d.adventurerId, q.id);
      }
    }
  }

  d.layout(g);

  // Build React Flow nodes
  const nodes: Node[] = [];

  for (const q of relevantQuests) {
    const info = g.node(q.id) as { x: number; y: number } | undefined;
    const x = info ? Math.round(info.x - NODE_WIDTH / 2) : 0;
    const y = info ? Math.round(info.y - NODE_HEIGHT / 2) : 0;

    nodes.push({
      id: q.id,
      type: 'quest',
      position: { x, y },
      data: {
        quest: q,
        isFocus: q.id === focusId,
        adventurerName: q.assignee ? snap.roster.find((card) => card.id === q.assignee?.adventurerId)?.name : undefined,
      },
    });
  }

  for (const cardId of cardIds) {
    const info = g.node(cardId) as { x: number; y: number } | undefined;
    const x = info ? Math.round(info.x - NODE_WIDTH / 2) : 0;
    const y = info ? Math.round(info.y - NODE_HEIGHT / 2) : 0;
    const card: Card = rosterMap.get(cardId) ?? {
      id: cardId,
      name: cardId,
      provider: '',
      lane: '',
      model: '',
      family: '',
      status: 'available',
      statusSince: null,
      statusReason: '',
      statusSetBy: null,
    };

    const isWorking = snap.quests.some(
      (q) => q.status === 'dispatched' && q.assignee?.adventurerId === cardId,
    );

    nodes.push({
      id: cardId,
      type: 'card',
      position: { x, y },
      data: {
        card,
        isWorking,
      },
    });
  }

  // Build React Flow edges
  const edges: Edge[] = [];

  // 1. Parent -> Child (dashed dark-ink trails)
  for (const q of relevantQuests) {
    for (const p of q.parents || []) {
      if (p !== q.id && relevantQuestIds.has(p)) {
        edges.push({
          id: `${p}->${q.id}`,
          source: p,
          target: q.id,
          type: 'default',
          style: {
            stroke: '#2b2118',
            strokeWidth: 2,
            strokeDasharray: '6 5',
          },
        });
      }
    }
  }

  // 2. Card -> Quest (dashed blue: #3f6f9e when running, #9cc2e8 when past)
  const cardQuestSeen = new Set<string>();
  for (const q of relevantQuests) {
    for (const d of q.dispatches || []) {
      const cardId = d.adventurerId;
      if (!cardId || !cardIdsSet.has(cardId)) continue;
      const edgeId = `${cardId}->${q.id}`;
      if (cardQuestSeen.has(edgeId)) continue;
      cardQuestSeen.add(edgeId);

      const isRunning = q.assignee?.adventurerId === cardId && q.status === 'dispatched';
      edges.push({
        id: edgeId,
        source: cardId,
        target: q.id,
        type: 'default',
        style: {
          stroke: isRunning ? '#3f6f9e' : '#9cc2e8',
          strokeWidth: isRunning ? 2.6 : 1.4,
          strokeDasharray: '6 5',
        },
      });
    }
  }

  // 3. Conflicts (dotted wax red #a8322a)
  const conflictSeen = new Set<string>();
  for (const q of relevantQuests) {
    for (const c of q.conflicts || []) {
      if (c !== q.id && relevantQuestIds.has(c)) {
        const pairKey = q.id < c ? `${q.id}--${c}` : `${c}--${q.id}`;
        if (!conflictSeen.has(pairKey)) {
          conflictSeen.add(pairKey);
          edges.push({
            id: `conflict:${pairKey}`,
            source: q.id,
            target: c,
            type: 'default',
            data: { kind: 'conflict' },
            style: {
              stroke: '#a8322a',
              strokeWidth: 1.6,
              strokeDasharray: '2 5',
            },
          });
        }
      }
    }
  }

  return { nodes, edges };
}
