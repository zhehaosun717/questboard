import { useState } from 'react';
import { ApiError, api } from '../../api/client';
import type { ThreadDetail } from '../../api/types';

interface NewThreadModalProps {
  author: string;
  onAuthorChange: (author: string) => void;
  onClose: () => void;
  onCreated: (thread: ThreadDetail) => void;
}

export function NewThreadModal({
  author,
  onAuthorChange,
  onClose,
  onCreated,
}: NewThreadModalProps) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tags, setTags] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [generalError, setGeneralError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setGeneralError(null);
    setFieldErrors({});

    const trimmedAuthor = author.trim();
    if (!trimmedAuthor) {
      setFieldErrors({ author: '请填写你的名字' });
      return;
    }

    setSubmitting(true);
    try {
      const tagList = tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const res = await api.createThread({
        title: title.trim(),
        body: body.trim(),
        tags: tagList,
        author: trimmedAuthor,
      });
      onCreated(res.thread);
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fields || {});
        if (err.message) {
          setGeneralError(err.message);
        }
      } else {
        setGeneralError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="modal-back"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form className="order" onSubmit={handleSubmit}>
        <p className="eyebrow">NEW THREAD · 新主题</p>
        <h2>发起新讨论</h2>

        {generalError && <div className="warn-tape">{generalError}</div>}

        <label htmlFor="nt-author">你的名字</label>
        <input
          id="nt-author"
          type="text"
          value={author}
          maxLength={60}
          onChange={(e) => onAuthorChange(e.target.value)}
          placeholder="你的昵称"
          required
        />
        {fieldErrors.author && (
          <div className="field-error-msg">{fieldErrors.author}</div>
        )}

        <label htmlFor="nt-title">标题</label>
        <input
          id="nt-title"
          type="text"
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="讨论主题标题"
          required
        />
        {fieldErrors.title && (
          <div className="field-error-msg">{fieldErrors.title}</div>
        )}

        <label htmlFor="nt-body">第一条消息</label>
        <textarea
          id="nt-body"
          rows={5}
          value={body}
          maxLength={20000}
          onChange={(e) => setBody(e.target.value)}
          placeholder="输入消息内容..."
          required
        />
        {fieldErrors.body && (
          <div className="field-error-msg">{fieldErrors.body}</div>
        )}

        <label htmlFor="nt-tags">
          标签 <span className="hint">（逗号分隔）</span>
        </label>
        <input
          id="nt-tags"
          type="text"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="如：research, playtest"
        />
        {fieldErrors.tag && (
          <div className="field-error-msg">{fieldErrors.tag}</div>
        )}

        <div className="row end" style={{ marginTop: '16px' }}>
          <button
            className="btn ghost"
            type="button"
            onClick={onClose}
            disabled={submitting}
          >
            取消
          </button>
          <button
            className="btn primary"
            type="submit"
            disabled={submitting}
          >
            {submitting ? '发布中…' : '发布主题'}
          </button>
        </div>
      </form>
    </div>
  );
}
