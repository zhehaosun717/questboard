import type { ReviewPage } from '../api/types';
import { isSafeReviewUrl } from '../lib/board';

interface ReviewViewProps {
  reviewPages?: ReviewPage[];
  selectedUrl: string | null;
  onSelectPage: (url: string | null) => void;
}

export function ReviewView({
  reviewPages = [],
  selectedUrl,
  onSelectPage,
}: ReviewViewProps) {
  const isSafe = isSafeReviewUrl(selectedUrl);

  if (selectedUrl && isSafe) {
    const matchedPage = reviewPages.find((p) => p.url === selectedUrl);
    const title = matchedPage ? matchedPage.title : '美术评审页';

    return (
      <div className="review-active-pane">
        <div className="rv-bar">
          <button
            className="btn ghost"
            type="button"
            onClick={() => onSelectPage(null)}
          >
            ← 返回列表
          </button>
          <span className="rv-bar-title">{title}</span>
          <a
            className="btn ghost"
            href={selectedUrl}
            target="_blank"
            rel="noreferrer"
          >
            在新窗口打开 ↗
          </a>
        </div>
        <div className="rv-frame-wrap">
          <iframe
            className="rv-iframe"
            src={selectedUrl}
            title={title}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="reviews-tab-view">
      <header className="sec-head">
        <span className="eyebrow">INSPECTION</span>
        <h2>美术评审页</h2>
      </header>
      <div className="rv-list">
        {reviewPages.length === 0 ? (
          <div className="empty">没有评审页</div>
        ) : (
          reviewPages.map((p) => {
            const meter =
              p.total > 0 ? (
                <span className="meter">
                  {Array.from({ length: p.total }, (_, i) => (
                    <i key={i} className={i < p.answered ? 'on' : ''} />
                  ))}
                </span>
              ) : null;

            const countLabel = p.error
              ? p.error
              : p.page
              ? `已批注 ${p.answered}/${p.total}`
              : '手工页面';

            const content = (
              <>
                <span className="rv-title">{p.title}</span>
                <span className="rv-count">{countLabel}</span>
                {meter}
              </>
            );

            if (!isSafeReviewUrl(p.url)) {
              return (
                <div key={p.url || p.title} className="rv disabled">
                  {content}
                </div>
              );
            }

            return (
              <button
                key={p.url}
                type="button"
                className="rv rv-btn"
                onClick={() => onSelectPage(p.url)}
              >
                {content}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
