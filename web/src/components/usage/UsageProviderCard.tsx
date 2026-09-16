import type { UsageProvider } from '../../api/types';
import { USAGE_TARGETED_REFRESH_SUPPORTED } from '../../lib/usageCache';
import {
  formatBalance,
  formatPercentOrUnknown,
  formatResetTime,
  formatSourceLabel,
  formatUsageDate,
  providerGuidanceText,
  USAGE_TARGETED_REFRESH_UNSUPPORTED_HINT,
  usageColorClass,
  usageStateInfo,
} from '../../lib/usage';

interface UsageProviderCardProps {
  provider: UsageProvider;
  refreshing: boolean;
  cooldownMs: number;
  onRefresh: () => void;
}

export function UsageProviderCard({ provider, refreshing, cooldownMs, onRefresh }: UsageProviderCardProps) {
  const info = usageStateInfo(provider);
  const showsNumbers = info.tone === 'data';
  const isStale = provider.state === 'stale';
  // 'expired'/'failed' need the owner to actually do something; 'unconfigured'/'unavailable' are just a
  // fact about this machine's setup, not a warning — the same visual language as "no quota" would read as
  // an accusation for a source nobody ever meant to hook up.
  const isUrgent = info.state === 'expired' || info.state === 'failed';
  const cardClasses = [
    'usage-card',
    info.tone === 'neutral' && !isUrgent ? 'unconfigured' : '',
    isUrgent ? 'failing' : '',
    isStale ? 'stale' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const canRefresh = !refreshing && cooldownMs <= 0 && info.state !== 'unavailable';
  const refreshLabel = refreshing
    ? '正在读取…'
    : cooldownMs > 0
      ? `冷却中 ${Math.ceil(cooldownMs / 1000)}s`
      : '刷新';

  return (
    <article className={cardClasses} aria-busy={refreshing}>
      <header className="usage-card-header">
        <div className="usage-card-title-row">
          <h3 className="usage-provider-name">{provider.name}</h3>
          <div className="usage-card-title-actions">
            <span className="source-tag">{formatSourceLabel(provider.source)}</span>
            {info.state !== 'unavailable' ? (
              <button
                type="button"
                className="btn usage-refresh-btn"
                aria-disabled={!canRefresh}
                aria-busy={refreshing}
                // aria-disabled (not the native `disabled` attribute) keeps this button focusable even
                // while it can't be activated, so pressing Enter on it never drops keyboard focus back to
                // <body> the way a truly-disabled button does (U10). The guard below is what actually
                // blocks the action.
                onClick={() => {
                  if (canRefresh) onRefresh();
                }}
                aria-label={`刷新 ${provider.name} 的用量`}
                title={USAGE_TARGETED_REFRESH_SUPPORTED ? undefined : USAGE_TARGETED_REFRESH_UNSUPPORTED_HINT}
              >
                {refreshLabel}
              </button>
            ) : null}
          </div>
        </div>
        {provider.keyFrom ? <div className="key-from-line">{provider.keyFrom}</div> : null}
        {info.label ? <span className={`usage-state-tag usage-state-${info.state}`}>{info.label}</span> : null}
      </header>

      {/* Not aria-live: a live region per card (one per provider) flooded screen readers with simultaneous
          announcements on "refresh all" — see UsageView's single consolidated status region instead. */}
      <div className="usage-card-body">
        {showsNumbers ? (
          <>
            {provider.windows.length > 0 ? (
              <div className="usage-windows-list">
                {provider.windows.map((win, idx) => {
                  const color = usageColorClass(win.usedPercent);
                  const percentDisplay = formatPercentOrUnknown(win.usedPercent);
                  const resetDisplay = win.resetsAt ? `重置于 ${formatResetTime(win.resetsAt)}` : null;
                  const widthPct =
                    win.usedPercent !== null && win.usedPercent !== undefined
                      ? Math.min(100, Math.max(0, win.usedPercent))
                      : 0;

                  return (
                    <div key={idx} className="usage-window-item">
                      <div className="window-header">
                        <span className="window-label">{win.label}</span>
                        <span className="window-percent">{percentDisplay}</span>
                        {resetDisplay ? <span className="window-reset">{resetDisplay}</span> : null}
                      </div>
                      <div className="usage-bar-track">
                        <div className={`usage-bar-fill ${color}`} style={{ width: `${widthPct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}

            {provider.balances.length > 0 ? (
              <div className="usage-balances-row">
                <span className="balance-title">余额：</span>
                {provider.balances.map((b, idx) => (
                  <span key={idx} className="balance-chip">
                    {formatBalance(b.amount, b.currency)}
                  </span>
                ))}
              </div>
            ) : null}

            <div className="usage-dim-details">
              {provider.plan ? <p className="usage-dim-line">{provider.plan}</p> : null}
              {provider.note ? <p className="usage-dim-line">{provider.note}</p> : null}
              {provider.asOf ? <p className="usage-dim-line">数据截至 {formatUsageDate(provider.asOf)}</p> : null}
              {provider.lastSuccessAt ? (
                <p className="usage-dim-line">上次成功 {formatUsageDate(provider.lastSuccessAt)}</p>
              ) : null}
            </div>

            {isStale ? <div className="usage-stale-note">{providerGuidanceText(provider)}</div> : null}
          </>
        ) : (
          <div className={isUrgent ? 'warn-tape usage-error-tape' : 'usage-neutral-block'}>
            {providerGuidanceText(provider)}
          </div>
        )}
      </div>
    </article>
  );
}
