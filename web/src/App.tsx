import { useEffect, useState } from 'react';
import { Board } from './components/Board';
import { InTray } from './components/InTray';
import { BriefShelf } from './components/BriefShelf';
import { CardModal } from './components/CardModal';
import { Chips } from './components/Chips';
import { GraphView } from './components/GraphView';
import { Guild } from './components/Guild';
import { Header } from './components/Header';
import { HistoryView } from './components/HistoryView';
import { QuestDrawer } from './components/QuestDrawer';
import { ReviewView } from './components/ReviewView';
import { RosterView } from './components/RosterView';
import { SettingsView } from './components/SettingsView';
import { ThreadsView } from './components/ThreadsView';
import { Toasts } from './components/Toasts';
import { UsageView } from './components/UsageView';
import { WorkOrderModal } from './components/WorkOrderModal';
import { useBoard } from './hooks/useBoard';
import { formatRoute, parseRoute, type Route, type Tab } from './lib/route';
import './styles/tabs.css';
import './styles/config.css';

export function App() {
  const { snap, connected, error, toasts, refresh, pushToast, setDragging } =
    useBoard();

  const [route, setRoute] = useState<Route>(() =>
    parseRoute(window.location.hash),
  );
  const [selectedQuestId, setSelectedQuestId] = useState<string | null>(null);
  const [pickingCardId, setPickingCardId] = useState<string | null>(null);
  const [workOrder, setWorkOrder] = useState<{
    questId: string;
    cardId: string;
  } | null>(null);
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [draggingCardId, setDraggingCardId] = useState<string | null>(null);
  const [rulingDrafts, setRulingDrafts] = useState<Record<string, string>>({});
  const [isNewThreadOpen, setIsNewThreadOpen] = useState(false);

  useEffect(() => {
    const handleHashChange = () => {
      setRoute(parseRoute(window.location.hash));
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  useEffect(() => {
    if (snap?.project?.name) {
      document.title = `${snap.project.name} 委托板`;
    }
  }, [snap?.project?.name]);

  useEffect(() => {
    const isPicking =
      (route.tab === 'board' || route.tab === 'graph') &&
      Boolean(pickingCardId);
    document.body.classList.toggle('picking', isPicking);
  }, [pickingCardId, route.tab]);

  useEffect(() => {
    const isDragging =
      (route.tab === 'board' || route.tab === 'graph') &&
      Boolean(draggingCardId);
    document.body.classList.toggle('dragging', isDragging);
    setDragging(isDragging);
  }, [draggingCardId, route.tab, setDragging]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (workOrder || editingCardId) {
          setWorkOrder(null);
          setEditingCardId(null);
        } else if (isNewThreadOpen) {
          setIsNewThreadOpen(false);
        } else if (selectedQuestId) {
          setSelectedQuestId(null);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [workOrder, editingCardId, isNewThreadOpen, selectedQuestId]);

  const handleTabChange = (tab: Tab) => {
    window.location.hash = formatRoute({ tab });
  };

  const handleSelectThread = (threadId: string | null) => {
    window.location.hash = formatRoute({ tab: 'threads', threadId });
  };

  const handleSelectReviewPage = (url: string | null) => {
    window.location.hash = formatRoute({ tab: 'review', reviewUrl: url });
  };

  const workOrderQuest = snap?.quests.find((q) => q.id === workOrder?.questId);
  const workOrderCard = snap?.roster.find((c) => c.id === workOrder?.cardId);
  const editingCard = snap?.roster.find((c) => c.id === editingCardId);
  const selectedQuest = snap?.quests.find((q) => q.id === selectedQuestId);

  return (
    <>
      <Header
        projectName={snap?.project?.name}
        tab={route.tab}
        onTabChange={handleTabChange}
        openQuestions={snap?.openQuestions}
      />
      <Chips snap={snap} connected={connected} error={error} />

      {route.tab === 'board' || route.tab === 'graph' ? (
        <div className="layout">
          <main>
            {route.tab === 'graph' ? (
              snap ? (
                <GraphView
                  snap={snap}
                  focusId={selectedQuestId}
                  onSelectQuest={setSelectedQuestId}
                  onOpenWorkOrder={(questId, cardId) =>
                    setWorkOrder({ questId, cardId })
                  }
                  setDragging={setDragging}
                  pickingCardId={draggingCardId}
                />
              ) : null
            ) : snap ? (
              <>
                <InTray snap={snap} onOpenQuest={setSelectedQuestId} />
                <Board
                  snap={snap}
                  pickingCardId={pickingCardId}
                  onSelectQuest={setSelectedQuestId}
                  onDropCard={(questId, cardId) =>
                    setWorkOrder({ questId, cardId })
                  }
                />
              </>
            ) : null}
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
      ) : (
        <div className="layout tab-full">
          <main>
            {route.tab === 'threads' && (
              <ThreadsView
                activeThreadId={route.threadId}
                onSelectThread={handleSelectThread}
                isNewModalOpen={isNewThreadOpen}
                onOpenNewModal={() => setIsNewThreadOpen(true)}
                onCloseNewModal={() => setIsNewThreadOpen(false)}
              />
            )}
            {route.tab === 'review' && (
              <ReviewView
                reviewPages={snap?.reviewPages}
                selectedUrl={route.reviewUrl}
                onSelectPage={handleSelectReviewPage}
              />
            )}
            {route.tab === 'history' && <HistoryView />}
            {route.tab === 'roster' && snap && (
              <RosterView
                snap={snap}
                refresh={refresh}
                pushToast={pushToast}
              />
            )}
            {route.tab === 'usage' && (
              <UsageView scope={snap ? { loaded: true, projectId: snap.project.id ?? null } : { loaded: false }} />
            )}
            {route.tab === 'settings' && <SettingsView roster={snap?.roster ?? []} />}
          </main>
        </div>
      )}

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
