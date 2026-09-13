import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api/client';
import type { Thread, ThreadDetail, ThreadStatusFilter } from '../api/types';
import { formatClock } from '../lib/board';
import { NewThreadModal } from './threads/NewThreadModal';
import { ThreadDetailPane } from './threads/ThreadDetailPane';

interface ThreadsViewProps {
  activeThreadId: string | null;
  onSelectThread: (threadId: string | null) => void;
  isNewModalOpen: boolean;
  onOpenNewModal: () => void;
  onCloseNewModal: () => void;
}

function getStoredAuthor(): string {
  try {
    return localStorage.getItem('questboard.author') || '';
  } catch {
    return '';
  }
}

function setStoredAuthor(name: string): void {
  try {
    localStorage.setItem('questboard.author', name);
  } catch {}
}

function getStoredSeen(id: string): string | null {
  try {
    return localStorage.getItem(`questboard.seen.${id}`);
  } catch {
    return null;
  }
}

function setStoredSeen(id: string, stamp: string): void {
  try {
    localStorage.setItem(`questboard.seen.${id}`, stamp);
  } catch {}
}

export function ThreadsView({
  activeThreadId,
  onSelectThread,
  isNewModalOpen,
  onOpenNewModal,
  onCloseNewModal,
}: ThreadsViewProps) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [statusFilter, setStatusFilter] = useState<ThreadStatusFilter>('open');
  const [searchQuery, setSearchQuery] = useState('');
  const [listError, setListError] = useState<string | null>(null);

  const [activeThread, setActiveThread] = useState<ThreadDetail | null>(null);
  const [activeError, setActiveError] = useState<string | null>(null);

  const [author, setAuthor] = useState(getStoredAuthor);
  const [replyBody, setReplyBody] = useState('');
  const [refusalMessage, setRefusalMessage] = useState<string | null>(null);
  const [replySubmitting, setReplySubmitting] = useState(false);

  const handleAuthorChange = (val: string) => {
    setAuthor(val);
    setStoredAuthor(val);
    if (val.trim()) setRefusalMessage(null);
  };

  const loadThreads = useCallback(async () => {
    try {
      setListError(null);
      const res = await api.threads({
        status: statusFilter,
        q: searchQuery,
      });
      setThreads(res.threads);
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    }
  }, [statusFilter, searchQuery]);

  const loadActiveThread = useCallback(async (id: string) => {
    try {
      setActiveError(null);
      const detail = await api.thread(id);
      setActiveThread(detail);
      setStoredSeen(
        detail.id,
        detail.lastMessageAt || detail.updatedAt || new Date().toISOString(),
      );
    } catch (err) {
      setActiveError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    loadThreads();
    const interval = setInterval(loadThreads, 10000);
    return () => clearInterval(interval);
  }, [loadThreads]);

  useEffect(() => {
    if (activeThreadId) {
      loadActiveThread(activeThreadId);
    } else {
      setActiveThread(null);
    }
  }, [activeThreadId, loadActiveThread]);

  const handleSelect = (id: string) => {
    onSelectThread(id);
    setStoredSeen(id, new Date().toISOString());
  };

  const handleTogglePin = async () => {
    if (!activeThread) return;
    try {
      await api.pinThread(activeThread.id, !activeThread.pinned);
      await Promise.all([loadThreads(), loadActiveThread(activeThread.id)]);
    } catch (err) {
      setRefusalMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const handleToggleClose = async () => {
    if (!activeThread) return;
    try {
      await api.closeThread(activeThread.id, !activeThread.closed);
      await Promise.all([loadThreads(), loadActiveThread(activeThread.id)]);
    } catch (err) {
      setRefusalMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSendReply = async () => {
    if (!activeThread || activeThread.closed) return;
    setRefusalMessage(null);

    const trimmedAuthor = author.trim();
    if (!trimmedAuthor) {
      setRefusalMessage('请先填写你的名字');
      return;
    }

    const trimmedBody = replyBody.trim();
    if (!trimmedBody) return;

    setReplySubmitting(true);
    try {
      await api.reply(activeThread.id, {
        body: trimmedBody,
        author: trimmedAuthor,
      });
      setReplyBody('');
      await Promise.all([loadThreads(), loadActiveThread(activeThread.id)]);
    } catch (err) {
      if (err instanceof ApiError) {
        setRefusalMessage(err.message || '回复失败');
      } else {
        setRefusalMessage(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setReplySubmitting(false);
    }
  };

  return (
    <div className="threads-view">
      <aside className="threads-sidebar">
        <div className="threads-sidebar-head">
          <div className="head-row">
            <span className="eyebrow">TOPICS</span>
            <button
              className="btn primary"
              type="button"
              onClick={onOpenNewModal}
            >
              + 新主题
            </button>
          </div>
          <div className="filters-grid">
            <input
              type="search"
              placeholder="搜索主题..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <select
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(e.target.value as ThreadStatusFilter)
              }
            >
              <option value="open">开放</option>
              <option value="all">全部</option>
              <option value="closed">已关闭</option>
            </select>
          </div>
          <div className="th-count-row">
            <span>主题列表</span>
            <span className="count">{threads.length}</span>
          </div>
        </div>

        {listError && <div className="th-error-line">{listError}</div>}

        <div className="threads-list">
          {threads.length === 0 ? (
            <div className="empty">还没有主题</div>
          ) : (
            threads.map((t) => {
              const lastSeen = getStoredSeen(t.id);
              const unread = Boolean(
                t.lastMessageAt && (!lastSeen || t.lastMessageAt > lastSeen),
              );
              const isActive = t.id === activeThreadId;

              return (
                <button
                  key={t.id}
                  type="button"
                  className={`thread-item${isActive ? ' on' : ''}${unread ? ' unread' : ''}`}
                  onClick={() => handleSelect(t.id)}
                >
                  <div className="th-item-top">
                    {t.pinned && <span className="pin-mark">●</span>}
                    <strong className="th-item-title">{t.title}</strong>
                    {unread && <span className="unread-dot" title="有新消息" />}
                  </div>
                  <div className="th-item-meta">
                    <span>
                      {t.author} · {formatClock(t.updatedAt)}
                    </span>
                    <span className="mono">{t.messageCount} 条</span>
                  </div>
                  {t.tags.length > 0 && (
                    <div className="th-item-tags">
                      {t.tags.map((tag) => (
                        <span key={tag} className="chip">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </button>
              );
            })
          )}
        </div>
      </aside>

      <section className="threads-content">
        <ThreadDetailPane
          activeThread={activeThread}
          activeError={activeError}
          author={author}
          onAuthorChange={handleAuthorChange}
          replyBody={replyBody}
          onReplyBodyChange={setReplyBody}
          refusalMessage={refusalMessage}
          replySubmitting={replySubmitting}
          onTogglePin={handleTogglePin}
          onToggleClose={handleToggleClose}
          onSendReply={handleSendReply}
        />
      </section>

      {isNewModalOpen && (
        <NewThreadModal
          author={author}
          onAuthorChange={handleAuthorChange}
          onClose={onCloseNewModal}
          onCreated={(thread) => {
            loadThreads();
            onSelectThread(thread.id);
          }}
        />
      )}
    </div>
  );
}
