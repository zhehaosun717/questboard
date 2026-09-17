import type { Tab } from '../lib/route';
import { useT } from '../lib/i18n';

interface HeaderProps {
  projectName?: string;
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  openQuestions?: number;
}

export function Header({
  projectName,
  tab,
  onTabChange,
  openQuestions,
}: HeaderProps) {
  const t = useT();
  const threadsLabel =
    openQuestions && openQuestions > 0
      ? t('header.tab.threadsWithCount', { count: openQuestions })
      : t('header.tab.threads');

  return (
    <header className="top">
      <div className="brand">
        <p className="eyebrow" id="projectName">
          {projectName
            ? t('header.eyebrowWithProject', { project: projectName })
            : t('header.eyebrowPlain')}
        </p>
        {/* No standing motto here: this header is on every tab, so a board-only instruction was showing on
            设置 and 用量 too. The guild sidebar says how to dispatch, where the dispatching happens. */}
        <h1>{t('header.title')}</h1>
      </div>
      <nav className="nav" aria-label={t('header.navLabel')}>
        <button
          className={`plate tab${tab === 'board' ? ' on' : ''}`}
          data-view="board"
          type="button"
          onClick={() => onTabChange('board')}
        >
          {t('header.tab.board')}
        </button>
        <button
          className={`plate tab${tab === 'graph' ? ' on' : ''}`}
          data-view="graph"
          type="button"
          onClick={() => onTabChange('graph')}
        >
          {t('header.tab.graph')}
        </button>
        <button
          className={`plate tab${tab === 'threads' ? ' on' : ''}`}
          data-view="threads"
          type="button"
          onClick={() => onTabChange('threads')}
        >
          {threadsLabel}
        </button>
        <button
          className={`plate tab${tab === 'review' ? ' on' : ''}`}
          data-view="review"
          type="button"
          onClick={() => onTabChange('review')}
        >
          {t('header.tab.review')}
        </button>
        <button
          className={`plate tab${tab === 'history' ? ' on' : ''}`}
          data-view="history"
          type="button"
          onClick={() => onTabChange('history')}
        >
          {t('header.tab.history')}
        </button>
        <button
          className={`plate tab${tab === 'roster' ? ' on' : ''}`}
          data-view="roster"
          type="button"
          onClick={() => onTabChange('roster')}
        >
          {t('header.tab.roster')}
        </button>
        <button
          className={`plate tab${tab === 'usage' ? ' on' : ''}`}
          data-view="usage"
          type="button"
          onClick={() => onTabChange('usage')}
        >
          {t('header.tab.usage')}
        </button>
        <button
          className={`plate tab${tab === 'settings' ? ' on' : ''}`}
          data-view="settings"
          type="button"
          onClick={() => onTabChange('settings')}
        >
          {t('header.tab.settings')}
        </button>
      </nav>
    </header>
  );
}
