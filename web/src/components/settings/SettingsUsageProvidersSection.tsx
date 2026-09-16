import type { UsageDraft } from '../../lib/settingsForm';

// The manual-only cards the server knows about (src/usage/manualProviders.js), in the same order.
const MANUAL_PROVIDER_CHOICES: Array<{ id: string; name: string; note: string }> = [
  { id: 'alibaba-token-plan', name: '阿里云百炼 Token Plan', note: '当前通过控制台查看' },
  { id: 'alibaba-coding-plan', name: '阿里云百炼 Coding Plan', note: '当前通过控制台查看' },
  { id: 'nvidia', name: 'NVIDIA', note: '当前通过控制台查看（build.nvidia.com 右上角账户菜单）' },
  { id: 'claude-subscription', name: 'Claude 订阅', note: '在 Claude Code 里运行 /usage 查看' },
  { id: 'openai-spend', name: 'OpenAI API 消耗', note: '当前通过控制台查看' },
];

// The settings slice narrows Alibaba's choices to the editions/regions we have evidence for
// (feedback 36 review R3). The server allowlist stays wider; an older saved value is still shown
// as its own option so that nothing is silently dropped.
const ALIBABA_EDITIONS = [
  { value: '', label: '未选择' },
  { value: 'personal', label: '个人版' },
  { value: 'team', label: '团队版' },
];

const ALIBABA_REGIONS = [
  { value: '', label: '未选择' },
  { value: 'cn-beijing', label: '北京' },
  { value: 'ap-southeast-1', label: '新加坡' },
];

export function toggleManualProvider(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id];
}

function withCurrentOption(options: Array<{ value: string; label: string }>, current: string) {
  if (current === '' || options.some((option) => option.value === current)) {
    return options;
  }
  return [...options, { value: current, label: `${current}（当前配置）` }];
}

interface SettingsUsageProvidersSectionProps {
  draft: UsageDraft;
  errors: Record<string, string>;
  onChange: (patch: Partial<UsageDraft>) => void;
}

export function SettingsUsageProvidersSection({ draft, errors, onChange }: SettingsUsageProvidersSectionProps) {
  const alibabaError = errors['usage.alibaba'];
  return (
    <section className="settings-section">
      <h3 className="settings-sec-title">手动查看的用量来源</h3>
      <p className="hint">
        打开后，这几种暂未接入的用量会在用量页显示为“手动查看”卡片；不会发起查询，也不会读取密钥。
      </p>
      <div className="settings-card">
        {/* The group-level read-only note above only covers the checking sections; these choices are written
            into questboard.config.json through the page's whole-config save, so this section says so itself. */}
        <p className="settings-write-note">
          这里的开关和阿里云版本、区域会写入项目配置（usage.manualProviders、usage.alibaba）。
        </p>
        <div className="usage-providers-list">
          {MANUAL_PROVIDER_CHOICES.map((choice) => (
            <label key={choice.id} className="usage-provider-toggle-row">
              <input
                type="checkbox"
                checked={draft.manualProviders.includes(choice.id)}
                onChange={() =>
                  onChange({ manualProviders: toggleManualProvider(draft.manualProviders, choice.id) })
                }
              />
              <span className="usage-provider-toggle-name">{choice.name}</span>
              <span className="usage-provider-toggle-note">{choice.note}</span>
            </label>
          ))}
        </div>
        <div className="alibaba-choice-grid">
          <label className="alibaba-choice-field">
            <span className="alibaba-choice-label">阿里云版本</span>
            <select
              value={draft.alibabaEdition}
              onChange={(event) => onChange({ alibabaEdition: event.target.value })}
            >
              {withCurrentOption(ALIBABA_EDITIONS, draft.alibabaEdition).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="alibaba-choice-field">
            <span className="alibaba-choice-label">阿里云区域</span>
            <select
              value={draft.alibabaRegion}
              onChange={(event) => onChange({ alibabaRegion: event.target.value })}
            >
              {withCurrentOption(ALIBABA_REGIONS, draft.alibabaRegion).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {alibabaError ? <p className="field-error">{alibabaError}</p> : null}
        <p className="hint usage-providers-restart-hint">保存后需要重启看板才会生效。</p>
      </div>
    </section>
  );
}

export default SettingsUsageProvidersSection;
