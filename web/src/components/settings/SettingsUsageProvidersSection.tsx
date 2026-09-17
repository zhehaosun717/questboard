import type { UsageDraft } from '../../lib/settingsForm';
import { useT, type I18nKey } from '../../lib/i18n';

// The manual-only cards the server knows about (src/usage/manualProviders.js), in the same order.
const MANUAL_PROVIDER_CHOICES: Array<{ id: string; nameKey: I18nKey; noteKey: I18nKey }> = [
  { id: 'alibaba-token-plan', nameKey: 'settingsUsageProviders.provider.alibabaTokenPlan', noteKey: 'settingsUsageProviders.note.console' },
  { id: 'alibaba-coding-plan', nameKey: 'settingsUsageProviders.provider.alibabaCodingPlan', noteKey: 'settingsUsageProviders.note.console' },
  { id: 'nvidia', nameKey: 'settingsUsageProviders.provider.nvidia', noteKey: 'settingsUsageProviders.note.nvidia' },
  { id: 'claude-subscription', nameKey: 'settingsUsageProviders.provider.claudeSubscription', noteKey: 'settingsUsageProviders.note.claude' },
  { id: 'openai-spend', nameKey: 'settingsUsageProviders.provider.openaiSpend', noteKey: 'settingsUsageProviders.note.console' },
];

// The settings slice narrows Alibaba's choices to the editions/regions we have evidence for
// (feedback 36 review R3). The server allowlist stays wider; an older saved value is still shown
// as its own option so that nothing is silently dropped.
const ALIBABA_EDITIONS: Array<{ value: string; labelKey: I18nKey }> = [
  { value: '', labelKey: 'settingsUsageProviders.notChosen' },
  { value: 'personal', labelKey: 'settingsUsageProviders.editionPersonal' },
  { value: 'team', labelKey: 'settingsUsageProviders.editionTeam' },
];

const ALIBABA_REGIONS: Array<{ value: string; labelKey: I18nKey }> = [
  { value: '', labelKey: 'settingsUsageProviders.notChosen' },
  { value: 'cn-beijing', labelKey: 'settingsUsageProviders.regionBeijing' },
  { value: 'ap-southeast-1', labelKey: 'settingsUsageProviders.regionSingapore' },
];

export function toggleManualProvider(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id];
}

interface SettingsUsageProvidersSectionProps {
  draft: UsageDraft;
  errors: Record<string, string>;
  onChange: (patch: Partial<UsageDraft>) => void;
}

export function SettingsUsageProvidersSection({ draft, errors, onChange }: SettingsUsageProvidersSectionProps) {
  const t = useT();
  const alibabaError = errors['usage.alibaba'];
  // An older saved value may sit outside the shortlist above; show it as its own option instead of
  // silently dropping it (the server's allowlist is wider).
  const renderOptions = (options: Array<{ value: string; labelKey: I18nKey }>, current: string) => {
    const currentOnly = current !== '' && !options.some((option) => option.value === current);
    const extra: { value: string; labelKey: I18nKey } = {
      value: current,
      labelKey: 'settingsUsageProviders.currentSuffix',
    };
    const list = currentOnly ? [...options, extra] : options;
    return list.map((option) => (
      <option key={option.value} value={option.value}>
        {currentOnly && option.value === current
          ? t('settingsUsageProviders.currentSuffix', { value: current })
          : t(option.labelKey)}
      </option>
    ));
  };
  return (
    <section className="settings-section">
      <h3 className="settings-sec-title">{t('settingsUsageProviders.title')}</h3>
      <p className="hint">{t('settingsUsageProviders.intro')}</p>
      <div className="settings-card">
        {/* The group-level read-only note above only covers the checking sections; these choices are written
            into questboard.config.json through the page's whole-config save, so this section says so itself. */}
        <p className="settings-write-note">{t('settingsUsageProviders.writeNote')}</p>
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
              <span className="usage-provider-toggle-name">{t(choice.nameKey)}</span>
              <span className="usage-provider-toggle-note">{t(choice.noteKey)}</span>
            </label>
          ))}
        </div>
        <div className="alibaba-choice-grid">
          <label className="alibaba-choice-field">
            <span className="alibaba-choice-label">{t('settingsUsageProviders.alibabaEdition')}</span>
            <select
              value={draft.alibabaEdition}
              onChange={(event) => onChange({ alibabaEdition: event.target.value })}
            >
              {renderOptions(ALIBABA_EDITIONS, draft.alibabaEdition)}
            </select>
          </label>
          <label className="alibaba-choice-field">
            <span className="alibaba-choice-label">{t('settingsUsageProviders.alibabaRegion')}</span>
            <select
              value={draft.alibabaRegion}
              onChange={(event) => onChange({ alibabaRegion: event.target.value })}
            >
              {renderOptions(ALIBABA_REGIONS, draft.alibabaRegion)}
            </select>
          </label>
        </div>
        {alibabaError ? <p className="field-error">{alibabaError}</p> : null}
        <p className="hint usage-providers-restart-hint">{t('settingsUsageProviders.restartHint')}</p>
      </div>
    </section>
  );
}

export default SettingsUsageProvidersSection;
