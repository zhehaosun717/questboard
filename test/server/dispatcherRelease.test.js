// FB2-06 item 4: release no longer demands a cancel first when the board has verified the worker's
// process tree is empty — a dispatched quest whose job object counts zero processes releases directly
// (with the same acknowledgement/detail as any release); a tree that is alive or unverifiable is still
// refused with an explanation naming which case it was.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDispatcher } from '../../src/server/dispatcher.js';
import { QuestStore } from '../../src/core/store.js';
import { makeProject, card } from '../helpers.js';

function fixture({ verifyTree } = {}) {
  const { config, write } = makeProject();
  write('docs/briefs/REL-T-1-x.md', 'brief');
  const store = new QuestStore(config);
  const dispatcher = createDispatcher({
    config, store,
    ...(verifyTree ? { verifyTree } : {}),
    runners: { run: async () => ({ code: 0 }) },
  });
  store.post({ package: 'REL-T-1', brief: 'docs/briefs/REL-T-1-x.md', by: 'owner' });
  const assigned = dispatcher.assign('REL-T-1', card('codex-luna'), 'owner');
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  return { config, store, dispatcher };
}

describe('dispatcher release with verified-empty process tree (FB2-06)', () => {
  it('releases a dispatched quest directly when the process tree verifies empty', async () => {
    const { store, dispatcher } = fixture({ verifyTree: async ({ attemptId }) => {
      assert.equal(attemptId, store.get('REL-T-1').assignee.attemptId, 'the verification asks about this exact attempt');
      return 'empty';
    } });
    const result = await dispatcher.release('REL-T-1', 'cli', '进程树已核验为空，worker 死了', { source: 'cli', ack: true });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const quest = store.get('REL-T-1');
    assert.equal(quest.assignee, null);
    assert.equal(quest.lastDetail, '进程树已核验为空，worker 死了');
    assert.equal(quest.dispatches.length, 1, 'the dispatch history stays');
  });

  it('refuses a dispatched quest whose tree is still alive, saying to cancel first', async () => {
    const { store, dispatcher } = fixture({ verifyTree: async () => 'alive' });
    const result = await dispatcher.release('REL-T-1', 'cli', 'ps shows nothing', { source: 'cli', ack: true });
    assert.equal(result.status, 409);
    assert.match(result.body.reasons[0].message, /先 cancel 再 release/);
    assert.ok(store.get('REL-T-1').assignee, 'the slot is not freed on a refusal');
  });

  it('refuses a dispatched quest whose tree cannot be verified, naming the unknown', async () => {
    const { store, dispatcher } = fixture({ verifyTree: async () => 'unknown' });
    const result = await dispatcher.release('REL-T-1', 'cli', 'ps shows nothing', { source: 'cli', ack: true });
    assert.equal(result.status, 409);
    assert.match(result.body.reasons[0].message, /无法确认进程树/);
    assert.ok(store.get('REL-T-1').assignee);
  });

  it('a stalled quest still releases the ordinary way, without asking the process tree', async () => {
    let asked = 0;
    const { store, dispatcher } = fixture({ verifyTree: async () => { asked += 1; return 'alive'; } });
    store.setStatus('REL-T-1', 'stalled', { detail: 'no output', by: 'lanes', source: 'collector', evidence: { kind: 'collector', attemptId: store.get('REL-T-1').assignee.attemptId } });
    const result = await dispatcher.release('REL-T-1', 'cli', '确认已停', { source: 'cli', ack: true });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(asked, 0, 'the tree check is only for a still-running quest');
    assert.equal(store.get('REL-T-1').assignee, null);
  });
});
