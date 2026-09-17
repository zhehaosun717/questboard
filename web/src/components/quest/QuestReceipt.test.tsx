import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { makeAssignee, makeQuest, makeSnapshot } from '../../lib/testFixtures';
import { DEFAULT_LOCALE, setLocale } from '../../lib/i18n';
import { copyAttempt, QuestReceipt } from './QuestReceipt';

const REPORT_A = {
  source: 'delivery' as const,
  ref: 'delivery/A-1-worker.md',
  digest: 'digest-one',
  bytes: 10,
  sizeBytes: 10,
  truncated: false,
  capturedAt: '2026-09-16T03:00:00.000Z',
  attemptId: 'att-1',
  verdict: 'PASS' as const,
};
const REPORT_B = {
  ...REPORT_A,
  ref: 'delivery/A-1-worker-2.md',
  digest: 'digest-two',
  attemptId: 'att-2',
};

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
      expect(keyA).toBe(`${snap.project.id ?? ''}:${questA.id}::`);
      expect(keyB).toBe(`${snap.project.id ?? ''}:${questB.id}::`);
      expect(keyA).not.toBe(keyB);
    });

    it('gives the same quest the same key across re-renders, so it is not remounted needlessly', () => {
      const quest = makeQuest({ id: 'A-1' });
      const snap = makeSnapshot({ quests: [quest] });
      expect(reportSectionKey(quest, snap)).toBe(reportSectionKey(quest, snap));
    });
  });

  // Item 1 (N4): the key also carries the report's own ref+digest, not just project+quest — a same quest id
  // whose report changed (a new dispatch attempt captured while the drawer stayed open) must remount
  // ReportSection instead of reusing its `state`/`panelOpen`, so switching between two attempts' reports
  // never shows the previous attempt's stale summary or panel for even one frame.
  describe('item 1: ReportSection is also keyed on the report reference, so a new attempt never reuses a stale panel', () => {
    it('gives the same quest id two different keys across its two reports (two attempts, one frame each)', () => {
      const questFrame1 = makeQuest({ id: 'A-1', report: REPORT_A });
      const questFrame2 = makeQuest({ id: 'A-1', report: REPORT_B });
      const snap1 = makeSnapshot({ quests: [questFrame1] });
      const snap2 = makeSnapshot({ quests: [questFrame2] });
      const key1 = reportSectionKey(questFrame1, snap1);
      const key2 = reportSectionKey(questFrame2, snap2);
      expect(key1).toBe(`${snap1.project.id ?? ''}:A-1:${REPORT_A.ref}:${REPORT_A.digest}`);
      expect(key2).toBe(`${snap2.project.id ?? ''}:A-1:${REPORT_B.ref}:${REPORT_B.digest}`);
      expect(key1).not.toBe(key2);
    });

    it('keeps the same key across re-renders of the same attempt, so it is not remounted needlessly', () => {
      const quest = makeQuest({ id: 'A-1', report: REPORT_A });
      const snap = makeSnapshot({ quests: [quest] });
      expect(reportSectionKey(quest, snap)).toBe(reportSectionKey(quest, snap));
    });
  });
});

// Item 6 (M5): a copy failure — the clipboard API rejects, or is entirely absent (an insecure context, or a
// very old browser) — must not be silently ignored. `copyAttempt` is the whole decision QuestReceipt's own
// click handler delegates to, so it is directly testable without a DOM or a real clipboard.
describe('copyAttempt (item 6/M5)', () => {
  it('writes through to a real clipboard when one is available', async () => {
    const writeText = (text: string) => Promise.resolve(text).then(() => undefined);
    const calls: string[] = [];
    const clipboard = { writeText: (text: string) => { calls.push(text); return writeText(text); } };
    await expect(copyAttempt(clipboard, '交付文件 delivery/x.md abc123')).resolves.toBeUndefined();
    expect(calls).toEqual(['交付文件 delivery/x.md abc123']);
  });

  it('rejects immediately when there is no clipboard API at all, instead of silently doing nothing', async () => {
    await expect(copyAttempt(undefined, 'text')).rejects.toThrow();
  });

  it('surfaces a real clipboard rejection (e.g. permission denied) instead of swallowing it', async () => {
    const clipboard = { writeText: () => Promise.reject(new Error('permission denied')) };
    await expect(copyAttempt(clipboard, 'text')).rejects.toThrow('permission denied');
  });
});

describe('QuestReceipt language switch (item 38 follow-up)', () => {
  afterEach(() => {
    setLocale(DEFAULT_LOCALE);
  });

  it('renders every converted label in English, with no residual CJK outside ids/paths', () => {
    setLocale('en');
    const assignee = makeAssignee('adv-1', { name: 'worker-1', lane: 'oc' });
    const quest = makeQuest({
      id: 'A-EN-1',
      status: 'delivered',
      lastDetail: 'done',
      files: ['a.md', 'b.md'],
      assignee,
      dispatches: [assignee],
    });
    const snap = makeSnapshot({ quests: [quest], live: { 'worker-1': { state: 'running', elapsed: 120, edits: 3, lastText: '', tokens: null } } });
    const html = renderToStaticMarkup(<QuestReceipt quest={quest} snap={snap} />);
    expect(html).toContain('What was returned');
    expect(html).toContain('Its own summary');
    expect(html).toContain('Files the brief allows changing');
    expect(html).toContain('Last dispatched');
    expect(html).toContain('Live: running');
    expect(html).toContain('edits');
    expect(html).toContain('Project-wide tests');
    expect(html).toContain('No record');
    // lib/board.ts's formatAgo() is out of this slice's scope and still renders a Chinese unit (秒/分/时).
    expect(
      html.replace(/A-EN-1|worker-1|a\.md|b\.md|adv-1-model|\d+秒/g, ''),
    ).not.toMatch(/[一-鿿]/);
    expect(html).not.toMatch(/[\u3000-\u303F\uFF00-\uFFEF]/);
  });

  it('shows the no-delivery and final-report states in English too', () => {
    setLocale('en');
    const quest = makeQuest({ id: 'A-EN-2' });
    const snap = makeSnapshot({ quests: [quest] });
    const html = renderToStaticMarkup(<QuestReceipt quest={quest} snap={snap} />);
    expect(html).toContain('Nothing returned yet');
    expect(html).not.toMatch(/[一-鿿]/);
  });
});
