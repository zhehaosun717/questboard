import type { UsageProvider } from '../../api/types';
import {
  formatBalance,
  formatResetTime,
  formatSourceLabel,
  formatUsageDate,
  usageColorClass,
} from '../../lib/usage';

interface UsageProviderCardProps {
  provider: UsageProvider;
}

export function UsageProviderCard({ provider }: UsageProviderCardProps) {
  const isUnconfigured = !provider.configured;
  const isFailing = provider.configured && !provider.ok;

  const cardClasses = [
    'usage-card',
    isUnconfigured ? 'unconfigured' : '',
    isFailing ? 'failing' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <article className={cardClasses}>
      <header className="usage-card-header">
        <div className="usage-card-title-row">
          <h3 className="usage-provider-name">{provider.name}</h3>
          <span className="source-tag">
            {formatSourceLabel(provider.source)}
          </span>
        </div>
        {provider.keyFrom ? (
          <div className="key-from-line">{provider.keyFrom}</div>
        ) : null}
      </header>

      {isUnconfigured ? (
        <div className="usage-unconfigured-block">
          <p className="unconfigured-label">
            {provider.error || '未接入 / 未配置'}
          </p>
        </div>
      ) : isFailing ? (
        <div className="warn-tape usage-error-tape">
          {provider.error || '获取用量失败'}
        </div>
      ) : (
        <div className="usage-card-body">
          {provider.windows && provider.windows.length > 0 ? (
            <div className="usage-windows-list">
              {provider.windows.map((win, idx) => {
                const color = usageColorClass(win.usedPercent);
                const percentDisplay =
                  win.usedPercent !== null && win.usedPercent !== undefined
                    ? `${win.usedPercent}%`
                    : '未知';
                const resetDisplay = win.resetsAt
                  ? `重置于 ${formatResetTime(win.resetsAt)}`
                  : null;

                const widthPct =
                  win.usedPercent !== null && win.usedPercent !== undefined
                    ? Math.min(100, Math.max(0, win.usedPercent))
                    : 0;

                return (
                  <div key={idx} className="usage-window-item">
                    <div className="window-header">
                      <span className="window-label">{win.label}</span>
                      <span className="window-percent">{percentDisplay}</span>
                      {resetDisplay ? (
                        <span className="window-reset">{resetDisplay}</span>
                      ) : null}
                    </div>
                    <div className="usage-bar-track">
                      <div
                        className={`usage-bar-fill ${color}`}
                        style={{ width: `${widthPct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}

          {provider.balances && provider.balances.length > 0 ? (
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
            {provider.plan ? (
              <p className="usage-dim-line">{provider.plan}</p>
            ) : null}
            {provider.note ? (
              <p className="usage-dim-line">{provider.note}</p>
            ) : null}
            {provider.asOf ? (
              <p className="usage-dim-line">
                数据截至 {formatUsageDate(provider.asOf)}
              </p>
            ) : null}
          </div>
        </div>
      )}
    </article>
  );
}
