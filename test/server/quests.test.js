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
    assert.equal((await fx.api('/api/quests/RUN-4/status', 'POST', { status: 'done', detail: 'owner confirmed', ack: true })).body.quest.status, 'done');
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
    const released = await fx.api('/api/quests/HAZ-1/release', 'POST', { detail: 'process gone', ack: true });
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

  it('applies lane results: exact bounces limit one card, unknown bounces stay advisory', async () => {
    fx.project.write('docs/briefs/MOD-1-x.md', 'x');
    await fx.api('/api/quests', 'POST', { package: 'MOD-1', brief: 'docs/briefs/MOD-1-x.md' });
    await fx.api('/api/quests/MOD-1/assign', 'POST', { adventurer: 'oc-mimo' });
    await tick();
    const now = new Date().toISOString();
    fx.holder.lanes = { packages: [
      { name: 'mod1', package: 'MOD-1', lane: 'opencode', model: 'xiaomi/mimo-v2.5-pro', state: 'delivered', dispatchedAt: now },
      { name: 'look2f', package: 'LOOK-2F', lane: 'agy', model: 'gemini-3.8-flash-high', adventurerId: 'agy-gemini', state: 'bounced', bounceUntil: '1:54 PM', dispatchedAt: now },
      { name: 'look3', package: 'LOOK-3', lane: 'opencode', model: 'xiaomi/mimo-v2.5-pro', state: 'bounced', bounceUntil: '1:54 PM', dispatchedAt: now },
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
    assert.ok(gemini.derived && gemini.derived.reason, 'the exact bounce exposes its derived reason');
    assert.equal(fx.server.statusLog.current().has('agy-gemini'), false, 'a bounce is not written into the status log');
    const mimo = body.roster.find((a) => a.id === 'oc-mimo');
    assert.equal(mimo.status, 'available', 'an unknown-identity bounce does not limit another card');
    assert.ok(mimo.laneDiagnostics?.some((entry) => entry.code === 'quota_identity_unknown'), 'the unknown bounce is an advisory diagnostic');
  });

  it('hides acknowledged or unattributable lane limits from /api/lanes and the snapshot alike', async () => {
    const laneFx = await startFixture();
    try {
      const bouncedAt = new Date(Date.now() - 60000).toISOString();
      const luna = { adventurerId: 'codex-luna', at: bouncedAt, since: bouncedAt, until: null, resetsAt: null, name: 'luna-run' };
      const ghost = { adventurerId: 'ghost-card', at: bouncedAt, since: bouncedAt, until: null, resetsAt: null, name: 'ghost-run' };
      laneFx.holder.lanes = { packages: [], laneLimits: {
        codex: { ...luna, cards: { 'codex-luna': luna } },
        agy: { ...ghost, cards: { 'ghost-card': ghost } },
      } };
      const before = await laneFx.api('/api/lanes');
      assert.equal(before.status, 200);
      assert.ok(before.body.laneLimits.codex, 'a limit on a real, still-limited card stays visible');
      assert.equal(before.body.laneLimits.agy, undefined, 'a limit on a card outside the roster never shows');

      const set = await laneFx.api('/api/roster/codex-luna/status', 'POST', { status: 'available', reason: '\u989d\u5ea6\u5df2\u786e\u8ba4' });
      assert.equal(set.status, 200);
      const afterLanes = await laneFx.api('/api/lanes');
      assert.equal(afterLanes.body.laneLimits.codex, undefined, 'the owner acknowledgement clears the lane header here too');

      const { body } = await laneFx.api('/api/quests');
      assert.equal(body.laneLimits.codex, undefined);
      assert.equal(body.laneLimits.agy, undefined);
      assert.equal(body.laneEvidence.codex.cards['codex-luna'].cleared, 'owner');
      assert.equal(body.laneEvidence.agy.cards['ghost-card'].cleared, 'no_card');
    } finally {
      await laneFx.close();
    }
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

describe('quest metadata', () => {
  let mfx;
  before(async () => {
    mfx = await startFixture();
    mfx.project.write('docs/briefs/META-1-x.md', 'META-1 — x');
    mfx.project.write('docs/briefs/META-2-x.md', 'META-2 — x');
  });
  after(() => mfx.close());

  it('corrects a posted quest\'s fields, leaving untouched ones exactly as they were, with the actor recorded', async () => {
    const posted = await mfx.api('/api/quests', 'POST', { package: 'META-1', brief: 'docs/briefs/META-1-x.md', title: 'old title', needsOwner: 'pick one' });
    const revision = posted.body.quest.revision;
    const updated = await mfx.api('/api/quests/META-1/metadata', 'POST', { title: 'new title', by: 'owner-zh' });
    assert.equal(updated.status, 200, updated.text);
    assert.equal(updated.body.quest.title, 'new title');
    assert.equal(updated.body.quest.needsOwner, 'pick one', 'a field never mentioned in this update is untouched');
    assert.equal(updated.body.quest.revision, revision + 1);
    const last = mfx.events().at(-1);
    assert.equal(last.event, 'metadata_update');
    assert.equal(last.by, 'owner-zh');
    assert.deepEqual(last.changedFields, ['title']);
  });

  it('rejects a validation failure (bad field) with 400 and leaves revision/events unchanged', async () => {
    const posted = await mfx.api('/api/quests', 'POST', { package: 'META-2', brief: 'docs/briefs/META-2-x.md' });
    const before = mfx.events().length;
    const bad = await mfx.api('/api/quests/META-2/metadata', 'POST', { parents: 'GHOST-1' });
    assert.equal(bad.status, 400, bad.text);
    assert.match(bad.body.fields.parents, /GHOST-1 not found/);
    const unchanged = await mfx.api('/api/quests/META-2');
    assert.equal(unchanged.body.quest.revision, posted.body.quest.revision, 'an invalid candidate never bumps the revision');
    assert.equal(mfx.events().length, before, 'and never appends an event');
  });

  it('refuses with 409 while a worker holds the quest\'s slot, and again after it stalls with the worker still assigned', async () => {
    await mfx.api('/api/quests/META-2/assign', 'POST', { adventurer: 'codex-luna' });
    await tick();
    const busy = await mfx.api('/api/quests/META-2/metadata', 'POST', { title: 'nope' });
    assert.equal(busy.status, 409, busy.text);
    assert.equal(busy.body.reasons[0].code, 'holds_slot');
    await mfx.api('/api/quests/META-2/status', 'POST', { status: 'stalled', detail: 'no output' });
    const stillBusy = await mfx.api('/api/quests/META-2/metadata', 'POST', { title: 'nope' });
    assert.equal(stillBusy.status, 409);
    await mfx.api('/api/quests/META-2/release', 'POST', { detail: 'confirmed gone', ack: true });
  });

  it('refuses a stale ifRevision with 409 and the current revision, then accepts once re-read', async () => {
    const current = (await mfx.api('/api/quests/META-2')).body.quest.revision;
    const stale = await mfx.api('/api/quests/META-2/metadata', 'POST', { title: 'x', ifRevision: current - 1 });
    assert.equal(stale.status, 409, stale.text);
    assert.equal(stale.body.revision, current);
    const fresh = await mfx.api('/api/quests/META-2/metadata', 'POST', { title: 'x', ifRevision: current });
    assert.equal(fresh.status, 200, fresh.text);
  });

  it('404s a metadata update for a quest that does not exist', async () => {
    assert.equal((await mfx.api('/api/quests/NOPE-1/metadata', 'POST', { title: 'x' })).status, 404);
  });

  it('rejects a privileged or unknown field with a 400 naming it, applying nothing at all', async () => {
    const posted = await mfx.api('/api/quests', 'POST', { package: 'META-3', brief: 'docs/briefs/META-2-x.md', title: 'kept' });
    const before = mfx.events().length;
    const bad = await mfx.api('/api/quests/META-3/metadata', 'POST', { title: 'new', status: 'done', kind: 'owner' });
    assert.equal(bad.status, 400, bad.text);
    assert.match(bad.body.fields.status, /unknown field/);
    assert.match(bad.body.fields.kind, /unknown field/);
    const unchanged = await mfx.api('/api/quests/META-3');
    assert.equal(unchanged.body.quest.title, 'kept');
    assert.equal(unchanged.body.quest.revision, posted.body.quest.revision);
    assert.equal(mfx.events().length, before);
  });
});

describe('review ancestry protection', () => {
  let mfx;
  before(async () => {
    mfx = await startFixture();
    mfx.project.write('docs/briefs/RA-4-x.md', 'RA-4 — x');
    mfx.project.write('docs/briefs/RA-5-x.md', 'RA-5 — x');
    mfx.project.write('docs/briefs/RA-6-x.md', 'RA-6 — x');
    await mfx.api('/api/quests', 'POST', { package: 'RA-4', brief: 'docs/briefs/RA-4-x.md' });
    await mfx.api('/api/quests', 'POST', { package: 'RA-6', brief: 'docs/briefs/RA-6-x.md' });
    await mfx.api('/api/quests/RA-4/assign', 'POST', { adventurer: 'codex-luna' });
    await tick();
    await mfx.api('/api/quests/RA-4/status', 'POST', { status: 'delivered', detail: 'd', ack: true });
    await mfx.api('/api/quests', 'POST', { package: 'RA-5', kind: 'review', brief: 'docs/briefs/RA-5-x.md', parents: 'RA-4' });
  });
  after(() => mfx.close());

  it('refuses to clear or reparent a posted review through the metadata endpoint, over HTTP', async () => {
    const cleared = await mfx.api('/api/quests/RA-5/metadata', 'POST', { parents: '' });
    assert.equal(cleared.status, 400, cleared.text);
    assert.match(cleared.body.fields.parents, /RA-5 is a posted review/);
    const reparented = await mfx.api('/api/quests/RA-5/metadata', 'POST', { parents: 'RA-6' });
    assert.equal(reparented.status, 400);
    assert.match(reparented.body.fields.parents, /RA-5 is a posted review/);
    const still = await mfx.api('/api/quests/RA-5');
    assert.deepEqual(still.body.quest.parents, ['RA-4']);
  });

  it('refuses the same clear/reparent, and a kind change, through the re-post upsert endpoint', async () => {
    const cleared = await mfx.api('/api/quests', 'POST', { package: 'RA-5', kind: 'review', brief: 'docs/briefs/RA-5-x.md', parents: '' });
    assert.equal(cleared.status, 400, cleared.text);
    assert.match(cleared.body.fields.parents, /RA-5 is a posted review/);
    const kindSwitch = await mfx.api('/api/quests', 'POST', { package: 'RA-5', kind: 'code', brief: 'docs/briefs/RA-5-x.md', parents: '' });
    assert.equal(kindSwitch.status, 400);
    assert.match(kindSwitch.body.fields.kind, /RA-5 is a posted review/);
    const still = await mfx.api('/api/quests/RA-5');
    assert.deepEqual(still.body.quest.parents, ['RA-4']);
    assert.equal(still.body.quest.kind, 'review');
  });

  it('keeps the author refused before and after every attempted bypass', async () => {
    const refusedFor = (body) => body.eligibility['RA-5']['codex-luna'].reasons.some((r) => r.code === 'reviewer_coded_parent');
    assert.ok(refusedFor((await mfx.api('/api/quests')).body));
    await mfx.api('/api/quests/RA-5/metadata', 'POST', { parents: '' });
    await mfx.api('/api/quests', 'POST', { package: 'RA-5', kind: 'code', brief: 'docs/briefs/RA-5-x.md', parents: '' });
    await mfx.api('/api/quests', 'POST', { package: 'RA-5', kind: 'review', brief: 'docs/briefs/RA-5-x.md', parents: '' });
    assert.ok(refusedFor((await mfx.api('/api/quests')).body), 'still refused after every attempted bypass');
  });
});

// QB-FB-REVIEW-METADATA2 found the review-target lock above did not reach an ancestor two or more links
// away, and did not stop an ancestor's kind from being laundered into or out of 'review' — over HTTP, the
// same as the store-level tests in test/core/reviewLineageLock.test.js.
describe('review lineage lock: ancestors beyond the immediate parent, over HTTP', () => {
  let mfx;
  before(async () => {
    mfx = await startFixture();
    for (const id of ['RB-2', 'RB-3', 'RB-4', 'RB-6']) mfx.project.write(`docs/briefs/${id}-x.md`, `${id} — x`);
    await mfx.api('/api/quests', 'POST', { package: 'RB-2', brief: 'docs/briefs/RB-2-x.md' });
    await mfx.api('/api/quests', 'POST', { package: 'RB-6', brief: 'docs/briefs/RB-6-x.md' });
    await mfx.api('/api/quests/RB-2/assign', 'POST', { adventurer: 'codex-luna' });
    await tick();
    await mfx.api('/api/quests/RB-2/status', 'POST', { status: 'delivered', detail: 'd', ack: true });
    await mfx.api('/api/quests', 'POST', { package: 'RB-3', brief: 'docs/briefs/RB-3-x.md', parents: 'RB-2' });
    await mfx.api('/api/quests/RB-3/assign', 'POST', { adventurer: 'oc-mimo' });
    await tick();
    await mfx.api('/api/quests/RB-3/status', 'POST', { status: 'delivered', detail: 'd', ack: true });
    await mfx.api('/api/quests', 'POST', { package: 'RB-4', brief: 'docs/briefs/RB-4-x.md', kind: 'review', parents: 'RB-3' });
  });
  after(() => mfx.close());

  it('refuses to give the grandparent a new parent through the metadata endpoint, naming the protecting review', async () => {
    // RB-2 was posted with no parents of its own, so giving it one (not clearing, which would be a no-op) is
    // the actual change the lock must refuse.
    const reparented = await mfx.api('/api/quests/RB-2/metadata', 'POST', { parents: 'RB-6' });
    assert.equal(reparented.status, 400, reparented.text);
    assert.match(reparented.body.fields.parents, /RB-2 is locked/);
    assert.match(reparented.body.fields.parents, /RB-4 is a posted review/);
    assert.match(reparented.body.fields.parents, /does not unlock RB-2/);
    assert.deepEqual((await mfx.api('/api/quests/RB-2')).body.quest.parents, []);
  });

  it('refuses turning the delivered, authored parent into a review through the re-post endpoint', async () => {
    const switched = await mfx.api('/api/quests', 'POST', { package: 'RB-3', brief: 'docs/briefs/RB-3-x.md', kind: 'review' });
    assert.equal(switched.status, 400, switched.text);
    assert.match(switched.body.fields.kind, /RB-3 has dispatch history or an assignee/);
    assert.equal((await mfx.api('/api/quests/RB-3')).body.quest.kind, 'code');
  });
});
