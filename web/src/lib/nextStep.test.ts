import { describe, expect, it } from 'vitest';
import type { Reason } from '../api/types';
import { nextStep } from './nextStep';
import { makeAssignee, makeCard, makeQuest, makeSnapshot } from './testFixtures';

const conflict: Reason = { code: 'conflict_running', message: '排队：LOOK-3 正在改同一批文件，一次一个' };
const round = makeAssignee('card-1', { at: '2026-09-13T01:00:00.000Z' });

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
    expect([step.tone, step.action, step.title]).toEqual(['ready', 'assign', '可以派 · 1 张工牌能接']);
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

  it('asks for sign-off on returned work nobody has reviewed', () => {
    const step = nextStep(makeQuest({ id: 'd', status: 'delivered', dispatches: [round] }), makeSnapshot());
    expect([step.who, step.action, step.title]).toEqual(['you', 'sign-off', '等你验收']);
  });

  it('waits on an open review, points to it, and still lets the owner decide', () => {
    const work = makeQuest({ id: 'd', status: 'reviewing', dispatches: [round] });
    const review = makeQuest({
      id: 'REVIEW-d', kind: 'review', parents: ['d'], status: 'dispatched', assignee: makeAssignee('card-2'),
      createdAt: '2026-09-13T02:00:00.000Z',
    });
    const step = nextStep(work, makeSnapshot({ quests: [work, review] }));
    expect([step.who, step.action, step.targetId]).toEqual(['reviewer', 'sign-off', 'REVIEW-d']);
  });

  it('carries a failing verdict into the sign-off step', () => {
    const work = makeQuest({ id: 'd', status: 'reviewing', dispatches: [round] });
    const review = makeQuest({
      id: 'REVIEW-d', kind: 'review', parents: ['d'], status: 'delivered', lastDetail: 'FINDINGS\n1. x\nVERDICT: FAIL',
      createdAt: '2026-09-13T02:00:00.000Z',
    });
    expect(nextStep(work, makeSnapshot({ quests: [work, review] })).title).toBe('等你验收 · 审核不通过');
  });

  it('ignores a review from an earlier round', () => {
    const work = makeQuest({ id: 'd', status: 'delivered', dispatches: [makeAssignee('card-1', { at: '2026-09-13T05:00:00.000Z' })] });
    const old = makeQuest({
      id: 'REVIEW-d', kind: 'review', parents: ['d'], status: 'done', lastDetail: 'VERDICT: PASS', createdAt: '2026-09-13T02:00:00.000Z',
    });
    expect(nextStep(work, makeSnapshot({ quests: [work, old] })).title).toBe('等你验收');
  });

  it('sends a returned review to the work it reviews instead of offering sign-off on the review', () => {
    const review = makeQuest({ id: 'REVIEW-d', kind: 'review', parents: ['d'], status: 'delivered', lastDetail: 'VERDICT: PASS' });
    const step = nextStep(review, makeSnapshot());
    expect([step.title, step.targetId, step.action]).toEqual(['审核结论：通过', 'd', 'none']);
  });

  it('tells an accepted quest from one marked done elsewhere', () => {
    expect(nextStep(makeQuest({ id: 'a', status: 'done', lastDetail: 'owner 验收通过' }), makeSnapshot()).detail).toContain('验收通过');
    expect(nextStep(makeQuest({ id: 'b', status: 'done', lastDetail: '' }), makeSnapshot()).detail).toContain('不是在看板上验收');
  });
});
