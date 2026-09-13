import { useState } from 'react';
import type { ReviewPage } from '../api/types';
import { isSafeReviewUrl } from '../lib/board';
import {
  getAdjacentReviewPage,
  getNextUnansweredPage,
  getReviewProgressLabel,
  getReviewProgressPercent,
  hasReviewError,
  isReviewPageIncomplete,
  sortReviewPages,
} from '../lib/reviewList';
import './../styles/review.css';

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
  const [onlyUnanswered, setOnlyUnanswered] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [frameVersion, setFrameVersion] = useState(0);
  const orderedPages = sortReviewPages(reviewPages);
  const filteredPages = onlyUnanswered
    ? orderedPages.filter(isReviewPageIncomplete)
    : orderedPages;
  const navigablePages = filteredPages.filter((page) => isSafeReviewUrl(page.url));
  const selectedPage = reviewPages.find((page) => page.url === selectedUrl);
  const nextUnanswered = getNextUnansweredPage(navigablePages, selectedUrl);
  const pendingCount = filteredPages.filter(isReviewPageIncomplete).length;

  const goToAdjacent = (direction: 'previous' | 'next') => {
    const page = getAdjacentReviewPage(navigablePages, selectedUrl, direction);
    if (page) onSelectPage(page.url);
  };

  const renderPage = (page: ReviewPage) => {
    const progress = getReviewProgressPercent(page);
    const isSelected = page.url === selectedUrl;
    const content = (
      <>
        <span className="review-page-title">{page.title}</span>
        <span className={hasReviewError(page) ? 'review-page-label is-error' : 'review-page-label'}>
          {getReviewProgressLabel(page)}
        </span>
        {progress !== null && (
          <span
            className="review-progress-track"
            role="progressbar"
            aria-label={`${page.title} 批注进度`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
          >
            <span className="review-progress-fill" style={{ width: `${progress}%` }} />
          </span>
        )}
      </>
    );

    if (!isSafeReviewUrl(page.url)) {
      return (
        <div key={`${page.url}-${page.title}`} className="review-page is-disabled">
          {content}
        </div>
      );
    }

    return (
      <button
        key={`${page.url}-${page.title}`}
        className={isSelected ? 'review-page is-selected' : 'review-page'}
        type="button"
        aria-current={isSelected ? 'page' : undefined}
        onClick={() => onSelectPage(page.url)}
      >
        {content}
      </button>
    );
  };

  return (
    <div className={isSidebarOpen ? 'reviews-tab-view' : 'reviews-tab-view sidebar-closed'}>
      <div className="review-shell">
        {isSidebarOpen && (
          <aside className="review-sidebar" aria-label="评审页列表">
            <div className="review-sidebar-head">
              <div>
                <span className="eyebrow">评审列表</span>
                <h2>评审顺序</h2>
              </div>
              <label className="review-filter">
                <input
                  type="checkbox"
                  checked={onlyUnanswered}
                  onChange={(event) => setOnlyUnanswered(event.target.checked)}
                />
                <span>只看未处理</span>
              </label>
            </div>
            <div className="review-sidebar-summary">
              {filteredPages.length === 0 || pendingCount === 0
                ? '都处理完了'
                : `${pendingCount} 份未处理，未处理优先`}
            </div>
            <div className="review-page-list">
              {reviewPages.length === 0 ? (
                <p className="review-list-empty">暂无评审页，页面加载后会显示在这里。</p>
              ) : filteredPages.length === 0 ? (
                <p className="review-list-empty">都处理完了。可以取消筛选查看全部页面。</p>
              ) : (
                filteredPages.map(renderPage)
              )}
            </div>
          </aside>
        )}

        <section className="review-reader" aria-label="评审阅读区">
          <div className="review-toolbar">
            <div className="review-toolbar-title">
              <span className="eyebrow">当前评审</span>
              <h2>{selectedPage?.title ?? '还没有选择评审页'}</h2>
            </div>
            <div className="review-toolbar-actions">
              {selectedUrl && isSafeReviewUrl(selectedUrl) && (
                <>
                  <button
                    className="btn ghost"
                    type="button"
                    onClick={() => setFrameVersion((version) => version + 1)}
                  >
                    重新载入
                  </button>
                  <a
                    className="btn ghost"
                    href={selectedUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    新窗口打开 ↗
                  </a>
                  <div className="review-nav" aria-label="连续评审">
                    <button
                      className="btn ghost"
                      type="button"
                      onClick={() => goToAdjacent('previous')}
                      disabled={!getAdjacentReviewPage(navigablePages, selectedUrl, 'previous')}
                    >
                      ← 上一份
                    </button>
                    <button
                      className="btn ghost"
                      type="button"
                      onClick={() => onSelectPage(nextUnanswered?.url ?? null)}
                      disabled={!nextUnanswered}
                      title={nextUnanswered ? '跳到下一份未处理页面' : '都处理完了'}
                    >
                      下一份未处理
                      {!nextUnanswered && <span className="review-disabled-note">都处理完了</span>}
                    </button>
                    <button
                      className="btn ghost"
                      type="button"
                      onClick={() => goToAdjacent('next')}
                      disabled={!getAdjacentReviewPage(navigablePages, selectedUrl, 'next')}
                    >
                      下一份 →
                    </button>
                  </div>
                </>
              )}
              <button
                className="btn ghost review-sidebar-toggle"
                type="button"
                aria-pressed={isSidebarOpen}
                onClick={() => setIsSidebarOpen((open) => !open)}
              >
                {isSidebarOpen ? '收起列表' : '展开列表'}
              </button>
            </div>
          </div>

          {selectedUrl && isSafeReviewUrl(selectedUrl) ? (
            <div className="review-frame-wrap">
              <iframe
                key={frameVersion}
                className="review-iframe"
                src={selectedUrl}
                title={selectedPage?.title ?? '美术评审页'}
              />
            </div>
          ) : (
            <div className="review-reader-empty">
              <p>先从左侧选择一份评审页。</p>
              <span>打开后，按页面内容写批注或给出判断；完成一份再继续下一份。</span>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
