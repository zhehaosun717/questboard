import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  OptionalArgsEditor,
  describeGroup,
  getUnknownFields,
  type OptionalArgsEditorProps,
} from './OptionalArgsEditor';
import type { OptionalArgGroupDraft } from '../../lib/settingsForm';

function render(props: Partial<OptionalArgsEditorProps> = {}) {
  const defaultProps: OptionalArgsEditorProps = {
    laneId: 'test-lane',
    laneIndex: 0,
    run: ['node', 'scripts/run-worker.mjs', '--lane', 'test-lane'],
    optionalArgs: [],
    onChange: () => {},
    errors: {},
    ...props,
  };
  return renderToStaticMarkup(<OptionalArgsEditor {...defaultProps} />);
}

describe('OptionalArgsEditor (real JSX via renderToStaticMarkup)', () => {
  it('renders empty message when no optionalArgs groups exist', () => {
    const html = render({ optionalArgs: [] });
    expect(html).toContain('暂未配置可选参数组');
    expect(html).toContain('+ 添加可选参数组');
  });

  it('renders plain-words summary for a configured group', () => {
    const group: OptionalArgGroupDraft = {
      when: 'variant',
      args: ['--effort', '{variant}'],
      omitWhen: ['none'],
      insertAt: 2,
    };
    const summary = describeGroup(group, 4);
    expect(summary).toBe('当卡片填了 variant 时，在第 3 个位置插入 --effort {variant}；值为 none 时整组省略');

    const html = render({ optionalArgs: [group] });
    expect(html).toContain('当卡片填了 variant 时，在第 3 个位置插入 --effort {variant}；值为 none 时整组省略');
  });

  it('renders agent trigger condition summary and omitWhen with multiple items', () => {
    const group: OptionalArgGroupDraft = {
      when: 'agent',
      args: ['--agent', '{agent}'],
      omitWhen: ['none', 'off'],
      insertAt: 3,
    };
    const summary = describeGroup(group, 4);
    expect(summary).toBe('当卡片填了 agent 时，在第 4 个位置插入 --agent {agent}；值为 none、off 时整组省略');

    const html = render({ optionalArgs: [group] });
    expect(html).toContain(summary);
  });

  it('renders when selector with variant and agent options', () => {
    const group: OptionalArgGroupDraft = {
      when: 'variant',
      args: ['--effort', '{variant}'],
      omitWhen: [],
      insertAt: 2,
    };
    const html = render({ optionalArgs: [group] });
    expect(html).toContain('触发条件 (when)');
    expect(html).toContain('variant（卡片填了变体时）');
    expect(html).toContain('agent（卡片填了智能体时）');
  });

  it('renders exact argument inputs one per field, preserving spaces and quotes', () => {
    const group: OptionalArgGroupDraft = {
      when: 'variant',
      args: ['--prompt', 'arg with spaces', 'quoted "value" {variant}'],
      omitWhen: ['none'],
      insertAt: 2,
    };
    const html = render({ optionalArgs: [group] });
    expect(html).toContain('value="--prompt"');
    expect(html).toContain('value="arg with spaces"');
    expect(html).toContain('value="quoted &quot;value&quot; {variant}"');
  });

  it('flags empty and whitespace-only arguments with an error message', () => {
    const group: OptionalArgGroupDraft = {
      when: 'variant',
      args: ['--effort', '   '],
      omitWhen: ['none'],
      insertAt: 2,
    };
    const html = render({ optionalArgs: [group] });
    expect(html).toContain('参数不能仅为空白字符');
    const emptyHtml = render({ optionalArgs: [{ ...group, args: ['--effort', ''] }] });
    expect(emptyHtml).toContain('参数不能仅为空白字符');
  });

  it('flags whitespace-only omitWhen item with an error message', () => {
    const group: OptionalArgGroupDraft = {
      when: 'variant',
      args: ['--effort', '{variant}'],
      omitWhen: ['   '],
      insertAt: 2,
    };
    const html = render({ optionalArgs: [group] });
    expect(html).toContain('省略值不能仅为空白字符');
  });

  it('shows allowed range for insertAt based on lane run command', () => {
    // node lane: run[0] === 'node', min is 2
    const nodeHtml = render({
      run: ['node', 'worker.js', '--task', '{package}'],
      optionalArgs: [{ when: 'variant', args: ['--opt', '{variant}'], omitWhen: [], insertAt: 2 }],
    });
    expect(nodeHtml).toContain('允许范围：2 ～ 4');
    expect(nodeHtml).toContain('第 0 位是 node，第 1 位是脚本文件');

    // non-node binary lane: run[0] === 'codex', min is 1
    const binaryHtml = render({
      run: ['codex', 'exec', '--task'],
      optionalArgs: [{ when: 'variant', args: ['--opt', '{variant}'], omitWhen: [], insertAt: 1 }],
    });
    expect(binaryHtml).toContain('允许范围：1 ～ 3');
    expect(binaryHtml).toContain('第 0 位是执行程序');
  });

  it('preserves and displays unknown fields as 未知字段，已保留', () => {
    const group: OptionalArgGroupDraft = {
      when: 'variant',
      args: ['--effort', '{variant}'],
      omitWhen: ['none'],
      insertAt: 2,
      extraAnnotation: 'custom-data',
      priority: 10,
    };
    const unknown = getUnknownFields(group);
    expect(unknown).toEqual({ extraAnnotation: 'custom-data', priority: 10 });

    const html = render({ optionalArgs: [group] });
    expect(html).toContain('未知字段，已保留：');
    expect(html).toContain('extraAnnotation, priority');
  });

  it('shows malformed groups as retained raw data instead of coercing or dropping them', () => {
    const raw = { when: 'model', args: ['--effort', '{variant}'], insertAt: '3', futureFlag: true };
    const html = render({
      optionalArgs: [{ when: 'model', args: ['--effort', '{variant}'], omitWhen: [], insertAt: undefined, parseError: '可选参数组无法解析，已原样保留：when 必须是 variant 或 agent', rawOptionalArg: raw }],
    });
    expect(html).toContain('无法解析，已原样保留');
    expect(html).toContain('&quot;when&quot;:&quot;model&quot;');
    expect(html).toContain('删除此组');
    expect(html).not.toContain('cfg-opt-when-test-lane-0');
  });

  it('renders field errors passed via errors prop', () => {
    const group: OptionalArgGroupDraft = {
      when: 'variant',
      args: ['--effort', '{variant}'],
      omitWhen: ['none'],
      insertAt: 1, // Invalid for node lane
    };
    const html = render({
      optionalArgs: [group],
      errors: {
        'lanes.0.optionalArgs[0].insertAt': 'insertAt must be an integer between 2 and 4',
      },
    });
    expect(html).toContain('insertAt must be an integer between 2 and 4');
  });
});
