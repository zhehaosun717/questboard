// FB2-04 items 3/5: review deliveries and batch waitingOn landings post to the coordinator inbox.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFixture, tick } from './fixture.js';

let fx;
before(async () => { fx = await startFixture(); });
after(() => fx.close());

const threadCount = () => fx.server.boardStore.listThreads().length;
const findThread = (titlePattern) => {
  const thread = fx.server.boardStore.listThreads().find((t) => titlePattern.test(t.title));
  return thread ? fx.server.boardStore.getThread(thread.id) : null;
};
const bodies = (thread) => (thread?.messages || []).map((m) => m.body).join('\n');

describe('delivery notifications (FB2-04)', () => {
  it('a review quest delivery posts 卡号 + 结论来源 + 等多久 to the coordinator inbox', async () => {
    fx.project.write('docs/briefs/DN-1-x.md', '# DN-1');
    await fx.api('/api/quests', 'POST', { package: 'DN-1', brief: 'docs/briefs/DN-1-x.md' });
    await fx.api('/api/quests/DN-1/assign', 'POST', { adventurer: 'codex-luna' });
    await tick();
    await fx.api('/api/quests/DN-1/status', 'POST', { status: 'delivered', detail: 'done', ack: true });
    fx.project.write('docs/briefs/REVIEW-DN-1-x.md', '# REVIEW-DN-1');
    await fx.api('/api/quests', 'POST', { package: 'REVIEW-DN-1', brief: 'docs/briefs/REVIEW-DN-1-x.md', kind: 'review', parents: 'DN-1' });
    const before = threadCount();
    await fx.api('/api/quests/REVIEW-DN-1/assign', 'POST', { adventurer: 'agy-gemini' });
    await tick();
    await fx.api('/api/quests/REVIEW-DN-1/status', 'POST', { status: 'delivered', detail: 'VERDICT: PASS', ack: true });
    const thread = findThread(/REVIEW-DN-1 复核交付/);
    assert.ok(thread, 'review delivery posted a thread');
    const body = bodies(thread);
    assert.match(body, /复核 DN-1/);
    assert.match(body, /结论来源/);
    assert.match(body, /等了/);
    assert.equal(threadCount(), before + 1);
    // an ordinary delivery of work posts nothing
    fx.project.write('docs/briefs/DN-2-x.md', '# DN-2');
    const beforeWork = threadCount();
    await fx.api('/api/quests', 'POST', { package: 'DN-2', brief: 'docs/briefs/DN-2-x.md' });
    await fx.api('/api/quests/DN-2/assign', 'POST', { adventurer: 'codex-luna' });
    await tick();
    await fx.api('/api/quests/DN-2/status', 'POST', { status: 'delivered', detail: 'done', ack: true });
    assert.equal(threadCount(), beforeWork, 'no inbox noise for plain work');
  });

  it('a waitingOn quest delivery reminds the coordinator to accept the batch', async () => {
    fx.project.write('docs/briefs/DN-3-x.md', '# DN-3');
    fx.project.write('docs/briefs/DN-4-x.md', '# DN-4');
    fx.project.write('docs/briefs/DN-5-x.md', '# DN-5');
    await fx.api('/api/quests', 'POST', { package: 'DN-3', brief: 'docs/briefs/DN-3-x.md' });
    await fx.api('/api/quests', 'POST', { package: 'DN-4', brief: 'docs/briefs/DN-4-x.md' });
    await fx.api('/api/quests', 'POST', { package: 'DN-5', brief: 'docs/briefs/DN-5-x.md' });
    for (const id of ['DN-3', 'DN-4']) {
      const meta = await fx.api(`/api/quests/${id}/metadata`, 'POST', { batch: 'DN-3,DN-4,DN-5', waitingOn: 'DN-5' });
      assert.equal(meta.status, 200, meta.text);
    }
    const before = threadCount();
    await fx.api('/api/quests/DN-5/assign', 'POST', { adventurer: 'codex-luna' });
    await tick();
    await fx.api('/api/quests/DN-5/status', 'POST', { status: 'delivered', detail: 'done', ack: true });
    const thread = findThread(/DN-5 交付：这批该验收了/);
    assert.ok(thread, 'waitingOn delivery posted a reminder');
    const body = bodies(thread);
    assert.match(body, /DN-3（和 DN-4 一批）/);
    assert.match(body, /DN-4（和 DN-3 一批）/);
    assert.equal(threadCount(), before + 1);
  });

  it('metadata refuses a batch list that leaves the quest itself out, or a self-wait', async () => {
    fx.project.write('docs/briefs/DN-6-x.md', '# DN-6');
    await fx.api('/api/quests', 'POST', { package: 'DN-6', brief: 'docs/briefs/DN-6-x.md' });
    const noSelf = await fx.api('/api/quests/DN-6/metadata', 'POST', { batch: 'DN-3,DN-4' });
    assert.equal(noSelf.status, 400);
    assert.match(noSelf.body.fields.batch, /包含它自己/);
    const selfWait = await fx.api('/api/quests/DN-6/metadata', 'POST', { waitingOn: 'DN-6' });
    assert.equal(selfWait.status, 400);
    assert.match(selfWait.body.fields.waitingOn, /不能等它自己/);
  });
});
