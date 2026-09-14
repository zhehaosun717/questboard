import { describe, expect, it } from 'vitest';
import { acceptedOnBoard, evidenceFor, parseVerdict } from './evidence';
import { makeAssignee, makeCard, makeQuest, makeSnapshot } from './testFixtures';

describe('acceptedOnBoard', () => {
  it('returns true for legacy and new acceptance details, and false for neither', () => {
    expect(acceptedOnBoard('验收通过')).toBe(true);
    expect(acceptedOnBoard('owner 验收通过')).toBe(true);
    expect(acceptedOnBoard('owner 验收')).toBe(true);
    expect(acceptedOnBoard('owner 验收：已测试')).toBe(true);
    expect(acceptedOnBoard('已完成')).toBe(false);
    expect(acceptedOnBoard('')).toBe(false);
  });
});

describe('parseVerdict', () => {
  it('reads the verdict line the review brief asks for', () => {
    expect(parseVerdict('PASS — scope\nVERDICT: PASS')).toBe('pass');
    expect(parseVerdict('FINDINGS\n1. x\nVERDICT: PASS WITH FINDINGS')).toBe('findings');
    expect(parseVerdict('verdict: fail\n')).toBe('fail');
  });

  it('does not read the echoed template or a missing verdict as a result, and takes the last verdict', () => {
    expect(parseVerdict('VERDICT: PASS | PASS WITH FINDINGS | FAIL')).toBe('unknown');
    expect(parseVerdict('looks fine to me')).toBe('unknown');
    expect(parseVerdict('VERDICT: PASS\nre-checked the tests\nVERDICT: FAIL')).toBe('fail');
  });
});

describe('evidenceFor', () => {
  const work = (overrides = {}) =>
    makeQuest({ id: 'd', status: 'delivered', dispatches: [makeAssignee('card-1', { at: '2026-09-13T01:00:00.000Z' })], ...overrides });

  it('says the worker only claims the work until someone checks it', () => {
    const [claimed, reviewed, accepted] = evidenceFor(work(), makeSnapshot({ roster: [makeCard('card-1', { name: 'Luna' })] }));
    expect(claimed?.state).toBe('done');
    expect(claimed?.note).toContain('Luna');
    expect(claimed?.note).toContain('不算核实');
    expect(reviewed?.state).toBe('skipped');
    expect([accepted?.state, accepted?.note]).toEqual(['pending', '等你验收']);
  });

  it('marks a failing review as bad, a missing verdict as unknown, and a running review as pending', () => {
    const review = (status: 'delivered' | 'dispatched', lastDetail: string) =>
      makeQuest({ id: 'REVIEW-d', kind: 'review', parents: ['d'], status, lastDetail, createdAt: '2026-09-13T02:00:00.000Z', assignee: makeAssignee('card-2') });
    const rung = (r: ReturnType<typeof review>) => evidenceFor(work(), makeSnapshot({ quests: [work(), r] }))[1];
    expect(rung(review('delivered', 'VERDICT: FAIL'))).toMatchObject({ state: 'bad', note: 'REVIEW-d：复核不通过' });
    expect(rung(review('delivered', 'no verdict here'))?.state).toBe('pending');
    expect(rung(review('dispatched', ''))?.note).toBe('REVIEW-d 复核中');
  });

  it('ignores a review from before the latest dispatch', () => {
    const old = makeQuest({ id: 'REVIEW-d', kind: 'review', parents: ['d'], status: 'done', lastDetail: 'VERDICT: PASS', createdAt: '2026-09-13T00:30:00.000Z' });
    expect(evidenceFor(work(), makeSnapshot({ quests: [work(), old] }))[1]?.state).toBe('skipped');
  });

  it('tells an owner acceptance on the board from a quest marked done elsewhere', () => {
    expect(evidenceFor(work({ status: 'done', lastDetail: 'owner 验收通过' }), makeSnapshot())[2]?.note).toBe('你在看板上验收');
    expect(evidenceFor(work({ status: 'done', lastDetail: 'owner 验收' }), makeSnapshot())[2]?.note).toBe('你在看板上验收');
    expect(evidenceFor(work({ status: 'done', lastDetail: '' }), makeSnapshot())[2]?.note).toBe('已标成完成，不是在看板上验收的');
  });

  it('shows nothing claimed before any dispatch, and no ladder for 你来 quests or reviews', () => {
    expect(evidenceFor(makeQuest({ id: 'p' }), makeSnapshot())[0]?.state).toBe('skipped');
    expect(evidenceFor(makeQuest({ id: 'o', kind: 'owner' }), makeSnapshot())).toEqual([]);
    expect(evidenceFor(makeQuest({ id: 'r', kind: 'review' }), makeSnapshot())).toEqual([]);
  });
});
