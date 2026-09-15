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

  it('holds a refused script unresolved instead of freeing it, and a review by the author family is refused', async () => {
    await fx.api('/api/quests', 'POST', { package: 'REVIEW-26', kind: 'review', brief: 'docs/briefs/REVIEW-26-review-run-4.md', parents: 'RUN-4' });
    assert.equal((await fx.api('/api/quests/REVIEW-26/assign', 'POST', { adventurer: 'codex-luna' })).status, 409, 'the author family is refused');
    assert.equal((await fx.api('/api/quests/REVIEW-26/assign', 'POST', { adventurer: 'agy-gemini' })).status, 200);
    await tick();
    const review = (await fx.api('/api/quests')).body.quests.find((q) => q.id === 'REVIEW-26');
    assert.equal(review.status, 'dispatched', 'no evidence the script never started, so the slot is held, not freed');
    assert.equal(review.assignee.name, 'review26', 'the same attempt still holds the quest');
    assert.equal(review.assignee.phase, 'launching');
    assert.equal(review.assignee.unresolved, true);
    assert.match(fx.events().at(-1).detail, /退出码 3/);
  });

  it('adopts once, rules, and only lets dispatch happen through assign', async () => {
    fx.project.write('docs/briefs/LOOK-2F-x.md', 'x');
    await fx.api('/api/quests', 'POST', { package: 'LOOK-2F', brief: 'docs/briefs/LOOK-2F-x.md' });
    const adopted = await fx.api('/api/quests/LOOK-2F/adopt', 'POST', { adventurer: 'agy-gemini', name: 'look2f' });
    assert.deepEqual([adopted.body.quest.status, adopted.body.quest.assignee.adopted], ['dispatched', true]);
    assert.equal((await fx.api('/api/quests/LOOK-2F/adopt', 'POST', { adventurer: 'agy-gemini', name: 'look2f' })).status, 409);
    await fx.api('/api/quests', 'POST', { package: 'ARC-3', kind: 'owner', needsOwner: '三个点选哪个' });
    fx.server.boardStore.createThread({ title: 'ARC-3 appraisal', body: 'which?', author: 'coordinator', tags: ['question'] });
    const mentions = fx.server.boardStore.createThread({ title: 'ARC-3 的贴图参考', body: '顺便一提', author: 'coordinator', tags: ['note'] }).thread.id;
    assert.equal((await fx.api('/api/quests/ARC-3/ruling', 'POST', { text: '第二个' })).body.quest.status, 'posted');
    const answered = fx.server.boardStore.listThreads({ q: 'appraisal' })[0];
    assert.equal(answered.messageCount, 2, 'the ruling is replied on the question thread');
    assert.equal(answered.closed, true, 'answering a question closes it, so 待答 can go down');
    assert.equal(fx.server.boardStore.getThread(mentions).closed, false, 'a thread that only mentions the quest stays open');
    assert.equal((await fx.api('/api/quests/RUN-4/status', 'POST', { status: 'dispatched' })).status, 400);
    assert.equal((await fx.api('/api/quests/RUN-4/status', 'POST', { status: 'done' })).body.quest.status, 'done');
  });

  it('holds a silent worker: refuses re-dispatch until it is released', async () => {
    fx.project.write('docs/briefs/HAZ-1-x.md', 'x');
    await fx.api('/api/quests', 'POST', { package: 'HAZ-1', brief: 'docs/briefs/HAZ-1-x.md' });
    assert.equal((await fx.api('/api/quests/HAZ-1/assign', 'POST', { adventurer: 'codex-luna' })).status, 200);
    await tick();
    assert.equal((await fx.api('/api/quests/HAZ-1/release', 'POST', { detail: 'too early' })).status, 409, 'a running quest is cancelled, not released');
    const stalled = await fx.api('/api/quests/HAZ-1/status', 'POST', { status: 'stalled', detail: 'no output' });
    assert.equal(stalled.body.quest.assignee.name, 'haz1', 'the stall keeps the worker');
    const refused = await fx.api('/api/quests/HAZ-1/assign', 'POST', { adventurer: 'oc-deepseek' });
    assert.equal(refused.status, 409);
    assert.ok(refused.body.reasons.some((r) => r.code === 'worker_unconfirmed'), JSON.stringify(refused.body));
    const snapshot = (await fx.api('/api/quests')).body;
    assert.equal(snapshot.eligibility['HAZ-1']['oc-deepseek'].ok, false, 'the refusal shows before the drop');
    const released = await fx.api('/api/quests/HAZ-1/release', 'POST', { detail: 'process gone' });
    assert.equal(released.status, 200, released.text);
    assert.equal(released.body.quest.assignee, null);
    assert.equal(fx.events().at(-1).event, 'released');
    assert.equal((await fx.api('/api/quests/HAZ-1/assign', 'POST', { adventurer: 'oc-deepseek' })).status, 200);
    await tick();
  });

  it('answers a repeated request key without a second worker, and refuses a stale revision', async () => {
    // A fresh fixture, not the describe-level `fx`: by this point agy-gemini's 2 slots in `fx` are
    // legitimately held (REVIEW-26's now-unresolved-not-freed attempt above, LOOK-2F's adopt below) — that
    // occupancy is the correct behavior under test elsewhere, not a leak to route around here. Isolating this
    // test's own card/adventurer pair keeps its capacity assertions meaningful without touching fixture.js,
    // production capacity, or maxParallel.
    const isoFx = await startFixture();
    try {
      isoFx.project.write('docs/briefs/HAZ-2-x.md', 'x');
      const posted = await isoFx.api('/api/quests', 'POST', { package: 'HAZ-2', brief: 'docs/briefs/HAZ-2-x.md' });
      const revision = posted.body.quest.revision;
      assert.equal(typeof revision, 'number');
      const stale = await isoFx.api('/api/quests/HAZ-2/assign', 'POST', { adventurer: 'agy-gemini', ifRevision: revision - 1 });
      assert.equal(stale.status, 409);
      assert.equal(stale.body.reasons[0].code, 'stale_revision');
      assert.equal((await isoFx.api('/api/quests/HAZ-2/assign', 'POST', { adventurer: 'agy-gemini', requestKey: 'bad key!' })).status, 400);
      const runsBefore = isoFx.calls.length;
      const first = await isoFx.api('/api/quests/HAZ-2/assign', 'POST', { adventurer: 'agy-gemini', requestKey: 'haz2-try1', ifRevision: revision });
      assert.equal(first.status, 200, first.text);
      await tick();
      const again = await isoFx.api('/api/quests/HAZ-2/assign', 'POST', { adventurer: 'agy-gemini', requestKey: 'haz2-try1' });
      assert.equal(again.status, 200);
      assert.equal(again.body.repeated, true);
      assert.equal(again.body.quest.assignee.requestKey, 'haz2-try1');
      assert.equal(isoFx.calls.length, runsBefore + 1, 'one worker started');
      assert.equal((await isoFx.api('/api/quests/HAZ-2/assign', 'POST', { adventurer: 'agy-gemini', requestKey: 'haz2-try2' })).status, 409, 'a new key on a running quest is a normal refusal');
    } finally {
      await isoFx.close();
    }
  });

  it('pages events forward by seq', async () => {
    const all = await fx.api('/api/events?after=0&limit=500');
    assert.equal(all.status, 200);
    const seqs = all.body.events.map((e) => e.seq);
    assert.ok(seqs.length > 3);
    assert.deepEqual(seqs, seqs.map((_, i) => i + 1));
    const page = await fx.api(`/api/events?after=${seqs.length - 2}&limit=1`);
    assert.deepEqual(page.body.events.map((e) => e.seq), [seqs.length - 1]);
    assert.equal(page.body.nextAfter, seqs.length - 1);
    assert.equal((await fx.api('/api/events?after=-1')).status, 400);
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

  it('refuses dispatch and shows server down in eligibility when a lane server is down', async () => {
    const downFx = await startFixture({
      checkLaneServers: async () => [{ id: 'opencode', api: 'http://oc.test', serve: null, up: false }],
    });
    try {
      const posted = await downFx.api('/api/quests', 'POST', { package: 'RUN-4', brief: 'docs/briefs/RUN-4-the-way-back.md' });
      assert.equal(posted.status, 201);
      await downFx.server.refreshLaneHealth();
      const { body } = await downFx.api('/api/quests');
      assert.ok(body.eligibility['RUN-4']['oc-mimo'].reasons.some((r) => r.code === 'lane_server_down'));
      assert.equal(body.eligibility['RUN-4']['codex-luna'].reasons.some((r) => r.code === 'lane_server_down'), false);
      const assigned = await downFx.api('/api/quests/RUN-4/assign', 'POST', { adventurer: 'oc-mimo' });
      assert.equal(assigned.status, 409);
      assert.ok(assigned.body.reasons.some((r) => r.code === 'lane_server_down'));
    } finally {
      await downFx.close();
    }
  });
});
