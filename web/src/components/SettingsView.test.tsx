// Server-rendered checks for the 本机与连接 group. It mixes read-only checks with 手动查看的用量来源, which
// writes usage.* into questboard.config.json on save, so no copy may claim the whole group is read-only and
// the writing section must say so itself. No jsdom in this repo; the live flow is covered by the browser
// check in the runbook.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { settingsFormReducer, SettingsLocalGroup, type SettingsFormState } from './SettingsView';
import { SettingsNav } from './settings/SettingsNav';
import { validateDrafts, type PolicyDraft, type SettingsDrafts } from '../lib/settingsForm';

const usageDraft = { manualProviders: ['nvidia'], alibabaEdition: 'team', alibabaRegion: 'cn-beijing' };

function renderGroup(): string {
  return renderToStaticMarkup(
    <SettingsLocalGroup
      home={{ dir: 'C:/qb', roster: 'C:/qb/roster.json', rosterExists: true, status: 'C:/qb/status.jsonl' }}
      openCodeAuthFile={{ file: 'C:/qb/opencode-auth.json', exists: false }}
      omo={{ file: 'C:/qb/omo.json', exists: true }}
      usageKeys={[
        { id: 'deepseek', name: 'DeepSeek', sources: [{ kind: 'env', name: 'DEEPSEEK_API_KEY', present: true }] },
      ]}
      usageDraft={usageDraft}
      errors={{}}
      onUsageChange={() => {}}
    />,
  );
}

describe('本机与连接 group', () => {
  it('scopes the read-only promise to the checking sections instead of the whole group', () => {
    const html = renderGroup();
    expect(html).not.toContain('本组只读检查，不会写入项目配置。');
    expect(html).not.toContain('本组');
    expect(html).toContain('本机信息与用量密钥只读检查，不会写入项目配置。');
  });

  it('shows a plain statement that the manual providers are written into the project config', () => {
    const html = renderGroup();
    expect(html).toContain('会写入项目配置');
    expect(html).toContain('usage.manualProviders');
  });

  it('describes the group in the nav as checks plus usage sources, not read-only', () => {
    const html = renderToStaticMarkup(
      <SettingsNav
        activeGroup="local"
        groupErrors={{ 'project-files': false, execution: false, policy: false, local: false }}
        onSelect={() => {}}
      />,
    );
    expect(html).toContain('检查与用量来源');
    expect(html).not.toContain('只读检查');
  });
});

// Round 4 (closes F4): React may run a state updater during render (and twice under StrictMode).
// The round-3 createPolicyUpdater nested setErrors inside the setDrafts updater, so when React deferred the
// updater to the render phase the patch was dropped. The reducer is pure, so the same action applied twice
// from the same state (StrictMode) and a result computed during render then discarded must both yield the
// edited draft and the right error map — exactly the F4 probe the browser review caught.
function makeDrafts(policyPatch: Partial<PolicyDraft> = {}): SettingsDrafts {
  return {
    project: { name: 'Q', port: '6097', dataDir: '', events: '', registry: '', lockFile: '', bash: '' },
    briefs: { dispatchDirs: '', ownerDirs: '', packagePattern: '', fileListHeading: '', recentDays: '7' },
    lanes: [
      {
        id: 'codex', formKey: 'form-1', originalId: 'codex', run: ['node', 'worker.js'], outputDir: '',
        api: '', protocol: '', serve: [], deliveryDir: '', defaultModel: '', editCounter: '', serialize: false,
        spacingMs: '', env: '', sessionRun: [], sessionSaveTo: '', healthPath: '', healthJson: '',
      },
    ],
    policy: {
      bannedModelPatterns: [], bannedAgents: [], stallAfterMinutes: '', laneConcurrency: [], defaultLane: '',
      defaultCard: '', bouncePatterns: [], ...policyPatch,
    },
    review: { dir: '' },
    usage: { manualProviders: [], alibabaEdition: '', alibabaRegion: '' },
    verification: { hooks: [] },
  };
}

function makeFailedState(): SettingsFormState {
  const drafts = makeDrafts({
    stallAfterMinutes: '0',
    bouncePatterns: [{ code: 'quota_5h', pattern: '(', label: '额度用尽' }],
  });
  return { drafts, errors: validateDrafts(drafts) };
}

describe('settingsFormReducer keeps the error map live (X11, round 4)', () => {
  it('applies the same policy edit twice from the same previous state with the same result (StrictMode)', () => {
    const state = makeFailedState();
    expect(state.errors['policy.stallAfterMinutes']).toBeDefined();
    const action = { type: 'updatePolicy', patch: { stallAfterMinutes: '45' } } as const;

    const once = settingsFormReducer(state, action);
    const twice = settingsFormReducer(state, action);

    expect(once.drafts?.policy.stallAfterMinutes).toBe('45');
    // A stale-draft read (validating the pre-edit drafts) or a skipped call would leave this defined.
    expect(once.errors['policy.stallAfterMinutes']).toBeUndefined();
    expect(once.errors['policy.bouncePatterns.0.pattern']).toMatch(/^正则不合法：/);
    expect(twice).toEqual(once);
  });

  it('keeps the edited draft and error map when the during-render result is discarded before applying', () => {
    const state = makeFailedState();
    const action = { type: 'updatePolicy', patch: { stallAfterMinutes: '45' } } as const;

    // React's render-phase updater result is discarded; the real apply is a separate, identical action.
    const duringRender = settingsFormReducer(state, action);
    expect(duringRender.drafts?.policy.stallAfterMinutes).toBe('45');

    const applied = settingsFormReducer(state, action);
    expect(applied.drafts?.policy.stallAfterMinutes).toBe('45');
    expect(applied.errors['policy.stallAfterMinutes']).toBeUndefined();
    expect(applied.errors['policy.bouncePatterns.0.pattern']).toMatch(/^正则不合法：/);
  });

  it('does nothing before the settings have loaded', () => {
    const state: SettingsFormState = { drafts: null, errors: {} };
    const next = settingsFormReducer(state, { type: 'updatePolicy', patch: { stallAfterMinutes: '0' } });
    expect(next).toEqual(state);
  });
});
