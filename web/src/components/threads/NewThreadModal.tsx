import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { ApiError, api } from '../../api/client';
import { UNKNOWN_ERROR_ZH, bulkErrorLabel, describeFieldErrors } from '../../api/threadBatch';
import type { ThreadDetail } from '../../api/types';
import { canReceiveFocus, isFocusStillParked } from './threadAsyncGuards';
import { useT } from '../../lib/i18n';

interface NewThreadModalProps {
  author: string;
  onAuthorChange: (author: string) => void;
  onClose: () => void;
  // R5-2: `onCreated` used to fire unconditionally once the request resolved — late enough that the owner
  // could already be on a different project (or have left the view entirely), and it would still reload
  // and navigate as if nothing had changed. `beginCreateEpoch` is called synchronously, before the
  // request goes out, and its result is handed back to `onCreated` unchanged; ThreadsView decides there
  // whether the project it names is still the one on screen (create's scope is the project generation
  // only — never `activeThreadId`, which has nothing to do with a thread that doesn't exist yet).
  beginCreateEpoch: () => string;
  onCreated: (thread: ThreadDetail, epoch: string) => void;
  // D6: whatever had focus right before this modal opened (the "+ 新主题" button, most often). Given back
  // focus once this modal unmounts — cancel, backdrop click, Escape, or a successful create — unless the
  // owner has since moved focus off <body> themselves (there is no focus trap here, so that only happens
  // if something outside this modal grabbed it while it was open).
  restoreFocusRef?: MutableRefObject<HTMLElement | null>;
}

