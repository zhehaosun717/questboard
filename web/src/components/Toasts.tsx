import type { Toast } from '../hooks/useBoard';
import { formatClock } from '../lib/board';
import { useT } from '../lib/i18n';

interface ToastsProps {
  toasts: Toast[];
}

export function Toasts({ toasts }: ToastsProps) {
  const t = useT();
  if (toasts.length === 0) return null;

  return (
    <div id="toasts" className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="toast">
          <span className="t-time">{formatClock(toast.at)}{t('toast.guildReceipt')}</span>
          {toast.text}
        </div>
      ))}
    </div>
  );
}
