import type { ReviewDraft } from '../../lib/settingsForm';

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
  return (
    <section className="settings-section">
      <h3 className="settings-sec-title">评审页 (Review)</h3>
      <div className="settings-card">
        <div className="form-field">
          <label htmlFor="cfg-review-dir">
            评审页面目录 (reviewPages.dir)
            <span className="muted">（留空将移除整项评审页配置）</span>
          </label>
          <input
            id="cfg-review-dir"
            value={draft.dir}
            placeholder="例如 docs/review"
            onChange={(e) => onChange({ dir: e.target.value })}
          />
          {resolvedDir ? (
            <span className="path-resolved-help">
              解析绝对路径：<code>{resolvedDir}</code>
            </span>
          ) : (
            <span className="path-resolved-help muted">当前未设置</span>
          )}
        </div>
      </div>
    </section>
  );
}
