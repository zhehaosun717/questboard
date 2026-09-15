// QB-FB-F: GET /api/quests/:id — one enriched quest, read-only, missing and odd ids answered with 404.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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

// R3: the non-durable session diagnostic (requirement 5) must actually reach an HTTP consumer through this
// same GET, sanitized — not just be queryable from inside the process via an internal import.
describe('GET /api/quests/:id — unpersistedSession diagnostic (R3)', () => {
  it('shows persisted:false and the known session id after both the quest store and the events file fail to record it', async () => {
    let qp;
    let ef;
    const diagFx = await startFixture({
      runners: {
        // The session step captures a real id, then its own write-ahead persistence (quests.jsonl) *and*
        // the confirming events file both fail — the exact "both sinks down" shape F4/requirement 5 guard
        // against, so the diagnostic must not depend on either sink's own health to be readable.
        session: async () => {
          qp && fs.rmSync(qp, { recursive: true, force: true });
          qp && fs.mkdirSync(qp);
          ef && fs.rmSync(ef, { recursive: true, force: true });
          ef && fs.mkdirSync(ef);
          return { code: 0, session: 'ses_http_diag' };
        },
        run: async () => ({ code: 0 }),
      },
    });
    try {
      qp = path.join(diagFx.project.config.paths.data, 'quests.jsonl');
      ef = diagFx.project.config.paths.events;
      diagFx.project.write('docs/briefs/RUN-DIAG-1-x.md', 'brief');
      await diagFx.api('/api/quests', 'POST', { package: 'RUN-DIAG-1', brief: 'docs/briefs/RUN-DIAG-1-x.md' });
      const assigned = await diagFx.api('/api/quests/RUN-DIAG-1/assign', 'POST', { adventurer: 'oc-mimo' });
      assert.equal(assigned.status, 200);
      await tick(300);
      const detail = await diagFx.api('/api/quests/RUN-DIAG-1');
      assert.equal(detail.status, 200);
      const diag = detail.body.quest.unpersistedSession;
      assert.ok(diag, 'an HTTP consumer must be able to see the stopgap, not just code with a direct import');
      assert.equal(diag.persisted, false, 'never presented as a confirmed, restart-safe fact');
      assert.equal(diag.sessionId, 'ses_http_diag');
      assert.equal(diag.error, undefined, 'never raw error text (paths, stderr) over the wire');
      assert.deepEqual(Object.keys(diag).sort(), ['attemptId', 'notedAt', 'persisted', 'questId', 'sessionId']);
    } finally {
      try { fs.existsSync(qp) && fs.statSync(qp).isDirectory() && fs.rmdirSync(qp); } catch { /* ignore */ }
      try { fs.existsSync(ef) && fs.statSync(ef).isDirectory() && fs.rmdirSync(ef); } catch { /* ignore */ }
      await diagFx.close();
    }
  });
});
