import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Card, SettingsReport } from '../api/types';
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
import { SettingsNav, type SettingsGroupId } from './settings/SettingsNav';
import { SettingsPolicySection } from './settings/SettingsPolicySection';
import { SettingsProjectSection } from './settings/SettingsProjectSection';
import { SettingsReviewSection } from './settings/SettingsReviewSection';
import { SettingsUsageKeysSection } from './settings/SettingsUsageKeysSection';

interface SettingsViewProps {
  // The machine roster, so 派遣限制 can search real models and show which cards a rule would ban.
  roster: readonly Card[];
}

export function SettingsView({ roster }: SettingsViewProps) {
  const [settings, setSettings] = useState<SettingsReport | null>(null);
  const [drafts, setDrafts] = useState<SettingsDrafts | null>(null);
  const [initialDraft, setInitialDraft] = useState<SettingsDrafts | null>(null);
  const [activeGroup, setActiveGroup] = useState<SettingsGroupId>('project-files');
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
        const nextDraft = toDrafts(data.raw);
        setDrafts(nextDraft);
        setInitialDraft(nextDraft);
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
      const nextDraft = toDrafts(refreshed.raw);
      setDrafts(nextDraft);
      setInitialDraft(nextDraft);
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

  const hasGroupErrors = (prefixes: string[]) =>
    Object.keys(errors).some((key) =>
      prefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}.`)),
    );

  const activeContent = (() => {
    switch (activeGroup) {
      case 'project-files':
        return (
          <>
            <SettingsProjectSection
              draft={drafts.project}
              paths={project.paths}
              errors={errors}
              onChange={updateProject}
            />
            <SettingsBriefsSection
              draft={drafts.briefs}
              errors={errors}
              onChange={updateBriefs}
            />
            <SettingsReviewSection
              draft={drafts.review}
              resolvedDir={project.reviewPagesDir}
              onChange={updateReview}
            />
          </>
        );
      case 'execution':
        return (
          <SettingsLanesSection
            lanes={drafts.lanes}
            errors={errors}
            onChange={updateLanes}
          />
        );
      case 'policy':
        return (
          <SettingsPolicySection
            draft={drafts.policy}
            roster={roster}
            onChange={updatePolicy}
          />
        );
      case 'local':
        return (
          <>
            <div className="settings-read-only-note">本组只读检查，不会写入项目配置。</div>
            <SettingsLocalSection
              home={home}
              openCodeAuthFile={openCodeAuthFile}
              omo={omo}
            />
            <SettingsUsageKeysSection usageKeys={usageKeys} />
          </>
        );
    }
  })();

  return (
    <div className="settings-view-container">
      <SettingsNav
        activeGroup={activeGroup}
        onSelect={setActiveGroup}
        groupErrors={{
          'project-files': hasGroupErrors(['project', 'briefs']),
          execution: hasGroupErrors(['lanes']),
          policy: hasGroupErrors(['policy']),
          local: hasGroupErrors(['local', 'usageKeys']),
        }}
      />

      <main className="settings-main">
        <header className="settings-view-header">
          <div>
            <span className="eyebrow">SYSTEM CONFIGURATION</span>
            <h2>系统设置</h2>
            <p className="settings-group-caption">
              {activeGroup === 'project-files' ? '项目与文件' : null}
              {activeGroup === 'execution' ? '接入方式' : null}
              {activeGroup === 'policy' ? '派出禁令' : null}
              {activeGroup === 'local' ? '本机与连接' : null}
            </p>
          </div>
        </header>

        {saveSuccess ? <div className="omo-save-msg ok settings-alert-msg">{saveSuccess}</div> : null}
        {serverError ? <div className="warn-tape settings-alert-msg">保存失败：{serverError}</div> : null}

        <div className="settings-group-content">{activeContent}</div>

        <div className="settings-save-bar">
          <div className="settings-save-copy">
            <strong>{isDirty ? '存在未保存的修改' : '设置已同步'}</strong>
            <span>需重启看板后生效</span>
          </div>
          <div className="settings-save-actions">
            <button type="button" className="btn ghost" disabled={saving || !isDirty} onClick={handleReset}>
              放弃未保存修改
            </button>
            <button type="button" className="btn primary" disabled={saving || !isDirty} onClick={handleSave}>
              {saving ? '正在保存…' : '保存项目设置'}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
