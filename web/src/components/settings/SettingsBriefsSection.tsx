import type { BriefsDraft } from '../../lib/settingsForm';

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
  return (
    <section className="settings-section">
      <h3 className="settings-sec-title">简报 (Briefs)</h3>
      <div className="settings-card">
        <div className="settings-fields-grid">
          <div className="form-field">
            <label htmlFor="cfg-briefs-dispatch">派出目录（逗号分隔）</label>
            <input
              id="cfg-briefs-dispatch"
              value={draft.dispatchDirs}
              placeholder="docs/briefs"
              onChange={(e) => onChange({ dispatchDirs: e.target.value })}
            />
          </div>

          <div className="form-field">
            <label htmlFor="cfg-briefs-owner">负责人目录（逗号分隔）</label>
            <input
              id="cfg-briefs-owner"
              value={draft.ownerDirs}
              placeholder="docs/design"
              onChange={(e) => onChange({ ownerDirs: e.target.value })}
            />
          </div>

          <div className="form-field">
            <label htmlFor="cfg-briefs-pkg">委托包正则模式 (packagePattern)</label>
            <input
              id="cfg-briefs-pkg"
              className="mono-input"
              value={draft.packagePattern}
              placeholder="^[A-Z]+(?:-[A-Z]+)*-\\d+[A-Z]?"
              onChange={(e) => onChange({ packagePattern: e.target.value })}
            />
          </div>

          <div className="form-field">
            <label htmlFor="cfg-briefs-heading">文件列表标题正则 (fileListHeading)</label>
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
              简报窗口天数 (recentDays)
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
