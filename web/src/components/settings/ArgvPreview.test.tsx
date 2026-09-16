import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArgvPreview, buildPreviewLane, cardPreviewValues, isUnsupportedPreviewError, previewLaneDraftKey, type ArgvPreviewProps } from './ArgvPreview';
import { ApiError } from '../../api/client';
import type { Card } from '../../api/types';
import type { LaneDraft } from '../../lib/settingsForm';

function mockLane(patch: Partial<LaneDraft> = {}): LaneDraft {
  return {
    id: 'test-lane',
    formKey: 'form-1',
    originalId: 'test-lane',
    run: ['node', 'scripts/run.mjs', '--lane', 'test-lane'],
    outputDir: 'out',
    api: '',
    serve: [],
    deliveryDir: '',
    defaultModel: 'claude-3-7-sonnet',
    editCounter: 'patch',
    serialize: false,
    spacingMs: '',
    env: '',
    sessionRun: [],
    sessionSaveTo: '',
    healthPath: '',
    healthJson: '',
    optionalArgs: [],
    ...patch,
  };
}

const mockRoster: Card[] = [
  {
    id: 'card-1',
    name: 'Alice',
    provider: 'anthropic',
    lane: 'test-lane',
    family: 'claude',
    model: 'claude-3-7-sonnet',
    variant: 'high',
    agent: 'coder',
    status: 'available',
    statusSince: '2026-09-16T00:00:00Z',
    statusReason: 'ready',
    statusSetBy: 'system',
  },
  {
    id: 'card-2',
    name: 'Bob',
    provider: 'openai',
    lane: 'test-lane',
    family: 'gpt',
    model: 'gpt-4o',
    variant: 'none',
    agent: 'analyst',
    status: 'available',
    statusSince: '2026-09-16T00:00:00Z',
    statusReason: 'ready',
    statusSetBy: 'system',
  },
];

function render(props: Partial<ArgvPreviewProps> = {}) {
  const lane = props.lane || mockLane();
  return renderToStaticMarkup(<ArgvPreview lane={lane} {...props} />);
}

