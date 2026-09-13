import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFixture, tick } from './fixture.js';

let fx;
before(async () => { fx = await startFixture({ runResult: (step) => (step.command[1] === 'review26' ? { code: 3, error: 'refused' } : { code: 0 }) }); });
after(() => fx.close());

describe('pages', () => {
  it('serves the board with a strict CSP, its assets, the message board, history and review pages', async () => {
    const page = await fx.api('/');
    assert.match(page.text, /悬赏板/);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self';/);
    assert.equal((await fx.api('/assets/quests.app.js')).status, 200);
    assert.equal((await fx.api('/assets/..%2Fpackage.json')).status, 404);
    assert.equal((await fx.api('/board')).status, 200);
    assert.equal((await fx.api('/history')).status, 200);
    const review = await fx.api('/review/robot/review_robot8.html');
    assert.match(review.headers.get('content-security-policy'), /connect-src http:\/\/127\.0\.0\.1:\*\/api\/annotations/);
    assert.equal((await fx.api('/review/..%2F..%2Fquestboard.config.json')).status, 404);
  });
});

describe('quest API', () => {
  it('posts and returns a snapshot with eligibility, unposted briefs and review progress', async () => {
    assert.equal((await fx.api('/api/quests', 'POST', { package: 'RUN-4', brief: 'docs/briefs/RUN-4-the-way-back.md', allowedLanes: 'codex' })).status, 201);
    const { body } = await fx.api('/api/quests');
    assert.equal(body.project.name, 'Test Game');
    assert.equal(body.eligibility['RUN-4']['codex-luna'].ok, true);
    assert.ok(body.eligibility['RUN-4']['agy-gemini'].reasons.some((r) => r.code === 'lane_not_allowed'));
    assert.ok(body.unpostedBriefs.some((b) => b.package === 'RUN-9'));
    assert.deepEqual([body.reviewPages[0].page, body.reviewPages[0].total], ['robot8', 2]);
  });

  it('refuses writes a foreign page could send, before running anything', async () => {
    assert.equal((await fx.api('/api/quests/RUN-4/assign', 'POST', { adventurer: 'codex-luna' }, { 'content-type': 'text/plain' })).status, 403);
    assert.equal((await fx.api('/api/quests/RUN-4/assign', 'POST', { adventurer: 'codex-luna' }, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await fx.api('/api/roster/codex-astra/status', 'POST', { status: 'available' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal(fx.calls.length, 0);
  });

  it('writes a card status record and shows why and since when; refuses that card', async () => {
    const set = await fx.api('/api/roster/codex-astra/status', 'POST', { status: 'paused', reason: '费用' });
    assert.equal(set.body.status.status, 'paused');
    const astra = (await fx.api('/api/roster')).body.adventurers.find((a) => a.id === 'codex-astra');
    assert.deepEqual([astra.status, astra.statusReason, astra.statusSetBy], ['paused', '费用', 'owner']);
    assert.ok(astra.statusSince);
    const refused = await fx.api('/api/quests/RUN-4/assign', 'POST', { adventurer: 'codex-astra' });
    assert.equal(refused.status, 409);
    assert.ok(refused.body.reasons.some((r) => r.code === 'adventurer_paused'));
    assert.equal((await fx.api('/api/roster/nobody/status', 'POST', { status: 'paused' })).status, 404);
  });

  it('dispatches from the lane template: assigned, then dispatched once the script started', async () => {
    const assigned = await fx.api('/api/quests/RUN-4/assign', 'POST', { adventurer: 'codex-luna' });
    assert.equal(assigned.status, 200);
    await tick();
    assert.deepEqual(fx.calls.at(-1).command, ['tools/codex-run.sh', 'run4', 'docs/briefs/RUN-4-the-way-back.md', 'gpt-5.6-luna', 'high']);
    assert.deepEqual(fx.events().slice(-2).map((e) => e.event), ['assigned', 'dispatched']);
  });

  it('fails a refused script, and a review by the author family is refused', async () => {
    await fx.api('/api/quests', 'POST', { package: 'REVIEW-26', kind: 'review', brief: 'docs/briefs/REVIEW-26-review-run-4.md', parents: 'RUN-4' });
    assert.equal((await fx.api('/api/quests/REVIEW-26/assign', 'POST', { adventurer: 'codex-luna' })).status, 409);
    assert.equal((await fx.api('/api/quests/REVIEW-26/assign', 'POST', { adventurer: 'agy-gemini' })).status, 200);
    await tick();
    const review = (await fx.api('/api/quests')).body.quests.find((q) => q.id === 'REVIEW-26');
    assert.equal(review.status, 'failed');
    assert.match(review.lastDetail, /退出码 3/);
  });

  it('adopts once, rules, and only lets dispatch happen through assign', async () => {
    fx.project.write('docs/briefs/LOOK-2F-x.md', 'x');
    await fx.api('/api/quests', 'POST', { package: 'LOOK-2F', brief: 'docs/briefs/LOOK-2F-x.md' });
    const adopted = await fx.api('/api/quests/LOOK-2F/adopt', 'POST', { adventurer: 'agy-gemini', name: 'look2f' });
    assert.deepEqual([adopted.body.quest.status, adopted.body.quest.assignee.adopted], ['dispatched', true]);
    assert.equal((await fx.api('/api/quests/LOOK-2F/adopt', 'POST', { adventurer: 'agy-gemini', name: 'look2f' })).status, 409);
    await fx.api('/api/quests', 'POST', { package: 'ARC-3', kind: 'owner', needsOwner: '三个点选哪个' });
    fx.server.boardStore.createThread({ title: 'ARC-3 appraisal', body: 'which?', author: 'coordinator', tags: ['question'] });
    assert.equal((await fx.api('/api/quests/ARC-3/ruling', 'POST', { text: '第二个' })).body.quest.status, 'posted');
    assert.match(fx.server.boardStore.listThreads({ q: 'ARC-3' })[0].messageCount === 2 ? 'ok' : 'missing', /ok/);
    assert.equal((await fx.api('/api/quests/RUN-4/status', 'POST', { status: 'dispatched' })).status, 400);
    assert.equal((await fx.api('/api/quests/RUN-4/status', 'POST', { status: 'done' })).body.quest.status, 'done');
  });

  it('applies lane results: API deliveries are written first, bounces heal instead of being stored', async () => {
    fx.project.write('docs/briefs/MOD-1-x.md', 'x');
    await fx.api('/api/quests', 'POST', { package: 'MOD-1', brief: 'docs/briefs/MOD-1-x.md' });
    await fx.api('/api/quests/MOD-1/assign', 'POST', { adventurer: 'oc-mimo' });
    await tick();
    const now = new Date().toISOString();
    fx.holder.lanes = { packages: [
      { name: 'mod1', package: 'MOD-1', lane: 'opencode', model: 'xiaomi/mimo-v2.5-pro', state: 'delivered', dispatchedAt: now },
      { name: 'look2f', package: 'LOOK-2F', lane: 'agy', model: 'gemini-3.8-flash-high', state: 'bounced', bounceUntil: '1:54 PM', dispatchedAt: now },
    ], laneLimits: {} };
    fx.server.questRoutes.applyLanes();
    await tick();
    const { body } = await fx.api('/api/quests');
    const mod1 = body.quests.find((q) => q.id === 'MOD-1');
    assert.equal(mod1.status, 'delivered');
    assert.match(mod1.lastDetail, /交付已写入 \.work\/oc\/mod1\.md/);
    assert.equal(body.quests.find((q) => q.id === 'LOOK-2F').status, 'bounced');
    const gemini = body.roster.find((a) => a.id === 'agy-gemini');
    assert.equal(gemini.status, 'limited');
    assert.equal(fx.server.statusLog.current().has('agy-gemini'), false, 'a bounce is not written into the status log');
  });
});
