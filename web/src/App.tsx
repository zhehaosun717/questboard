import { useEffect, useState } from 'react';
import { Board } from './components/Board';
import { BriefShelf } from './components/BriefShelf';
import { CardModal } from './components/CardModal';
import { Chips } from './components/Chips';
import { GraphView } from './components/GraphView';
import { Guild } from './components/Guild';
import { Header } from './components/Header';
import { QuestDrawer } from './components/QuestDrawer';
import { ReviewShelf } from './components/ReviewShelf';
import { Toasts } from './components/Toasts';
import { WorkOrderModal } from './components/WorkOrderModal';
import { useBoard } from './hooks/useBoard';

export function App() {
  const { snap, connected, error, toasts, refresh, pushToast, setDragging } = useBoard();

  const [view, setView] = useState<'board' | 'graph'>('board');
  const [selectedQuestId, setSelectedQuestId] = useState<string | null>(null);
  const [pickingCardId, setPickingCardId] = useState<string | null>(null);
  const [workOrder, setWorkOrder] = useState<{ questId: string; cardId: string } | null>(null);
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [draggingCardId, setDraggingCardId] = useState<string | null>(null);
  const [rulingDrafts, setRulingDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    if (snap?.project?.name) {
      document.title = `${snap.project.name} 悬赏板`;
    }
  }, [snap?.project?.name]);

  useEffect(() => {
    document.body.classList.toggle('picking', Boolean(pickingCardId));
  }, [pickingCardId]);

  useEffect(() => {
    const isDragging = Boolean(draggingCardId);
    document.body.classList.toggle('dragging', isDragging);
    setDragging(isDragging);
  }, [draggingCardId, setDragging]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (workOrder || editingCardId) {
          setWorkOrder(null);
          setEditingCardId(null);
        } else if (selectedQuestId) {
          setSelectedQuestId(null);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [workOrder, editingCardId, selectedQuestId]);

  const workOrderQuest = snap?.quests.find((q) => q.id === workOrder?.questId);
  const workOrderCard = snap?.roster.find((c) => c.id === workOrder?.cardId);
  const editingCard = snap?.roster.find((c) => c.id === editingCardId);
  const selectedQuest = snap?.quests.find((q) => q.id === selectedQuestId);

  return (
    <>
      <Header
        projectName={snap?.project?.name}
        view={view}
        onViewChange={setView}
      />
      <Chips snap={snap} connected={connected} error={error} />
      <div className="layout">
        <main>
          {view === 'graph' ? (
            snap ? (
              <GraphView
                snap={snap}
                focusId={selectedQuestId}
                onSelectQuest={setSelectedQuestId}
                onOpenWorkOrder={(questId, cardId) => setWorkOrder({ questId, cardId })}
                setDragging={setDragging}
              />
            ) : null
          ) : snap ? (
            <Board
              snap={snap}
              pickingCardId={pickingCardId}
              onSelectQuest={setSelectedQuestId}
              onDropCard={(questId, cardId) => setWorkOrder({ questId, cardId })}
            />
          ) : null}
          <ReviewShelf reviewPages={snap?.reviewPages} />
          <BriefShelf unpostedBriefs={snap?.unpostedBriefs} />
        </main>
        {snap && (
          <Guild
            roster={snap.roster}
            snap={snap}
            draggingCardId={draggingCardId}
            onEditCard={setEditingCardId}
            onHoverCard={(id) => {
              if (!draggingCardId) setPickingCardId(id);
            }}
            onDragStart={(id) => {
              setDraggingCardId(id);
              setPickingCardId(id);
            }}
            onDragEnd={() => {
              setDraggingCardId(null);
              setPickingCardId(null);
            }}
          />
        )}
      </div>
      {selectedQuest && snap && (
        <QuestDrawer
          quest={selectedQuest}
          snap={snap}
          draft={rulingDrafts[selectedQuest.id] || ''}
          onDraftChange={(text) =>
            setRulingDrafts((prev) => ({ ...prev, [selectedQuest.id]: text }))
          }
          onClose={() => setSelectedQuestId(null)}
          onSelectQuest={setSelectedQuestId}
          onAssignCard={(questId, cardId) => setWorkOrder({ questId, cardId })}
          refresh={refresh}
          pushToast={pushToast}
          setDragging={setDragging}
        />
      )}
      {workOrder && workOrderQuest && workOrderCard && (
        <WorkOrderModal
          quest={workOrderQuest}
          card={workOrderCard}
          onClose={() => setWorkOrder(null)}
          onSuccess={() => {
            setWorkOrder(null);
            refresh();
          }}
        />
      )}
      {editingCard && (
        <CardModal
          card={editingCard}
          onClose={() => setEditingCardId(null)}
          onSuccess={() => {
            setEditingCardId(null);
            refresh();
          }}
          onError={pushToast}
        />
      )}
      <Toasts toasts={toasts} />
    </>
  );
}
