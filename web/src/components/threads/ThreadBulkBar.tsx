import type { ThreadBulkAction } from '../../api/threadBatch';
import { MAX_THREAD_BULK_IDS } from '../../api/threadBatch';
import { useT } from '../../lib/i18n';

export interface ThreadBulkBarProps {
  visibleCount: number;
  selectedCount: number;
  trashView: boolean;
  busy: boolean;
  // Last run result, announced through aria-live. A partial run stays visible until the next action.
  status: string | null;
  onSelectVisible: () => void;
  onClear: () => void;
  // `trash` never arrives here directly: the parent opens the confirmation dialog first.
  onAction: (action: ThreadBulkAction) => void;
}

// One narrow toolbar above the list. Every button names the exact action; nothing is implicit, and
// the count row keeps the owner honest about how many rows the next click will touch.
export function ThreadBulkBar({
  visibleCount,
  selectedCount,
  trashView,
  busy,
  status,
  onSelectVisible,
  onClear,
  onAction,
}: ThreadBulkBarProps) {
  const t = useT();
  const none = selectedCount === 0;
  const disabled = busy || none;
  const limit =
    selectedCount >= MAX_THREAD_BULK_IDS
      ? t('threadsBulk.limit', { max: MAX_THREAD_BULK_IDS })
      : '';

  return (
    <div className="tb-bulk-bar" role="group" aria-label={t('threadsBulk.groupLabel')}>
      <div className="tb-bulk-row">
        <button
          type="button"
          className="btn ghost tb-btn"
          onClick={onSelectVisible}
          disabled={busy || visibleCount === 0}
        >
          {t('threadsBulk.selectVisible')}
        </button>
        <button
          type="button"
          className="btn ghost tb-btn"
          onClick={onClear}
          disabled={busy || none}
        >
          {t('threadsBulk.clear')}
        </button>
        <span className="tb-count" aria-live="polite">
          {t('threadsBulk.count', { selected: selectedCount, visible: visibleCount })}
          {limit}
        </span>
      </div>
      <div className="tb-bulk-row">
        {trashView ? (
          <button
            type="button"
            className="btn primary tb-btn"
            onClick={() => onAction('restore')}
            disabled={disabled}
          >
            {t('threadsBulk.restoreSelected')}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn ghost tb-btn"
              onClick={() => onAction('close')}
              disabled={disabled}
            >
              {t('threadsBulk.close')}
            </button>
            <button
              type="button"
              className="btn ghost tb-btn"
              onClick={() => onAction('reopen')}
              disabled={disabled}
            >
              {t('threadsBulk.reopen')}
            </button>
            <button
              type="button"
              className="btn ghost tb-btn"
              onClick={() => onAction('pin')}
              disabled={disabled}
            >
              {t('threadsBulk.pin')}
            </button>
            <button
              type="button"
              className="btn ghost tb-btn"
              onClick={() => onAction('unpin')}
              disabled={disabled}
            >
              {t('threadsBulk.unpin')}
            </button>
            <button
              type="button"
              className="btn danger tb-btn"
              onClick={() => onAction('trash')}
              disabled={disabled}
            >
              {t('threadsBulk.delete')}
            </button>
          </>
        )}
      </div>
      {(status || busy) && (
        // While a run is in flight the bar says so — buttons grey out, but the reason is visible too.
        <div className="tb-status" role="status" aria-live="polite">
          {status ?? t('threadsBulk.busy')}
        </div>
      )}
    </div>
  );
}
