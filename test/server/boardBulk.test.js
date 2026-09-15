import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFixture } from './fixture.js';
import { validateThreadBulkRequest, BoardStore } from '../../src/server/boardStore.js';

let fx;
before(async () => { fx = await startFixture(); });
after(() => fx.close());

async function makeThread(title) {
  const created = await fx.api('/api/threads', 'POST', { title, body: 'first', author: 'owner' });
  assert.equal(created.status, 201);
  return created.body.thread.id;
}

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

describe('thread bulk validation (shape only)', () => {
  it('refuses unknown actions, empty, oversize and duplicate id arrays', () => {
    assert.match(validateThreadBulkRequest({ action: 'delete', ids: ['t_a'] }).error, /action must be one of/);
    assert.match(validateThreadBulkRequest({ action: 'close', ids: [] }).error, /non-empty array/);
    assert.match(validateThreadBulkRequest({ action: 'close', ids: ['t_a', 't_a'] }).error, /repeats an earlier id/);
    assert.match(validateThreadBulkRequest({ action: 'close', ids: Array.from({ length: 101 }, (_, i) => `t_${i}`) }).error, /at most 100/);
    assert.match(validateThreadBulkRequest({ action: 'close', ids: [7] }).error, /ids\[0\] must be a non-empty string/);
    assert.match(validateThreadBulkRequest('not an object').error, /JSON body must be an object/);
    assert.equal(validateThreadBulkRequest({ action: 'trash', ids: ['t_a', 't_b'] }).error, undefined);
  });

  it('bounds a thread id to 128 characters — a refusal, never a silent truncation (F6)', () => {
    assert.match(validateThreadBulkRequest({ action: 'close', ids: ['t'.repeat(129)] }).error, /must be 128 characters or fewer/);
    assert.equal(validateThreadBulkRequest({ action: 'close', ids: ['t'.repeat(128)] }).error, undefined);
  });
});

