import { afterEach, describe, expect, it } from 'vitest';
import {
  acceptedOnBoard,
  boardAcceptanceDetail,
  evidenceFor,
  parseVerdict,
  RAW_TAIL_LABEL,
  recordedAcceptor,
  REPORT_SOURCE_LABEL,
  reviewVerdictOf,
  VERDICT_LABEL,
} from './evidence';
import { DEFAULT_LOCALE, setLocale } from './i18n';
import { makeAssignee, makeCard, makeQuest, makeSnapshot } from './testFixtures';

describe('label tables language switch (item 38 follow-up)', () => {
  afterEach(() => {
    setLocale(DEFAULT_LOCALE);
  });

  it('VERDICT_LABEL, REPORT_SOURCE_LABEL and RAW_TAIL_LABEL render in Chinese by default, byte-identical to the originals', () => {
    expect(VERDICT_LABEL.pass).toBe('通过');
    expect(VERDICT_LABEL.findings).toBe('通过但有问题');
    expect(VERDICT_LABEL.fail).toBe('不通过');
    expect(VERDICT_LABEL.unknown).toBe('没写结论');
    expect(REPORT_SOURCE_LABEL.delivery).toBe('交付文件');
    expect(REPORT_SOURCE_LABEL['exit-file']).toBe('退出文件');
    expect(REPORT_SOURCE_LABEL.summary).toBe('运行记录（.out）');
    expect(RAW_TAIL_LABEL()).toBe('最近记录（末尾片段）');
  });

  it('translate in English mode', () => {
    setLocale('en');
    expect(VERDICT_LABEL.pass).toBe('Pass');
    expect(VERDICT_LABEL.findings).toBe('Passed with findings');
    expect(VERDICT_LABEL.fail).toBe('Failed');
    expect(VERDICT_LABEL.unknown).toBe('No verdict written');
    expect(REPORT_SOURCE_LABEL.delivery).toBe('Delivery file');
    expect(REPORT_SOURCE_LABEL['exit-file']).toBe('Exit file');
    expect(REPORT_SOURCE_LABEL.summary).toBe('Run log (.out)');
    expect(RAW_TAIL_LABEL()).toBe('Most recent record (tail fragment)');
  });
});

describe('acceptedOnBoard', () => {
  it('returns true for legacy and new acceptance details, and false for neither', () => {
    expect(acceptedOnBoard('验收通过')).toBe(true);
    expect(acceptedOnBoard('owner 验收通过')).toBe(true);
    expect(acceptedOnBoard('owner 验收')).toBe(true);
    expect(acceptedOnBoard('owner 验收：已测试')).toBe(true);
    expect(acceptedOnBoard('coordinator 验收')).toBe(true);
    expect(acceptedOnBoard('coordinator 验收：npm test 过了')).toBe(true);
    expect(acceptedOnBoard('已完成')).toBe(false);
    expect(acceptedOnBoard('')).toBe(false);
  });

  it('a note that only quotes an acceptance did not accept anything (QB-FB-BG)', () => {
    expect(acceptedOnBoard('复核意见：照例写一句 owner 验收 即可')).toBe(false);
    expect(recordedAcceptor('报告尾部引用了 owner 验收 四个字')).toBeNull();
  });
});

describe('recordedAcceptor', () => {
  it('reads the actor from the record only, and never guesses it', () => {
    expect(recordedAcceptor('owner 验收')).toBe('owner');
    expect(recordedAcceptor('coordinator 验收：跑过测试')).toBe('coordinator');
    expect(recordedAcceptor('验收通过')).toBe('unknown');
    expect(recordedAcceptor('退回重做：少个判空')).toBeNull();
    expect(recordedAcceptor('')).toBeNull();
  });
});

