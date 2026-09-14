import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Background, Controls, MiniMap, ReactFlow, ReactFlowProvider,
  useEdgesState, useNodesInitialized, useNodesState, useReactFlow, type Edge, type Node,
} from '@xyflow/react';
import type { Quest, QuestStatus, Snapshot } from '../api/types';
import { isQueueOnly } from '../lib/board';
import { questAtPoint } from '../lib/graphHit';
import { buildGraph } from '../lib/graphLayout';
import { type PlacedCard, placedCardNodes } from '../lib/graphPlaced';
import { applyPositions, loadPositions, type NodePositions, savePositions } from '../lib/graphPositions';
import { getDropVerdict } from '../lib/questState';
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
  // The card the owner is dragging from the guild column, as a fallback when a browser gives no drag data.
  pickingCardId?: string | null;
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

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// The box dagre lays out in graphLayout, so a dropped model lands centred under the cursor.
const NODE_WIDTH = 180;
const NODE_HEIGHT = 50;

function GraphViewInner({
  snap,
  questIds,
  focusId,
  compact = false,
  onSelectQuest,
  onOpenWorkOrder,
  setDragging,
  pickingCardId,
}: GraphViewProps) {
  const reactFlow = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  // The drawer shows a second, compact graph while the main one is mounted. React Flow names its background
  // pattern after this id, and two <pattern> elements sharing an id collide, so give every instance its own.
  const backgroundId = useId().replace(/:/g, '');

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
  // Models the owner dropped on empty canvas: buildGraph only knows cards that already dispatched something,
  // so without these a model that has never worked has no node to drag onto a quest.
  const [placedCards, setPlacedCards] = useState<PlacedCard[]>([]);
  // Quest nodes the owner dragged to tidy the main graph. Kept apart from the layout because every snapshot
  // rebuilds the nodes from dagre, which would snap a moved node straight back. The drawer's small graph is for
  // navigation, so its nodes stay fixed and nothing is remembered for it.
  const [movedPositions, setMovedPositions] = useState<NodePositions>(() =>
    compact ? {} : loadPositions(browserStorage()),
  );

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
    const laidOut = graphData.nodes.map((node) => {
      if (node.type === 'quest') {
        const dropClass = intersectingQuests[node.id] || '';
        return {
          ...node,
          draggable: !compact,
          className: dropClass,
          data: { ...node.data, dropClass, onSelect: onSelectQuest },
        };
      }
      return { ...node, draggable: true };
    });
    const placed = placedCardNodes(
      placedCards,
      snap.roster,
      new Set(graphData.nodes.map((n) => n.id)),
    );
    for (const n of [...graphData.nodes, ...placed]) {
      layoutPositionsRef.current.set(n.id, { ...n.position });
    }
    setNodes([...applyPositions(laidOut, movedPositions), ...placed]);
    setEdges(visibleEdges);
  }, [graphData, onSelectQuest, intersectingQuests, movedPositions, placedCards, snap.roster, setNodes, setEdges, visibleEdges]);

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

  // Same verdict-to-class rule the board wall uses, so a drop here reads the same as a drop there.
  const dropClassFor = useCallback(
    (questId: string, cardId: string) => {
      const quest = snap.quests.find((q) => q.id === questId);
      const verdict = quest ? getDropVerdict(snap, quest, cardId) : undefined;
      const isOpen = quest ? OPEN_STATUSES.includes(quest.status) : false;
      if (verdict?.ok) return 'drop-ok ok';
      if (isOpen && isQueueOnly(verdict)) return 'drop-queue queue';
      return 'drop-no refused drop-refused';
    },
    [snap],
  );

  const questUnderPointer = useCallback(
    (clientX: number, clientY: number) => questAtPoint(reactFlow.getNodes(), reactFlow.screenToFlowPosition({ x: clientX, y: clientY })),
    [reactFlow],
  );

  // A card dragged from the guild column is an ordinary HTML drag, not a React Flow node drag: without these
  // the graph silently refuses every drop, and a model that has never been dispatched has no node to drag.
  const handleGuildDragOver = useCallback(
    (event: React.DragEvent) => {
      if (!onOpenWorkOrder) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const cardId = pickingCardId;
      const questId = questUnderPointer(event.clientX, event.clientY);
      const next = cardId && questId ? { [questId]: dropClassFor(questId, cardId) } : {};
      const current = currentIntersectionRef.current;
      const same = Object.keys(next).length === Object.keys(current).length && Object.entries(next).every(([k, v]) => current[k] === v);
      if (!same) {
        currentIntersectionRef.current = next;
        setIntersectingQuests(next);
      }
    },
    [dropClassFor, onOpenWorkOrder, pickingCardId, questUnderPointer],
  );

  const clearGuildHighlight = useCallback(() => {
    if (!Object.keys(currentIntersectionRef.current).length) return;
    currentIntersectionRef.current = {};
    setIntersectingQuests({});
  }, []);

  const handleGuildDrop = useCallback(
    (event: React.DragEvent) => {
      if (!onOpenWorkOrder) return;
      event.preventDefault();
      clearGuildHighlight();
      const cardId = event.dataTransfer.getData('text/plain') || pickingCardId || '';
      if (!cardId) return;
      const questId = questUnderPointer(event.clientX, event.clientY);
      if (questId) {
        onOpenWorkOrder(questId, cardId);
        return;
      }
      // Empty canvas: put the model on the graph, so it can be dragged onto a quest from here.
      const point = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const x = Math.round(point.x - NODE_WIDTH / 2);
      const y = Math.round(point.y - NODE_HEIGHT / 2);
      setPlacedCards((prev) => [...prev.filter((p) => p.cardId !== cardId), { cardId, x, y }]);
    },
    [clearGuildHighlight, onOpenWorkOrder, pickingCardId, questUnderPointer, reactFlow],
  );

  const handleNodeDragStart = useCallback(
    (_event: React.MouseEvent | MouseEvent | TouchEvent, _node: Node) => {
      // Hold snapshot updates for any node drag: each update rebuilds the nodes from the layout, which snapped a
      // quest node being moved straight back under the pointer.
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
        const quest = snap.quests.find((q) => q.id === targetQuestId);
        const verdict = quest ? getDropVerdict(snap, quest, cardId) : undefined;
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
    [reactFlow, snap],
  );

  const handleNodeDragStop = useCallback(
    (event: React.MouseEvent | MouseEvent | TouchEvent, node: Node) => {
      // A quest node is moved only to tidy the graph: remember where the owner put it, and nothing else.
      if (node.type === 'quest') {
        setDragging?.(false);
        if (compact) return;
        const next = {
          ...movedPositions,
          [node.id]: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
        };
        setMovedPositions(next);
        savePositions(browserStorage(), next);
        return;
      }
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

      // A node the owner placed stays where they drag it; one dagre laid out springs back to its slot.
      if (!targetQuestId && placedCards.some((p) => p.cardId === node.id)) {
        const x = Math.round(node.position.x);
        const y = Math.round(node.position.y);
        layoutPositionsRef.current.set(node.id, { x, y });
        setPlacedCards((prev) => prev.map((p) => (p.cardId === node.id ? { ...p, x, y } : p)));
        return;
      }

      const orig = layoutPositionsRef.current.get(node.id);
      if (orig) {
        setNodes((nds) => nds.map((n) => (n.id === node.id ? { ...n, position: { ...orig } } : n)));
        reactFlow.updateNode(node.id, { position: { ...orig } });
      }
    },
    [compact, movedPositions, onOpenWorkOrder, placedCards, reactFlow, setDragging, setNodes],
  );

  const resetLayout = () => {
    setMovedPositions({});
    savePositions(browserStorage(), {});
  };

  // Removing a placed node must forget the placement too, or the next recompute would put it straight back.
  const handleNodesDelete = useCallback((deleted: Node[]) => {
    const ids = new Set(deleted.map((n) => n.id));
    setPlacedCards((prev) => prev.filter((p) => !ids.has(p.cardId)));
  }, []);

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
      onNodesDelete={handleNodesDelete}
      onNodeDragStart={handleNodeDragStart}
      onNodeDrag={handleNodeDrag}
      onNodeDragStop={handleNodeDragStop}
      minZoom={0.2}
      maxZoom={2}
    >
      <Background id={backgroundId} color="#c9b48f" gap={24} size={1} />
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
          把名册里的卡拖到空白处，就能把这个模型放上图；再拖到委托上派工，选中按 Delete 移走。
          委托节点可以拖动整理位置，会记住。
        </span>
        <span style={{ display: 'flex', gap: 6 }}>
          {Object.keys(movedPositions).length > 0 ? (
            <button
              type="button"
              className="btn"
              style={{ padding: '2px 8px', fontSize: 11, whiteSpace: 'nowrap' }}
              title="忘掉手动拖过的位置，回到自动排版"
              onClick={resetLayout}
            >
              重新排版
            </button>
          ) : null}
          <button
            type="button"
            className="btn"
            style={{ padding: '2px 8px', fontSize: 11, whiteSpace: 'nowrap' }}
            onClick={() => setShowConflicts((prev) => !prev)}
          >
            {showConflicts ? '隐藏文件冲突' : '显示文件冲突'}
          </button>
        </span>
      </p>
      <div
        style={{ flex: 1, width: '100%', minHeight: 400 }}
        onDragOver={handleGuildDragOver}
        onDragLeave={clearGuildHighlight}
        onDrop={handleGuildDrop}
      >
        {flowContent}
      </div>
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
