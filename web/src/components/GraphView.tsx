import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Background, Controls, MiniMap, ReactFlow, ReactFlowProvider,
  useEdgesState, useNodesInitialized, useNodesState, useReactFlow,
  type Edge, type Node, type NodeChange,
} from '@xyflow/react';
import type { Quest, QuestStatus, Snapshot } from '../api/types';
import { cardActivity } from '../lib/cardActivity';
import { shouldSkipGraphDeleteKey } from '../lib/graphDeleteGuard';
import { canOpenWorkOrder, dropEffectFor, dropVerdictInfo, type DropVerdictInfo } from '../lib/graphDrop';
import { questAtPoint } from '../lib/graphHit';
import { buildGraph } from '../lib/graphLayout';
import { loadPlacedCards, type PlacedCard, placedCardNodes, savePlacedCards } from '../lib/graphPlaced';
import {
  applyPositions, graphInstanceKey, isCommittedPositionChange, loadPositions, type NodePositions,
  positionAfterDrop, projectIdOf, savePositions,
} from '../lib/graphPositions';
import { getDropVerdict, isAwaitingSignOff } from '../lib/questState';
import { OPEN_STATUSES } from '../lib/labels';
import { pinColor } from '../lib/mapLook';
import { CardNode } from './CardNode';
import { QuestNode } from './QuestNode';
import '../styles/map.css';

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
  // Scopes DOM-level hover bookkeeping (see handleNodeDrag/handleNodeDragStop) to this graph instance, so a
  // drag in the main graph never paints drop highlights onto the drawer's compact graph, or vice versa.
  const containerRef = useRef<HTMLDivElement>(null);

  const projectId = projectIdOf(snap);

  const targetQuestIds = useMemo(() => {
    return questIds ?? getGraphQuestIds(snap);
  }, [questIds, snap]);

  const graphData = useMemo(() => {
    return buildGraph(snap, targetQuestIds, focusId);
  }, [snap, targetQuestIds, focusId]);

  const [showConflicts, setShowConflicts] = useState(false);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  // The quest(s) currently under a drag, with the same reason text/class the board wall shows before a drop.
  const [intersectingQuests, setIntersectingQuests] = useState<Record<string, DropVerdictInfo>>({});
  // Models the owner dropped on empty canvas: buildGraph only knows cards that already dispatched something,
  // so without these a model that has never worked has no node to drag onto a quest. Persisted per project so
  // a placed model survives a reload, the same as its position (the drawer's compact graph never places one).
  const [placedCards, setPlacedCards] = useState<PlacedCard[]>(() =>
    compact ? [] : loadPlacedCards(browserStorage(), projectId),
  );
  // Quest and model nodes the owner dragged to tidy the main graph. Kept apart from the layout because every
  // snapshot rebuilds the nodes from dagre, which would snap a moved node straight back. The drawer's small
  // graph is for navigation, so its nodes stay fixed and nothing is remembered for it.
  const [movedPositions, setMovedPositions] = useState<NodePositions>(() =>
    compact ? {} : loadPositions(browserStorage(), projectId),
  );

  const layoutPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const currentIntersectionRef = useRef<Record<string, DropVerdictInfo>>({});
  const lastFitQuestIdsKeyRef = useRef<string | null>(null);
  // Selection survives a snapshot poll rebuilding every node from scratch (see the layout effect below).
  const selectedIdsRef = useRef<Set<string>>(new Set());
  // True from the moment a mouse/touch node drag starts until handleNodeDragStop has run its own position
  // bookkeeping, so the matching onNodesChange position-commit (React Flow emits one at drag end too) is not
  // also treated as a keyboard move and persisted a second time.
  const nodeDragActiveRef = useRef(false);

  const questIdsKey = useMemo(() => [...targetQuestIds].sort().join(','), [targetQuestIds]);

  const visibleEdges = useMemo(() => {
    if (compact || showConflicts) {
      return graphData.edges;
    }
    return graphData.edges.filter((e) => e.data?.kind !== 'conflict');
  }, [compact, showConflicts, graphData.edges]);

  // Rebuilds node positions/data from the layout. Deliberately does NOT depend on `intersectingQuests`: that
  // changes on every pointer move during a drag, and rebuilding every node's position from dagre/moved state
  // on each of those would snap the node actually being dragged back to its layout slot for a frame (see the
  // drop-highlight effect below, which is the one intersectingQuests actually drives).
  useEffect(() => {
    const laidOut = graphData.nodes.map((node) => {
      // Only a locally placed model is ever deletable (FAIL D): a quest or a card the graph draws from real
      // dispatch history is not something Delete/Backspace here may remove, only tidy the layout of.
      const selected = selectedIdsRef.current.has(node.id);
      if (node.type === 'quest') {
        return {
          ...node,
          draggable: !compact,
          deletable: false,
          selected,
          data: { ...node.data, dropClass: '', dropHint: '', dropWarning: undefined, onSelect: onSelectQuest },
        };
      }
      return {
        // The compact drawer graph is for navigation only: its card nodes must never be draggable, or a node
        // drag onto a quest there would dispatch, which is not a thing this view is allowed to do.
        ...node,
        draggable: !compact,
        deletable: false,
        selected,
        data: { ...node.data, activity: cardActivity(snap, node.id), onSelectQuest },
      };
    });
    const placed = placedCardNodes(
      placedCards,
      snap.roster,
      new Set(graphData.nodes.map((n) => n.id)),
    ).map((node) => {
      const isWorking = snap.quests.some(
        (q) => q.status === 'dispatched' && q.assignee?.adventurerId === node.id,
      );
      return {
        ...node,
        draggable: !compact,
        deletable: !compact,
        selected: selectedIdsRef.current.has(node.id),
        data: {
          ...node.data,
          isWorking,
          activity: cardActivity(snap, node.id),
          onSelectQuest,
        },
      };
    });
    for (const n of [...graphData.nodes, ...placed]) {
      layoutPositionsRef.current.set(n.id, { ...n.position });
    }
    // Forget the selection of any node this rebuild no longer draws at all, so it cannot resurface stuck
    // "selected" on an unrelated node that later reuses the same id.
    const liveIds = new Set([...graphData.nodes.map((n) => n.id), ...placed.map((n) => n.id)]);
    for (const id of selectedIdsRef.current) {
      if (!liveIds.has(id)) selectedIdsRef.current.delete(id);
    }
    setNodes([...applyPositions(laidOut, movedPositions), ...applyPositions(placed, movedPositions)]);
    setEdges(visibleEdges);
  }, [compact, graphData, onSelectQuest, movedPositions, placedCards, snap, setNodes, setEdges, visibleEdges]);

  // Paints the drop-target highlight (class + reason text) onto quest nodes only, leaving every node's
  // position/dragging/selected state untouched — this is what intersectingQuests is allowed to drive.
  useEffect(() => {
    setNodes((prev) =>
      prev.map((node) => {
        if (node.type !== 'quest') return node;
        const hint = intersectingQuests[node.id];
        const dropClass = hint?.cls || '';
        const dropHint = hint?.message || '';
        const dropWarning = hint?.warning;
        if (node.className === dropClass && node.data.dropClass === dropClass && node.data.dropHint === dropHint && node.data.dropWarning === dropWarning) {
          return node;
        }
        return { ...node, className: dropClass, data: { ...node.data, dropClass, dropHint, dropWarning } };
      }),
    );
  }, [intersectingQuests, setNodes]);

  // fitView does nothing until React Flow has measured the nodes, so wait for that before fitting.
  useEffect(() => {
    if (!nodesInitialized || nodes.length === 0) return;
    if (lastFitQuestIdsKeyRef.current === questIdsKey) return;

    lastFitQuestIdsKeyRef.current = questIdsKey;
    const padding = compact ? 0.12 : 0.2;
    const timer = setTimeout(() => {
      // Capped: fitting a single node (the first model placed on an otherwise empty board) would otherwise
      // zoom all the way to the canvas's maxZoom of 2, which reads as a runaway jump rather than a fit.
      void reactFlow.fitView({ padding, maxZoom: 1 });
    }, 50);
    return () => clearTimeout(timer);
  }, [compact, nodes.length, nodesInitialized, questIdsKey, reactFlow]);

  // Same verdict-to-class-and-text rule the board wall uses (QuestCard), so a drop here reads the same as a
  // drop there: queue-only reads as a refusal for drop purposes, and the reason shows before the drop lands.
  const dropInfoFor = useCallback(
    (questId: string, cardId: string): DropVerdictInfo => {
      const quest = snap.quests.find((q) => q.id === questId);
      const verdict = quest ? getDropVerdict(snap, quest, cardId) : undefined;
      const isOpen = quest ? OPEN_STATUSES.includes(quest.status) : false;
      return dropVerdictInfo(verdict, isOpen, quest ? isAwaitingSignOff(quest) : false);
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
      const cardId = pickingCardId;
      const questId = questUnderPointer(event.clientX, event.clientY);
      const hoverInfo = cardId && questId ? dropInfoFor(questId, cardId) : null;
      // No-drop over a quest that would refuse the drop or only queue it: neither opens a work order, so the
      // cursor must not promise one. Everywhere else (including empty canvas, where a drop places the model)
      // stays the normal move cursor.
      event.dataTransfer.dropEffect = dropEffectFor(hoverInfo);
      const next: Record<string, DropVerdictInfo> = questId && hoverInfo ? { [questId]: hoverInfo } : {};
      const current = currentIntersectionRef.current;
      const same =
        Object.keys(next).length === Object.keys(current).length &&
        Object.entries(next).every(([k, v]) => current[k]?.cls === v.cls && current[k]?.message === v.message && current[k]?.warning === v.warning);
      if (!same) {
        currentIntersectionRef.current = next;
        setIntersectingQuests(next);
      }
    },
    [dropInfoFor, onOpenWorkOrder, pickingCardId, questUnderPointer],
  );

  const clearGuildHighlight = useCallback(() => {
    if (!Object.keys(currentIntersectionRef.current).length) return;
    currentIntersectionRef.current = {};
    setIntersectingQuests({});
  }, []);

  // A dragleave bubbles from every child element boundary the pointer crosses, not just when it actually
  // leaves this wrapper: without the containment check, the reason text flickers off and back on every time
  // the pointer moves across a quest node's own internal borders while still over the map.
  const handleGuildDragLeave = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const related = event.relatedTarget as globalThis.Node | null;
      if (related && event.currentTarget.contains(related)) return;
      clearGuildHighlight();
    },
    [clearGuildHighlight],
  );

  const handleGuildDrop = useCallback(
    (event: React.DragEvent) => {
      if (!onOpenWorkOrder) return;
      event.preventDefault();
      clearGuildHighlight();
      const cardId = event.dataTransfer.getData('text/plain') || pickingCardId || '';
      if (!cardId) return;
      const questId = questUnderPointer(event.clientX, event.clientY);
      if (questId) {
        // Refused and queue-only both stop here: the hover highlight already showed why, and neither opens a
        // paid work order. Only a fully accepted drop does, through the existing confirmation.
        const quest = snap.quests.find((q) => q.id === questId);
        const verdict = quest ? getDropVerdict(snap, quest, cardId) : undefined;
        if (canOpenWorkOrder(verdict)) {
          onOpenWorkOrder(questId, cardId);
        }
        return;
      }
      // Empty canvas: put the model on the graph, so it can be dragged onto a quest from here. This is the
      // only way to place a model that has never been dispatched, including when there is no quest at all.
      const point = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const x = Math.round(point.x - NODE_WIDTH / 2);
      const y = Math.round(point.y - NODE_HEIGHT / 2);
      setPlacedCards((prev) => {
        const next = [...prev.filter((p) => p.cardId !== cardId), { cardId, x, y }];
        if (!compact) savePlacedCards(browserStorage(), projectId, next);
        return next;
      });
      if (!compact) {
        const next = { ...movedPositions, [cardId]: { x, y } };
        setMovedPositions(next);
        savePositions(browserStorage(), projectId, next);
      }
    },
    [clearGuildHighlight, compact, movedPositions, onOpenWorkOrder, pickingCardId, projectId, questUnderPointer, reactFlow, snap],
  );

  const handleNodeDragStart = useCallback(
    (_event: React.MouseEvent | MouseEvent | TouchEvent, _node: Node) => {
      // Hold snapshot updates for any node drag: each update rebuilds the nodes from the layout, which snapped a
      // quest node being moved straight back under the pointer.
      setDragging?.(true);
      nodeDragActiveRef.current = true;
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

      const newMap: Record<string, DropVerdictInfo> = {};
      if (targetQuestId) {
        newMap[targetQuestId] = dropInfoFor(targetQuestId, cardId);
      }

      // Scoped to this graph's own DOM subtree: a compact drawer graph and the main graph can both be
      // mounted at once, and a drag in one must never paint drop highlights in the other. This is an instant
      // visual cue only (colour), ahead of the React state update below that carries the reason text.
      const root: ParentNode = containerRef.current ?? document;
      const questDoms = root.querySelectorAll('.react-flow__node-quest, .rf-quest-node');
      questDoms.forEach((el) => {
        const qid = (el as HTMLElement).dataset.id || (el as HTMLElement).dataset.quest;
        if (!qid) return;
        const cls = newMap[qid]?.cls;
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
        newKeys.some(
          (k) => currentIntersectionRef.current[k]?.cls !== newMap[k]?.cls || currentIntersectionRef.current[k]?.message !== newMap[k]?.message || currentIntersectionRef.current[k]?.warning !== newMap[k]?.warning,
        );

      if (changed) {
        currentIntersectionRef.current = newMap;
        setIntersectingQuests(newMap);
      }
    },
    [dropInfoFor, reactFlow],
  );

  // The one place a moved quest or card position is actually remembered: on the browser (unless compact) and,
  // for a card the owner placed by hand, in its placement entry too, so presence and position stay together.
  const persistMovedPosition = useCallback(
    (id: string, x: number, y: number) => {
      if (compact) return;
      const rx = Math.round(x);
      const ry = Math.round(y);
      setPlacedCards((prev) => {
        if (!prev.some((p) => p.cardId === id)) return prev;
        const next = prev.map((p) => (p.cardId === id ? { ...p, x: rx, y: ry } : p));
        savePlacedCards(browserStorage(), projectId, next);
        return next;
      });
      setMovedPositions((prev) => {
        const next = { ...prev, [id]: { x: rx, y: ry } };
        savePositions(browserStorage(), projectId, next);
        return next;
      });
    },
    [compact, projectId],
  );

  const handleNodeDragStop = useCallback(
    (event: React.MouseEvent | MouseEvent | TouchEvent, node: Node) => {
      nodeDragActiveRef.current = false;

      // A quest node is moved only to tidy the graph: remember where the owner put it, and nothing else.
      if (node.type === 'quest') {
        setDragging?.(false);
        persistMovedPosition(node.id, node.position.x, node.position.y);
        return;
      }
      if (node.type !== 'card') return;

      setDragging?.(false);
      currentIntersectionRef.current = {};
      setIntersectingQuests({});

      const root: ParentNode = containerRef.current ?? document;
      const questDoms = root.querySelectorAll('.react-flow__node-quest, .rf-quest-node');
      questDoms.forEach((el) => {
        el.classList.remove('drop-ok', 'ok', 'drop-queue', 'queue', 'drop-no', 'refused', 'drop-refused');
      });

      const clientPos = getEventClientPos(event);
      const targetQuestId = clientPos
        ? questAtPoint(reactFlow.getNodes(), reactFlow.screenToFlowPosition(clientPos))
        : null;

      // Springs back to wherever the owner last put this node, not the raw dagre slot underneath: a drop on
      // a quest is a dispatch attempt, not a layout move, so a previously tidied historical or placed card
      // must not lose its arrangement just because an assignment attempt opened or was refused (FAIL A).
      const springBack = () => {
        const orig = positionAfterDrop(node.id, movedPositions, layoutPositionsRef.current.get(node.id));
        if (orig) {
          setNodes((nds) => nds.map((n) => (n.id === node.id ? { ...n, position: { ...orig } } : n)));
          reactFlow.updateNode(node.id, { position: { ...orig } });
        }
      };

      // The compact drawer graph is for navigation only: card nodes there are not draggable at all (see the
      // layout effect), but this stays as the defensive fallback for that invariant — it never dispatches and
      // never remembers a tidied layout.
      if (compact) {
        springBack();
        return;
      }

      if (targetQuestId && onOpenWorkOrder) {
        // Refused and queue-only both stop here: the highlight already showed why, and neither opens a paid
        // work order. Only a fully accepted drop does, through the existing confirmation.
        const quest = snap.quests.find((q) => q.id === targetQuestId);
        const verdict = quest ? getDropVerdict(snap, quest, node.id) : undefined;
        if (canOpenWorkOrder(verdict)) {
          onOpenWorkOrder(targetQuestId, node.id);
        }
        // A drop onto a quest is a dispatch attempt, not a layout move: the node returns to its slot either
        // way, and the work order (or the refusal already shown) is the only other visible effect.
        springBack();
        return;
      }

      // Not dropped on a quest: the owner is tidying the map. Remember it like a moved quest node, whether
      // this model already had dispatch history or was placed here by hand.
      persistMovedPosition(node.id, node.position.x, node.position.y);
    },
    [compact, movedPositions, onOpenWorkOrder, persistMovedPosition, reactFlow, setDragging, setNodes, snap],
  );

  const resetLayout = () => {
    setMovedPositions({});
    savePositions(browserStorage(), projectId, {});
  };

  // Removing a node must forget its placement/position preference too, or the next recompute (or a later
  // reappearance of the same card once it gets real dispatch history) would put it straight back where the
  // owner deleted it from. This only ever clears a local view preference: it never touches the quest/roster
  // data the delete was performed on.
  const handleNodesDelete = useCallback(
    (deleted: Node[]) => {
      const ids = new Set(deleted.map((n) => n.id));
      for (const id of ids) selectedIdsRef.current.delete(id);
      setPlacedCards((prev) => {
        if (!prev.some((p) => ids.has(p.cardId))) return prev;
        const next = prev.filter((p) => !ids.has(p.cardId));
        if (!compact) savePlacedCards(browserStorage(), projectId, next);
        return next;
      });
      if (compact) return;
      setMovedPositions((prev) => {
        if (!Object.keys(prev).some((id) => ids.has(id))) return prev;
        const next: NodePositions = Object.fromEntries(Object.entries(prev).filter(([id]) => !ids.has(id)));
        savePositions(browserStorage(), projectId, next);
        return next;
      });
    },
    [compact, projectId],
  );

  // Wraps the plain onNodesChange from useNodesState with two things React Flow does not give a hook into on
  // its own: keeping the selection alive across a snapshot poll rebuilding every node (FAIL D), and
  // persisting an arrow-key move the same way a mouse drag-stop already does (FAIL B). A mouse drag's own
  // final position change is skipped here (nodeDragActiveRef is still true until handleNodeDragStop runs),
  // so it is never persisted twice.
  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      onNodesChange(changes);
      for (const change of changes) {
        if (change.type === 'select') {
          if (change.selected) selectedIdsRef.current.add(change.id);
          else selectedIdsRef.current.delete(change.id);
        } else if (change.type === 'remove') {
          selectedIdsRef.current.delete(change.id);
        } else if (change.type === 'position' && change.position) {
          if (isCommittedPositionChange(change) && !compact && !nodeDragActiveRef.current) {
            persistMovedPosition(change.id, change.position.x, change.position.y);
          }
        }
      }
    },
    [compact, onNodesChange, persistMovedPosition],
  );

  // deleteKeyCode is disabled on every ReactFlow instance below; this is the only way nodes are ever deleted.
  // Attaching it to the container div (not document, which is where React Flow's own listener lives) scopes
  // it for free to whichever graph actually has focus: a keypress in the drawer's compact graph, an input, or
  // the other graph instance never reaches this handler at all, since it never bubbles through this subtree.
  // shouldSkipGraphDeleteKey also covers a drag still in flight (FAIL N1) and a keypress that actually
  // originated in an interactive control or a card's open detail panel rather than the node itself (FAIL N2).
  const handleGraphKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (
        shouldSkipGraphDeleteKey({
          key: event.key,
          target: event.target as HTMLElement | null,
          isNodeDragActive: nodeDragActiveRef.current,
        })
      ) {
        return;
      }
      const toDelete = reactFlow.getNodes().filter((n) => n.selected && n.deletable !== false);
      if (toDelete.length === 0) return;
      event.preventDefault();
      void reactFlow.deleteElements({ nodes: toDelete.map((n) => ({ id: n.id })) });
    },
    [reactFlow],
  );

  const isEmpty = targetQuestIds.length === 0;

  // The drawer's compact graph exists to navigate a quest's neighbours; with none, there is nothing to show
  // or to place a model onto, so it keeps the plain placeholder instead of a live drop target.
  if (compact && isEmpty) {
    return (
      <div className="map-view compact">
        <div className="empty">没有相关委托</div>
      </div>
    );
  }

  const flowContent = (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={handleNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={nodeTypes}
      onNodeClick={(_event, node) => {
        if (node.type === 'quest') onSelectQuest(node.id);
      }}
      onNodesDelete={handleNodesDelete}
      onNodeDragStart={handleNodeDragStart}
      onNodeDrag={handleNodeDrag}
      onNodeDragStop={handleNodeDragStop}
      // Disabled everywhere: React Flow's own listener defaults to Backspace only and listens document-wide,
      // reaching whichever graph/selection happens to exist anywhere on the page. handleGraphKeyDown replaces
      // it on the main graph only, scoped to this container and to both Delete and Backspace (FAIL D); the
      // compact drawer graph gets no replacement at all, so it stays navigation-only.
      deleteKeyCode={null}
      minZoom={0.2}
      maxZoom={2}
    >
      <Background id={backgroundId} color="rgba(43, 33, 24, 0.12)" gap={24} size={1} />
      {!compact && <Controls />}
      {!compact && (
        <MiniMap
          nodeColor={(n) => {
            if (n.type === 'card') return '#3f6f9e';
            const q = (n.data as { quest?: Quest })?.quest;
            return q ? pinColor(q.status) : '#9a8b72';
          }}
          maskColor="rgba(43, 33, 24, 0.25)"
        />
      )}
    </ReactFlow>
  );

  if (compact) {
    return (
      <div ref={containerRef} className="map-view compact" style={{ width: '100%', height: '100%' }}>
        {flowContent}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      id="graphView"
      className="graph-wrap map-view"
      style={{ height: '64vh', minHeight: 480, display: 'flex', flexDirection: 'column' }}
      onKeyDown={handleGraphKeyDown}
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
          {isEmpty
            ? '暂时没有进行中的委托。可以先把名册里的冒险者拖到下面空地上，占个位置。'
            : '地点 = 委托，路 = 前后关系，蓝色虚线 = 冒险者正在做，红点线 = 文件冲突。点地点看卷宗，点冒险者看他的委托。把名册里的冒险者拖到空白处放上地图，再拖到地点上派出，选中按 Delete 移走。地点和冒险者都能拖动整理位置，会记住。'}
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
          {!isEmpty ? (
            <button
              type="button"
              className="btn"
              style={{ padding: '2px 8px', fontSize: 11, whiteSpace: 'nowrap' }}
              onClick={() => setShowConflicts((prev) => !prev)}
            >
              {showConflicts ? '隐藏文件冲突' : '显示文件冲突'}
            </button>
          ) : null}
        </span>
      </p>
      <div
        style={{ flex: 1, width: '100%', minHeight: 400 }}
        onDragOver={handleGuildDragOver}
        onDragLeave={handleGuildDragLeave}
        onDrop={handleGuildDrop}
      >
        {flowContent}
      </div>
    </div>
  );
}

export function GraphView(props: GraphViewProps) {
  // A project switch on a reused GraphView must not keep the previous project's moved/placed positions, dagre
  // layout ref, or fit-view ref: keying the inner component by project id forces React to unmount the old
  // instance and mount a fresh one, whose state re-initialises from (and only from) the new project's own
  // storage. This covers the missing -> known identity transition too, since "unknown" is its own stable key.
  const key = graphInstanceKey(projectIdOf(props.snap));
  return (
    <ReactFlowProvider>
      <GraphViewInner key={key} {...props} />
    </ReactFlowProvider>
  );
}
