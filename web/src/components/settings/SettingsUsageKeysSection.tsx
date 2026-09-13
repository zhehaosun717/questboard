import type { SettingsReport } from '../../api/types';

interface SettingsUsageKeysSectionProps {
  usageKeys: SettingsReport['usageKeys'];
}

export function SettingsUsageKeysSection({
  usageKeys,
}: SettingsUsageKeysSectionProps) {
  return (
    <section className="settings-section">
      <h3 className="settings-sec-title">用量密钥 (Usage Keys)</h3>
      <p className="hint">key 只在服务器内存里用，不会显示也不会保存.</p>
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
                      ? `环境变量 ${src.name}`
                      : `OpenCode 登录 ${src.name}`;
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
