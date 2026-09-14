import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseFileSet } from '../../src/core/briefs.js';
import { activeReviewOf, buildReviewBrief, pickReviewId } from '../../src/core/reviewRequest.js';
import { makeProject } from '../helpers.js';

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
});
