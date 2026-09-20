// FB2-02 items 2/4/6: the send-back decision route, the hand-to-coordinator button, and the owner's
// saved review ruling (needs_owner -> owner_ruled).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startFixture } from './fixture.js';
import { appendJsonLine } from '../../src/core/jsonl.js';

const iso = '2026-09-20T12:00:00.000Z';

function addLog(fx, page, items) {
  appendJsonLine(path.join(fx.project.config.paths.data, 'annotations', `${page}.jsonl`), { page, items, savedAt: iso });
}

async function postArt(fx, id, page = 'robot8') {
  const brief = `docs/briefs/${id}-x.md`;
  fx.project.write(brief, `# ${id}`);
  const posted = await fx.api('/api/quests', 'POST', { package: id, kind: 'art', reviewPage: page, brief });
  assert.equal(posted.status, 201, posted.text);
}

async function inboxBodies(fx) {
  const inbox = await fx.api('/api/inbox');
  assert.equal(inbox.status, 200);
  return inbox.body.messages.map((m) => m.body);
}

describe('send-back route (FB2-02 item 2)', () => {
  it('plain send-back: ruling recorded, quest back to posted, no inbox noise', async () => {
    const fx = await startFixture();
    try {
      await postArt(fx, 'ART-60');
      await fx.api('/api/quests/ART-60/status', 'POST', { status: 'reviewing', detail: 'worker 交差了' });
      const result = await fx.api('/api/quests/ART-60/send-back', 'POST', { reason: '颜色不对' });
      assert.equal(result.status, 200, result.text);
      assert.equal(result.body.routed, 'posted');
      const quest = fx.server.store.get('ART-60');
      assert.equal(quest.status, 'posted');
      assert.ok(quest.rulings.some((ruling) => ruling.text.includes('颜色不对')));
      assert.ok(fx.events().some((e) => e.event === 'owner_ruling'));
      assert.equal((await inboxBodies(fx)).length, 0, 'no coordinator thread for an ordinary redo');
    } finally {
      await fx.close();
    }
  });

  it('an annotation naming the coordinator routes to needs_coordinator with an inbox thread, never posted', async () => {
    const fx = await startFixture();
    try {
      await postArt(fx, 'ART-61');
      addLog(fx, 'robot8', [{ id: 'a', verdict: 'fail', note: '这块要 coordinator 重新排版图' }]);
      await fx.api('/api/quests/ART-61/status', 'POST', { status: 'reviewing', detail: 'worker 交差了' });
      const result = await fx.api('/api/quests/ART-61/send-back', 'POST', { reason: '有批注要 coordinator 看' });
      assert.equal(result.status, 200, result.text);
      assert.equal(result.body.routed, 'needs_coordinator');
      const quest = fx.server.store.get('ART-61');
      assert.equal(quest.status, 'needs_coordinator');
      assert.ok(fx.events().some((e) => e.event === 'status_needs_coordinator'), 'event emitted');
      const bodies = await inboxBodies(fx);
      assert.equal(bodies.length, 1);
      assert.match(bodies[0], /ART-61/);
      assert.match(bodies[0], /robot8/, 'the message names the review page');
    } finally {
      await fx.close();
    }
  });

  it('the owner checkbox routes to needs_coordinator even with no annotation mention', async () => {
    const fx = await startFixture();
    try {
      await postArt(fx, 'ART-62');
      await fx.api('/api/quests/ART-62/status', 'POST', { status: 'delivered', detail: '交差' });
      const result = await fx.api('/api/quests/ART-62/send-back', 'POST', { reason: '整体思路要换', needsCoordinator: true });
      assert.equal(result.status, 200, result.text);
      assert.equal(result.body.routed, 'needs_coordinator');
      assert.equal(fx.server.store.get('ART-62').status, 'needs_coordinator');
    } finally {
      await fx.close();
    }
  });

  it('refuses a send-back on a quest with nothing to send back, and refuses an empty reason', async () => {
    const fx = await startFixture();
    try {
      await postArt(fx, 'ART-63');
      const empty = await fx.api('/api/quests/ART-63/send-back', 'POST', { reason: '  ' });
      assert.equal(empty.status, 400);
      await fx.api('/api/quests/ART-63/status', 'POST', { status: 'reviewing', detail: 'x' });
      // already covered above; here a posted quest:
      await fx.api('/api/quests/ART-63/status', 'POST', { status: 'posted', detail: 'back' });
      const wrong = await fx.api('/api/quests/ART-63/send-back', 'POST', { reason: '重做' });
      assert.equal(wrong.status, 409, wrong.text);
    } finally {
      await fx.close();
    }
  });
});

describe('hand-to-coordinator route (FB2-02 item 4)', () => {
  it('posts a question thread naming the card into the coordinator inbox', async () => {
    const fx = await startFixture();
    try {
      await postArt(fx, 'ART-64');
      const result = await fx.api('/api/quests/ART-64/hand-to-coordinator', 'POST', { note: '简报要重写' });
      assert.equal(result.status, 200, result.text);
      const bodies = await inboxBodies(fx);
      assert.equal(bodies.length, 1);
      assert.match(bodies[0], /ART-64/);
      assert.match(bodies[0], /简报要重写/);
    } finally {
      await fx.close();
    }
  });

  it('404s an unknown quest', async () => {
    const fx = await startFixture();
    try {
      const result = await fx.api('/api/quests/NOPE-1/hand-to-coordinator', 'POST', { note: 'x' });
      assert.equal(result.status, 404);
    } finally {
      await fx.close();
    }
  });
});

describe('owner ruling route (FB2-02 item 6)', () => {
  it('needs_owner -> owner_ruled with counts and annotation texts in the inbox', async () => {
    const fx = await startFixture();
    try {
      await postArt(fx, 'ART-65');
      addLog(fx, 'robot8', [
        { id: 'a', verdict: 'pass', note: '构图可以' },
        { id: 'b', verdict: 'fail', note: '颜色不对' },
        { id: 'c', verdict: 'needs-fix', note: '手再修一下' },
      ]);
      await fx.api('/api/quests/ART-65/status', 'POST', { status: 'needs_owner', detail: '等你裁决' });
      const result = await fx.api('/api/quests/ART-65/owner-ruling', 'POST', {});
      assert.equal(result.status, 200, result.text);
      const quest = fx.server.store.get('ART-65');
      assert.equal(quest.status, 'owner_ruled');
      assert.match(quest.lastDetail, /通过 1/);
      assert.match(quest.lastDetail, /不行 1/);
      assert.match(quest.lastDetail, /需要修改 1/);
      assert.ok(fx.events().some((e) => e.event === 'status_owner_ruled'));
      const bodies = await inboxBodies(fx);
      assert.equal(bodies.length, 1);
      assert.match(bodies[0], /通过 1/);
      assert.match(bodies[0], /颜色不对/, 'the annotation text itself is in the message');
    } finally {
      await fx.close();
    }
  });

  it('refuses when the quest is not waiting for the owner, naming the actual status', async () => {
    const fx = await startFixture();
    try {
      await postArt(fx, 'ART-66');
      const result = await fx.api('/api/quests/ART-66/owner-ruling', 'POST', {});
      assert.equal(result.status, 409, result.text);
      assert.match(result.text, /posted/);
    } finally {
      await fx.close();
    }
  });
});
