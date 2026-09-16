// B2 (revision 4): the review's pre-drop verdict (reviewEligibility, judging reviewRequest.js's
// hypotheticalReview) and the review's actual dispatch-time verdict (dispatcher.assign, once requestReview
// has posted and written the real quest) must always agree. Before this fix, an unrelated held quest with an
// unknown (oversized/unreadable) brief gave the hypothetical review nothing (it is a synthetic object never
// run through withFileSets) but gave the real, posted review its token (withFileSets did not exempt reviews)
// — so a drop that looked fine before the drop could still be refused at dispatch, leaving the review posted
// with its brief already written and nothing to show for the refusal. Reviews hold no files, so this
// revision makes withFileSets never give a review kind a conflict key, real or hypothetical alike.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDispatcher } from '../../src/server/dispatcher.js';
import { QuestStore } from '../../src/core/store.js';
import { withFileSets, MAX_BRIEF_BYTES } from '../../src/core/briefs.js';
import { requestReview, reviewEligibility } from '../../src/core/reviewRequest.js';
import { makeProject, card } from '../helpers.js';

describe('a review is never blocked by an unrelated held quest\'s unknown brief (B2)', () => {
  it('agrees before and after the drop, and never leaves the review posted with its brief written', () => {
    const { config, write } = makeProject();
    const pad = 'x'.repeat(MAX_BRIEF_BYTES + 1024);
    write('docs/briefs/RUN-1-running.md', `# T\n\n## Files you may edit\n- \`src/unrelated.js\`\n${pad}\n`);
    write('docs/briefs/RUN-5-x.md', '# T\n\n## Files you may edit\n- `src/reviewed.js`\n');
    const store = new QuestStore(config);
    const dispatcher = createDispatcher({ config, store, runners: { session: async () => ({ code: 0 }), run: async () => ({ code: 0 }) } });

    store.post({ package: 'RUN-1', brief: 'docs/briefs/RUN-1-running.md', by: 'owner' });
    store.assign('RUN-1', { adventurer: card('codex-luna'), name: 'run1', by: 'owner' });

    store.post({ package: 'RUN-5', brief: 'docs/briefs/RUN-5-x.md', by: 'owner' });
    store.assign('RUN-5', { adventurer: card('oc-deepseek'), name: 'run5', by: 'owner' });
    store.setStatus('RUN-5', 'delivered', { detail: 'done', by: 'owner' });

    // Pre-drop: the same shape questRoutes.js's review route and snapshot.js's reviewEligibility use.
    const quests = withFileSets(config, store.list());
    const parent = quests.find((q) => q.id === 'RUN-5');
    const preDrop = reviewEligibility({
      parent, roster: [card('agy-gemini')], quests, policy: {}, env: { treeLocked: false, laneIds: new Set(['agy']) },
    })['agy-gemini'];
    assert.equal(preDrop.ok, true, 'RUN-1\'s unknown brief must not block a review that touches none of its files');

    const result = requestReview({ config, store, parentId: 'RUN-5', by: 'owner' });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const reviewId = result.body.review.id;

    const assign = dispatcher.assign(reviewId, card('agy-gemini'), 'owner');
    assert.equal(assign.status, 200, 'the dispatch-time verdict must agree with the pre-drop verdict');
    assert.equal(store.get(reviewId).status, 'dispatched', 'a review whose pre-drop check passed must never be left posted');
  });
});