describe('thread bulk routes', () => {
  it('reports per-id outcomes and never claims success for ids that failed', async () => {
    const keep = await makeThread('RUN-BULK keep');
    const gone = await makeThread('RUN-BULK gone');
    const partial = await fx.api('/api/threads/bulk', 'POST', { action: 'close', ids: [keep, 't_missing', gone] });
    assert.equal(partial.status, 200);
    assert.equal(partial.body.changed, 2);
    assert.equal(partial.body.failed, 1);
    assert.deepEqual(partial.body.results.map((r) => (r.ok ? 'ok' : r.error)), ['ok', 'thread not found', 'ok']);
    assert.equal((await fx.api(`/api/threads/${keep}`)).body.closed, true);
  });

  it('refuses an oversize batch before touching anything', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `t_over_${i}`);
    const refused = await fx.api('/api/threads/bulk', 'POST', { action: 'trash', ids });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /at most 100/);
  });

  it('refuses a cross-origin bulk write without touching any thread', async () => {
    const id = await makeThread('RUN-BULK refused');
    const refused = await fx.api('/api/threads/bulk', 'POST', { action: 'trash', ids: [id] }, { origin: 'http://evil.example' });
    assert.equal(refused.status, 403);
    assert.equal((await fx.api(`/api/threads/${id}`)).body.trashed, false);
    assert.equal((await fx.api('/api/threads?status=open')).body.threads.some((t) => t.id === id), true);
  });

  it('trash hides the thread from the normal list, keeps direct reads, and restore brings it back', async () => {
    const id = await makeThread('RUN-BULK recycle');
    assert.equal((await fx.api('/api/threads/bulk', 'POST', { action: 'trash', ids: [id] })).body.changed, 1);
    assert.equal((await fx.api('/api/threads?status=all')).body.threads.some((t) => t.id === id), false, 'not in the normal list');
    const bin = await fx.api('/api/threads?trash=only');
    assert.deepEqual(bin.body.threads.filter((t) => t.id === id).map((t) => t.title), ['RUN-BULK recycle']);
    assert.equal((await fx.api(`/api/threads/${id}`)).body.trashed, true, 'a direct read answers and says it is trashed');
    assert.equal((await fx.api(`/api/threads/${id}/messages`, 'POST', { body: 'late', author: 'owner' })).status, 409, 'no writes to a trashed thread');
    assert.equal((await fx.api('/api/threads/bulk', 'POST', { action: 'close', ids: [id] })).body.results[0].ok, false, 'bulk close refuses a trashed thread');
    assert.equal((await fx.api('/api/threads/bulk', 'POST', { action: 'restore', ids: [id] })).body.changed, 1);
    assert.equal((await fx.api('/api/threads?status=all')).body.threads.some((t) => t.id === id), true, 'back in the normal list');
    assert.equal((await fx.api(`/api/threads/${id}/messages`, 'POST', { body: 'late', author: 'owner' })).status, 201, 'writes work again after restore');
  });

  it('a closed thread takes no replies until reopened, and bulk reopen clears that', async () => {
    const id = await makeThread('RUN-BULK close');
    assert.equal((await fx.api('/api/threads/bulk', 'POST', { action: 'close', ids: [id] })).body.changed, 1);
    assert.equal((await fx.api(`/api/threads/${id}/messages`, 'POST', { body: 'x', author: 'owner' })).status, 409);
    assert.equal((await fx.api('/api/threads/bulk', 'POST', { action: 'reopen', ids: [id] })).body.changed, 1);
    assert.equal((await fx.api(`/api/threads/${id}/messages`, 'POST', { body: 'x', author: 'owner' })).status, 201);
  });

  it('pin and unpin act as a pair', async () => {
    const id = await makeThread('RUN-BULK pin');
    assert.equal((await fx.api('/api/threads/bulk', 'POST', { action: 'pin', ids: [id] })).body.results[0].thread.pinned, true);
    assert.equal((await fx.api('/api/threads/bulk', 'POST', { action: 'unpin', ids: [id] })).body.results[0].thread.pinned, false);
  });

  it('the default list hides trash so recycled threads never surface as open questions', async () => {
    const id = await makeThread('RUN-BULK question');
    await fx.api('/api/threads/bulk', 'POST', { action: 'trash', ids: [id] });
    const snapshot = await fx.api('/api/quests');
    assert.equal(snapshot.body.threads[id], undefined, 'the quest drawer thread links exclude it');
  });
});

