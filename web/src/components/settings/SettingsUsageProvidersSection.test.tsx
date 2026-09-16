import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { UsageDraft } from '../../lib/settingsForm';
import { SettingsUsageProvidersSection, toggleManualProvider } from './SettingsUsageProvidersSection';

const baseDraft: UsageDraft = { manualProviders: [], alibabaEdition: '', alibabaRegion: '' };

function render(draft: Partial<UsageDraft>, errors: Record<string, string> = {}) {
  return renderToStaticMarkup(
    <SettingsUsageProvidersSection draft={{ ...baseDraft, ...draft }} errors={errors} onChange={() => {}} />,
  );
}

describe('SettingsUsageProvidersSection', () => {
  it('lists every manual provider with a toggle that reflects the saved draft', () => {
    const html = render({ manualProviders: ['nvidia'] });
    expect(html).toContain('阿里云百炼 Token Plan');
    expect(html).toContain('阿里云百炼 Coding Plan');
    expect(html).toContain('NVIDIA');
    expect(html).toContain('Claude 订阅');
    expect(html).toContain('OpenAI API 消耗');
    expect(html.match(/type="checkbox"/g)).toHaveLength(5);
    // only the enabled one renders as checked
    expect(html.match(/checked=""/g)).toHaveLength(1);
  });

  it('toggles ids immutably', () => {
    const before = ['nvidia'];
    const added = toggleManualProvider(before, 'openai-spend');
    expect(added).toEqual(['nvidia', 'openai-spend']);
    expect(before).toEqual(['nvidia']);
    expect(toggleManualProvider(added, 'nvidia')).toEqual(['openai-spend']);
  });

  it('offers only the evidenced Alibaba editions and regions, plus an explicit 未选择', () => {
    const html = render({});
    expect(html).toContain('未选择');
    expect(html).toContain('<option value="personal">个人版</option>');
    expect(html).toContain('团队版');
    expect(html).toContain('<option value="cn-beijing">北京</option>');
    expect(html).toContain('<option value="ap-southeast-1">新加坡</option>');
    expect(html).not.toContain('enterprise');
    expect(html).not.toContain('cn-shanghai');
    expect(html).not.toContain('当前配置');
  });

  it('keeps a saved value outside the narrowed list, labelled as the current config', () => {
    const html = render({ alibabaEdition: 'enterprise', alibabaRegion: 'cn-hangzhou' });
    expect(html).toContain('<option value="enterprise" selected="">enterprise（当前配置）</option>');
    expect(html).toContain('<option value="cn-hangzhou" selected="">cn-hangzhou（当前配置）</option>');
  });

  it('says plainly that its choices are written into the project config, above the controls', () => {
    const html = render({});
    expect(html).toContain('这里的开关和阿里云版本、区域会写入项目配置（usage.manualProviders、usage.alibaba）。');
    expect(html.indexOf('settings-write-note')).toBeGreaterThan(-1);
    expect(html.indexOf('settings-write-note')).toBeLessThan(html.indexOf('usage-providers-list'));
  });

  it('shows the Alibaba pairing error and the restart notice', () => {
    const html = render({}, { 'usage.alibaba': '阿里云版本和区域要么都选，要么都不选' });
    expect(html).toContain('阿里云版本和区域要么都选，要么都不选');
    expect(html).toContain('保存后需要重启看板才会生效。');
  });

  it('shows no error line when the Alibaba pairing is fine', () => {
    const html = render({ alibabaEdition: 'personal', alibabaRegion: 'cn-beijing' });
    expect(html).not.toContain('要么都选');
  });
});
