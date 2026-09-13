import type { Tab } from '../lib/route';

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
  const threadsLabel =
    openQuestions && openQuestions > 0
      ? `留言板 · ${openQuestions}`
      : '留言板';

  return (
    <header className="top">
      <div className="brand">
        <p className="eyebrow" id="projectName">
          {projectName
            ? `${projectName} · SALVAGE GUILD`
            : 'QUESTBOARD · SALVAGE GUILD'}
        </p>
        <h1>悬赏板</h1>
        <p className="motto">把冒险者拖到委托上。能不能接，放下之前就知道。</p>
      </div>
      <nav className="nav" aria-label="视图">
        <button
          className={`plate tab${tab === 'board' ? ' on' : ''}`}
          data-view="board"
          type="button"
          onClick={() => onTabChange('board')}
        >
          委托墙
        </button>
        <button
          className={`plate tab${tab === 'graph' ? ' on' : ''}`}
          data-view="graph"
          type="button"
          onClick={() => onTabChange('graph')}
        >
          关系图
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
          美术评审
        </button>
        <button
          className={`plate tab${tab === 'history' ? ' on' : ''}`}
          data-view="history"
          type="button"
          onClick={() => onTabChange('history')}
        >
          派遣记录
        </button>
        <button
          className={`plate tab${tab === 'roster' ? ' on' : ''}`}
          data-view="roster"
          type="button"
          onClick={() => onTabChange('roster')}
        >
          冒险者
        </button>
        <button
          className={`plate tab${tab === 'usage' ? ' on' : ''}`}
          data-view="usage"
          type="button"
          onClick={() => onTabChange('usage')}
        >
          用量
        </button>
        <button
          className={`plate tab${tab === 'settings' ? ' on' : ''}`}
          data-view="settings"
          type="button"
          onClick={() => onTabChange('settings')}
        >
          设置
        </button>
      </nav>
    </header>
  );
}
