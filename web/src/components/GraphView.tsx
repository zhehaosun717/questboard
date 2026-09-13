import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background, Controls, MiniMap, ReactFlow, ReactFlowProvider,
  useEdgesState, useNodesInitialized, useNodesState, useReactFlow, type Edge, type Node,
} from '@xyflow/react';
import type { Quest, QuestStatus, Snapshot } from '../api/types';
import { isQueueOnly } from '../lib/board';
import { questAtPoint } from '../lib/graphHit';
import { buildGraph } from '../lib/graphLayout';
import { NODE_COLORS, OPEN_STATUSES } from '../lib/labels';
import { CardNode } from './CardNode';
import { QuestNode } from './QuestNode';

export interface GraphViewProps {
  snap: Snapshot;
  questIds?: string[];
  focusId?: string | null;
  compact?: boolean;
  onSelectQuest: (questId: string) => void;
  onOpenWorkOrder?: (questId: string, cardId: string) => void;
  setDragging?: (dragging: boolean) => void;
}

export function getGraphQuestIds(snap: Snapshot): string[] {
  const archived = new Set<QuestStatus>(['done', 'superseded', 'cancelled']);
  const active = snap.quests.filter((q) => !archived.has(q.status));
  const questMap = new Map(snap.quests.map((q) => [q.id, q]));
  const ids = new Set(active.map((q) => q.id));
  for (const q of active) {
    for (const p of q.parents || []) {
      if (questMap.has(p)) ids.add(p);
    }
  }
  return Array.from(ids);
}

function getEventClientPos(event: React.MouseEvent | MouseEvent | TouchEvent): { x: number; y: number } | null {
  if ('clientX' in event && typeof event.clientX === 'number') return { x: event.clientX, y: event.clientY };
  const touch = (event as TouchEvent).touches?.[0] || (event as TouchEvent).changedTouches?.[0];
  return touch && typeof touch.clientX === 'number' ? { x: touch.clientX, y: touch.clientY } : null;
}

const nodeTypes = { quest: QuestNode, card: CardNode };

