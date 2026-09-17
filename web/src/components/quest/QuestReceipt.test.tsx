import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { makeQuest, makeSnapshot } from '../../lib/testFixtures';
import { QuestReceipt } from './QuestReceipt';

// This project has no DOM test environment installed (jsdom/happy-dom/react-test-renderer — see the same
// gap noted in LaneCard.test.tsx), and the brief for this fix bars installing one. A literal mount-effect
// race test (render quest A, let its fetch resolve, re-render quest B, inspect the committed DOM before any
// effect refires) is therefore not reachable from vitest here; that race is instead proven by the real,
// intercepted Chromium check in the delivery report (real mouse clicks, every animation frame sampled).
// What *is* reachable, and is the actual R3-1 fix, is the `key` React uses to decide whether a quest switch
// reuses `ReportSection`'s fiber (carrying over its `state`/`panelOpen`) or throws it away and mounts fresh.
// `QuestReceipt` itself calls no hooks, so calling it directly (as `renderToStaticMarkup` already does one
// layer up) returns its element tree with no rendering/DOM needed — real production code, not a stand-in.
function reportSectionKey(quest: Parameters<typeof QuestReceipt>[0]['quest'], snap: Parameters<typeof QuestReceipt>[0]['snap']) {
  const tree = QuestReceipt({ quest, snap }) as ReactElement<{ children: ReactNode }>;
  const children = tree.props.children;
  const list = Array.isArray(children) ? children : [children];
  const section = list.find(
    (child): child is ReactElement => Boolean(child) && typeof child === 'object' && (child as ReactElement).type instanceof Function && ((child as ReactElement).type as { name: string }).name === 'ReportSection',
  );
  if (!section) throw new Error('ReportSection element not found in QuestReceipt output');
  return section.key;
}

// SSR only (no DOM installed here, same approach as MetadataSection.test.tsx): the detail-route summary
// fetch never fires, so these prove the parts that render synchronously — the legacy fallback, and the
// reference line/expand control that come straight from the snapshot's own pruned `quest.report`.
describe('QuestReceipt (real JSX, SSR)', () => {
  it('keeps the current receipt, with no 最终报告 block, for a legacy quest with no report', () => {
    const quest = makeQuest({ id: 'A-1', lastDetail: '做完了' });
    const snap = makeSnapshot({ quests: [quest] });
    const html = renderToStaticMarkup(<QuestReceipt quest={quest} snap={snap} />);
    expect(html).toContain('冒险者交回的东西');
    expect(html).not.toContain('最终报告');
    expect(html).not.toContain('查看完整报告');
  });

  it('shows the reference line and an expand control once the snapshot carries a report', () => {
    const quest = makeQuest({
      id: 'A-2',
      lastDetail: '做完了',
      report: {
        source: 'delivery',
        ref: 'delivery/A-2-worker.md',
        digest: '0123456789abcdef',
        bytes: 100,
        sizeBytes: 100,
        truncated: false,
        capturedAt: '2026-09-16T03:00:00.000Z',
        attemptId: 'att-1',
        verdict: 'PASS',
      },
    });
    const snap = makeSnapshot({ quests: [quest] });
    const html = renderToStaticMarkup(<QuestReceipt quest={quest} snap={snap} />);
    expect(html).toContain('最终报告');
    expect(html).toContain('交付文件');
    expect(html).toContain('delivery/A-2-worker.md');
    expect(html).toContain('0123456789ab'); // first 12 hex chars of the digest, never the full one by default
    expect(html).toContain('查看完整报告');
    // Before the on-demand summary fetch resolves (never, under SSR), the loading note shows in the report
    // block — never a lastDetail tail standing in for the heading/paragraph there.
    expect(html).toContain('摘要读取中');
  });

  it('B1 (round 2): once a report exists, lastDetail is never shown as 它自己的总结 — it moves below, relabelled', () => {
    const quest = makeQuest({
      id: 'A-4',
      status: 'delivered',
      lastDetail: '…中中中中 VERDICT: PASS',
      report: {
        source: 'exit-file',
        ref: 'out/A-4-worker.md',
        digest: '0123456789abcdef',
        bytes: 100,
        sizeBytes: 100,
        truncated: false,
        capturedAt: '2026-09-16T03:00:00.000Z',
        attemptId: 'att-1',
        verdict: 'PASS',
      },
    });
    const snap = makeSnapshot({ quests: [quest] });
    const html = renderToStaticMarkup(<QuestReceipt quest={quest} snap={snap} />);
    expect(html).not.toContain('它自己的总结');
    expect(html).toContain('最近记录（末尾片段）');
    expect(html).toContain('…中中中中 VERDICT: PASS');
    // The tail note is its own block, positioned after the report's own actions — never inside it.
    expect(html.indexOf('末尾片段')).toBeGreaterThan(html.indexOf('查看完整报告'));
  });

  it('shows the truncation notice from the snapshot reference alone, before any fetch resolves', () => {
    const quest = makeQuest({
      id: 'A-3',
      report: {
        source: 'exit-file',
        ref: 'out/A-3-worker.md',
        digest: 'deadbeefcafe0123',
        bytes: 2 * 1024 * 1024,
        sizeBytes: 2 * 1024 * 1024 + 500,
        truncated: true,
        capturedAt: '2026-09-16T03:00:00.000Z',
        attemptId: 'att-1',
        verdict: 'unknown',
        verdictReason: '报告超过 2 MB，只读了前 2097152 字节，没有读到结尾，给不出最终结论',
      },
    });
    const snap = makeSnapshot({ quests: [quest] });
    const html = renderToStaticMarkup(<QuestReceipt quest={quest} snap={snap} />);
    expect(html).toContain('报告没有读完整，只显示了前面一部分');
    expect(html).toContain('退出文件');
  });

  describe('R3-1 (revision 4): ReportSection is keyed per project and quest, like MetadataSection', () => {
    it('gives two different quests in the same project two different keys, so a switch remounts instead of reusing state', () => {
      const questA = makeQuest({ id: 'A-1' });
      const questB = makeQuest({ id: 'A-4' });
      const snap = makeSnapshot({ quests: [questA, questB] });
      const keyA = reportSectionKey(questA, snap);
      const keyB = reportSectionKey(questB, snap);
      expect(keyA).toBe(`${snap.project.id ?? ''}:${questA.id}`);
      expect(keyB).toBe(`${snap.project.id ?? ''}:${questB.id}`);
      expect(keyA).not.toBe(keyB);
    });

    it('gives the same quest the same key across re-renders, so it is not remounted needlessly', () => {
      const quest = makeQuest({ id: 'A-1' });
      const snap = makeSnapshot({ quests: [quest] });
      expect(reportSectionKey(quest, snap)).toBe(reportSectionKey(quest, snap));
    });
  });
});
