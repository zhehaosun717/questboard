import { useRef } from 'react';
import type { ThreadDetail } from '../../api/types';
import { linkSegments } from '../../lib/threads';

interface ThreadDetailPaneProps {
  activeThread: ThreadDetail | null;
  activeError: string | null;
  author: string;
  onAuthorChange: (author: string) => void;
  replyBody: string;
  onReplyBodyChange: (body: string) => void;
  refusalMessage: string | null;
  replySubmitting: boolean;
  onTogglePin: () => void;
  onToggleClose: () => void;
  onSendReply: () => void;
  // A direct read of a trashed thread still answers (the recycle view opens it); it takes no writes
  // until restored, so the pane shows that state instead of the composer.
  trashed?: boolean;
  onRestoreFromTrash?: () => void;
  // F5: the restore buttons wait for a running bulk action instead of racing it.
  restoreBusy?: boolean;
  // R5-3: 置顶/关闭 had no busy gate at all — a synchronous double click sent two POSTs. Both buttons
  // share one flag (they write the same pane) and disable together while either is in flight.
  writeBusy?: boolean;
}

export function ThreadDetailPane({
  activeThread,
  activeError,
  author,
  onAuthorChange,
  replyBody,
  onReplyBodyChange,
  refusalMessage,
  replySubmitting,
  onTogglePin,
  onToggleClose,
  onSendReply,
  trashed = false,
  onRestoreFromTrash,
  restoreBusy = false,
  writeBusy = false,
}: ThreadDetailPaneProps) {
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  if (activeError) {
    return <div className="th-error-line">{activeError}</div>;
  }

  if (!activeThread) {
    // While the route points at a thread that has not loaded yet (or has just changed), the pane has no
    // stale controls to show — but it still says why it looks inactive, the same way any other blocked
    // write does, instead of looking like nothing is selected. G3: that reason is announced (role +
    // aria-live) exactly like the bulk bar's own status line already is — a screen-reader user gets the
    // same "still loading, not actually empty" signal a sighted owner reads from the text itself.
    return (
      <div
        className="empty"
        style={{ margin: 'auto' }}
        role={refusalMessage ? 'status' : undefined}
        aria-live={refusalMessage ? 'polite' : undefined}
      >
        {refusalMessage ? <span className="th-refusal">{refusalMessage}</span> : '选一个主题，或者开一个新的'}
      </div>
    );
  }

  const handleKeyDownReply = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onSendReply();
    }
  };

  return (
    <div className="thread-detail">
      <header className="thread-detail-head">
        <div className="th-head-info">
          <div className="th-head-top">
            <h2>{activeThread.title}</h2>
            {trashed && (
              <span className="stamp s-cancelled">在回收站中</span>
            )}
            {activeThread.closed && (
              <span className="stamp s-cancelled">已关闭</span>
            )}
          </div>
          <div className="d-meta">
            {activeThread.author} ·{' '}
            {new Date(activeThread.createdAt).toLocaleString('zh-CN')}
            {activeThread.tags.length > 0 && (
              <> · 标签：{activeThread.tags.join(', ')}</>
            )}
          </div>
        </div>
        <div className="th-head-actions">
          {trashed ? (
            <button
              className="btn primary tb-btn"
              type="button"
              onClick={onRestoreFromTrash}
              disabled={restoreBusy}
            >
              还原出回收站
            </button>
          ) : (
            <>
              <button className="btn ghost" type="button" onClick={onTogglePin} disabled={writeBusy}>
                {activeThread.pinned ? '取消置顶' : '置顶'}
              </button>
              <button className="btn ghost" type="button" onClick={onToggleClose} disabled={writeBusy}>
                {activeThread.closed ? '重新打开' : '关闭'}
              </button>
            </>
          )}
        </div>
      </header>

      <div className="thread-messages">
        {activeThread.messages.map((msg) => (
          <article key={msg.id} className="th-message">
            <div className="th-msg-header">
              <strong>{msg.author}</strong>
              <time className="mono">
                {new Date(msg.createdAt).toLocaleString('zh-CN')}
              </time>
            </div>
            <div className="th-msg-body">
              {linkSegments(msg.body).map((seg, i) =>
                seg.kind === 'link' ? (
                  <a
                    key={i}
                    href={seg.value}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {seg.value}
                  </a>
                ) : (
                  seg.value
                ),
              )}
            </div>
          </article>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="thread-composer">
        {trashed ? (
          <div className="th-closed-tape tb-trashed-note">
            此主题在回收站里（消息都还在，还原后保持原样继续）。
            {onRestoreFromTrash && (
              <button
                className="btn primary tb-btn"
                type="button"
                onClick={onRestoreFromTrash}
                disabled={restoreBusy}
              >
                还原此主题
              </button>
            )}
          </div>
        ) : activeThread.closed ? (
          <div className="th-closed-tape">此主题已关闭</div>
        ) : (
          <div className="th-composer-inner">
            <div className="th-author-row">
              <label htmlFor="th-reply-author">你的名字：</label>
              <input
                id="th-reply-author"
                type="text"
                className="th-author-input"
                value={author}
                maxLength={60}
                onChange={(e) => onAuthorChange(e.target.value)}
                placeholder="你的昵称"
              />
              <span className="hint">Ctrl + Enter 发送</span>
            </div>
            <textarea
              rows={3}
              placeholder="写下回复..."
              value={replyBody}
              onChange={(e) => onReplyBodyChange(e.target.value)}
              onKeyDown={handleKeyDownReply}
            />
            <div className="row end">
              {refusalMessage && (
                <span className="th-refusal">{refusalMessage}</span>
              )}
              <button
                className="btn primary"
                type="button"
                disabled={replySubmitting}
                onClick={onSendReply}
              >
                {replySubmitting ? '发送中…' : '发送回复'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
