import { describe, expect, it } from 'vitest';
import {
  acceptedOnBoard,
  boardAcceptanceDetail,
  evidenceFor,
  parseVerdict,
  recordedAcceptor,
} from './evidence';
import { makeAssignee, makeCard, makeQuest, makeSnapshot } from './testFixtures';

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

  it('marks a failing review as bad, a missing verdict as pending with no conclusion, and a running review as pending', () => {
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
