import { useEffect, useMemo, useRef, useState } from 'react';
import type { Quest, QuestStatus, Snapshot } from '../api/types';
import { filterQuests, paginate, projectScopedKey, questsInColumn } from '../lib/board';
import { COLUMNS, type Column } from '../lib/labels';
import { useLocale, useT } from '../lib/i18n';
import { QuestCard } from './QuestCard';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import '../styles/responsibility.css';
import '../styles/archive.css';

interface BoardProps {
  snap: Snapshot;
  pickingCardId: string | null;
  onSelectQuest: (questId: string) => void;
  onDropCard: (questId: string, cardId: string) => void;
}

// 已完成 is history, not work, and 等会长 can grow long once a few reviews land at once: both fold to a
// narrow strip so the board fits beside the guild without a horizontal scroll. Each choice is remembered
// per project in this browser only (projectScopedKey keeps two projects on one machine from sharing it).
const DONE_OPEN_KEY = 'questboard.doneColumnOpen';
const OWNER_OPEN_KEY = 'questboard.ownerColumnOpen';
const ARCHIVE_PAGE_SIZE = 12;

function readFoldOpen(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : raw === '1';
  } catch {
    return fallback; // storage blocked (private window): use the default
  }
}

function writeFoldOpen(key: string, open: boolean): void {
  try {
    window.localStorage.setItem(key, open ? '1' : '0');
  } catch {
    // storage blocked: the choice still holds for this visit
  }
}

// The folded strip for either column: it always shows the column's true, uncapped count — folding is a
// view choice, never a way to make pending or archived work look smaller than it is.
function FoldedStrip({ col, count, onOpen }: { col: Column; count: number; onOpen: () => void }) {
  const t = useT();
  return (
    <section className={`col c-${col.key} collapsed`}>
      <button
        className="flex w-full min-h-full flex-col items-center gap-2.5 px-0 py-3.5 text-cream bg-transparent border-0 cursor-pointer transition-colors hover:bg-white/4"
        type="button"
        title={t('board.expandTitle', { title: col.title })}
        onClick={onOpen}
      >
        <span className="font-display text-[26px] leading-none text-rust">{col.num}</span>
        <Badge variant="outline">{count}</Badge>
        <span className="[writing-mode:vertical-rl] font-han text-[17px] tracking-[.25em] text-tag">{col.title}</span>
        <span className="[writing-mode:vertical-rl] text-[11px] tracking-[.2em] text-dim">{t('board.expand')}</span>
      </button>
    </section>
  );
}

// At 1024px in English the column title wraps onto two lines and the subtitle only repeats it
// (ON QUEST under "On quest"). Hide the subtitle when it says nothing the title has not said;
// OPEN stays because "Quest board" and "OPEN" do not match. Chinese rendering is untouched.
function subRepeatsTitle(col: Column): boolean {
  const normalize = (value: string) => value.toUpperCase().replace(/\s+/g, ' ').trim();
  const title = normalize(col.title);
  const sub = normalize(col.sub);
  if (sub.length === 0) {
    return false;
  }
  return title.startsWith(sub) || sub.startsWith(title);
}

function ColumnTitle({ col }: { col: Column }) {
  const locale = useLocale();
  const showSub = locale === 'en' ? !subRepeatsTitle(col) : true;
  return (
    <div className="flex min-w-0 flex-col">
      <h2 className="m-0 font-han text-[20px] leading-tight tracking-[.05em] text-tag">{col.title}</h2>
      {showSub ? <span className="mt-[3px] font-display text-[10px] leading-none tracking-[.28em] text-dim">{col.sub}</span> : null}
    </div>
  );
}

// One guild header for every column: the numeral is the big display glyph, the count is a stamped plate,
// and folding is a ghost plate button. Shared so the four columns cannot drift apart.
function ColumnHead({
  col,
  count,
  countTitle,
  fold,
}: {
  col: Column;
  count: number;
  countTitle?: string;
  fold?: { title: string; label: string; onClick: () => void };
}) {
  return (
    <header className="flex items-end gap-2.5 border-b border-rivet/45 bg-[linear-gradient(180deg,rgba(75,54,36,.35),transparent)] px-3 pb-2.5 pt-3.5">
      <span className="font-display text-[34px] leading-[.82] tracking-[.02em] text-rust drop-shadow-[0_1px_2px_rgba(0,0,0,.6)]">{col.num}</span>
      <ColumnTitle col={col} />
      <Badge variant="outline" className="ml-auto min-w-[30px] justify-center" title={countTitle}>{count}</Badge>
      {fold ? (
        <Button variant="ghost" size="xs" type="button" title={fold.title} onClick={fold.onClick}>{fold.label}</Button>
      ) : null}
    </header>
  );
}

