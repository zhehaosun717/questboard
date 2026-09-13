import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from './fixture.js';
import { validateAnnotations } from '../../src/server/boardRoutes.js';

let fx;
before(async () => { fx = await startFixture(); });
after(() => fx.close());

describe('message board', () => {
  it('creates, replies, pins and closes threads, and serves the inbox per reader', async () => {
    const created = await fx.api('/api/threads', 'POST', { title: 'RUN-5 leachate', body: 'which one?', author: 'coordinator', tags: ['question', 'RUN-5'] });
    assert.equal(created.status, 201);
    const id = created.body.thread.id;
    assert.equal((await fx.api(`/api/threads/${id}/messages`, 'POST', { body: '用挖掘驱动', author: 'owner' })).status, 201);
    assert.equal((await fx.api(`/api/threads/${id}/pin`, 'POST', { pinned: true })).body.pinned, true);
    assert.equal((await fx.api(`/api/threads/${id}/close`, 'POST', { closed: true })).body.closed, true);
    assert.equal((await fx.api(`/api/threads/${id}/messages`, 'POST', { body: 'late', author: 'owner' })).status, 409);
    const inbox = await fx.api('/api/inbox?for=coordinator');
    assert.deepEqual(inbox.body.messages.map((m) => m.author), ['owner']);
    assert.equal((await fx.api('/api/threads', 'POST', { title: '', body: '', author: '' })).status, 400);
    assert.equal((await fx.api('/api/threads/t_missing')).status, 404);
    assert.equal((await fx.api('/api/threads', 'POST', { title: 'x', body: 'y', author: 'z' }, { origin: 'http://evil.example' })).status, 403);
  });

  it('counts open questions in the snapshot', async () => {
    assert.equal((await fx.api('/api/quests')).body.openQuestions, 0, 'the question thread above was closed');
  });
});

describe('health', () => {
  it('names the project and its root so the desktop shell can tell same-named projects apart', async () => {
    const health = await fx.api('/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(typeof health.body.project, 'string');
    assert.ok(health.body.root && typeof health.body.root === 'string');
  });
});

describe('annotations', () => {
  it('saves and folds annotations with CORS for file:// review pages', async () => {
    const items = [{ id: 'a', verdict: '用新的', note: '好', updatedAt: new Date().toISOString() }];
    const saved = await fx.api('/api/annotations', 'POST', { page: 'robot8', items });
    assert.equal(saved.headers.get('access-control-allow-origin'), '*');
    await fx.api('/api/annotations', 'POST', { page: 'robot8', items: [{ ...items[0], note: '改主意了' }] });
    assert.equal((await fx.api('/api/annotations?page=robot8')).body.items[0].note, '改主意了');
    const snapshot = (await fx.api('/api/quests')).body;
    assert.equal(snapshot.reviewPages[0].answered, 1);
    assert.equal((await fx.api('/api/annotations', 'OPTIONS')).status, 204);
    assert.equal((await fx.api('/api/annotations?page=../x')).status, 400);
  });

  it('validates every field with a named message', () => {
    assert.match(validateAnnotations({ page: 'Bad Page', items: [] }), /page must match/);
    assert.match(validateAnnotations({ page: 'p', items: [{ id: 'a', note: 1, verdict: '', updatedAt: 'x' }] }), /note must be a string/);
    assert.match(validateAnnotations({ page: 'p', items: [{ id: 'a', note: '', verdict: '', updatedAt: 'nope' }] }), /updatedAt must be a valid date/);
    assert.equal(validateAnnotations({ page: 'p', items: [] }), null);
  });
});
