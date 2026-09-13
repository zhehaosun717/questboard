import { useEffect, useMemo, useRef } from 'react';
import type { QuestStatus, Snapshot } from '../api/types';
import { questsInColumn } from '../lib/board';
import { COLUMNS } from '../lib/labels';
import { QuestCard } from './QuestCard';

interface BoardProps {
  snap: Snapshot;
  pickingCardId: string | null;
  onSelectQuest: (questId: string) => void;
  onDropCard: (questId: string, cardId: string) => void;
}

export function Board({ snap, pickingCardId, onSelectQuest, onDropCard }: BoardProps) {
  const seenRef = useRef<Set<string>>(new Set());
  const lastStatusRef = useRef<Map<string, QuestStatus>>(new Map());

  const isNewMap = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const q of snap.quests) {
      map.set(q.id, !seenRef.current.has(q.id));
    }
    return map;
  }, [snap.quests]);

  const changedMap = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const q of snap.quests) {
      const prev = lastStatusRef.current.get(q.id);
      map.set(q.id, prev !== undefined && prev !== q.status);
    }
    return map;
  }, [snap.quests]);

  useEffect(() => {
    for (const q of snap.quests) {
      seenRef.current.add(q.id);
      lastStatusRef.current.set(q.id, q.status);
    }
  }, [snap.quests]);

  let globalIndex = 0;

  return (
    <div id="boardView" className="columns">
      {COLUMNS.map((col) => {
        const items = questsInColumn(snap, col);
        return (
          <section className={`col c-${col.key}`} key={col.key}>
            <header className="col-head">
              <span className="col-num">{col.num}</span>
              <div className="col-title">
                <h2>{col.title}</h2>
                <span>{col.sub}</span>
              </div>
              <span className="count">{items.length}</span>
            </header>
            <div className="list">
              {items.length > 0 ? (
                items.map((q) => {
                  const cardIndex = globalIndex++;
                  return (
                    <QuestCard
                      key={q.id}
                      quest={q}
                      index={cardIndex}
                      snap={snap}
                      pickingCardId={pickingCardId}
                      isNew={isNewMap.get(q.id) ?? false}
                      statusChanged={changedMap.get(q.id) ?? false}
                      onSelect={onSelectQuest}
                      onDropCard={onDropCard}
                    />
                  );
                })
              ) : (
                <div className="empty">
                  {snap.quests.length > 0 ? (
                    '— 空 —'
                  ) : (
                    <>
                      暂无委托<code>node tools/board/quest.js post</code>
                    </>
                  )}
                </div>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
