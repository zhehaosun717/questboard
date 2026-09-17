import { useEffect, useReducer, useState } from 'react';
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
  type VerificationDraft,
  applyPolicyEdit,
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
import { SettingsVerificationSection } from './settings/SettingsVerificationSection';

// Round 4 (closes F4): state updaters must be pure and must never call another setter. drafts and
// errors that a policy edit touches live in ONE state value, so a single functional update runs
// applyPolicyEdit. React may run an updater during render (and twice under StrictMode); a pure reducer
// returns the same result either way, and a result discarded during render cannot drop the patch.
export interface SettingsFormState {
  drafts: SettingsDrafts | null;
  errors: Record<string, string>;
}

export type SettingsFormAction =
  | { type: 'setDrafts'; drafts: SettingsDrafts | null }
  | { type: 'setErrors'; errors: Record<string, string> }
  | { type: 'reset' }
  | { type: 'updateProject'; patch: Partial<ProjectDraft> }
  | { type: 'updateBriefs'; patch: Partial<BriefsDraft> }
  | { type: 'updateReview'; patch: Partial<ReviewDraft> }
  | { type: 'updateLanes'; lanes: LaneDraft[] }
  | { type: 'updatePolicy'; patch: Partial<PolicyDraft> }
  | { type: 'updateUsage'; patch: Partial<UsageDraft> }
  | { type: 'updateVerification'; patch: Partial<VerificationDraft> };

export function settingsFormReducer(state: SettingsFormState, action: SettingsFormAction): SettingsFormState {
  switch (action.type) {
    case 'setDrafts':
      return { ...state, drafts: action.drafts };
    case 'setErrors':
      return { ...state, errors: action.errors };
    case 'reset':
      return { ...state, errors: {} };
    case 'updateProject':
      return state.drafts
        ? { ...state, drafts: { ...state.drafts, project: { ...state.drafts.project, ...action.patch } } }
        : state;
    case 'updateBriefs':
      return state.drafts
        ? { ...state, drafts: { ...state.drafts, briefs: { ...state.drafts.briefs, ...action.patch } } }
        : state;
    case 'updateReview':
      return state.drafts
        ? { ...state, drafts: { ...state.drafts, review: { ...state.drafts.review, ...action.patch } } }
        : state;
    case 'updateLanes': {
      if (!state.drafts) return state;
      const drafts = { ...state.drafts, lanes: action.lanes };
      const errors = Object.keys(state.errors).length > 0 ? validateDrafts(drafts) : state.errors;
      return { drafts, errors };
    }
    case 'updatePolicy': {
      if (!state.drafts) return state;
      const result = applyPolicyEdit({ drafts: state.drafts, errors: state.errors }, action.patch);
      return { drafts: result.drafts, errors: result.errors };
    }
    case 'updateUsage': {
      if (!state.drafts) return state;
      const drafts = { ...state.drafts, usage: { ...state.drafts.usage, ...action.patch } };
      const errors = Object.keys(state.errors).length > 0 ? validateDrafts(drafts) : state.errors;
      return { drafts, errors };
    }
    case 'updateVerification':
      return state.drafts
        ? { ...state, drafts: { ...state.drafts, verification: { ...state.drafts.verification, ...action.patch } } }
        : state;
    default:
      return state;
  }
}

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
  const [{ drafts, errors }, dispatch] = useReducer(settingsFormReducer, { drafts: null, errors: {} });
  const [initialDraft, setInitialDraft] = useState<SettingsDrafts | null>(null);
  const [activeGroup, setActiveGroup] = useState<SettingsGroupId>('project-files');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const loadSettings = (isMounted: () => boolean) => {
    setLoading(true);
    api
      .settings()
      .then((data) => {
        if (!isMounted()) return;
        setSettings(data);
        const nextDraft = toDrafts(data.raw);
        dispatch({ type: 'setDrafts', drafts: nextDraft });
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
    dispatch({ type: 'reset' });
    loadSettings(() => true);
  };

  const handleSave = async () => {
    if (!drafts || saving) return;
    setSaveSuccess(null);
    setServerError(null);

    const validationErrors = validateDrafts(drafts);
    if (Object.keys(validationErrors).length > 0) {
      dispatch({ type: 'setErrors', errors: validationErrors });
      return;
    }

    dispatch({ type: 'setErrors', errors: {} });
    setSaving(true);
    try {
      const rawPayload = toRaw(settings?.raw ?? null, drafts);
      await api.saveSettings(rawPayload);
      setSaveSuccess(t('settings.saveSuccess'));

      const refreshed = await api.settings();
      setSettings(refreshed);
      const nextDraft = toDrafts(refreshed.raw);
      dispatch({ type: 'setDrafts', drafts: nextDraft });
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

  const updateProject = (patch: Partial<ProjectDraft>) => dispatch({ type: 'updateProject', patch });

  const updateBriefs = (patch: Partial<BriefsDraft>) => dispatch({ type: 'updateBriefs', patch });

  const updateReview = (patch: Partial<ReviewDraft>) => dispatch({ type: 'updateReview', patch });

  // Errors are keyed by index/id and only computed on Save, so without this an edit or a delete that
  // shifts positions would leave a stale error (or a stale "this lane needs attention" state) attached to
  // whatever now sits at that slot. Only recompute once a save attempt has actually put errors on screen —
  // before that, editing must not start nagging the owner ahead of their first Save click.
  const updateLanes = (lanes: LaneDraft[]) => dispatch({ type: 'updateLanes', lanes });

  // X11: policy rows are keyed by index, so a fixed field must drop its complaint and a deleted row must not
  // hide the errors of the row that moves into its place. The reducer's updatePolicy action runs
  // applyPolicyEdit over the combined state, so no closure over `drafts`/`errors` can go stale here.
  const updatePolicy = (patch: Partial<PolicyDraft>) => dispatch({ type: 'updatePolicy', patch });

  // Same reasoning as updateLanes: the Alibaba pairing error is keyed by field, so an edit that now makes
  // the pair valid again must clear the old complaint once a save attempt has put errors on screen.
  const updateUsage = (patch: Partial<UsageDraft>) => dispatch({ type: 'updateUsage', patch });

  const updateVerification = (patch: Partial<VerificationDraft>) => dispatch({ type: 'updateVerification', patch });

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
      case 'verification':
        return <SettingsVerificationSection draft={drafts.verification} onChange={updateVerification} />;
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
          verification: hasGroupErrors(['verification']),
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
              {activeGroup === 'verification' ? t('settings.group.verification') : null}
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
