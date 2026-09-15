// QB-FB-F: GET /api/quests/:id — one enriched quest, read-only, missing and odd ids answered with 404.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFixture, tick } from './fixture.js';

let fx;
before(async () => { fx = await startFixture(); });
after(() => fx.close());

describe('GET /api/quests/:id', () => {
  it('returns one enriched quest and mutates nothing', async () => {
    fx.project.write('docs/briefs/QD-1-read-me-once.md', '# QD-1\n\n## Files you may edit\n\n- `src/qd/a.js`\n- `src/qd/b.md`\n');
    const posted = await fx.api('/api/quests', 'POST', { package: 'QD-1', brief: 'docs/briefs/QD-1-read-me-once.md' });
    assert.equal(posted.status, 201);
    const eventsBefore = fx.events().length;
    const one = await fx.api('/api/quests/QD-1');
    assert.equal(one.status, 200);
    const quest = one.body.quest;
    assert.equal(quest.id, 'QD-1');
    assert.equal(typeof quest.revision, 'number');
    assert.deepEqual(quest.files, ['src/qd/a.js', 'src/qd/b.md']);
    assert.equal(quest.assignee, null);
    assert.deepEqual(quest.dispatches, []);
    assert.equal(quest.live, null);
    assert.deepEqual(quest.threads, []);
    assert.ok(quest.eligibility.canTake.includes('codex-luna'));
    const again = await fx.api('/api/quests/QD-1');
    assert.equal(again.body.quest.revision, quest.revision, 'reading does not bump the revision');
    assert.equal(fx.events().length, eventsBefore, 'the read itself appends no events');
  });

  it('decodes URL-encoded ids, 404s missing and odd ones, keeps the list route intact', async () => {
    assert.equal((await fx.api('/api/quests/QD%2D1')).body.quest.id, 'QD-1');
    const missing = await fx.api('/api/quests/NOPE-1');
    assert.deepEqual([missing.status, missing.body.error], [404, 'quest not found']);
    assert.equal((await fx.api(`/api/quests/${encodeURIComponent('../escape')}`)).status, 404);
    assert.equal((await fx.api('/api/quests/QD-1/extra')).status, 404);
    const list = await fx.api('/api/quests');
    assert.ok(list.body.quests.some((q) => q.id === 'QD-1'), 'the snapshot route still answers');
  });

  it('carries the running worker and its history, and the stalled-only release guard stays', async () => {
    assert.equal((await fx.api('/api/quests/QD-1/assign', 'POST', { adventurer: 'codex-luna' })).status, 200);
    await tick();
    const quest = (await fx.api('/api/quests/QD-1')).body.quest;
    assert.equal(quest.status, 'dispatched');
    assert.equal(quest.assignee.name, 'qd1');
    assert.equal(quest.dispatches.length, 1);
    assert.equal(quest.eligibility.canTake.includes('codex-luna'), false, 'the busy card may not take it again');
    assert.equal((await fx.api('/api/quests/QD-1/release', 'POST', { detail: 'too early' })).status, 409, 'a running quest is cancelled, not released');
    await fx.api('/api/quests/QD-1/status', 'POST', { status: 'stalled', detail: 'no output for a long time' });
    const released = await fx.api('/api/quests/QD-1/release', 'POST', { detail: 'process gone' });
    assert.equal(released.status, 200, released.text);
    assert.equal(released.body.quest.assignee, null);
    assert.equal(fx.events().at(-1).event, 'released');
  });
});
