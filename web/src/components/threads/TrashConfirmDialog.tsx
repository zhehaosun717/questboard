import { useEffect, useRef } from 'react';
import type { ThreadWithTrash } from '../../api/threadBatch';
import { TRASH_EXPLANATION } from '../../api/threadBatch';
import { canReceiveFocus } from './threadAsyncGuards';

interface TrashConfirmDialogProps {
  // The exact threads the confirm button will act on; the list and its ids are what the owner approves.
  selected: ThreadWithTrash[];
  onConfirm: () => void;
  onCancel: () => void;
  // F5(a): where to send focus when the opener (删除) cannot take it back — confirming disables it in the
  // same render that unmounts this dialog, so `.focus()` on it is a no-op and focus would fall to <body>.
  onFallbackFocus?: () => void;
}

const LISTED = 10;
const FOCUSABLE = 'button:not([disabled])';

// Deleting is the one bulk action that asks first, because「删除」on most boards means gone forever.
// Here it means the recycle bin, so the dialog says that in one sentence and shows the count + ids
// of what will move. F5: it is also a real modal — initial focus goes to 取消 (the safe choice, so a
// stray Enter cannot confirm), Tab is trapped inside, Escape always closes it (never a click-through
// to the list below), and focus returns to the opener when it closes — or to `onFallbackFocus` when the
// opener was disabled or removed by the mutation the dialog just triggered.
export function TrashConfirmDialog({ selected, onConfirm, onCancel, onFallbackFocus }: TrashConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const initialFocusRef = useRef<HTMLButtonElement | null>(null);
  const onFallbackFocusRef = useRef(onFallbackFocus);
  onFallbackFocusRef.current = onFallbackFocus;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    initialFocusRef.current?.focus();
    return () => {
      if (canReceiveFocus(opener)) {
        opener!.focus();
      } else {
        // The opener is gone or disabled (a successful 确认删除 disables it before this cleanup runs):
        // land on a stable, always-present control instead of stranding focus on <body>.
        onFallbackFocusRef.current?.();
      }
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !dialogRef.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !dialogRef.current.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    // Listen on the window (capture): the dialog is only mounted while open, and Escape must work
    // wherever focus is — not only when it happens to sit inside the backdrop.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onCancel]);

  const shown = selected.slice(0, LISTED);
  const rest = selected.length - shown.length;

  return (
    <div
      className="modal-back"
      onClick={(e) => {
        // Only a click on the backdrop itself cancels; clicks inside the card never pass through.
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div ref={dialogRef} className="order tb-confirm" role="alertdialog" aria-modal="true" aria-labelledby="tb-trash-title">
        <p className="eyebrow">CONFIRM · 确认删除</p>
        <h2 id="tb-trash-title">把这 {selected.length} 个主题放入回收站？</h2>
        <p className="tb-note">{TRASH_EXPLANATION}</p>
        <ul className="tb-id-list" aria-label="将被放入回收站的主题">
          {shown.map((t) => (
            <li key={t.id}>
              <span className="mono">{t.id}</span> {t.title}
            </li>
          ))}
          {rest > 0 && <li className="tb-more">…另有 {rest} 个</li>}
        </ul>
        <div className="row end">
          <button
            ref={initialFocusRef}
            className="btn ghost"
            type="button"
            onClick={onCancel}
          >
            取消
          </button>
          <button className="btn danger" type="button" onClick={onConfirm}>
            确认放入回收站（{selected.length} 个）
          </button>
        </div>
      </div>
    </div>
  );
}
