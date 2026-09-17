import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { makeQuest } from '../../lib/testFixtures';
import { DEFAULT_LOCALE, setLocale } from '../../lib/i18n';
import { EvidenceRow, EvidenceSection } from './EvidenceSection';

// Same constraint as QuestReceipt.test.tsx: no DOM test environment is installed here, so the on-demand
// fetch inside EvidenceSection's effect never fires under SSR. What IS reachable — and is what matters for
// an additive, old-server-safe field — is the synchronous loading render, proven here, and the row rendering
// logic proven directly below through the exported pure row renderer.
describe('EvidenceSection (SSR)', () => {
  it('shows a loading note before the on-demand fetch would resolve, and nothing crashes with no evidence yet', () => {
    const quest = makeQuest({ id: 'EV-W-1' });
    const html = renderToStaticMarkup(<EvidenceSection quest={quest} projectId="proj-1" />);
    expect(html).toContain('证据读取中');
  });
});

describe('EvidenceSection row rendering (pure, real JSX)', () => {
  it('shows the Chinese state chip, source/ref/digest and never a 未绑定 chip for a bound, passed item', () => {
    const html = renderToStaticMarkup(
      <EvidenceRow
        item={{
          kind: 'report', label: '模型自报', state: 'passed', source: 'delivery', ref: '.work/oc/mod1.md',
          digest: '0123456789abcdef', capturedAt: '2026-09-16T00:00:00.000Z', attemptId: 'a1', bound: true,
        }}
      />,
    );
    expect(html).toContain('模型自报');
    expect(html).toContain('通过');
    expect(html).toContain('.work/oc/mod1.md');
    expect(html).toContain('0123456789ab');
    expect(html).not.toContain('不是这次派遣的');
  });

  it('marks a bound:false item with the 未绑定 chip even though its own state reads passed', () => {
    const html = renderToStaticMarkup(
      <EvidenceRow
        item={{
          kind: 'project-verification', label: '项目验证记录', state: 'passed', source: 'progress-strip',
          ref: '.work/full/progress.txt', digest: 'deadbeef', capturedAt: '2026-09-13T00:00:00.000Z',
          attemptId: 'a1', bound: false, reason: '这是这次派遣之前的记录，不算这次的证据',
        }}
      />,
    );
    expect(html).toContain('不是这次派遣的');
    expect(html).toContain('这是这次派遣之前的记录，不算这次的证据');
  });

  it('shows 未配置/缺失 states with their reason and no reference row when there is nothing to reference', () => {
    const html = renderToStaticMarkup(
      <EvidenceRow
        item={{
          kind: 'hook', label: '验证钩子', state: 'not_configured', source: null, ref: null, digest: null,
          capturedAt: null, attemptId: null, bound: false, reason: '项目没有启用验证钩子',
        }}
      />,
    );
    expect(html).toContain('验证钩子');
    expect(html).toContain('未配置');
    expect(html).toContain('项目没有启用验证钩子');
    expect(html).not.toContain('复制');
  });

  // F6: missing/not_configured are "no record at all", not a wrong-version one — the 不是这次派遣的 chip
  // would only be noise on top of the state chip and reason that already explain it.
  it('never shows the 未绑定 chip on a not_configured item, even though bound is false', () => {
    const html = renderToStaticMarkup(
      <EvidenceRow
        item={{
          kind: 'project-verification', label: '项目验证记录', state: 'not_configured', source: null, ref: null,
          digest: null, capturedAt: null, attemptId: null, bound: false, reason: '项目没有配置验证目录',
        }}
      />,
    );
    expect(html).not.toContain('不是这次派遣的');
  });

  it('never shows the 未绑定 chip on a missing item, even though bound is false', () => {
    const html = renderToStaticMarkup(
      <EvidenceRow
        item={{
          kind: 'report', label: '模型自报', state: 'missing', source: null, ref: null, digest: null,
          capturedAt: null, attemptId: null, bound: false, reason: '这次派遣没有报告',
        }}
      />,
    );
    expect(html).not.toContain('不是这次派遣的');
  });

  it('still shows the 未绑定 chip on a stale-but-real record (state passed, bound false)', () => {
    const html = renderToStaticMarkup(
      <EvidenceRow
        item={{
          kind: 'project-verification', label: '项目验证记录', state: 'passed', source: 'progress-strip',
          ref: '.work/full/progress.txt', digest: 'deadbeef', capturedAt: '2026-09-13T00:00:00.000Z',
          attemptId: 'a1', bound: false, reason: '这是这次派遣之前的记录，不算这次的证据',
        }}
      />,
    );
    expect(html).toContain('不是这次派遣的');
  });

  it('maps known evidence sources to Chinese labels, falls back to the raw value, and labels a hook item 命令', () => {
    const known = renderToStaticMarkup(
      <EvidenceRow
        item={{
          kind: 'report', label: '模型自报', state: 'passed', source: 'delivery', ref: '.work/oc/mod1.md',
          digest: '0123456789abcdef', capturedAt: '2026-09-16T00:00:00.000Z', attemptId: 'a1', bound: true,
        }}
      />,
    );
    expect(known).toContain('来源 交差文件');

    const fallback = renderToStaticMarkup(
      <EvidenceRow
        item={{
          kind: 'project-verification', label: '项目验证记录', state: 'passed', source: 'some-unmapped-source',
          ref: '.work/full/progress.txt', digest: 'deadbeef', capturedAt: '2026-09-13T00:00:00.000Z',
          attemptId: 'a1', bound: true,
        }}
      />,
    );
    expect(fallback).toContain('来源 some-unmapped-source');

    const hook = renderToStaticMarkup(
      <EvidenceRow
        item={{
          kind: 'hook', label: '验证钩子', state: 'passed', source: 'npm test', ref: null, digest: null,
          capturedAt: null, attemptId: 'a1', bound: true,
        }}
      />,
    );
    expect(hook).toContain('命令 npm test');
    expect(hook).not.toContain('来源');
  });
});

describe('EvidenceSection/EvidenceRow language switch (item 38 follow-up)', () => {
  afterEach(() => {
    setLocale(DEFAULT_LOCALE);
  });

  it('EvidenceSection shows the loading note in English', () => {
    setLocale('en');
    const quest = makeQuest({ id: 'EV-W-2' });
    const html = renderToStaticMarkup(<EvidenceSection quest={quest} projectId="proj-1" />);
    expect(html).toContain('Reading evidence');
    expect(html).not.toMatch(/[一-鿿]/);
  });

  it('EvidenceRow renders every converted label in English, with no residual CJK outside a hook source command', () => {
    setLocale('en');
    const html = renderToStaticMarkup(
      <EvidenceRow
        item={{
          kind: 'project-verification', label: 'x', state: 'passed', source: 'progress-strip',
          ref: '.work/full/progress.txt', digest: 'deadbeef', capturedAt: '2026-09-16T00:00:00.000Z',
          attemptId: 'a1', bound: false, reason: 'stale evidence',
        }}
      />,
    );
    expect(html).toContain('Project verification record');
    expect(html).toContain('Passed');
    expect(html).toContain('Not from this dispatch');
    expect(html).toContain('source');
    expect(html).toContain('Project verification dir (progress.txt)');
    expect(html).toContain('path');
    expect(html).toContain('digest');
    expect(html).toContain('Copy');
    expect(html).toContain('Recorded');
    expect(html).not.toMatch(/[一-鿿]/);
  });
});
