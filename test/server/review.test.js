import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFixture, tick } from './fixture.js';

let fx;
before(async () => { fx = await startFixture(); });
after(() => fx.close());

describe('model review of returned work', () => {
  it('refuses a review for work that has not come back', async () => {
    assert.equal((await fx.api('/api/quests', 'POST', { package: 'RUN-4', brief: 'docs/briefs/RUN-4-the-way-back.md' })).status, 201);
    const early = await fx.api('/api/quests/RUN-4/review', 'POST', { note: '' });
    assert.equal(early.status, 409);
    assert.match(early.body.error, /只有已交付或审核中/);
    assert.equal((await fx.api('/api/quests/NOPE-1/review', 'POST', {})).status, 404);
  });

  it('writes the brief, posts a review quest, moves the work to reviewing and keeps its summary', async () => {
    assert.equal((await fx.api('/api/quests/RUN-4/assign', 'POST', { adventurer: 'codex-luna' })).status, 200);
    await tick(50);
    assert.equal((await fx.api('/api/quests/RUN-4/status', 'POST', { status: 'delivered', detail: 'the worker summary', ack: true })).status, 200);

    const requested = await fx.api('/api/quests/RUN-4/review', 'POST', { note: '重点看边界' });
    assert.equal(requested.status, 201, requested.text);
    const { review, quest } = requested.body;
    assert.deepEqual([review.id, review.kind, review.parents, review.brief], ['REVIEW-RUN-4', 'review', ['RUN-4'], 'docs/briefs/REVIEW-RUN-4-review.md']);
    assert.equal(quest.status, 'reviewing');
    assert.equal(quest.lastDetail, 'the worker summary', 'moving to reviewing must not erase what the receipt shows');

    const brief = fs.readFileSync(path.join(fx.project.config.root, review.brief), 'utf8');
    assert.match(brief, /docs\/briefs\/RUN-4-the-way-back\.md/);
    assert.match(brief, /重点看边界/);
    assert.ok(fx.events().some((e) => e.event === 'review_posted' && e.package === 'REVIEW-RUN-4'));

    const snapshot = (await fx.api('/api/quests')).body;
    assert.ok(
      snapshot.eligibility['REVIEW-RUN-4']['codex-luna'].reasons.some((r) => r.code === 'reviewer_coded_parent'),
      'the model that wrote the work is kept off its review',
    );
  });

  it('refuses a second review while one is open, without writing another brief', async () => {
    const again = await fx.api('/api/quests/RUN-4/review', 'POST', {});
    assert.equal(again.status, 409);
    assert.equal(again.body.review.id, 'REVIEW-RUN-4');
    assert.equal(fs.existsSync(path.join(fx.project.config.root, 'docs/briefs/REVIEW-RUN-4B-review.md')), false);
  });
});
