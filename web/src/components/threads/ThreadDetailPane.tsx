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
}: ThreadDetailPaneProps) {
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  if (activeError) {
    return <div className="th-error-line">{activeError}</div>;
  }

  if (!activeThread) {
    return (
      <div className="empty" style={{ margin: 'auto' }}>
        选一个主题，或者开一个新的
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
          <button className="btn ghost" type="button" onClick={onTogglePin}>
            {activeThread.pinned ? '取消置顶' : '置顶'}
          </button>
          <button className="btn ghost" type="button" onClick={onToggleClose}>
            {activeThread.closed ? '重新打开' : '关闭'}
          </button>
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
        {activeThread.closed ? (
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
