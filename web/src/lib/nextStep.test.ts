import { describe, expect, it } from 'vitest';
import type { Quest, Reason } from '../api/types';
import { nextStep, WHO_LABEL } from './nextStep';
import { makeAssignee, makeCard, makeQuest, makeSnapshot } from './testFixtures';

const conflict: Reason = { code: 'conflict_running', message: '排队：LOOK-3 正在改同一批文件，一次一个' };
const round = makeAssignee('card-1', { at: '2026-09-13T01:00:00.000Z' });

const codeWork = (overrides: Partial<Quest> = {}): Quest => makeQuest({ id: 'd', kind: 'code', ...overrides });

describe('nextStep', () => {
  it('asks the owner to do a 你来 quest themselves', () => {
    const step = nextStep(makeQuest({ id: 'o', kind: 'owner' }), makeSnapshot());
    expect([step.who, step.action, step.title]).toEqual(['you', 'owner-task', '等你亲自做']);
  });

  it('asks the owner to decide an open question, quoting it', () => {
    const step = nextStep(makeQuest({ id: 'q', needsOwner: '选 A 还是 B？' }), makeSnapshot());
    expect([step.title, step.action]).toEqual(['等你拍板', 'owner-task']);
    expect(step.detail).toContain('选 A 还是 B？');
    expect(nextStep(makeQuest({ id: 'o', kind: 'owner', status: 'needs_owner' }), makeSnapshot()).title).toBe('等你拍板');
  });

  it('offers dispatch with the number of cards that can take the quest', () => {
    const snap = makeSnapshot({
      eligibility: { p: { 'card-1': { ok: true, reasons: [] }, 'card-2': { ok: false, reasons: [conflict] } } },
    });
    const step = nextStep(makeQuest({ id: 'p' }), snap);
    expect([step.tone, step.action, step.title]).toEqual(['ready', 'assign', '可以派 · 1 个冒险者能接']);
  });

  it('says once why nobody can take an open quest', () => {
    const snap = makeSnapshot({ eligibility: { p: { 'card-1': { ok: false, reasons: [conflict] } } } });
    const step = nextStep(makeQuest({ id: 'p' }), snap);
    expect([step.tone, step.title, step.detail]).toEqual(['waiting', '暂时派不了', conflict.message]);
  });

  it('names the card that is working', () => {
    const snap = makeSnapshot({ roster: [makeCard('card-1', { name: 'Luna' })] });
    const step = nextStep(makeQuest({ id: 'r', status: 'dispatched', assignee: makeAssignee('card-1') }), snap);
    expect([step.who, step.title, step.action]).toEqual(['adventurer', 'Luna 在做', 'none']);
  });

  it('asks the owner to confirm a silent worker before releasing it', () => {
    const step = nextStep(makeQuest({ id: 's', status: 'stalled', assignee: makeAssignee('card-1') }), makeSnapshot());
    expect([step.who, step.action]).toEqual(['you', 'release']);
  });

  it('sends returned code to the coordinator, not to the owner', () => {
    const step = nextStep(codeWork({ status: 'delivered', dispatches: [round] }), makeSnapshot());
    expect([step.who, step.action, step.title]).toEqual(['coordinator', 'sign-off', '等 coordinator 核验']);
    expect(step.detail).toContain('把名册里的冒险者拖到这张委托上');
  });

  it('sends returned tool work to the coordinator too', () => {
    const step = nextStep(makeQuest({ id: 't', kind: 'tool', status: 'reviewing', dispatches: [round] }), makeSnapshot());
    expect([step.who, step.action]).toEqual(['coordinator', 'sign-off']);
  });

  it('keeps returned art as the owner sign-off it was', () => {
    const step = nextStep(makeQuest({ id: 'a', kind: 'art', status: 'delivered', dispatches: [round] }), makeSnapshot());
    expect([step.who, step.action, step.title]).toEqual(['you', 'sign-off', '等你验收']);
  });

  it('waits on an open review without pretending the owner must act', () => {
    const work = codeWork({ status: 'reviewing', dispatches: [round] });
    const review = makeQuest({
      id: 'REVIEW-d', kind: 'review', parents: ['d'], status: 'dispatched', assignee: makeAssignee('card-2'),
      createdAt: '2026-09-13T02:00:00.000Z',
    });
    const step = nextStep(work, makeSnapshot({ quests: [work, review] }));
    expect([step.who, step.action, step.targetId]).toEqual(['reviewer', 'sign-off', 'REVIEW-d']);
    expect(step.detail).toContain('由 coordinator 核验');
    expect(step.detail).toContain('不等于验收');
  });

  it('carries a failing verdict into the coordinator sign-off, not the owner inbox', () => {
    const work = codeWork({ status: 'reviewing', dispatches: [round] });
    const review = makeQuest({
      id: 'REVIEW-d', kind: 'review', parents: ['d'], status: 'delivered', lastDetail: 'FINDINGS\n1. x\nVERDICT: FAIL',
      createdAt: '2026-09-13T02:00:00.000Z',
    });
    const step = nextStep(work, makeSnapshot({ quests: [work, review] }));
    // No captured report on the review, so the tail-parsed verdict is labelled unverified (B2, round 2).
    expect([step.who, step.action, step.title]).toEqual(['coordinator', 'sign-off', '等 coordinator 验收 · 复核不通过（未经核验）']);
    expect(step.detail).toContain('不代表编译或测试跑过');
  });

  it('keeps a reported verdict on art as the owner request it is', () => {
    const work = makeQuest({ id: 'a', kind: 'art', status: 'reviewing', dispatches: [round] });
    const review = makeQuest({
      id: 'REVIEW-a', kind: 'review', parents: ['a'], status: 'delivered', lastDetail: 'VERDICT: PASS',
      createdAt: '2026-09-13T02:00:00.000Z',
    });
    const step = nextStep(work, makeSnapshot({ quests: [work, review] }));
    expect([step.who, step.title]).toEqual(['you', '等你验收 · 复核通过（未经核验）']);
  });

  it('B2 (round 2): a verified verdict from the review’s captured report needs no 未经核验 label', () => {
    const work = codeWork({ status: 'reviewing', dispatches: [round] });
    const review = makeQuest({
      id: 'REVIEW-d', kind: 'review', parents: ['d'], status: 'delivered', lastDetail: 'VERDICT: FAIL',
      createdAt: '2026-09-13T02:00:00.000Z',
      report: {
        source: 'delivery', ref: 'delivery/x.md', digest: 'abc', bytes: 10, sizeBytes: 10, truncated: false,
        capturedAt: '2026-09-13T02:30:00.000Z', attemptId: 'att-1', verdict: 'PASS',
      },
    });
    const step = nextStep(work, makeSnapshot({ quests: [work, review] }));
    expect(step.title).toBe('等 coordinator 验收 · 复核通过');
    expect(step.title).not.toContain('未经核验');
  });

  it('ignores a review from an earlier round', () => {
    const work = codeWork({ status: 'delivered', dispatches: [makeAssignee('card-1', { at: '2026-09-13T05:00:00.000Z' })] });
    const old = makeQuest({
      id: 'REVIEW-d', kind: 'review', parents: ['d'], status: 'done', lastDetail: 'VERDICT: PASS', createdAt: '2026-09-13T02:00:00.000Z',
    });
    expect(nextStep(work, makeSnapshot({ quests: [work, old] })).title).toBe('等 coordinator 核验');
  });

  it('sends a returned review on code to the coordinator instead of offering sign-off on the review', () => {
    const parent = codeWork({ id: 'd' });
    const review = makeQuest({ id: 'REVIEW-d', kind: 'review', parents: ['d'], status: 'delivered', lastDetail: 'VERDICT: PASS' });
    const step = nextStep(review, makeSnapshot({ quests: [parent, review] }));
    expect([step.who, step.title, step.targetId, step.action]).toEqual(['coordinator', '复核结论：通过（未经核验）', 'd', 'none']);
    expect(step.detail).toContain('不用你验收');
  });

  it('keeps a returned review on art pointing the owner at the work it reviews', () => {
    const parent = makeQuest({ id: 'a', kind: 'art' });
    const review = makeQuest({ id: 'REVIEW-a', kind: 'review', parents: ['a'], status: 'delivered', lastDetail: 'VERDICT: PASS WITH FINDINGS' });
    const step = nextStep(review, makeSnapshot({ quests: [parent, review] }));
    expect([step.who, step.title, step.targetId]).toEqual(['you', '复核结论：通过但有问题（未经核验）', 'a']);
    expect(step.detail).toContain('决定验收还是退回');
  });

  it('says so plainly when a returned review has no parent to judge it against', () => {
    const review = makeQuest({ id: 'REVIEW-x', kind: 'review', parents: ['gone'], status: 'delivered', lastDetail: 'VERDICT: PASS' });
    const step = nextStep(review, makeSnapshot());
    expect(step.who).toBe('nobody');
    expect(step.title).toBe('复核结论：通过（未经核验）');
    expect(step.detail).toContain('不在看板上');
    expect(step.detail).toContain('找 coordinator 核实');
    expect(step.targetId).toBeUndefined();
  });

  it('B2 (round 2): a review’s own headline shows the verified verdict with no unverified label', () => {
    const parent = codeWork({ id: 'd' });
    const review = makeQuest({
      id: 'REVIEW-d', kind: 'review', parents: ['d'], status: 'delivered', lastDetail: 'VERDICT: PASS',
      report: {
        source: 'summary', ref: 'out/x.out', digest: 'abc', bytes: 10, sizeBytes: 20, truncated: true,
        capturedAt: '2026-09-13T02:30:00.000Z', attemptId: 'att-1', verdict: 'unknown', verdictReason: '报告超过 2 MB，只读了前 10 字节，没有读到结尾，给不出最终结论',
      },
    });
    const step = nextStep(review, makeSnapshot({ quests: [parent, review] }));
    // R2-2: a verified unknown reads 结论未识别, not the tail-parse fallback's 没写结论.
    expect(step.title).toBe('复核结论：结论未识别');
    expect(step.title).not.toContain('未经核验');
    expect(step.title).not.toContain('通过');
  });

  it('lets an explicit question outrank the review kind', () => {
    const review = makeQuest({ id: 'REVIEW-d', kind: 'review', parents: ['d'], status: 'delivered', lastDetail: 'VERDICT: PASS', needsOwner: '这份代码要不要直接上线？' });
    const step = nextStep(review, makeSnapshot());
    expect([step.who, step.title, step.action]).toEqual(['you', '等你拍板', 'owner-task']);
  });

  it('tells the owner what a 待派 technical quest will do when it returns', () => {
    const snap = makeSnapshot({ eligibility: { d: { 'card-1': { ok: true, reasons: [] } } } });
    const step = nextStep(codeWork({ id: 'd' }), snap);
    expect(step.detail).toContain('由 coordinator 核验');
    expect(step.detail).not.toContain('等你验收');
  });

  it('keeps the reviewer-selection path open on returned technical work: same drag, same controls, verdict first', () => {
    const work = codeWork({ id: 'd', status: 'reviewing', dispatches: [round] });
    const review = makeQuest({
      id: 'REVIEW-d', kind: 'review', parents: ['d'], status: 'dispatched', assignee: makeAssignee('card-2'),
      createdAt: '2026-09-13T02:00:00.000Z',
    });
    const snap = makeSnapshot({
      quests: [work, review],
      reviewEligibility: { d: { 'card-2': { ok: true, reasons: [] } } },
    });
    const step = nextStep(work, snap);
    // action stays 'sign-off': the dossier keeps its controls (accept, send back, pick reviewers) for the
    // coordinator to act on; selecting a reviewer is a request to look, never an acceptance.
    expect([step.who, step.action, step.targetId]).toEqual(['reviewer', 'sign-off', 'REVIEW-d']);
  });

  it('labels who each step waits on, including the coordinator', () => {
    expect(WHO_LABEL.coordinator).toBe('等 coordinator');
    expect(WHO_LABEL.you).toBe('等你');
  });

  it('tells an accepted quest from one marked done elsewhere', () => {
    expect(nextStep(codeWork({ id: 'a', status: 'done', lastDetail: 'owner 验收通过' }), makeSnapshot()).detail).toContain('你在看板上验收了');
    expect(nextStep(codeWork({ id: 'a', status: 'done', lastDetail: 'coordinator 验收：npm test 过了' }), makeSnapshot()).detail).toContain('coordinator 在看板上验收了');
    expect(nextStep(codeWork({ id: 'a', status: 'done', lastDetail: '验收通过' }), makeSnapshot()).detail).toContain('没写是谁');
    expect(nextStep(codeWork({ id: 'b', status: 'done', lastDetail: '' }), makeSnapshot()).detail).toContain('不是在看板上验收');
  });
});
