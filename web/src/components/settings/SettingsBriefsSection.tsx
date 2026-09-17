import type { BriefsDraft } from '../../lib/settingsForm';
import { useT } from '../../lib/i18n';

interface SettingsBriefsSectionProps {
  draft: BriefsDraft;
  errors: Record<string, string>;
  onChange: (patch: Partial<BriefsDraft>) => void;
}

export function SettingsBriefsSection({
  draft,
  errors,
  onChange,
}: SettingsBriefsSectionProps) {
  const t = useT();
  return (
    <section className="settings-section">
      <h3 className="settings-sec-title">{t('settingsBriefs.title')}</h3>
      <div className="settings-card">
        <div className="settings-fields-grid">
          <div className="form-field">
            <label htmlFor="cfg-briefs-dispatch">{t('settingsBriefs.dispatchDirs')}</label>
            <input
              id="cfg-briefs-dispatch"
              value={draft.dispatchDirs}
              placeholder="docs/briefs"
              onChange={(e) => onChange({ dispatchDirs: e.target.value })}
            />
          </div>

          <div className="form-field">
            <label htmlFor="cfg-briefs-owner">{t('settingsBriefs.ownerDirs')}</label>
            <input
              id="cfg-briefs-owner"
              value={draft.ownerDirs}
              placeholder="docs/design"
              onChange={(e) => onChange({ ownerDirs: e.target.value })}
            />
          </div>

          <div className="form-field">
            <label htmlFor="cfg-briefs-pkg">{t('settingsBriefs.packagePattern')}</label>
            <input
              id="cfg-briefs-pkg"
              className="mono-input"
              value={draft.packagePattern}
              placeholder="^[A-Z]+(?:-[A-Z]+)*-\\d+[A-Z]?"
              onChange={(e) => onChange({ packagePattern: e.target.value })}
            />
          </div>

          <div className="form-field">
            <label htmlFor="cfg-briefs-heading">{t('settingsBriefs.fileListHeading')}</label>
            <input
              id="cfg-briefs-heading"
              className="mono-input"
              value={draft.fileListHeading}
              placeholder="^#{1,6}\\s*files you may (edit|touch)"
              onChange={(e) => onChange({ fileListHeading: e.target.value })}
            />
          </div>

          <div className="form-field">
            <label htmlFor="cfg-briefs-days">
              {t('settingsBriefs.recentDays')}
              {errors['briefs.recentDays'] ? (
                <span className="field-error"> · {errors['briefs.recentDays']}</span>
              ) : null}
            </label>
            <input
              id="cfg-briefs-days"
              type="number"
              min={1}
              value={draft.recentDays}
              placeholder="7"
              onChange={(e) => onChange({ recentDays: e.target.value })}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