describe('ArgvPreview (real JSX via renderToStaticMarkup)', () => {
  it('renders preview title, read-only tag, and roster picker', () => {
    const html = render({ roster: mockRoster });
    expect(html).toContain('命令预览 (Argv Preview)');
    expect(html).toContain('只读实时预览 · 不会保存配置');
    expect(html).toContain('从公会花名册选择卡片');
    expect(html).toContain('Alice (claude-3-7-sonnet · high · coder)');
    expect(html).toContain('Bob (gpt-4o · none · analyst)');
  });

  it('starts manual preview fields without made-up variant or agent values', () => {
    const html = render({ roster: [] });
    expect(html).toContain('id="cfg-preview-model-test-lane"');
    expect(html).toContain('id="cfg-preview-variant-test-lane"');
    expect(html).toContain('id="cfg-preview-agent-test-lane"');
    expect(html).toContain('value="claude-3-7-sonnet"');
    expect(html).toMatch(/id="cfg-preview-variant-test-lane"[^>]*value=""/);
    expect(html).toMatch(/id="cfg-preview-agent-test-lane"[^>]*value=""/);
    expect(html).not.toContain('value="high"');
    expect(html).not.toContain('value="coder"');
  });

  it('copies all real card values and excludes card env values from the preview input', () => {
    const sourceCard = mockRoster.find((item) => item.id === 'card-1');
    if (!sourceCard) throw new Error('test roster is missing card-1');
    const card = { ...sourceCard, variant: undefined, agent: undefined, env: { API_KEY: 'secret-value' } };
    expect(cardPreviewValues(card)).toEqual({ model: 'claude-3-7-sonnet', variant: '', agent: '' });
    expect(JSON.stringify(cardPreviewValues(card))).not.toContain('secret-value');
  });

  it('builds the preview lane with the save path env, session, health, and missing-required-field semantics', () => {
    const lane = mockLane({
      outputDir: '',
      api: 'http://127.0.0.1:6096',
      env: 'BASE_URL=https://api.example.test',
      sessionRun: ['node', 'session.mjs', '{package}'],
      sessionSaveTo: 'sessions/{package}.txt',
      healthPath: '/global/health',
      healthJson: '{"healthy":true}',
    });
    const payload = buildPreviewLane(lane);
    expect(payload.outputDir).toBeUndefined();
    expect(payload.api).toBe('http://127.0.0.1:6096');
    expect(payload.env).toEqual({ BASE_URL: 'https://api.example.test' });
    expect(payload.session).toEqual({ run: ['node', 'session.mjs', '{package}'], saveTo: 'sessions/{package}.txt' });
    expect(payload.health).toEqual({ path: '/global/health', json: { healthy: true } });
  });

  it('invalidates the debounced preview for every lane draft surface, including env-only edits', () => {
    const base = mockLane();
    const edits: Partial<LaneDraft>[] = [
      { run: [...base.run, '--changed'] },
      { outputDir: 'other-out' },
      { api: 'http://127.0.0.1:6096' },
      { serve: ['node', 'server.mjs'] },
      { deliveryDir: 'deliveries' },
      { defaultModel: 'another-model' },
      { editCounter: 'replace' },
      { serialize: true },
      { spacingMs: '250' },
      { env: 'X={agent}' },
      { sessionRun: ['node', 'session.mjs'] },
      { sessionSaveTo: 'session.txt' },
      { healthPath: '/health' },
      { healthJson: '{"healthy":true}' },
      { optionalArgs: [{ when: 'variant', args: ['--effort', '{variant}'], omitWhen: [] }] },
      { optionalArgsMalformed: { broken: true } },
      { healthMalformed: { broken: true } },
    ];

    const originalKey = previewLaneDraftKey(base);
    for (const edit of edits) {
      expect(previewLaneDraftKey({ ...base, ...edit })).not.toBe(originalKey);
    }
  });

  it('renders exact argv before one argument per line from lane.run', () => {
    const lane = mockLane({
      run: ['node', 'worker.js', '--flag', 'arg with spaces', 'quoted "value"'],
    });
    const html = render({ lane });
    expect(html).toContain('基础模板 (Run Arguments)');
    expect(html).toContain('5 项');
    expect(html).toContain('worker.js');
    expect(html).toContain('arg with spaces');
    expect(html).toContain('quoted &quot;value&quot;');
  });

  it('renders exact argv after one argument per line from preview response', () => {
    const html = render({
      initialPreview: {
        argv: ['/usr/bin/node', 'worker.js', '--effort', 'high', '--task', 'SAMPLE-1'],
        omitted: [],
        warnings: [],
      },
    });
    expect(html).toContain('最终执行命令 (展开后 Argv)');
    expect(html).toContain('6 项');
    expect(html).toContain('/usr/bin/node');
    expect(html).toContain('--effort');
    expect(html).toContain('high');
    expect(html).toContain('SAMPLE-1');
  });

  it('uses the router status only to identify an old preview route', () => {
    expect(isUnsupportedPreviewError(new ApiError('not found', [], {}, undefined, 404))).toBe(true);
    expect(isUnsupportedPreviewError(new ApiError('Git Bash not found; configure bash', [], {}, undefined, 400))).toBe(false);
  });

  it('renders omitted groups with reason', () => {
    const html = render({
      initialPreview: {
        argv: ['/usr/bin/node', 'worker.js'],
        omitted: [
          { when: 'variant', reason: 'absent' },
          { when: 'agent', reason: 'omitWhen: none' },
        ],
        warnings: [],
      },
    });
    expect(html).toContain('已根据条件整组省略的参数：');
    expect(html).toContain('variant (未填写)');
    expect(html).toContain('agent (omitWhen: none)');
  });

  it('renders warnings from the preview endpoint', () => {
    const warningText = '该接入方式的执行命令中直接包含 {variant}，无论卡片是否填写变体都会传入，无法按需省略。';
    const html = render({
      initialPreview: {
        argv: ['node', 'worker.js', 'high'],
        omitted: [],
        warnings: [warningText],
      },
    });
    expect(html).toContain('该接入方式的执行命令中直接包含 {variant}');
  });

  it('renders 这个版本的看板还不支持命令预览 on 404/unsupported server', () => {
    const html = render({ initialUnsupported: true });
    expect(html).toContain('这个版本的看板还不支持命令预览');
    // Ensure no fake/misleading argv output is shown in this state
    expect(html).not.toContain('最终执行命令');
  });

  it('renders error banner on other errors', () => {
    const html = render({ initialError: '执行命令参数不能为空白' });
    expect(html).toContain('预览失败：执行命令参数不能为空白');
  });
});
