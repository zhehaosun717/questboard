import type { ReviewPage } from '../api/types';
import { isSafeReviewUrl } from '../lib/board';

interface ReviewShelfProps {
  reviewPages?: ReviewPage[];
}

export function ReviewShelf({ reviewPages = [] }: ReviewShelfProps) {
  return (
    <section className="reviews" aria-labelledby="reviewsTitle">
      <header className="sec-head">
        <span className="eyebrow">INSPECTION</span>
        <h2 id="reviewsTitle">美术评审页</h2>
      </header>
      <div id="reviews" className="rv-list">
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

            const content = (
              <>
                <span className="rv-title">{p.title}</span>
                <span className="rv-count">
                  {p.error ? p.error : `已批注 ${p.answered}/${p.total}`}
                </span>
                {meter}
              </>
            );

            if (!isSafeReviewUrl(p.url)) {
              return (
                <div key={p.url || p.title} className="rv">
                  {content}
                </div>
              );
            }

            return (
              <a
                key={p.url}
                className="rv"
                href={p.url}
                target="_blank"
                rel="noreferrer"
              >
                {content}
              </a>
            );
          })
        )}
      </div>
    </section>
  );
}
