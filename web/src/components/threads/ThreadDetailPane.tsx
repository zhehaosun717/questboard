import { useRef } from 'react';
import type { ThreadDetail } from '../../api/types';
import { linkSegments } from '../../lib/threads';
import { useT } from '../../lib/i18n';

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
  const t = useT();
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
        {refusalMessage ? <span className="th-refusal">{refusalMessage}</span> : t('threads.pickOne')}
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
              <span className="stamp s-cancelled">{t('threads.paneTrashed')}</span>
            )}
            {activeThread.closed && (
              <span className="stamp s-cancelled">{t('threads.paneClosed')}</span>
            )}
          </div>
          <div className="d-meta">
            {activeThread.author} ·{' '}
            {new Date(activeThread.createdAt).toLocaleString('zh-CN')}
            {activeThread.tags.length > 0 && (
              <>{t('threads.tagsPrefix')}{activeThread.tags.join(', ')}</>
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
              {t('threads.restoreOut')}
            </button>
          ) : (
            <>
              <button className="btn ghost" type="button" onClick={onTogglePin} disabled={writeBusy}>
                {activeThread.pinned ? t('threads.unpin') : t('threads.pin')}
              </button>
              <button className="btn ghost" type="button" onClick={onToggleClose} disabled={writeBusy}>
                {activeThread.closed ? t('threads.reopen') : t('threads.close')}
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
            {t('threads.trashNote')}
            {onRestoreFromTrash && (
              <button
                className="btn primary tb-btn"
                type="button"
                onClick={onRestoreFromTrash}
                disabled={restoreBusy}
              >
                {t('threads.restoreThis')}
              </button>
            )}
          </div>
        ) : activeThread.closed ? (
          <div className="th-closed-tape">{t('threads.closedTape')}</div>
        ) : (
          <div className="th-composer-inner">
            <div className="th-author-row">
              <label htmlFor="th-reply-author">{t('threads.yourName')}</label>
              <input
                id="th-reply-author"
                type="text"
                className="th-author-input"
                value={author}
                maxLength={60}
                onChange={(e) => onAuthorChange(e.target.value)}
                placeholder={t('threads.namePlaceholder')}
              />
              <span className="hint">{t('threads.ctrlEnter')}</span>
            </div>
            <textarea
              rows={3}
              placeholder={t('threads.replyPlaceholder')}
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
                {replySubmitting ? t('threads.sending') : t('threads.sendReply')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
