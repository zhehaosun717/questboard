import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Card } from '../../api/types';
import type { PolicyDraft } from '../../lib/settingsForm';
import { toDrafts } from '../../lib/settingsForm';
import { makeCard } from '../../lib/testFixtures';
import { SettingsPolicySection } from './SettingsPolicySection';

// Lane ids shown in the selects; toDrafts is the least repetitive way to get fully shaped LaneDraft rows.
const lanes = toDrafts({ lanes: { codex: { run: ['tools/codex-run.sh', '{name}'] }, agy: { run: ['tools/agy-run.sh', '{name}'] } } }).lanes;

function draft(over: Partial<PolicyDraft> = {}): PolicyDraft {
  return {
    bannedModelPatterns: [],
    bannedAgents: [],
    stallAfterMinutes: '',
    laneConcurrency: [],
    defaultLane: '',
    defaultCard: '',
    bouncePatterns: [],
    ...over,
  };
}

function render(over: Partial<PolicyDraft> = {}, options: { roster?: readonly Card[]; errors?: Record<string, string> } = {}) {
  return renderToStaticMarkup(
    <SettingsPolicySection
      draft={draft(over)}
      roster={options.roster ?? [makeCard('codex-luna', { lane: 'codex', model: 'gpt-5.6-luna' })]}
      lanes={lanes}
      errors={options.errors ?? {}}
      onChange={() => {}}
    />,
  );
}

describe('SettingsPolicySection feedback-38 fields', () => {
  it('renders the four new groups, their hints and the restart footnote', () => {
    const html = render();
    expect(html).toContain('停摆判定');
    expect(html).toContain('停摆只是提醒，不会取消任务');
    expect(html).toContain('通道并发上限');
    expect(html).toContain('还没有设置上限。');
    expect(html).toContain('默认通道与默认卡');
    expect(html).toContain('结构化退避');
    expect(html).toContain('还没有规则，先走内置的用量限额识别。');
    expect(html).toContain('保存后需要重启看板才会生效。');
  });

  it('shows the missing preferred card note only when the roster lacks that card', () => {
    expect(render({ defaultCard: 'oc-mimo' })).toContain('首选卡「oc-mimo」不在名册里（设置会保留，不会自动换卡；补上这张卡或改掉 ID 即可）');
    expect(render({ defaultCard: 'codex-luna' })).not.toContain('首选卡「codex-luna」不在名册里');
  });

  it('shows each row value and marks a lane the project does not configure', () => {
    const html = render({
      stallAfterMinutes: '45',
      laneConcurrency: [{ lane: 'codex', limit: '2' }, { lane: 'ghost', limit: '1' }],
      defaultLane: 'codex',
      defaultCard: 'codex-luna',
      bouncePatterns: [{ code: 'quota_5h', pattern: 'resets (at|in)', label: '额度用尽' }],
    });
    expect(html).toContain('value="45"');
    expect(html).toContain('value="2"');
    expect(html).toContain('ghost（未配置）');
    expect(html).toContain('value="codex-luna"');
    expect(html).toContain('quota_5h');
    expect(html).toContain('resets (at|in)');
    expect(html).toContain('额度用尽');
    expect(html).not.toContain('还没有设置上限。');
    expect(html).not.toContain('还没有规则，先走内置的用量限额识别。');
  });

  it('renders the Chinese per-field errors the validator keys', () => {
    const html = render(
      { laneConcurrency: [{ lane: 'ghost', limit: '' }], bouncePatterns: [{ code: 'Bad Code', pattern: '', label: '' }] },
      {
        errors: {
          'policy.stallAfterMinutes': '停摆阈值必须是正整数（分钟）',
          'policy.laneConcurrency.0.lane': '通道「ghost」不在接入方式里',
          'policy.laneConcurrency.0.limit': '并发上限必须是正整数',
          'policy.defaultCard': '默认卡 ID 只能用小写字母、数字和连字符，1-48 个字符',
          'policy.bouncePatterns.0.code': 'code 只能用小写字母、数字、下划线，且以字母开头',
          'policy.bouncePatterns.0.pattern': '正则不能为空',
          'policy.bouncePatterns.0.label': '标签不能为空',
        },
      },
    );
    expect(html).toContain('停摆阈值必须是正整数（分钟）');
    expect(html).toContain('通道「ghost」不在接入方式里');
    expect(html).toContain('并发上限必须是正整数');
    expect(html).toContain('默认卡 ID 只能用小写字母、数字和连字符，1-48 个字符');
    expect(html).toContain('code 只能用小写字母、数字、下划线，且以字母开头');
    expect(html).toContain('正则不能为空');
    expect(html).toContain('标签不能为空');
  });
});