describe('thread trash persistence (store level)', () => {
  it('a new store on the same directory keeps the trash flag and every message', () => {
    const dir = tmp('qb-bulk-');
    const store = new BoardStore(dir);
    const created = store.createThread({ title: 'persist me', body: 'one', author: 'owner', tags: ['question'] });
    store.addMessage(created.thread.id, { body: 'two', author: 'friend' });
    store.applyThreadBulk([created.thread.id], 'trash');
    const reopened = new BoardStore(dir);
    const detail = reopened.getThread(created.thread.id);
    assert.equal(detail.trashed, true);
    assert.deepEqual(detail.messages.map((m) => m.body), ['one', 'two'], 'no message data was purged');
    assert.deepEqual(reopened.listThreads({}).map((t) => t.id), [], 'the default list excludes trash after reload');
    assert.deepEqual(reopened.listThreads({ trash: 'only' }).map((t) => t.id), [created.thread.id]);
    assert.equal(reopened.status().trashedThreads, 1);
    reopened.applyThreadBulk([created.thread.id], 'restore');
    assert.deepEqual(new BoardStore(dir).listThreads({}).map((t) => t.id), [created.thread.id], 'restore persists too');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('old snapshots without a trashed field load as live threads, not as errors', () => {
    const dir = tmp('qb-legacy-');
    const legacy = { type: 'thread', id: 't_old', title: 'before trash', tags: [], author: 'owner', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', pinned: false, closed: false, messageCount: 0, lastMessageAt: null };
    fs.writeFileSync(path.join(dir, 'threads.jsonl'), `${JSON.stringify(legacy)}\n`);
    const store = new BoardStore(dir);
    assert.deepEqual(store.listThreads({}).map((t) => t.id), ['t_old']);
    assert.equal(store.listThreads({ trash: 'only' }).length, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('revision fixes (F1 / F6 / F7)', () => {
  it('refuses over-long ids as a whole request, never truncating them (F6)', async () => {
    assert.match(validateThreadBulkRequest({ action: 'close', ids: ['t_'.padEnd(129, 'x')] }).error, /must be 128 characters or fewer/);
    assert.equal(validateThreadBulkRequest({ action: 'close', ids: ['t_'.padEnd(128, 'x')] }).error, undefined);
    const refused = await fx.api('/api/threads/bulk', 'POST', { action: 'trash', ids: ['t_'.padEnd(129, 'x')] });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /128 characters/);
  });

  it('the recycle bin lists a closed trashed thread even when asked for open only (F1)', async () => {
    const id = await makeThread('RUN-BULK closed-bin');
    assert.equal((await fx.api('/api/threads/bulk', 'POST', { action: 'close', ids: [id] })).body.changed, 1);
    assert.equal((await fx.api('/api/threads/bulk', 'POST', { action: 'trash', ids: [id] })).body.changed, 1);
    const bin = await fx.api('/api/threads?trash=only&status=open');
    assert.equal(bin.status, 200);
    assert.ok(bin.body.threads.some((t) => t.id === id), 'status filters never hide rows inside the bin');
    assert.equal((await fx.api('/api/threads?status=open')).body.threads.some((t) => t.id === id), false, 'the normal open list still hides trash');
  });

  it('openQuestions ignores trashed questions, and restore returns the actual state without inventing a ruling (F7)', async () => {
    const created = await fx.api('/api/threads', 'POST', { title: 'RUN-BULK ask', body: 'first', author: 'owner', tags: ['question'] });
    const id = created.body.thread.id;
    assert.equal((await fx.api('/api/quests')).body.openQuestions, 1);
    assert.equal((await fx.api('/api/threads/bulk', 'POST', { action: 'trash', ids: [id] })).body.changed, 1);
    assert.equal((await fx.api('/api/quests')).body.openQuestions, 0, 'a trashed thread is not an open question');
    const wrong = await fx.api('/api/threads/bulk', 'POST', { action: 'close', ids: [id] });
    assert.equal(wrong.body.results[0].ok, false, 'a bin thread takes no other bulk action');
    const restored = await fx.api('/api/threads/bulk', 'POST', { action: 'restore', ids: [id] });
    assert.equal(restored.body.results[0].ok, true);
    assert.equal(restored.body.results[0].thread.closed, false, 'restore fabricates nothing: the question is still genuinely open');
    assert.equal(restored.body.results[0].thread.trashed, false);
    assert.equal((await fx.api('/api/quests')).body.openQuestions, 1, 'it counts again exactly as it was');
  });

  it('restore keeps a closed thread closed (actual state, no silent reopen)', () => {
    const dir = tmp('qb-restore-state-');
    const store = new BoardStore(dir);
    const created = store.createThread({ title: 'answered once', body: 'one', author: 'owner', tags: ['question'] });
    store.applyThreadBulk([created.thread.id], 'close');
    store.applyThreadBulk([created.thread.id], 'trash');
    const restored = store.applyThreadBulk([created.thread.id], 'restore')[0];
    assert.equal(restored.ok, true);
    assert.equal(restored.thread.closed, true, 'the flag flip changes only the trash flag');
    assert.equal(restored.thread.trashed, false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the inbox keeps trashed threads history in the coordinator queue', () => {
    const dir = tmp('qb-inbox-history-');
    const store = new BoardStore(dir);
    const created = store.createThread({ title: 'ask', body: 'question here', author: 'owner', tags: ['question'] });
    store.addMessage(created.thread.id, { body: 'an answer', author: 'friend' });
    store.applyThreadBulk([created.thread.id], 'trash');
    const inbox = store.inbox(null, null);
    assert.deepEqual(inbox.map((m) => m.body), ['question here', 'an answer'], 'trash hides a thread, it never retracts messages');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