function ArchiveColumn({
  col,
  items,
  open,
  onToggle,
  onSelectQuest,
  projectId,
}: {
  col: Column;
  items: Quest[];
  open: boolean;
  onToggle: (open: boolean) => void;
  onSelectQuest: (questId: string) => void;
  projectId: string | undefined;
}) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const t = useT();

  // A query or page number left over from a previous project would otherwise silently filter the next
  // one's archive, since this component stays mounted across a project switch on a live board.
  useEffect(() => {
    setQuery('');
    setPage(1);
  }, [projectId]);

  const filtered = useMemo(() => filterQuests(items, query), [items, query]);
  const { pageItems, page: shownPage, totalPages, total } = paginate(filtered, page, ARCHIVE_PAGE_SIZE);
  const searching = query.trim().length > 0;

  if (!open) {
    return <FoldedStrip col={col} count={items.length} onOpen={() => onToggle(true)} />;
  }
  return (
    <section className={`col c-${col.key}`}>
      <ColumnHead
        col={col}
        count={items.length}
        countTitle={t('board.archiveCountTitle')}
        fold={{ title: t('board.collapseTitle', { title: col.title }), label: t('board.collapse'), onClick: () => onToggle(false) }}
      />
      <div className="archive-search">
        <input
          type="search"
          placeholder={t('board.searchPlaceholder')}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
        />
        {searching && (
          <span className="archive-match">
            {t('board.matchCount', { matched: total, total: items.length })}
          </span>
        )}
      </div>
      <div className="done-list">
        {pageItems.length > 0 ? (
          pageItems.map((q) => (
            <button key={q.id} className="done-row" type="button" onClick={() => onSelectQuest(q.id)}>
              <b>{q.id}</b>
              <span title={q.title}>{q.title}</span>
            </button>
          ))
        ) : (
          <div className="empty">{query ? t('board.noMatch') : t('board.empty')}</div>
        )}
        <a className="done-more" href="#/history">{t('board.archiveLink')}</a>
      </div>
      {total > ARCHIVE_PAGE_SIZE && (
        <div className="archive-pager">
          <button type="button" disabled={shownPage <= 1} onClick={() => setPage(shownPage - 1)}>{t('board.prevPage')}</button>
          <span>{t('board.page', { page: shownPage, total: totalPages, count: total })}</span>
          <button type="button" disabled={shownPage >= totalPages} onClick={() => setPage(shownPage + 1)}>{t('board.nextPage')}</button>
        </div>
      )}
    </section>
  );
}

function OwnerColumn({
  col,
  items,
  open,
  onToggle,
  renderQuestList,
}: {
  col: Column;
  items: Quest[];
  open: boolean;
  onToggle: (open: boolean) => void;
  renderQuestList: (items: Quest[]) => React.ReactNode;
}) {
  const t = useT();
  if (!open) {
    return <FoldedStrip col={col} count={items.length} onOpen={() => onToggle(true)} />;
  }
  return (
    <section className={`col c-${col.key}`}>
      <ColumnHead
        col={col}
        count={items.length}
        fold={{ title: t('board.collapseTitle', { title: col.title }), label: t('board.collapse'), onClick: () => onToggle(false) }}
      />
      <div className="list">{renderQuestList(items)}</div>
    </section>
  );
}

export function Board({ snap, pickingCardId, onSelectQuest, onDropCard }: BoardProps) {
  const t = useT();
  const seenRef = useRef<Set<string>>(new Set());
  const lastStatusRef = useRef<Map<string, QuestStatus>>(new Map());
  const doneKey = projectScopedKey(DONE_OPEN_KEY, snap);
  const ownerKey = projectScopedKey(OWNER_OPEN_KEY, snap);
  const [doneOpen, setDoneOpen] = useState(() => readFoldOpen(doneKey, false));
  const [ownerOpen, setOwnerOpen] = useState(() => readFoldOpen(ownerKey, true));

  // The project (and so the storage key) can change under a live board without a full remount; re-read
  // each fold's own stored choice rather than keeping the previous project's.
  useEffect(() => setDoneOpen(readFoldOpen(doneKey, false)), [doneKey]);
  useEffect(() => setOwnerOpen(readFoldOpen(ownerKey, true)), [ownerKey]);

  const toggleDone = (open: boolean) => {
    setDoneOpen(open);
    writeFoldOpen(doneKey, open);
  };
  const toggleOwner = (open: boolean) => {
    setOwnerOpen(open);
    writeFoldOpen(ownerKey, open);
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

  const globalIndex = useRef(0);
  globalIndex.current = 0;

  const renderQuestList = (items: Quest[]) => {
    if (items.length === 0) {
      return (
        <div className="empty">
          {snap.quests.length > 0 ? (
            t('board.empty')
          ) : (
            <>
              {t('board.noQuests')}<code>questboard post</code>
            </>
          )}
        </div>
      );
    }
    return items.map((q) => {
      const cardIndex = globalIndex.current++;
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
    });
  };

  return (
    <div id="boardView" className={`columns${doneOpen ? ' done-open' : ''}${ownerOpen ? '' : ' owner-collapsed'}`}>
      {COLUMNS.map((col) => {
        const items = questsInColumn(snap, col);
        if (col.key === 'done') {
          return (
            <ArchiveColumn
              key={col.key}
              col={col}
              items={items}
              open={doneOpen}
              onToggle={toggleDone}
              onSelectQuest={onSelectQuest}
              projectId={snap.project.id}
            />
          );
        }
        if (col.key === 'owner') {
          return (
            <OwnerColumn
              key={col.key}
              col={col}
              items={items}
              open={ownerOpen}
              onToggle={toggleOwner}
              renderQuestList={renderQuestList}
            />
          );
        }
        return (
          <section className={`col c-${col.key}`} key={col.key}>
            <ColumnHead col={col} count={items.length} />
            <div className="list">{renderQuestList(items)}</div>
          </section>
        );
      })}
    </div>
  );
}