export function NewThreadModal({
  author,
  onAuthorChange,
  onClose,
  beginCreateEpoch,
  onCreated,
  restoreFocusRef,
}: NewThreadModalProps) {
  const t = useT();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tags, setTags] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<'author' | 'title' | 'body' | 'tag', string>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [generalError, setGeneralError] = useState<string | null>(null);
  // D6: "modal opens focus inside it" — the title field is the first thing worth typing into (the name
  // field is usually already filled from storage).
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    titleInputRef.current?.focus();
  }, []);
  // R5-2 (unmount half): leaving the view entirely (e.g. to #/board) unmounts this modal while the create
  // request is still in flight. The request itself cannot be cancelled, but nothing here may touch this
  // component's own state — or call a prop that assumes it's still open — once that has happened.
  const mountedRef = useRef(true);
  useEffect(() => {
    // D4: StrictMode's dev-only mount→unmount→mount replay runs this cleanup once before the "real" mount
    // — without setting `true` back here, that replay left `mountedRef.current` permanently `false`, so a
    // real, current create's own success handler below read itself as already-unmounted and could never
    // clear `submitting` or navigate. `aliveRef` in ThreadsView already does this correctly (reset in the
    // effect body, not just cleared in cleanup); this brings the modal's own ref in line with it.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // D6: focus wherever it was before this modal opened, once it unmounts — but only if the owner hasn't
  // moved focus outside this modal themselves in the meantime. Unlike useBulkFocusRestore.ts's busy/
  // disable race (an element gains `disabled` but stays in the tree, so the browser blurs it to <body>
  // *before* that layout effect runs), this is a full unmount: React runs a deleted subtree's layout-
  // effect cleanups *before* detaching its DOM, so at this point the modal's own fields are still in the
  // document and still focused — `document.activeElement` is never `<body>` yet. Checking whether focus is
  // still somewhere inside this modal's own root (`rootRef`) and moving it to the opener *now*, ahead of
  // the detach, is what avoids the browser's own forced blur-to-body a moment later.
  const rootRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(
    () => () => {
      if (typeof document === 'undefined') return;
      const root = rootRef.current;
      if (!root || !root.contains(document.activeElement)) return;
      const opener = restoreFocusRef?.current;
      if (canReceiveFocus(opener)) opener?.focus();
    },
    [restoreFocusRef],
  );
  // 取消/发布主题 both disable while `submitting`, which — exactly like the bulk bar's own busy/disable race
  // (useBulkFocusRestore.ts's G4) — blurs a focused one straight to <body> the instant the disable commits,
  // before this component ever renders again. The title field is the one control this form never disables,
  // so it is the "still-enabled dialog target" to park on; by the time a settle (error stays open) or an
  // unmount (success/cancel/backdrop/Escape) runs, focus is back inside the dialog instead of stranded on
  // body, and the existing rootRef cleanup above already knows how to hand it on from there.
  //
  // F3: this modal parks unconditionally (it always redirects a busy-start <body> to 标题), so — unlike
  // useBulkFocusRestore.ts's shared hook, reused unmodified by the bulk bar and pane — a <body> seen again
  // at settle here can only mean the owner moved focus away themselves in between (a click on the
  // nonfocusable heading blurs straight to <body>, same as the disable does). Treating that <body> as
  // permission to restore is exactly the theft the fix forbids, so this modal tracks the owner's own intent
  // directly — any pointerdown or focusin that isn't the parked title field, for the whole busy stretch —
  // instead of asking document.activeElement to tell "nothing happened" apart from "the owner left".
  const focusOpenerRef = useRef<HTMLElement | null>(null);
  const pendingRestoreRef = useRef(false);
  const parkedValueRef = useRef<string | null>(null);
  const ownerMovedFocusRef = useRef(false);
  useLayoutEffect(() => {
    if (typeof document === 'undefined') return;
    if (submitting) {
      pendingRestoreRef.current = true;
      ownerMovedFocusRef.current = false;
      if (document.activeElement === document.body) {
        titleInputRef.current?.focus();
      }
      parkedValueRef.current = titleInputRef.current?.value ?? null;
      const noteOwnerIntent = (e: Event) => {
        if (e.target !== titleInputRef.current) ownerMovedFocusRef.current = true;
      };
      document.addEventListener('pointerdown', noteOwnerIntent, true);
      document.addEventListener('focusin', noteOwnerIntent, true);
      return () => {
        document.removeEventListener('pointerdown', noteOwnerIntent, true);
        document.removeEventListener('focusin', noteOwnerIntent, true);
      };
    }
    if (!pendingRestoreRef.current) return;
    pendingRestoreRef.current = false;
    const opener = focusOpenerRef.current;
    focusOpenerRef.current = null;
    const parkedValue = parkedValueRef.current;
    parkedValueRef.current = null;
    const movedAway = ownerMovedFocusRef.current;
    ownerMovedFocusRef.current = false;
    // The owner's own pointer/focus move wins outright — even one that (like the heading click) lands back
    // on <body> — so this never even reaches the atBody/atFallback check below.
    if (movedAway) return;
    const atBody = document.activeElement === document.body;
    const atFallback = document.activeElement === titleInputRef.current;
    if (!atBody && !atFallback) return;
    if (atFallback && !isFocusStillParked(parkedValue, titleInputRef.current?.value ?? null)) return;
    if (canReceiveFocus(opener)) {
      opener?.focus();
    } else {
      titleInputRef.current?.focus();
    }
  }, [submitting]);
  // R5-3/P3-P5's other half: `submitting` (render state) cannot by itself stop a same-task double
  // submission — a second Enter keypress dispatched before React flushes the first click's state update
  // still reads `submitting` as `false`. This ref is the synchronous check, set before any `await`,
  // scoped to this one modal instance (a fresh instance — a fresh ref — every time it opens).
  const submittingRef = useRef(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    setGeneralError(null);
    setFieldErrors({});

    const trimmedAuthor = author.trim();
    if (!trimmedAuthor) {
      setFieldErrors({ author: t('threadsForm.authorRequired') });
      return;
    }

    const epoch = beginCreateEpoch();
    // Capture whatever had focus right before 发布主题/取消 disable, the same way the bulk bar and
    // pane-write buttons already do — see useBulkFocusRestore.ts.
    focusOpenerRef.current =
      typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const tagList = tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean);
      const res = await api.createThread({
        title: title.trim(),
        body: body.trim(),
        tags: tagList,
        author: trimmedAuthor,
      });
      if (!mountedRef.current) return;
      // The project this create actually belongs to may no longer be the one on screen; ThreadsView's own
      // epoch check (not this component's) decides whether the reload/navigation still applies.
      onCreated(res.thread, epoch);
      onClose();
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof ApiError) {
        // D3/R11/R11b: `err.fields` is runtime data off an HTTP response, not curated UI copy — an
        // allowlisted field name, a known code mapped to fixed Chinese, anything else (an unrecognized
        // string, or a non-string value that would otherwise crash React trying to render it) becomes one
        // generic per-field line. See threadBatch.ts's `describeFieldErrors`.
        setFieldErrors(describeFieldErrors(err.fields));
        if (err.message) {
          // R5-5: route the top-level message through the same known/generic mapping every other thread
          // error uses, so an unrecognized create failure can't reflect raw server text either.
          setGeneralError(bulkErrorLabel(err.message));
        }
      } else {
        setGeneralError(UNKNOWN_ERROR_ZH);
      }
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  };

  return (
    <div
      ref={rootRef}
      className="modal-back"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form className="order" onSubmit={handleSubmit}>
        <p className="eyebrow">{t('threadsForm.eyebrow')}</p>
        <h2>{t('threadsForm.title')}</h2>

        {generalError && <div className="warn-tape">{generalError}</div>}

        <label htmlFor="nt-author">{t('threadsForm.authorLabel')}</label>
        <input
          id="nt-author"
          type="text"
          value={author}
          maxLength={60}
          onChange={(e) => onAuthorChange(e.target.value)}
          placeholder={t('threads.namePlaceholder')}
          required
        />
        {fieldErrors.author && (
          <div className="field-error-msg">{fieldErrors.author}</div>
        )}

        <label htmlFor="nt-title">{t('threadsForm.titleLabel')}</label>
        <input
          id="nt-title"
          ref={titleInputRef}
          type="text"
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('threadsForm.titlePlaceholder')}
          required
        />
        {fieldErrors.title && (
          <div className="field-error-msg">{fieldErrors.title}</div>
        )}

        <label htmlFor="nt-body">{t('threadsForm.firstMessage')}</label>
        <textarea
          id="nt-body"
          rows={5}
          value={body}
          maxLength={20000}
          onChange={(e) => setBody(e.target.value)}
          placeholder={t('threadsForm.bodyPlaceholder')}
          required
        />
        {fieldErrors.body && (
          <div className="field-error-msg">{fieldErrors.body}</div>
        )}

        <label htmlFor="nt-tags">
          {t('threadsForm.tagsLabel')} <span className="hint">{t('threadsForm.tagsHint')}</span>
        </label>
        <input
          id="nt-tags"
          type="text"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder={t('threadsForm.tagsPlaceholder')}
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
            {t('threadsForm.cancel')}
          </button>
          <button
            className="btn primary"
            type="submit"
            disabled={submitting}
          >
            {submitting ? t('threadsForm.publishing') : t('threadsForm.publish')}
          </button>
        </div>
      </form>
    </div>
  );
}
