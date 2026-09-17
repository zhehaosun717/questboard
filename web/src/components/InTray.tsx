import { useState } from 'react';
import type { Snapshot } from '../api/types';
import { inTrayItems } from '../lib/inTray';
import type { TrayKind } from '../lib/inTray';
import { useT, type I18nKey } from '../lib/i18n';
import '../styles/intray.css';

export interface InTrayProps {
  snap: Snapshot;
  onOpenQuest: (questId: string) => void;
}

// The tray's own words follow the per-browser language switch; the quest title and the step text are
// user-facing copies shown exactly as they arrive, never translated.
const TRAY_KIND_KEYS: Record<TrayKind, I18nKey> = {
  'sign-off': 'inTray.kind.sign-off',
  decide: 'inTray.kind.decide',
  release: 'inTray.kind.release',
  owner: 'inTray.kind.owner',
};

const TRAY_STAMP_KEYS: Record<TrayKind, I18nKey> = {
  'sign-off': 'inTray.stamp.sign-off',
  decide: 'inTray.stamp.decide',
  release: 'inTray.stamp.release',
  owner: 'inTray.stamp.owner',
};

export function InTray({ snap, onOpenQuest }: InTrayProps) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const items = inTrayItems(snap);

  if (items.length === 0) {
    return <div className="tray-empty">{t('inTray.empty')}</div>;
  }

  const hasMore = items.length > 4;
  const visibleItems = expanded ? items : items.slice(0, 4);

  return (
    <section className="tray-oak" aria-label={t('inTray.heading')}>
      <header className="tray-header">
        <div className="tray-lead">
          <span className="tray-eyebrow">{t('inTray.eyebrow')}</span>
          <h2 className="tray-heading">{t('inTray.heading')}</h2>
        </div>
        <div className="tray-meta">
          {hasMore && (
            <button
              type="button"
              className="tray-toggle-btn"
              onClick={() => setExpanded((prev) => !prev)}
            >
              {expanded ? t('inTray.collapse') : t('inTray.more', { count: items.length - 4 })}
            </button>
          )}
          <span className="tray-count" aria-label={t('inTray.countLabel', { count: items.length })}>
            {items.length}
          </span>
        </div>
      </header>
      <div className="tray-grid">
        {visibleItems.map((item) => {
          const kindLabel = t(TRAY_KIND_KEYS[item.kind]);
          const stampLabel = t(TRAY_STAMP_KEYS[item.kind]);
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
