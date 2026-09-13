interface HeaderProps {
  projectName?: string;
  view: 'board' | 'graph';
  onViewChange: (view: 'board' | 'graph') => void;
}

export function Header({ projectName, view, onViewChange }: HeaderProps) {
  return (
    <header className="top">
      <div className="brand">
        <p className="eyebrow" id="projectName">
          {projectName ? `${projectName} · SALVAGE GUILD` : 'QUESTBOARD · SALVAGE GUILD'}
        </p>
        <h1>悬赏板</h1>
        <p className="motto">把冒险者拖到委托上。能不能接，放下之前就知道。</p>
      </div>
      <nav className="nav" aria-label="视图">
        <button
          className={`plate tab${view === 'board' ? ' on' : ''}`}
          data-view="board"
          type="button"
          onClick={() => onViewChange('board')}
        >
          委托墙
        </button>
        <button
          className={`plate tab${view === 'graph' ? ' on' : ''}`}
          data-view="graph"
          type="button"
          onClick={() => onViewChange('graph')}
        >
          关系图
        </button>
        <a className="plate" href="/board" target="_blank" rel="noreferrer">
          留言板
        </a>
        <a className="plate" href="/history" target="_blank" rel="noreferrer">
          派遣历史
        </a>
      </nav>
    </header>
  );
}