function GraphViewInner({
  snap,
  questIds,
  focusId,
  compact = false,
  onSelectQuest,
  onOpenWorkOrder,
  setDragging,
}: GraphViewProps) {
  const reactFlow = useReactFlow();
  const nodesInitialized = useNodesInitialized();

  const targetQuestIds = useMemo(() => {
    return questIds ?? getGraphQuestIds(snap);
  }, [questIds, snap]);

  const graphData = useMemo(() => {
    return buildGraph(snap, targetQuestIds, focusId);
  }, [snap, targetQuestIds, focusId]);

  const [showConflicts, setShowConflicts] = useState(false);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [intersectingQuests, setIntersectingQuests] = useState<Record<string, string>>({});

  const layoutPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const currentIntersectionRef = useRef<Record<string, string>>({});
  const lastFitQuestIdsKeyRef = useRef<string | null>(null);

  const questIdsKey = useMemo(() => [...targetQuestIds].sort().join(','), [targetQuestIds]);

  const visibleEdges = useMemo(() => {
    if (compact || showConflicts) {
      return graphData.edges;
    }
    return graphData.edges.filter((e) => e.data?.kind !== 'conflict');
  }, [compact, showConflicts, graphData.edges]);

  useEffect(() => {
    for (const n of graphData.nodes) {
      layoutPositionsRef.current.set(n.id, { ...n.position });
    }
    setNodes(
      graphData.nodes.map((node) => {
        if (node.type === 'quest') {
          const dropClass = intersectingQuests[node.id] || '';
          return {
            ...node,
            draggable: false,
            className: dropClass,
            data: { ...node.data, dropClass, onSelect: onSelectQuest },
          };
        }
        return { ...node, draggable: true };
      }),
    );
    setEdges(visibleEdges);
  }, [graphData, onSelectQuest, intersectingQuests, setNodes, setEdges, visibleEdges]);

  // fitView does nothing until React Flow has measured the nodes, so wait for that before fitting.
  useEffect(() => {
    if (!nodesInitialized || nodes.length === 0 || targetQuestIds.length === 0) return;
    if (lastFitQuestIdsKeyRef.current === questIdsKey) return;

    lastFitQuestIdsKeyRef.current = questIdsKey;
    const padding = compact ? 0.12 : 0.2;
    const timer = setTimeout(() => {
      void reactFlow.fitView({ padding });
    }, 50);
    return () => clearTimeout(timer);
  }, [compact, nodes.length, nodesInitialized, questIdsKey, reactFlow, targetQuestIds.length]);

  const handleNodeDragStart = useCallback(
    (_event: React.MouseEvent | MouseEvent | TouchEvent, node: Node) => {
      if (node.type !== 'card') return;
      setDragging?.(true);
    },
    [setDragging],
  );

  const handleNodeDrag = useCallback(
    (event: React.MouseEvent | MouseEvent | TouchEvent, node: Node) => {
      if (node.type !== 'card') return;
      const cardId = node.id;

      const clientPos = getEventClientPos(event);
      const targetQuestId = clientPos
        ? questAtPoint(reactFlow.getNodes(), reactFlow.screenToFlowPosition(clientPos))
        : null;

      const newMap: Record<string, string> = {};
      if (targetQuestId) {
        const verdict = snap.eligibility[targetQuestId]?.[cardId];
        const quest = snap.quests.find((q) => q.id === targetQuestId);
        const isOpen = quest ? OPEN_STATUSES.includes(quest.status) : false;

        if (verdict?.ok) {
          newMap[targetQuestId] = 'drop-ok ok';
        } else if (!verdict?.ok && isOpen && isQueueOnly(verdict)) {
          newMap[targetQuestId] = 'drop-queue queue';
        } else {
          newMap[targetQuestId] = 'drop-no refused drop-refused';
        }
      }

      const questDoms = document.querySelectorAll('.react-flow__node-quest, .rf-quest-node');
      questDoms.forEach((el) => {
        const qid = (el as HTMLElement).dataset.id || (el as HTMLElement).dataset.quest;
        if (!qid) return;
        const cls = newMap[qid];
        el.classList.toggle('drop-ok', Boolean(cls?.includes('drop-ok')));
        el.classList.toggle('ok', Boolean(cls?.includes('ok')));
        el.classList.toggle('drop-queue', Boolean(cls?.includes('drop-queue')));
        el.classList.toggle('queue', Boolean(cls?.includes('queue')));
        el.classList.toggle('drop-no', Boolean(cls?.includes('drop-no')));
        el.classList.toggle('refused', Boolean(cls?.includes('refused')));
      });

      const curKeys = Object.keys(currentIntersectionRef.current);
      const newKeys = Object.keys(newMap);
      const changed =
        curKeys.length !== newKeys.length ||
        newKeys.some((k) => currentIntersectionRef.current[k] !== newMap[k]);

      if (changed) {
        currentIntersectionRef.current = newMap;
        setIntersectingQuests(newMap);
      }
    },
    [reactFlow, snap.eligibility, snap.quests],
  );

  const handleNodeDragStop = useCallback(
    (event: React.MouseEvent | MouseEvent | TouchEvent, node: Node) => {
      if (node.type !== 'card') return;

      setDragging?.(false);
      currentIntersectionRef.current = {};
      setIntersectingQuests({});

      const questDoms = document.querySelectorAll('.react-flow__node-quest, .rf-quest-node');
      questDoms.forEach((el) => {
        el.classList.remove('drop-ok', 'ok', 'drop-queue', 'queue', 'drop-no', 'refused', 'drop-refused');
      });

      const clientPos = getEventClientPos(event);
      const targetQuestId = clientPos
        ? questAtPoint(reactFlow.getNodes(), reactFlow.screenToFlowPosition(clientPos))
        : null;

      if (targetQuestId && onOpenWorkOrder) {
        onOpenWorkOrder(targetQuestId, node.id);
      }

      const orig = layoutPositionsRef.current.get(node.id);
      if (orig) {
        setNodes((nds) => nds.map((n) => (n.id === node.id ? { ...n, position: { ...orig } } : n)));
        reactFlow.updateNode(node.id, { position: { ...orig } });
      }
    },
    [onOpenWorkOrder, reactFlow, setDragging, setNodes],
  );

  if (targetQuestIds.length === 0) {
    return (
      <div id={compact ? undefined : 'graphView'} className="graph-wrap">
        <div className="empty">没有进行中的委托</div>
      </div>
    );
  }

  const flowContent = (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={nodeTypes}
      onNodeClick={(_event, node) => {
        if (node.type === 'quest') onSelectQuest(node.id);
      }}
      onNodeDragStart={handleNodeDragStart}
      onNodeDrag={handleNodeDrag}
      onNodeDragStop={handleNodeDragStop}
      minZoom={0.2}
      maxZoom={2}
    >
      <Background color="#c9b48f" gap={24} size={1} />
      {!compact && <Controls />}
      {!compact && (
        <MiniMap
          nodeColor={(n) => {
            if (n.type === 'card') return '#2f2a25';
            const q = (n.data as { quest?: Quest })?.quest;
            return (q && NODE_COLORS[q.status]) || '#857b70';
          }}
          maskColor="rgba(19, 17, 13, 0.7)"
        />
      )}
    </ReactFlow>
  );

  if (compact) {
    return <div style={{ width: '100%', height: '100%' }}>{flowContent}</div>;
  }

  return (
    <div
      id="graphView"
      className="graph-wrap"
      style={{ height: '64vh', minHeight: 480, display: 'flex', flexDirection: 'column' }}
    >
      <p
        className="hint"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        <span>
          实线：父任务 → 子任务（编码 → 审核 → 修复）。虚线：冒险者做过的委托，绿色表示正在做。红点线：文件冲突。点节点看档案。
        </span>
        <button
          type="button"
          className="btn"
          style={{ padding: '2px 8px', fontSize: 11, whiteSpace: 'nowrap' }}
          onClick={() => setShowConflicts((prev) => !prev)}
        >
          {showConflicts ? '隐藏文件冲突' : '显示文件冲突'}
        </button>
      </p>
      <div style={{ flex: 1, width: '100%', minHeight: 400 }}>{flowContent}</div>
    </div>
  );
}

export function GraphView(props: GraphViewProps) {
  return (
    <ReactFlowProvider>
      <GraphViewInner {...props} />
    </ReactFlowProvider>
  );
}
