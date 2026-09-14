import { useState } from 'react';
import type { Snapshot } from '../api/types';
import { inTrayItems, TRAY_KIND_LABEL, TRAY_STAMP_LABEL } from '../lib/inTray';
import '../styles/intray.css';

export interface InTrayProps {
  snap: Snapshot;
  onOpenQuest: (questId: string) => void;
}

export function InTray({ snap, onOpenQuest }: InTrayProps) {
  const [expanded, setExpanded] = useState(false);
  const items = inTrayItems(snap);

  if (items.length === 0) {
    return <div className="tray-empty">没有等你处理的事</div>;
  }

  const hasMore = items.length > 4;
  const visibleItems = expanded ? items : items.slice(0, 4);

  return (
    <section className="tray-oak" aria-label="待你处理">
      <header className="tray-header">
        <div className="tray-lead">
          <span className="tray-eyebrow">IN-TRAY</span>
          <h2 className="tray-heading">待你处理</h2>
        </div>
        <div className="tray-meta">
          {hasMore && (
            <button
              type="button"
              className="tray-toggle-btn"
              onClick={() => setExpanded((prev) => !prev)}
            >
              {expanded ? '收起' : `还有 ${items.length - 4} 件`}
            </button>
          )}
          <span className="tray-count" aria-label={`共 ${items.length} 件`}>
            {items.length}
          </span>
        </div>
      </header>
      <div className="tray-grid">
        {visibleItems.map((item) => {
          const kindLabel = TRAY_KIND_LABEL[item.kind];
          const stampLabel = TRAY_STAMP_LABEL[item.kind];
          const tabText = `${item.quest.id} · ${kindLabel}`;
          return (
            <div
              key={item.quest.id}
              className="tray-folder"
              data-tab={tabText}
            >
              <div className="tray-tab" title={tabText}>
                {tabText}
              </div>
              <div className="tray-folder-main">
                <h4 className="tray-folder-title" title={item.quest.title}>
                  {item.quest.title}
                </h4>
                <p className="tray-folder-step" title={item.step.detail}>
                  <strong className="tray-step-title">{item.step.title}</strong>
                  {item.step.detail ? ` · ${item.step.detail}` : ''}
                </p>
              </div>
              <button
                type="button"
                className={`tray-stamp tray-stamp-${item.kind}`}
                onClick={() => onOpenQuest(item.quest.id)}
              >
                {stampLabel}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
