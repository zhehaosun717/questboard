import type { Toast } from '../hooks/useBoard';
import { formatClock } from '../lib/board';

interface ToastsProps {
  toasts: Toast[];
}

export function Toasts({ toasts }: ToastsProps) {
  if (toasts.length === 0) return null;

  return (
    <div id="toasts" className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          <span className="t-time">{formatClock(t.at)} · 公会回执</span>
          {t.text}
        </div>
      ))}
    </div>
  );
}
