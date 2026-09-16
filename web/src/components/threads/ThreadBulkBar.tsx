import type { ThreadBulkAction } from '../../api/threadBatch';
import { MAX_THREAD_BULK_IDS } from '../../api/threadBatch';

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
  const none = selectedCount === 0;
  const disabled = busy || none;
  const limit =
    selectedCount >= MAX_THREAD_BULK_IDS
      ? `（已达单次上限 ${MAX_THREAD_BULK_IDS} 个）`
      : '';

  return (
    <div className="tb-bulk-bar" role="group" aria-label="批量操作">
      <div className="tb-bulk-row">
        <button
          type="button"
          className="btn ghost tb-btn"
          onClick={onSelectVisible}
          disabled={busy || visibleCount === 0}
        >
          选中可见
        </button>
        <button
          type="button"
          className="btn ghost tb-btn"
          onClick={onClear}
          disabled={busy || none}
        >
          清除
        </button>
        <span className="tb-count" aria-live="polite">
          已选 {selectedCount} / 可见 {visibleCount}
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
            还原所选
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn ghost tb-btn"
              onClick={() => onAction('close')}
              disabled={disabled}
            >
              关闭
            </button>
            <button
              type="button"
              className="btn ghost tb-btn"
              onClick={() => onAction('reopen')}
              disabled={disabled}
            >
              重新打开
            </button>
            <button
              type="button"
              className="btn ghost tb-btn"
              onClick={() => onAction('pin')}
              disabled={disabled}
            >
              置顶
            </button>
            <button
              type="button"
              className="btn ghost tb-btn"
              onClick={() => onAction('unpin')}
              disabled={disabled}
            >
              取消置顶
            </button>
            <button
              type="button"
              className="btn danger tb-btn"
              onClick={() => onAction('trash')}
              disabled={disabled}
            >
              删除
            </button>
          </>
        )}
      </div>
      {(status || busy) && (
        // While a run is in flight the bar says so — buttons grey out, but the reason is visible too.
        <div className="tb-status" role="status" aria-live="polite">
          {status ?? '批量操作处理中…'}
        </div>
      )}
    </div>
  );
}
