import { formatClockTime } from '../../lib/usage';
import { USAGE_INTERVAL_PRESETS_MS, type UsageRefreshMode } from '../../lib/usagePreference';
import { useT } from '../../lib/i18n';

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
  const t = useT();
  const intervalLabel = (ms: number): string =>
    ms % 60000 === 0
      ? t('usageControls.minutes', { count: ms / 60000 })
      : t('usageControls.seconds', { count: Math.round(ms / 1000) });
  const canRefreshAll = !refreshingAll && cooldownMs <= 0;
  const refreshAllLabel = refreshingAll
    ? t('common.reading')
    : cooldownMs > 0
      ? t('common.cooldown', { seconds: Math.ceil(cooldownMs / 1000) })
      : t('usageControls.refreshAll');

  const statusText = paused
    ? t('usageControls.paused')
    : mode === 'interval'
      ? t('usageControls.interval', { interval: intervalLabel(intervalMs) })
      : t('usageControls.manualOnly');

  return (
    <div className="usage-controls-row">
      {fetchedAt !== null ? (
        <span className="usage-timestamp">
          {t('usageControls.fetchedAt', { time: formatClockTime(fetchedAt) })}
          {refreshingAll ? t('usageControls.updating') : ''}
        </span>
      ) : null}

      <label className="usage-mode-select">
        {t('usageControls.mode')}
        <select value={mode} onChange={(e) => onModeChange(e.target.value === 'interval' ? 'interval' : 'manual')}>
          <option value="manual">{t('usageControls.modeManual')}</option>
          <option value="interval">{t('usageControls.modeInterval')}</option>
        </select>
      </label>

      {mode === 'interval' ? (
        <label className="usage-mode-select">
          {t('usageControls.intervalLabel')}
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
