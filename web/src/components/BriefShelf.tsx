import { useState } from 'react';
import type { UnpostedBrief } from '../api/types';

interface BriefShelfProps {
  unpostedBriefs?: UnpostedBrief[];
}

const BRIEFS_SHOWN = 8;

export function BriefShelf({ unpostedBriefs = [] }: BriefShelfProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <section className="reviews" aria-labelledby="briefsTitle">
      <header className="sec-head">
        <span className="eyebrow">DRAFTS</span>
        <h2 id="briefsTitle">还没上板的 brief</h2>
      </header>
      <p className="hint">
        最近 7 天写好、还没发布也没派过的 brief。coordinator 发布后才能指派。
      </p>
      <div id="briefs" className="bf-list">
        {unpostedBriefs.length === 0 ? (
          <div className="empty">没有待发布的 brief</div>
        ) : (
          (expanded ? unpostedBriefs : unpostedBriefs.slice(0, BRIEFS_SHOWN)).map(
            (b) => (
              <div className="bf" key={b.package}>
                <span className="pid">{b.package}</span>
                <span>{b.title}</span>
                <code>{b.brief}</code>
              </div>
            ),
          )
        )}
      </div>
      {unpostedBriefs.length > BRIEFS_SHOWN && (
        <button
          className="plate bf-toggle"
          type="button"
          onClick={() => setExpanded(!expanded)}
          style={{ marginTop: '10px' }}
        >
          {expanded ? '收起' : `展开全部 ${unpostedBriefs.length} 份`}
        </button>
      )}
    </section>
  );
}
