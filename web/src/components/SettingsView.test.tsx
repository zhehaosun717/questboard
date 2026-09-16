// Server-rendered checks for the 本机与连接 group. It mixes read-only checks with 手动查看的用量来源, which
// writes usage.* into questboard.config.json on save, so no copy may claim the whole group is read-only and
// the writing section must say so itself. No jsdom in this repo; the live flow is covered by the browser
// check in the runbook.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsLocalGroup } from './SettingsView';
import { SettingsNav } from './settings/SettingsNav';

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
