import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseFileSet } from '../../src/core/briefs.js';
import { activeReviewOf, buildReviewBrief, isReviewable, pickReviewId, reviewEligibility } from '../../src/core/reviewRequest.js';
import { card, makeProject } from '../helpers.js';

const parent = {
  id: 'ARC-2',
  title: '文物开采卡',
  brief: 'docs/briefs/ARC-2-how-do-you-open-it.md',
  kind: 'code',
  status: 'delivered',
  files: ['Assets/Game/Archive/ArtifactDefinition.cs'],
  dispatches: [{ model: 'gemini-3.8-flash-high', lane: 'agy', name: 'arc2' }],
  lastDetail: 'Strictly follow the taxonomy.',
};

describe('review requests', () => {
  it('writes a read-only review brief that points at the original brief and holds no files', () => {
    const { config } = makeProject();
    const text = buildReviewBrief({ reviewId: 'REVIEW-ARC-2', parent, note: '重点看边界情况' });
    assert.match(text, /^REVIEW-ARC-2 — Review of ARC-2/);
    assert.match(text, /docs\/briefs\/ARC-2-how-do-you-open-it\.md/);
    assert.match(text, /Do not edit any file/);
    assert.match(text, /gemini-3\.8-flash-high through the agy lane/);
    assert.match(text, /Strictly follow the taxonomy\./);
    assert.match(text, /重点看边界情况/);
    assert.match(text, /VERDICT: PASS \| PASS WITH FINDINGS \| FAIL/);
    assert.deepEqual(parseFileSet(text, config.briefs.fileListHeading), [], 'a review never queues behind the work it reviews');
  });

  it('says the file list is unknown and why when the parent brief is too large or unreadable, instead of an empty list', () => {
    const text = buildReviewBrief({
      reviewId: 'REVIEW-ARC-2',
      parent: { ...parent, files: [], briefUnknownReason: '文件过大（3.0MB，上限 2MB）' },
    });
    assert.match(text, /委托允许改的文件列表现在不知道：文件过大（3\.0MB，上限 2MB）/);
    assert.doesNotMatch(text, /The files that brief allowed it to change/);
  });

  it('leaves out the owner note and the worker lines when there are none', () => {
    const text = buildReviewBrief({ reviewId: 'REVIEW-ARC-2', parent: { ...parent, dispatches: [], files: [], lastDetail: '' } });
    assert.doesNotMatch(text, /owner's note/);
    assert.doesNotMatch(text, /Done by/);
    assert.doesNotMatch(text, /worker's own summary/);
  });

  it('picks the next free review id that the project pattern accepts', () => {
    const { config } = makeProject();
    assert.equal(pickReviewId(config, 'ARC-2', new Set()), 'REVIEW-ARC-2');
    assert.equal(pickReviewId(config, 'ARC-2', new Set(['REVIEW-ARC-2'])), 'REVIEW-ARC-2B');
    assert.equal(pickReviewId(config, 'LOOK-2F', new Set(['REVIEW-LOOK-2F'])), null, 'no second trailing letter the pattern would refuse');
  });

  it('finds an open review of a quest and ignores closed ones and other quests', () => {
    const quests = [
      { id: 'REVIEW-ARC-2', kind: 'review', parents: ['ARC-2'], status: 'done' },
      { id: 'REVIEW-ARC-2B', kind: 'review', parents: ['ARC-2'], status: 'dispatched' },
      { id: 'FIX-ARC-2', kind: 'code', parents: ['ARC-2'], status: 'posted' },
    ];
    assert.equal(activeReviewOf(quests, 'ARC-2')?.id, 'REVIEW-ARC-2B');
    assert.equal(activeReviewOf(quests.slice(0, 1), 'ARC-2'), null);
  });

  it('reviews returned work only — never a 你来 quest, an open quest, or a review itself', () => {
    assert.equal(isReviewable({ kind: 'code', status: 'delivered' }), true);
    assert.equal(isReviewable({ kind: 'art', status: 'reviewing' }), true);
    assert.equal(isReviewable({ kind: 'code', status: 'posted' }), false);
    assert.equal(isReviewable({ kind: 'owner', status: 'delivered' }), false);
    assert.equal(isReviewable({ kind: 'review', status: 'delivered' }), false);
  });

  it('judges who may review returned work before any review exists', () => {
    const { config } = makeProject();
    const env = { treeLocked: false, laneIds: new Set(Object.keys(config.lanes)) };
    const work = {
      id: 'RUN-4', kind: 'code', status: 'delivered', brief: 'docs/briefs/RUN-4-x.md', parents: [], conflicts: [], allowedLanes: [],
      needsOwner: '', assignee: null, files: [],
      dispatches: [{ adventurerId: 'codex-luna', family: 'gpt-5.6-luna', model: 'gpt-5.6-luna', lane: 'codex', name: 'run4' }],
    };
    const roster = [card('codex-luna'), card('agy-gemini')];
    const verdicts = reviewEligibility({ parent: work, roster, quests: [work], policy: config.policy, env });
    assert.ok(verdicts['codex-luna'].reasons.some((r) => r.code === 'reviewer_coded_parent'), 'the author is kept off');
    assert.equal(verdicts['agy-gemini'].ok, true, JSON.stringify(verdicts['agy-gemini'].reasons));

    const open = { id: 'REVIEW-RUN-4', kind: 'review', parents: ['RUN-4'], status: 'dispatched' };
    const blocked = reviewEligibility({ parent: work, roster, quests: [work, open], policy: config.policy, env });
    assert.ok(Object.values(blocked).every((v) => !v.ok && v.reasons[0].code === 'review_open'), 'one open review at a time');
  });
});
