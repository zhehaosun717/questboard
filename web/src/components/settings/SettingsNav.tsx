import { useT, type I18nKey } from '../../lib/i18n';

export type SettingsGroupId = 'project-files' | 'execution' | 'policy' | 'verification' | 'local';

interface SettingsNavProps {
  activeGroup: SettingsGroupId;
  groupErrors: Partial<Record<SettingsGroupId, boolean>>;
  onSelect: (group: SettingsGroupId) => void;
}

const groups: Array<{ id: SettingsGroupId; labelKey: I18nKey; hintKey: I18nKey }> = [
  { id: 'project-files', labelKey: 'settings.group.project', hintKey: 'settingsNav.hint.project' },
  { id: 'execution', labelKey: 'settings.group.lanes', hintKey: 'settingsNav.hint.lanes' },
  { id: 'policy', labelKey: 'settings.group.policy', hintKey: 'settingsNav.hint.policy' },
  { id: 'verification', labelKey: 'settings.group.verification', hintKey: 'settingsNav.hint.verification' },
  { id: 'local', labelKey: 'settings.group.local', hintKey: 'settingsNav.hint.local' },
];

export function SettingsNav({ activeGroup, groupErrors, onSelect }: SettingsNavProps) {
  const t = useT();
  return (
    <aside className="settings-nav" aria-label={t('settingsNav.aria')}>
      <div className="settings-nav-heading">{t('settingsNav.heading')}</div>
      <nav>
        {groups.map((group) => (
          <button
            key={group.id}
            type="button"
            className={`settings-nav-item ${activeGroup === group.id ? 'active' : ''}`}
            aria-current={activeGroup === group.id ? 'page' : undefined}
            onClick={() => onSelect(group.id)}
          >
            <span className="settings-nav-label">
              {t(group.labelKey)}
              {groupErrors[group.id] ? <span className="settings-nav-error">!</span> : null}
            </span>
            <span className="settings-nav-hint">{t(group.hintKey)}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}
