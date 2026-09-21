import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { EvidenceItem } from '../../api/types';
import { makeQuest } from '../../lib/testFixtures';
import { AcceptancePanel, AcceptanceRow } from './AcceptancePanel';

// Same constraint as EvidenceSection.test.tsx: no DOM test environment is installed here, so the on-demand
// fetch inside the effect never fires under SSR. What IS reachable is the synchronous loading render — proof
// this additive, old-server-safe panel does not crash before its fetch would resolve.
describe('AcceptancePanel (SSR)', () => {
  it('shows a loading note before the on-demand fetch would resolve, and nothing crashes with no evidence yet', () => {
    const quest = makeQuest({ id: 'AP-W-1' });
    const html = renderToStaticMarkup(<AcceptancePanel quest={quest} onChange={() => {}} />);
    expect(html).toContain('证据读取中');
    expect(html).toContain('选择这次验收依据的证据');
  });
});

// Feedback 11/15: the three evidence rows have to line up. Nothing here can measure pixels (no DOM), but the
// markup contract the CSS lays out — checkbox, then the name in its own span, then the 说明 in its own span,
// in that order inside one label — is exactly what the three-column grid works from, so it is pinned here.
describe('AcceptancePanel evidence row (FB2-09)', () => {
  const bound: EvidenceItem = {
    kind: 'report', label: '模型自报', state: 'passed', source: 'delivery', ref: '.work/oc/mod1.md',
    digest: '0123456789abcdef', capturedAt: '2026-09-16T00:00:00.000Z', attemptId: 'a1', bound: true,
  };
  const unbound: EvidenceItem = {
    ...bound, kind: 'project-verification', state: 'failed', ref: '.work/full/progress.txt',
    bound: false, reason: '这是这次派遣之前的记录，不算这次的证据',
  };

  it('names every column in its own element: checkbox, name span, then the why span, inside the label', () => {
    const html = renderToStaticMarkup(<AcceptanceRow item={unbound} checked={false} onToggle={() => {}} />);
    const inputAt = html.indexOf('<input');
    const nameAt = html.indexOf('<span class="acceptance-panel-label">项目验证记录</span>');
    const reasonAt = html.indexOf('<span class="acceptance-panel-reason">');
    expect(inputAt).toBeGreaterThan(-1);
    expect(nameAt).toBeGreaterThan(inputAt);
    expect(reasonAt).toBeGreaterThan(nameAt);
    // The name is never a bare text node next to the checkbox — that is what left each row at its own x.
    expect(html).not.toMatch(/\/>\s*项目验证记录/);
    expect(html).toContain('（这是这次派遣之前的记录，不算这次的证据）');
    expect(html).toContain('disabled');
    expect(html).toContain('acceptance-panel-item');
    expect(html).toContain('acceptance-panel-item-disabled');
  });

  it('a choosable row is not greyed and carries no why column at all', () => {
    const html = renderToStaticMarkup(<AcceptanceRow item={bound} checked onToggle={() => {}} />);
    expect(html).toContain('<span class="acceptance-panel-label">工作者报告</span>');
    expect(html).not.toContain('acceptance-panel-reason');
    expect(html).not.toContain('disabled');
  });

  it('falls back to a plain why line when the server sends no reason', () => {
    const html = renderToStaticMarkup(<AcceptanceRow item={{ ...unbound, reason: undefined }} checked={false} onToggle={() => {}} />);
    expect(html).toContain('<span class="acceptance-panel-reason">（还没绑定到本次尝试）</span>');
  });
});