describe('parseVerdict', () => {
  it('reads the verdict line the review brief asks for', () => {
    expect(parseVerdict('PASS — scope\nVERDICT: PASS')).toBe('pass');
    expect(parseVerdict('FINDINGS\n1. x\nVERDICT: PASS WITH FINDINGS')).toBe('findings');
    expect(parseVerdict('VERDICT: FAIL\n')).toBe('fail');
  });

  it('does not read the echoed template or a missing verdict as a result, and takes the last verdict', () => {
    expect(parseVerdict('VERDICT: PASS | PASS WITH FINDINGS | FAIL')).toBe('unknown');
    expect(parseVerdict('looks fine to me')).toBe('unknown');
    expect(parseVerdict('VERDICT: PASS\nre-checked the tests\nVERDICT: FAIL')).toBe('fail');
  });

  // Item 3 (N3): the backend's own extractVerdict (src/core/reportEvidence.js) only recognises the exact
  // uppercase token — a lowercase or mixed-case line is not a genuine verdict there, so this tail-parse
  // fallback must not disagree and read one out of it anyway.
  it('is case-sensitive like the backend: only an exact uppercase VERDICT/PASS/FAIL line counts', () => {
    expect(parseVerdict('verdict: fail\n')).toBe('unknown');
    expect(parseVerdict('Verdict: FAIL\n')).toBe('unknown');
    expect(parseVerdict('VERDICT: Fail\n')).toBe('unknown');
    expect(parseVerdict('VERDICT: fail\n')).toBe('unknown');
    expect(parseVerdict('verdict: PASS WITH FINDINGS\n')).toBe('unknown');
  });
});

