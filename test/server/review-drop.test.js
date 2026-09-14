import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFixture, tick } from './fixture.js';

let fx;
before(async () => { fx = await startFixture(); });
after(() => fx.close());

const briefFile = () => path.join(fx.project.config.root, 'docs/briefs/REVIEW-RUN-4-review.md');

describe('dropping a card on returned work', () => {
  it('shows who may review it before the drop, and refuses the author without writing anything', async () => {
    assert.equal((await fx.api('/api/quests', 'POST', { package: 'RUN-4', brief: 'docs/briefs/RUN-4-the-way-back.md' })).status, 201);
    assert.equal((await fx.api('/api/quests/RUN-4/assign', 'POST', { adventurer: 'codex-luna' })).status, 200);
    await tick(50);
    assert.equal((await fx.api('/api/quests/RUN-4/status', 'POST', { status: 'delivered', detail: 'done' })).status, 200);

    const before = (await fx.api('/api/quests')).body;
    assert.ok(before.reviewEligibility['RUN-4']['codex-luna'].reasons.some((r) => r.code === 'reviewer_coded_parent'));
    assert.equal(before.reviewEligibility['RUN-4']['agy-gemini'].ok, true, JSON.stringify(before.reviewEligibility['RUN-4']['agy-gemini']));

    const refused = await fx.api('/api/quests/RUN-4/review', 'POST', { adventurer: 'codex-luna' });
    assert.equal(refused.status, 409);
    assert.ok(refused.body.reasons.some((r) => r.code === 'reviewer_coded_parent'));
    assert.equal(fs.existsSync(briefFile()), false, 'a refused drop writes no brief');
    assert.equal((await fx.api('/api/quests')).body.quests.some((q) => q.id === 'REVIEW-RUN-4'), false, 'and posts no review');
  });

  it('posts the review and dispatches it to the dropped card in one step', async () => {
    const dropped = await fx.api('/api/quests/RUN-4/review', 'POST', { adventurer: 'agy-gemini', note: '看边界' });
    assert.equal(dropped.status, 201, dropped.text);
    assert.equal(dropped.body.review.id, 'REVIEW-RUN-4');
    assert.equal(dropped.body.review.status, 'dispatched');
    assert.equal(dropped.body.review.assignee.adventurerId, 'agy-gemini');
    assert.equal(dropped.body.quest.status, 'reviewing');
    assert.match(fs.readFileSync(briefFile(), 'utf8'), /看边界/);

    const after = (await fx.api('/api/quests')).body;
    assert.ok(Object.values(after.reviewEligibility['RUN-4']).every((v) => !v.ok && v.reasons[0].code === 'review_open'));
  });
});
