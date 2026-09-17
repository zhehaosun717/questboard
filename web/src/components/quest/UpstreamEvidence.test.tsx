import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { makeQuest } from '../../lib/testFixtures';
import { UpstreamEvidence, UpstreamParentRow } from './UpstreamEvidence';

const noop = () => undefined;

// Same constraint as EvidenceSection.test.tsx: no DOM test environment is installed here, so the on-demand
// fetch inside UpstreamEvidence's effect never fires under SSR. What IS reachable — and is what matters for
// an additive, old-server-safe field — is the synchronous loading render (only for a review quest; nothing
// at all for any other kind) and the row rendering logic proven directly below.
describe('UpstreamEvidence (SSR)', () => {
  it('renders nothing at all for a non-review quest', () => {
    const quest = makeQuest({ id: 'UE-1', kind: 'code' });
    const html = renderToStaticMarkup(<UpstreamEvidence quest={quest} projectId="proj-1" refresh={noop} pushToast={noop} />);
    expect(html).toBe('');
  });

  it('shows a loading note for a review quest before the on-demand fetch would resolve', () => {
    const quest = makeQuest({ id: 'REVIEW-UE-1', kind: 'review', parents: ['UE-1'] });
    const html = renderToStaticMarkup(<UpstreamEvidence quest={quest} projectId="proj-1" refresh={noop} pushToast={noop} />);
    expect(html).toContain('上游证据读取中');
  });
});

describe('UpstreamParentRow (pure, real JSX)', () => {
  it('names each kind with its Chinese label and state, and flags a gap when no project test passed', () => {
    const html = renderToStaticMarkup(
      <UpstreamParentRow
        parent={{
          id: 'PKG-1',
          attemptId: 'a1',
          states: { report: 'passed', 'project-verification': 'missing', hook: 'not_configured' },
          failing: [],
          gap: true,
          text: '上游 PKG-1 最近一次派遣：项目验证记录缺失、验证钩子未配置、模型自报通过（未经项目验证）',
        }}
      />,
    );
    expect(html).toContain('PKG-1');
    expect(html).toContain('模型自报');
    expect(html).toContain('项目验证记录');
    expect(html).toContain('验证钩子');
    expect(html).toContain('通过');
    expect(html).toContain('缺失');
    expect(html).toContain('未配置');
    expect(html).toContain('未经项目验证');
  });

  it('marks a failing required kind distinctly from a merely-not-passed one', () => {
    const html = renderToStaticMarkup(
      <UpstreamParentRow
        parent={{
          id: 'PKG-2',
          attemptId: 'a2',
          states: { report: 'passed', 'project-verification': 'failed', hook: 'not_configured' },
          failing: ['project-verification'],
          gap: true,
          text: '上游 PKG-2 最近一次派遣：项目验证记录失败、验证钩子未配置、模型自报通过（未经项目验证）',
        }}
      />,
    );
    expect(html).toContain('upstream-evidence-parent-failing');
    expect(html).toContain('upstream-evidence-chip-failing');
  });

  it('shows no gap chip once an actual project test has passed', () => {
    const html = renderToStaticMarkup(
      <UpstreamParentRow
        parent={{
          id: 'PKG-3',
          attemptId: 'a3',
          states: { report: 'passed', 'project-verification': 'passed', hook: 'not_configured' },
          failing: [],
          gap: false,
          text: '上游 PKG-3 最近一次派遣：验证钩子未配置',
        }}
      />,
    );
    expect(html).not.toContain('未经项目验证');
  });
});
