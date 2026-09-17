import type { ReviewDraft } from '../../lib/settingsForm';
import { useT } from '../../lib/i18n';

interface SettingsReviewSectionProps {
  draft: ReviewDraft;
  resolvedDir: string | null;
  onChange: (patch: Partial<ReviewDraft>) => void;
}

export function SettingsReviewSection({
  draft,
  resolvedDir,
  onChange,
}: SettingsReviewSectionProps) {
  const t = useT();
  return (
    <section className="settings-section">
      <h3 className="settings-sec-title">{t('settingsReview.title')}</h3>
      <div className="settings-card">
        <div className="form-field">
          <label htmlFor="cfg-review-dir">
            {t('settingsReview.label')}
            <span className="muted">{t('settingsReview.clearHint')}</span>
          </label>
          <input
            id="cfg-review-dir"
            value={draft.dir}
            placeholder={t('settingsReview.placeholder')}
            onChange={(e) => onChange({ dir: e.target.value })}
          />
          {resolvedDir ? (
            <span className="path-resolved-help">
              {t('settingsReview.resolvedPrefix')}<code>{resolvedDir}</code>
            </span>
          ) : (
            <span className="path-resolved-help muted">{t('settingsReview.notSet')}</span>
          )}
        </div>
      </div>
    </section>
  );
}
