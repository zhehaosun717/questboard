import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useT } from '../lib/i18n';
import type { Card, SettingsReport } from '../api/types';
import {
  type BriefsDraft,
  type LaneDraft,
  type PolicyDraft,
  type ProjectDraft,
  type ReviewDraft,
  type SettingsDrafts,
  type UsageDraft,
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
import { SettingsUsageProvidersSection } from './settings/SettingsUsageProvidersSection';

// 本机与连接 mixes read-only checks with 手动查看的用量来源, which DOES write usage.manualProviders and the
// Alibaba pair into questboard.config.json on save. The old group banner ("本组只读检查，不会写入项目配置。")
// promised nothing in this group is written, which is false for that section — and it sits directly above
// its controls. The read-only promise is scoped to the checking sections below; the writing section says
// the write itself (SettingsUsageProvidersSection), and the save bar keeps the restart notice.

interface SettingsLocalGroupProps {
  home: SettingsReport['home'];
  openCodeAuthFile: SettingsReport['openCodeAuthFile'];
  omo: SettingsReport['omo'];
  usageKeys: SettingsReport['usageKeys'];
  usageDraft: UsageDraft;
  errors: Record<string, string>;
  onUsageChange: (patch: Partial<UsageDraft>) => void;
}

// Exported as a pure view so a server-rendered test can pin this group's exact copy (no jsdom in this repo),
// the same pattern as NotificationsSection/NotificationsSectionView.
export function SettingsLocalGroup({
  home,
  openCodeAuthFile,
  omo,
  usageKeys,
  usageDraft,
  errors,
  onUsageChange,
}: SettingsLocalGroupProps) {
  const t = useT();
  return (
    <>
      <div className="settings-read-only-note">{t('settings.localNote')}</div>
      <SettingsLocalSection home={home} openCodeAuthFile={openCodeAuthFile} omo={omo} />
      <SettingsUsageKeysSection usageKeys={usageKeys} />
      <SettingsUsageProvidersSection draft={usageDraft} errors={errors} onChange={onUsageChange} />
    </>
  );
}

interface SettingsViewProps {
  // The machine roster, so 派遣限制 can search real models and show which cards a rule would ban.
  roster: readonly Card[];
}

export function SettingsView({ roster }: SettingsViewProps) {
  const t = useT();
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
      setSaveSuccess(t('settings.saveSuccess'));

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
    return <div className="hint settings-loading">{t('settings.loading')}</div>;
  }

  if (error && !settings) {
    return <div className="warn-tape settings-error">{t('settings.loadFailed', { error })}</div>;
  }

  if (!settings || !drafts) {
    return <div className="empty">{t('settings.empty')}</div>;
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
    if (!drafts) return;
    const next = { ...drafts, lanes };
    setDrafts(next);
    // Errors are keyed by index/id and only computed on Save, so without this an edit or a delete that
    // shifts positions would leave a stale error (or a stale "this lane needs attention" state) attached to
    // whatever now sits at that slot. Only recompute once a save attempt has actually put errors on screen —
    // before that, editing must not start nagging the owner ahead of their first Save click.
    setErrors((prevErrors) => (Object.keys(prevErrors).length > 0 ? validateDrafts(next) : prevErrors));
  };

  const updatePolicy = (patch: Partial<PolicyDraft>) => {
    setDrafts((prev) => (prev ? { ...prev, policy: { ...prev.policy, ...patch } } : prev));
  };

  const updateUsage = (patch: Partial<UsageDraft>) => {
    if (!drafts) return;
    const next = { ...drafts, usage: { ...drafts.usage, ...patch } };
    setDrafts(next);
    // Same reasoning as updateLanes: the Alibaba pairing error is keyed by field, so an edit that now makes
    // the pair valid again must clear the old complaint once a save attempt has put errors on screen.
    setErrors((prevErrors) => (Object.keys(prevErrors).length > 0 ? validateDrafts(next) : prevErrors));
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
            roster={roster}
          />
        );
      case 'policy':
        return (
          <SettingsPolicySection
            draft={drafts.policy}
            roster={roster}
            lanes={drafts.lanes}
            errors={errors}
            onChange={updatePolicy}
          />
        );
      case 'local':
        return (
          <SettingsLocalGroup
            home={home}
            openCodeAuthFile={openCodeAuthFile}
            omo={omo}
            usageKeys={usageKeys}
            usageDraft={drafts.usage}
            errors={errors}
            onUsageChange={updateUsage}
          />
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
          local: hasGroupErrors(['local', 'usageKeys', 'usage']),
        }}
      />

      <main className="settings-main">
        <header className="settings-view-header">
          <div>
            <span className="eyebrow">{t('settings.eyebrow')}</span>
            <h2>{t('settings.title')}</h2>
            <p className="settings-group-caption">
              {activeGroup === 'project-files' ? t('settings.group.project') : null}
              {activeGroup === 'execution' ? t('settings.group.lanes') : null}
              {activeGroup === 'policy' ? t('settings.group.policy') : null}
              {activeGroup === 'local' ? t('settings.group.local') : null}
            </p>
          </div>
        </header>

        {saveSuccess ? <div className="omo-save-msg ok settings-alert-msg">{saveSuccess}</div> : null}
        {serverError ? <div className="warn-tape settings-alert-msg">{t('settings.saveFailed', { error: serverError })}</div> : null}

        <div className="settings-group-content">{activeContent}</div>

        <div className="settings-save-bar">
          <div className="settings-save-copy">
            <strong>{isDirty ? t('settings.dirty') : t('settings.synced')}</strong>
            <span>{t('settings.restartHint')}</span>
          </div>
          <div className="settings-save-actions">
            <button type="button" className="btn ghost" disabled={saving || !isDirty} onClick={handleReset}>
              {t('settings.discard')}
            </button>
            <button type="button" className="btn primary" disabled={saving || !isDirty} onClick={handleSave}>
              {saving ? t('common.saving') : t('settings.save')}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
