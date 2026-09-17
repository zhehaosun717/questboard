import type { UsageProvider } from '../../api/types';
import { USAGE_TARGETED_REFRESH_SUPPORTED } from '../../lib/usageCache';
import { useT } from '../../lib/i18n';
import {
  formatAccessLabel,
  formatAsOfLine,
  formatBalance,
  formatBalanceAvailability,
  formatPercentOrUnknown,
  formatProviderStateLabel,
  formatUsageDate,
  formatWindowResetLine,
  providerGuidanceText,
  USAGE_TARGETED_REFRESH_UNSUPPORTED_HINT,
  usageColorClass,
  usageStateInfo,
  WINDOW_RESET_REFRESH_TEXT,
} from '../../lib/usage';

interface UsageProviderCardProps {
  provider: UsageProvider;
  refreshing: boolean;
  cooldownMs: number;
  onRefresh: () => void;
}

/** Only an https docsUrl becomes a link. The value comes from the server's catalog, but the card is the
 * last gate: whatever an old or misbehaving backend puts in this field, an http: or javascript: string
 * (or plain garbage) must never render as a clickable console link. */
function httpsDocsUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}

export function UsageProviderCard({ provider, refreshing, cooldownMs, onRefresh }: UsageProviderCardProps) {
  const t = useT();
  const info = usageStateInfo(provider);
  // Manual-only cards never show numbers or bars: there is no reading to show yet (feedback 36) — the
  // note and the console link are the whole card, whatever cache state the backend attached.
  const manualOnly = provider.providerState === 'manual_only';
  const showsNumbers = !manualOnly && info.tone === 'data';
  const isStale = provider.state === 'stale';
  // 'expired'/'failed' need the owner to actually do something; 'unconfigured'/'unavailable' are just a
  // fact about this machine's setup, not a warning — the same visual language as "no quota" would read as
  // an accusation for a source nobody ever meant to hook up.
  const isUrgent = info.state === 'expired' || info.state === 'failed';
  // Only these three states are something the owner can act on right now: a still-loading ('pending') card
  // showing setup steps next to "正在读取用量数据，请稍候" reads as if the owner has to do something on
  // every cold load, when there is simply no reading yet (F4).
  const showsSetupGuidance = info.state === 'unconfigured' || info.state === 'expired' || info.state === 'failed';
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
    ? t('common.reading')
    : cooldownMs > 0
      ? t('common.cooldown', { seconds: Math.ceil(cooldownMs / 1000) })
      : t('usageCard.refresh');

  // Three intentionally separate labels (feedback 36): providerState (正常/未订阅/未知/手动查看) is the
  // provider fact; the cache-state tag below the title is freshness; access (官方接口/...) says how the
  // reading is obtained; credentialType stays a plain type name.
  const accessLabel = formatAccessLabel(provider.access ?? provider.source);
  const providerStateLabel = provider.providerState ? formatProviderStateLabel(provider.providerState) : null;
  const showProviderStateLabel = providerStateLabel && providerStateLabel !== accessLabel;
  const subscribedWithoutPeriods = provider.providerState === 'unknown'
    && provider.plan.includes('已订阅')
    && provider.windows.length === 0
    && provider.balances.length === 0;
  const docsUrl = httpsDocsUrl(provider.docsUrl);
  const asOfLine = formatAsOfLine(provider.asOf, provider.asOfDerived);

  const docsLine = docsUrl ? (
    <p className="usage-dim-line">
      <a className="usage-docs-link" href={docsUrl} target="_blank" rel="noopener noreferrer">
        {t('usageCard.docs')}
      </a>
    </p>
  ) : null;
  // Shown as plain, selectable code text — never executed, and never turned into a button that runs it.
  const setupLine = provider.setupCommand ? (
    <p className="usage-dim-line">
      {t('usageCard.manualRun')}<code className="usage-setup-command">{provider.setupCommand}</code>
    </p>
  ) : null;

  return (
    <article className={cardClasses} aria-busy={refreshing}>
      <header className="usage-card-header">
        <div className="usage-card-title-row">
          <h3 className="usage-provider-name">{provider.name}</h3>
          <div className="usage-card-title-actions">
            <span className="source-tag">{accessLabel}</span>
            {provider.credentialType ? (
              <span className="usage-credential-type">{provider.credentialType}</span>
            ) : null}
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
                aria-label={t('usageCard.refreshAria', { name: provider.name })}
                title={USAGE_TARGETED_REFRESH_SUPPORTED ? undefined : USAGE_TARGETED_REFRESH_UNSUPPORTED_HINT}
              >
                {refreshLabel}
              </button>
            ) : null}
          </div>
        </div>
        {provider.keyFrom ? <div className="key-from-line">{provider.keyFrom}</div> : null}
        {info.label ? <span className={`usage-state-tag usage-state-${info.state}`}>{info.label}</span> : null}
        {showProviderStateLabel ? (
          <span className={`usage-provider-state-tag usage-provider-state-${provider.providerState}`}>
            {providerStateLabel}
          </span>
        ) : null}
      </header>

      {/* Not aria-live: a live region per card (one per provider) flooded screen readers with simultaneous
          announcements on "refresh all" — see UsageView's single consolidated status region instead. */}
      <div className="usage-card-body">
        {manualOnly ? (
          <div className="usage-manual-block">
            {provider.plan ? <p className="usage-dim-line">{provider.plan}</p> : null}
            {provider.note ? <p className="usage-manual-note">{provider.note}</p> : null}
            {docsLine}
            {setupLine}
          </div>
        ) : showsNumbers ? (
          <>
            {provider.windows.length > 0 ? (
              <div className="usage-windows-list">
                {provider.windows.map((win, idx) => {
                  // A reset window has no reading until the next use: say so instead of a percent, and
                  // never draw a bar — a 0-width bar would read as "0% used" (feedback 36).
                  const isReset = win.state === 'reset';
                  const color = usageColorClass(win.usedPercent);
                  const resetDisplay = formatWindowResetLine(win.resetsAt, win.resetDerived);
                  const widthPct =
                    !isReset && win.usedPercent !== null && win.usedPercent !== undefined
                      ? Math.min(100, Math.max(0, win.usedPercent))
                      : null;

                  return (
                    <div key={idx} className="usage-window-item">
                      <div className="window-header">
                        <span className="window-label">{win.label}</span>
                        {isReset ? (
                          <span className="window-reset-note">{WINDOW_RESET_REFRESH_TEXT}</span>
                        ) : (
                          <span className="window-percent">{formatPercentOrUnknown(win.usedPercent)}</span>
                        )}
                        {resetDisplay ? <span className="window-reset">{resetDisplay}</span> : null}
                      </div>
                      {widthPct !== null ? (
                        <div className="usage-bar-track">
                          <div className={`usage-bar-fill ${color}`} style={{ width: `${widthPct}%` }} />
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}

            {provider.balances.length > 0 ? (
              <div className="usage-balances-row">
                <span className="balance-title">{t('usageCard.balance')}</span>
                {provider.balances.map((b, idx) => {
                  // Availability may sit on the balance itself or (DeepSeek) once for the whole provider;
                  // an explicit null still means "not known" and is rendered as such, never as 不可用.
                  const availability = formatBalanceAvailability(
                    b.isAvailable !== undefined ? b.isAvailable : provider.isAvailable,
                  );
                  const split = [
                    b.granted !== undefined
                      ? t('usageCard.granted', { amount: formatBalance(b.granted, b.currency) })
                      : null,
                    b.toppedUp !== undefined
                      ? t('usageCard.toppedUp', { amount: formatBalance(b.toppedUp, b.currency) })
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ');
                  return (
                    <span key={idx} className="balance-chip">
                      {b.amount !== undefined ? formatBalance(b.amount, b.currency) : null}
                      {availability ? <span className="balance-availability">{availability}</span> : null}
                      {split ? <span className="balance-split">{split}</span> : null}
                    </span>
                  );
                })}
              </div>
            ) : null}

            {subscribedWithoutPeriods ? (
              <div className="usage-neutral-block">{t('usageCard.subscribedNoWindows')}</div>
            ) : null}

            <div className="usage-dim-details">
              {provider.plan ? <p className="usage-dim-line">{provider.plan}</p> : null}
              {provider.note ? <p className="usage-dim-line">{provider.note}</p> : null}
              {asOfLine ? <p className="usage-dim-line">{asOfLine}</p> : null}
              {provider.lastSuccessAt ? (
                <p className="usage-dim-line">{t('usageCard.lastSuccess', { time: formatUsageDate(provider.lastSuccessAt) })}</p>
              ) : null}
              {docsLine}
              {setupLine}
            </div>

            {isStale ? <div className="usage-stale-note">{providerGuidanceText(provider)}</div> : null}
          </>
        ) : (
          <>
            <div className={isUrgent ? 'warn-tape usage-error-tape' : 'usage-neutral-block'}>
              {providerGuidanceText(provider)}
            </div>
            {showsSetupGuidance ? docsLine : null}
            {showsSetupGuidance ? setupLine : null}
          </>
        )}
      </div>
    </article>
  );
}
