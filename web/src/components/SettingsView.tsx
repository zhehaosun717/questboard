import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { SettingsReport } from '../api/types';
import {
  type BriefsDraft,
  type LaneDraft,
  type PolicyDraft,
  type ProjectDraft,
  type ReviewDraft,
  type SettingsDrafts,
  toDrafts,
  toRaw,
  validateDrafts,
} from '../lib/settingsForm';
import { SettingsBriefsSection } from './settings/SettingsBriefsSection';
import { SettingsLanesSection } from './settings/SettingsLanesSection';
import { SettingsLocalSection } from './settings/SettingsLocalSection';
import { SettingsPolicySection } from './settings/SettingsPolicySection';
import { SettingsProjectSection } from './settings/SettingsProjectSection';
import { SettingsReviewSection } from './settings/SettingsReviewSection';
import { SettingsUsageKeysSection } from './settings/SettingsUsageKeysSection';

export function SettingsView() {
  const [settings, setSettings] = useState<SettingsReport | null>(null);
  const [drafts, setDrafts] = useState<SettingsDrafts | null>(null);
  const [initialDraft, setInitialDraft] = useState<SettingsDrafts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const loadSettings = (isMounted: () => boolean) => {
    setLoading(true);
    api
      .settings()
      .then((data) => {
        if (!isMounted()) return;
        setSettings(data);
        const d = toDrafts(data.raw);
        setDrafts(d);
        setInitialDraft(d);
        setError(null);
      })
      .catch((err) => {
        if (!isMounted()) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (isMounted()) setLoading(false);
      });
  };

  useEffect(() => {
    let mounted = true;
    loadSettings(() => mounted);
    return () => {
      mounted = false;
    };
  }, []);

  const isDirty =
    drafts !== null &&
    initialDraft !== null &&
    JSON.stringify(drafts) !== JSON.stringify(initialDraft);

  const handleReset = () => {
    if (saving) return;
    setSaveSuccess(null);
    setServerError(null);
    setErrors({});
    loadSettings(() => true);
  };

  const handleSave = async () => {
    if (!drafts || saving) return;
    setSaveSuccess(null);
    setServerError(null);

    const validationErrors = validateDrafts(drafts);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }

    setErrors({});
    setSaving(true);
    try {
      const rawPayload = toRaw(settings?.raw ?? null, drafts);
      await api.saveSettings(rawPayload);
      setSaveSuccess('已保存（旧文件已备份）· 重启看板后生效');

      const refreshed = await api.settings();
      setSettings(refreshed);
      const d = toDrafts(refreshed.raw);
      setDrafts(d);
      setInitialDraft(d);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading && !settings) {
    return <div className="hint settings-loading">正在读取系统配置…</div>;
  }

  if (error && !settings) {
    return <div className="warn-tape settings-error">读取系统设置失败：{error}</div>;
  }

  if (!settings || !drafts) {
    return <div className="empty">未能获取系统配置</div>;
  }

  const { project, home, usageKeys, openCodeAuthFile, omo } = settings;

  const updateProject = (patch: Partial<ProjectDraft>) => {
    setDrafts((prev) => (prev ? { ...prev, project: { ...prev.project, ...patch } } : prev));
  };

  const updateBriefs = (patch: Partial<BriefsDraft>) => {
    setDrafts((prev) => (prev ? { ...prev, briefs: { ...prev.briefs, ...patch } } : prev));
  };

  const updateReview = (patch: Partial<ReviewDraft>) => {
    setDrafts((prev) => (prev ? { ...prev, review: { ...prev.review, ...patch } } : prev));
  };

  const updateLanes = (lanes: LaneDraft[]) => {
    setDrafts((prev) => (prev ? { ...prev, lanes } : prev));
  };

  const updatePolicy = (patch: Partial<PolicyDraft>) => {
    setDrafts((prev) => (prev ? { ...prev, policy: { ...prev.policy, ...patch } } : prev));
  };

  return (
    <div className="settings-view-container">
      <header className="settings-view-header">
        <div>
          <span className="eyebrow">SYSTEM CONFIGURATION</span>
          <h2>系统设置</h2>
          <p className="settings-top-notice">
            修改将写入 questboard.config.json。保存后旧文件将自动备份，重启看板后生效。
          </p>
        </div>
        <div className="settings-header-actions">
          {isDirty ? (
            <span className="settings-dirty-notice">存在未保存的修改</span>
          ) : null}
          <button
            type="button"
            className="btn ghost"
            disabled={saving}
            onClick={handleReset}
          >
            还原
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={saving}
            onClick={handleSave}
          >
            {saving ? '正在保存…' : '保存'}
          </button>
        </div>
      </header>

      {saveSuccess ? (
        <div className="omo-save-msg ok settings-alert-msg">{saveSuccess}</div>
      ) : null}
      {serverError ? (
        <div className="warn-tape settings-alert-msg">保存失败：{serverError}</div>
      ) : null}

      {/* 1. 项目 */}
      <SettingsProjectSection
        draft={drafts.project}
        paths={project.paths}
        errors={errors}
        onChange={updateProject}
      />

      {/* 2. 简报 */}
      <SettingsBriefsSection
        draft={drafts.briefs}
        errors={errors}
        onChange={updateBriefs}
      />

      {/* 3. 评审页 */}
      <SettingsReviewSection
        draft={drafts.review}
        resolvedDir={project.reviewPagesDir}
        onChange={updateReview}
      />

      {/* 4. 通道 */}
      <SettingsLanesSection
        lanes={drafts.lanes}
        errors={errors}
        onChange={updateLanes}
      />

      {/* 5. 规则 */}
      <SettingsPolicySection
        draft={drafts.policy}
        onChange={updatePolicy}
      />

      {/* 6. 本机 */}
      <SettingsLocalSection
        home={home}
        openCodeAuthFile={openCodeAuthFile}
        omo={omo}
      />

      {/* 7. 用量密钥 */}
      <SettingsUsageKeysSection usageKeys={usageKeys} />
    </div>
  );
}