describe('evidenceFor', () => {
  const work = (overrides = {}) =>
    makeQuest({ id: 'd', status: 'delivered', dispatches: [makeAssignee('card-1', { at: '2026-09-13T01:00:00.000Z' })], ...overrides });

  it('says the worker only claims the work until someone checks it, and the acceptance rung waits on the coordinator', () => {
    const [claimed, reviewed, accepted] = evidenceFor(work(), makeSnapshot({ roster: [makeCard('card-1', { name: 'Luna' })] }));
    expect(claimed?.state).toBe('done');
    expect(claimed?.note).toContain('Luna');
    expect(claimed?.note).toContain('不算核实');
    expect(reviewed?.state).toBe('skipped');
    expect(accepted?.label).toBe('coordinator 验收');
    expect([accepted?.state, accepted?.note]).toEqual(['pending', '等 coordinator 核验']);
  });

  it('labels the acceptance rung 你验收 only for art, where the owner really is the one who accepts', () => {
    const [, , accepted] = evidenceFor(work({ id: 'a', kind: 'art' }), makeSnapshot());
    expect([accepted?.label, accepted?.state, accepted?.note]).toEqual(['你验收', 'pending', '等你验收']);
  });

  it('marks a dispatch row it cannot name as unknown instead of dressing up a worker', () => {
    const ghost = makeAssignee('gone-card', { at: '2026-09-13T01:00:00.000Z', model: '' });
    const [claimed] = evidenceFor(work({ dispatches: [ghost] }), makeSnapshot());
    expect(claimed?.state).toBe('done');
    expect(claimed?.note).toBe('有交差记录但说不清是谁，不算核实');
  });

  it('marks a failing review as bad, a missing verdict as pending with no conclusion, and a running review as pending — all unverified without a captured report', () => {
    const review = (status: 'delivered' | 'dispatched', lastDetail: string) =>
      makeQuest({ id: 'REVIEW-d', kind: 'review', parents: ['d'], status, lastDetail, createdAt: '2026-09-13T02:00:00.000Z', assignee: makeAssignee('card-2') });
    const rung = (r: ReturnType<typeof review>) => evidenceFor(work(), makeSnapshot({ quests: [work(), r] }))[1];
    expect(rung(review('delivered', 'VERDICT: FAIL'))).toMatchObject({ state: 'bad', note: 'REVIEW-d：复核不通过（未经核验）' });
    expect(rung(review('delivered', 'no verdict here'))?.state).toBe('pending');
    expect(rung(review('dispatched', ''))?.note).toBe('REVIEW-d 复核中');
  });

  it('B2 (round 2): the ladder prefers a review’s verified report and never shows 复核通过 for a truncated one', () => {
    const truncatedReview = makeQuest({
      id: 'REVIEW-d', kind: 'review', parents: ['d'], status: 'delivered', lastDetail: 'VERDICT: PASS',
      createdAt: '2026-09-13T02:00:00.000Z',
      report: {
        source: 'summary', ref: 'out/x.out', digest: 'abc', bytes: 10, sizeBytes: 20, truncated: true,
        capturedAt: '2026-09-13T02:30:00.000Z', attemptId: 'att-1', verdict: 'unknown', verdictReason: '报告超过 2 MB，只读了前 10 字节，没有读到结尾，给不出最终结论',
      },
    });
    const rung = evidenceFor(work(), makeSnapshot({ quests: [work(), truncatedReview] }))[1];
    expect(rung?.state).toBe('pending');
    expect(rung?.note).not.toContain('复核通过');
    // R2-2: a verified unknown (this truncated report) reads 结论未识别, not the tail-parse fallback's 没写结论 —
    // the report was read, it just could not be finished, which is not the same as the reviewer writing nothing.
    expect(rung?.note).toBe('REVIEW-d：复核结论未识别');

    const verifiedPass = makeQuest({
      id: 'REVIEW-e', kind: 'review', parents: ['d'], status: 'delivered', lastDetail: '看起来还行',
      createdAt: '2026-09-13T02:00:00.000Z',
      report: {
        source: 'delivery', ref: 'delivery/x.md', digest: 'abc', bytes: 10, sizeBytes: 10, truncated: false,
        capturedAt: '2026-09-13T02:30:00.000Z', attemptId: 'att-1', verdict: 'PASS',
      },
    });
    const rung2 = evidenceFor(work(), makeSnapshot({ quests: [work(), verifiedPass] }))[1];
    expect(rung2).toMatchObject({ state: 'done', note: 'REVIEW-e：复核通过' });
  });

  it('reviewVerdictOf prefers the verified report and only falls back to a tail parse, labelled, when there is none', () => {
    const withReport = makeQuest({
      id: 'REVIEW-d', kind: 'review', lastDetail: 'VERDICT: FAIL',
      report: {
        source: 'delivery', ref: 'delivery/x.md', digest: 'abc', bytes: 10, sizeBytes: 10, truncated: false,
        capturedAt: '2026-09-13T02:30:00.000Z', attemptId: 'att-1', verdict: 'PASS',
      },
    });
    expect(reviewVerdictOf(withReport)).toEqual({ verdict: 'pass', verified: true });

    const withoutReport = makeQuest({ id: 'REVIEW-e', kind: 'review', lastDetail: 'VERDICT: PASS' });
    expect(reviewVerdictOf(withoutReport)).toEqual({ verdict: 'pass', verified: false });
  });

  it('R2-2: reviewVerdictOf maps a verified findings report straight through', () => {
    const withFindings = makeQuest({
      id: 'REVIEW-f', kind: 'review', lastDetail: 'VERDICT: PASS WITH FINDINGS',
      report: {
        source: 'delivery', ref: 'delivery/x.md', digest: 'abc', bytes: 10, sizeBytes: 10, truncated: false,
        capturedAt: '2026-09-13T02:30:00.000Z', attemptId: 'att-1', verdict: 'findings',
      },
    });
    expect(reviewVerdictOf(withFindings)).toEqual({ verdict: 'findings', verified: true });
  });

  it('ignores a review from before the latest dispatch', () => {
    const old = makeQuest({ id: 'REVIEW-d', kind: 'review', parents: ['d'], status: 'done', lastDetail: 'VERDICT: PASS', createdAt: '2026-09-13T00:30:00.000Z' });
    expect(evidenceFor(work(), makeSnapshot({ quests: [work(), old] }))[1]?.state).toBe('skipped');
  });

  it('names the acceptance actor from the record, says unknown when it is silent, and never guesses from done', () => {
    expect(evidenceFor(work({ kind: 'art', status: 'done', lastDetail: 'owner 验收通过' }), makeSnapshot())[2]?.note).toBe('你在看板上验收');
    expect(evidenceFor(work({ status: 'done', lastDetail: 'coordinator 验收：npm test 过了' }), makeSnapshot())[2]?.note).toBe('coordinator 在看板上验收');
    expect(evidenceFor(work({ status: 'done', lastDetail: '验收通过' }), makeSnapshot())[2]?.note).toContain('没写是谁');
    expect(evidenceFor(work({ status: 'done', lastDetail: '' }), makeSnapshot())[2]?.note).toBe('已标成完成，不是在看板上验收的');
  });

  it('a code quest the owner accepted on the board is labelled owner, never coordinator (QB-FB-BG)', () => {
    const [claimed, , accepted] = evidenceFor(work({ status: 'done', lastDetail: 'owner 验收：跑过了' }), makeSnapshot());
    expect(claimed?.state).toBe('done');
    expect(accepted?.label).toBe('owner 验收');
    expect(accepted?.state).toBe('done');
    expect(accepted?.note).toContain('你在看板上验收');
    expect(accepted?.note).toContain('技术活本该 coordinator 先核验');
  });

  it('feedback 15: a structured acceptance record is authoritative and shows actor and evidence, never guessed from lastDetail', () => {
    const record = { actor: 'owner' as const, evidenceRefs: [{ kind: 'report' as const, ref: '.work/oc/mod1.md', digest: '0123456789abcdef', attemptId: 'a1' }] };
    const rung = evidenceFor(work({ status: 'done', lastDetail: 'this text is ignored', acceptance: record }), makeSnapshot())[2];
    expect(rung?.label).toBe('owner 验收');
    expect(rung?.state).toBe('done');
    expect(rung?.note).toBe('owner 验收（技术活本该 coordinator 先核验）');
    expect(rung?.refs).toEqual(record.evidenceRefs);
  });

  it('feedback 15: a coordinator acceptance is labelled coordinator, with no mismatch note for technical work', () => {
    const record = { actor: 'coordinator' as const, evidenceRefs: [] };
    const rung = evidenceFor(work({ status: 'done', acceptance: record }), makeSnapshot())[2];
    expect(rung?.label).toBe('coordinator 验收');
    expect(rung?.note).toBe('coordinator 验收');
    expect(rung?.refs).toBeUndefined();
  });

  it('feedback 15: an owner accepting art (the expected verifier) gets no mismatch note', () => {
    const record = { actor: 'owner' as const, evidenceRefs: [] };
    const rung = evidenceFor(work({ kind: 'art', status: 'done', acceptance: record }), makeSnapshot())[2];
    expect(rung?.note).toBe('owner 验收');
  });

  it('the board records every acceptance click as owner, whatever the kind — notes cannot name a coordinator who did not click (QB-FB-BG)', () => {
    expect(boardAcceptanceDetail('')).toBe('owner 验收');
    expect(boardAcceptanceDetail(' 跑过了 npm test ')).toBe('owner 验收：跑过了 npm test');
    expect(recordedAcceptor(boardAcceptanceDetail(''))).toBe('owner');
  });

  it('shows nothing claimed before any dispatch, and no ladder for 你来 quests or reviews', () => {
    expect(evidenceFor(makeQuest({ id: 'p' }), makeSnapshot())[0]?.state).toBe('skipped');
    expect(evidenceFor(makeQuest({ id: 'o', kind: 'owner' }), makeSnapshot())).toEqual([]);
    expect(evidenceFor(makeQuest({ id: 'r', kind: 'review' }), makeSnapshot())).toEqual([]);
  });
});
