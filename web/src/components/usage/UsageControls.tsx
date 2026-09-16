import { formatClockTime } from '../../lib/usage';
import { USAGE_INTERVAL_PRESETS_MS, type UsageRefreshMode } from '../../lib/usagePreference';

interface UsageControlsProps {
  fetchedAt: number | null;
  refreshingAll: boolean;
  cooldownMs: number;
  onRefreshAll: () => void;
  mode: UsageRefreshMode;
  intervalMs: number;
  onModeChange: (mode: UsageRefreshMode) => void;
  onIntervalChange: (ms: number) => void;
  paused: boolean;
}

function intervalLabel(ms: number): string {
  return ms % 60000 === 0 ? `${ms / 60000} 分钟` : `${Math.round(ms / 1000)} 秒`;
}

/** Header controls for the usage page: manual/interval choice, refresh-all with its own cooldown, and one
 * aria-live status line so a screen reader hears "auto-refresh paused" / the current interval without the
 * owner needing to find and re-read the whole grid. Auto-refresh itself lives in UsageView (the interval
 * timer + visibility pause) — this component only reflects that state and reports the owner's choices up. */
export function UsageControls({
  fetchedAt,
  refreshingAll,
  cooldownMs,
  onRefreshAll,
  mode,
  intervalMs,
  onModeChange,
  onIntervalChange,
  paused,
}: UsageControlsProps) {
  const canRefreshAll = !refreshingAll && cooldownMs <= 0;
  const refreshAllLabel = refreshingAll
    ? '正在读取…'
    : cooldownMs > 0
      ? `冷却中 ${Math.ceil(cooldownMs / 1000)}s`
      : '刷新全部';

  const statusText = paused
    ? '页面不可见，自动刷新已暂停'
    : mode === 'interval'
      ? `每 ${intervalLabel(intervalMs)} 自动刷新一次`
      : '仅手动刷新';

  return (
    <div className="usage-controls-row">
      {fetchedAt !== null ? (
        <span className="usage-timestamp">
          查询于 {formatClockTime(fetchedAt)}
          {refreshingAll ? ' · 正在更新…' : ''}
        </span>
      ) : null}

      <label className="usage-mode-select">
        更新方式
        <select value={mode} onChange={(e) => onModeChange(e.target.value === 'interval' ? 'interval' : 'manual')}>
          <option value="manual">手动</option>
          <option value="interval">定时</option>
        </select>
      </label>

      {mode === 'interval' ? (
        <label className="usage-mode-select">
          间隔
          <select value={intervalMs} onChange={(e) => onIntervalChange(Number(e.target.value))}>
            {USAGE_INTERVAL_PRESETS_MS.map((ms) => (
              <option key={ms} value={ms}>
                {intervalLabel(ms)}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {/* aria-disabled, not `disabled`: keeps this button focusable through a refresh it just triggered
          with the keyboard, instead of losing focus to <body> (U10). */}
      <button
        type="button"
        className="btn usage-refresh-all-btn"
        aria-disabled={!canRefreshAll}
        aria-busy={refreshingAll}
        onClick={() => {
          if (canRefreshAll) onRefreshAll();
        }}
      >
        {refreshAllLabel}
      </button>

      {/* Not aria-live: the page's one consolidated status region (UsageView) covers the pause/refreshing
          announcement; this line still shows the same text visually. */}
      <span className="usage-status-line">{statusText}</span>
    </div>
  );
}
