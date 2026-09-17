import type { SettingsReport } from '../../api/types';
import { useT } from '../../lib/i18n';

interface SettingsUsageKeysSectionProps {
  usageKeys: SettingsReport['usageKeys'];
}

export function SettingsUsageKeysSection({
  usageKeys,
}: SettingsUsageKeysSectionProps) {
  const t = useT();
  return (
    <section className="settings-section">
      <h3 className="settings-sec-title">{t('settingsUsageKeys.title')}</h3>
      <p className="hint">{t('settingsUsageKeys.note')}</p>
      <div className="settings-card">
        <div className="usage-keys-list">
          {usageKeys.map((item) => (
            <div key={item.id} className="usage-key-row">
              <div className="usage-key-provider">
                <strong>{item.name}</strong>
                <code className="muted">{item.id}</code>
              </div>
              <div className="usage-key-sources">
                {item.sources.map((src, idx) => {
                  const label =
                    src.kind === 'env'
                      ? t('settingsUsageKeys.envPrefix', { name: src.name })
                      : t('settingsUsageKeys.authPrefix', { name: src.name });
                  return (
                    <span
                      key={idx}
                      className={`chip ${src.present ? 'ok' : 'dim'}`}
                    >
                      <i className={`led ${src.present ? 'ok' : ''}`} />
                      {label}
                    </span>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
