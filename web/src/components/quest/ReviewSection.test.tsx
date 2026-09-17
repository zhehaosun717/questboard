import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RAW_TAIL_LABEL } from '../../lib/evidence';
import { makeQuest, makeSnapshot } from '../../lib/testFixtures';
import { ReviewSection } from './ReviewSection';

const noop = () => undefined;

function renderSection(parent: Parameters<typeof makeQuest>[0], reviews: ReturnType<typeof makeQuest>[]) {
  const quest = makeQuest(parent);
  const snap = makeSnapshot({ quests: [quest, ...reviews] });
  return renderToStaticMarkup(
    <ReviewSection
      quest={quest}
      snap={snap}
      draft=""
      onDraftChange={noop}
      onSelectQuest={noop}
      onAssignCard={noop}
      refresh={noop}
      pushToast={noop}
    />,
  );
}

// Item 12: a review with a captured, verified report shows the backend's own verdict — not a guess parsed
// out of lastDetail — labelled as the model's self-report, with its source and captured time. It must never
// read as the board's own acceptance (that is a separate control further down the section).
describe('ReviewSection verdict line (item 12)', () => {
  it('shows the backend verdict, source label and captured time when the review has a captured report', () => {
    const review = makeQuest({
      id: 'R-1',
      kind: 'review',
      parents: ['A-1'],
      status: 'delivered',
      lastDetail: '看起来过程记录被截断了',
      report: {
        source: 'delivery',
        ref: 'delivery/R-1-worker.md',
        digest: 'abc123',
        bytes: 10,
        sizeBytes: 10,
        truncated: false,
        capturedAt: '2026-09-16T03:00:00.000Z',
        attemptId: 'att-1',
        verdict: 'PASS',
      },
    });
    const html = renderSection({ id: 'A-1' }, [review]);
    expect(html).toContain('复核结论（模型自报）：通过');
    expect(html).toContain('交付文件');
    expect(html).not.toContain('未经核验');
  });

  it('shows the reason when the backend verdict is unknown', () => {
    const review = makeQuest({
      id: 'R-2',
      kind: 'review',
      parents: ['A-1'],
      status: 'delivered',
      report: {
        source: 'exit-file',
        ref: 'out/R-2-worker.md',
        digest: 'def456',
        bytes: 5,
        sizeBytes: 2 * 1024 * 1024 + 1,
        truncated: true,
        capturedAt: '2026-09-16T04:00:00.000Z',
        attemptId: 'att-2',
        verdict: 'unknown',
        verdictReason: '报告超过 2 MB，只读了前 5 字节，没有读到结尾，给不出最终结论',
      },
    });
    const html = renderSection({ id: 'A-1' }, [review]);
    expect(html).toContain('复核结论（模型自报）');
    expect(html).toContain('结论未识别');
    expect(html).toContain('报告超过 2 MB');
    expect(html).toContain('退出文件');
  });

  // R2-2: a genuine "no VERDICT line" unknown (never truncated, never a .out transcript) carries no backend
  // reason. The UI must never invent one (M3's "报告里没有找到 VERDICT 行" was false whenever the report did
  // have a VERDICT line the backend just didn't recognise, e.g. PASS WITH FINDINGS before this fix) — it
  // shows plain 未识别 with no parenthetical when the backend gives no reason.
  it('shows plain 未识别 with no invented reason for a verified-unknown report with no backend reason', () => {
    const review = makeQuest({
      id: 'R-4',
      kind: 'review',
      parents: ['A-1'],
      status: 'delivered',
      report: {
        source: 'delivery',
        ref: 'delivery/R-4-worker.md',
        digest: 'aaa111',
        bytes: 20,
        sizeBytes: 20,
        truncated: false,
        capturedAt: '2026-09-16T05:00:00.000Z',
        attemptId: 'att-4',
        verdict: 'unknown',
      },
    });
    const html = renderSection({ id: 'A-1' }, [review]);
    expect(html).toContain('复核结论（模型自报）：结论未识别');
    expect(html).not.toContain('未识别（');
    expect(html).not.toContain('VERDICT 行');
  });

  // R2-2: the review template's third choice, PASS WITH FINDINGS, is now recognised as a verified verdict —
  // shown as findings, never as an invented "no VERDICT line" unknown.
  it('shows a verified PASS WITH FINDINGS report as findings, not an invented unknown', () => {
    const review = makeQuest({
      id: 'R-5',
      kind: 'review',
      parents: ['A-1'],
      status: 'delivered',
      report: {
        source: 'delivery',
        ref: 'delivery/R-5-worker.md',
        digest: 'bbb222',
        bytes: 30,
        sizeBytes: 30,
        truncated: false,
        capturedAt: '2026-09-16T06:00:00.000Z',
        attemptId: 'att-5',
        verdict: 'findings',
      },
    });
    const html = renderSection({ id: 'A-1' }, [review]);
    expect(html).toContain('复核结论（模型自报）：通过但有问题');
    expect(html).not.toContain('未识别');
    expect(html).not.toContain('未经核验');
  });

  it('falls back to a labelled, lastDetail-derived verdict when the review has no captured report', () => {
    const review = makeQuest({
      id: 'R-3',
      kind: 'review',
      parents: ['A-1'],
      status: 'delivered',
      lastDetail: 'VERDICT: FAIL',
    });
    const html = renderSection({ id: 'A-1' }, [review]);
    expect(html).not.toContain('复核结论（模型自报）');
    expect(html).toContain('复核不通过');
    expect(html).toContain('没有最终报告，这是从最后几行输出里猜的');
  });

  // N1/item 2: a raw lastDetail tail must never sit next to a verdict unlabelled — most sharply wrong right
  // beside a verified 结论未识别, where it could be an echoed review template that reads as if it were the
  // verdict's own evidence. It is shown labelled instead, following the receipt's own wording, never hidden
  // or bare — this holds for every verdict state, not only the verified-unknown case.
  it('labels a raw lastDetail tail beside a verified 结论未识别, never showing it bare (N1)', () => {
    const review = makeQuest({
      id: 'R-6',
      kind: 'review',
      parents: ['A-1'],
      status: 'delivered',
      lastDetail: '…审核填充 VERDICT: PASS | PASS WITH FINDINGS | FAIL',
      report: {
        source: 'delivery',
        ref: 'delivery/R-6-worker.md',
        digest: 'ccc333',
        bytes: 40,
        sizeBytes: 40,
        truncated: false,
        capturedAt: '2026-09-16T07:00:00.000Z',
        attemptId: 'att-6',
        verdict: 'unknown',
      },
    });
    const html = renderSection({ id: 'A-1' }, [review]);
    expect(html).toContain('结论未识别');
    expect(html).toContain(RAW_TAIL_LABEL);
    expect(html).toContain('…审核填充 VERDICT: PASS | PASS WITH FINDINGS | FAIL');
    // The label sits before the raw tail, not after — it reads as "here is a fragment", not a caption below it.
    expect(html.indexOf(RAW_TAIL_LABEL)).toBeLessThan(html.indexOf('…审核填充'));
  });

  it('also labels a raw lastDetail tail beside a verified pass, not only the unknown case', () => {
    const review = makeQuest({
      id: 'R-7',
      kind: 'review',
      parents: ['A-1'],
      status: 'delivered',
      lastDetail: '看起来过程记录被截断了',
      report: {
        source: 'delivery',
        ref: 'delivery/R-7-worker.md',
        digest: 'ddd444',
        bytes: 40,
        sizeBytes: 40,
        truncated: false,
        capturedAt: '2026-09-16T08:00:00.000Z',
        attemptId: 'att-7',
        verdict: 'PASS',
      },
    });
    const html = renderSection({ id: 'A-1' }, [review]);
    expect(html).toContain(RAW_TAIL_LABEL);
  });
});
