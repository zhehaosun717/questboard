import { useEffect, useMemo, useRef, useState } from 'react';
import type { Quest, QuestStatus, Snapshot } from '../api/types';
import { questsInColumn } from '../lib/board';
import { COLUMNS, type Column } from '../lib/labels';
import { QuestCard } from './QuestCard';

interface BoardProps {
  snap: Snapshot;
  pickingCardId: string | null;
  onSelectQuest: (questId: string) => void;
  onDropCard: (questId: string, cardId: string) => void;
}

// 已完成 is history, not work: it starts folded to a narrow strip so the four working columns fit beside the
// guild without a horizontal scroll. The owner's choice is remembered in this browser only.
const DONE_OPEN_KEY = 'questboard.doneColumnOpen';

function readDoneOpen(): boolean {
  try {
    return window.localStorage.getItem(DONE_OPEN_KEY) === '1';
  } catch {
    return false; // storage blocked (private window): start folded
  }
}

function DoneColumn({
  col,
  items,
  open,
  onToggle,
  onSelectQuest,
}: {
  col: Column;
  items: Quest[];
  open: boolean;
  onToggle: (open: boolean) => void;
  onSelectQuest: (questId: string) => void;
}) {
  if (!open) {
    return (
      <section className={`col c-${col.key} collapsed`}>
        <button className="col-toggle" type="button" title={`展开${col.title}`} onClick={() => onToggle(true)}>
          <span className="col-num">{col.num}</span>
          <span className="count">{items.length}</span>
          <span className="v-title">{col.title}</span>
          <span className="v-hint">展开</span>
        </button>
      </section>
    );
  }
  return (
    <section className={`col c-${col.key}`}>
      <header className="col-head">
        <span className="col-num">{col.num}</span>
        <div className="col-title">
          <h2>{col.title}</h2>
          <span>{col.sub}</span>
        </div>
        <span className="count">{items.length}</span>
        <button className="col-fold" type="button" title={`收起${col.title}`} onClick={() => onToggle(false)}>
          收起
        </button>
      </header>
      <div className="done-list">
        {items.length > 0 ? (
          items.map((q) => (
            <button key={q.id} className="done-row" type="button" onClick={() => onSelectQuest(q.id)}>
              <b>{q.id}</b>
              <span title={q.title}>{q.title}</span>
            </button>
          ))
        ) : (
          <div className="empty">— 空 —</div>
        )}
        <a className="done-more" href="#/history">全部历史在「派出记录」</a>
      </div>
    </section>
  );
}

export function Board({ snap, pickingCardId, onSelectQuest, onDropCard }: BoardProps) {
  const seenRef = useRef<Set<string>>(new Set());
  const lastStatusRef = useRef<Map<string, QuestStatus>>(new Map());
  const [doneOpen, setDoneOpen] = useState(readDoneOpen);

  const toggleDone = (open: boolean) => {
    setDoneOpen(open);
    try {
      window.localStorage.setItem(DONE_OPEN_KEY, open ? '1' : '0');
    } catch {
      // storage blocked: the choice still holds for this visit
    }
  };

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
    <div id="boardView" className={`columns${doneOpen ? ' done-open' : ''}`}>
      {COLUMNS.map((col) => {
        const items = questsInColumn(snap, col);
        if (col.key === 'done') {
          return (
            <DoneColumn
              key={col.key}
              col={col}
              items={items}
              open={doneOpen}
              onToggle={toggleDone}
              onSelectQuest={onSelectQuest}
            />
          );
        }
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
                      暂无委托<code>questboard post</code>
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
