// FB2-04 item 1: a code dispatch snapshots git status --porcelain before the worker starts, so the
// reviewer can tell pre-existing edits apart from what the worker touched.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDispatcher } from '../../src/server/dispatcher.js';
import { QuestStore } from '../../src/core/store.js';
import { makeProject, card } from '../helpers.js';

const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture({ gitStatusSync, kind = 'code' } = {}) {
  const { config, write } = makeProject();
  write('docs/briefs/PD-1-x.md', 'brief');
  const store = new QuestStore(config);
  store.post({ package: 'PD-1', brief: 'docs/briefs/PD-1-x.md', kind, by: 'owner' });
  const dispatcher = createDispatcher({
    config,
    store,
    ...(gitStatusSync ? { gitStatusSync } : {}),
    runners: { run: async () => ({ code: 0 }) },
  });
  return { config, store, dispatcher };
}

describe('dispatcher pre-dispatch git snapshot (FB2-04)', () => {
  it('records the porcelain file list on the attempt before the runner starts', async () => {
    const { config, write } = makeProject();
    write('docs/briefs/PD-1-x.md', 'brief');
    const store = new QuestStore(config);
    store.post({ package: 'PD-1', brief: 'docs/briefs/PD-1-x.md', by: 'owner' });
    let seenAtRun = null;
    const dispatcher = createDispatcher({
      config,
      store,
      gitStatusSync: () => ({ available: true, files: ['src/dirty.js', 'docs/notes.md'] }),
      runners: {
        run: async () => {
          seenAtRun = store.get('PD-1').assignee.preDispatchChanges || null;
          return { code: 0 };
        },
      },
    });
    const result = dispatcher.assign('PD-1', card('codex-luna'), 'owner');
    assert.equal(result.status, 200, JSON.stringify(result.body));
    await wait();
    assert.ok(seenAtRun, 'the snapshot is already recorded when the worker starts');
    assert.deepEqual(seenAtRun.files, ['src/dirty.js', 'docs/notes.md']);
    const quest = store.get('PD-1');
    assert.deepEqual(quest.assignee.preDispatchChanges.files, ['src/dirty.js', 'docs/notes.md']);
    assert.ok(quest.assignee.preDispatchChanges.at);
    assert.deepEqual(quest.dispatches.at(-1).preDispatchChanges.files, ['src/dirty.js', 'docs/notes.md']);
  });

  it('skips non-code quests entirely', async () => {
    let called = 0;
    const { store, dispatcher } = fixture({
      kind: 'art',
      gitStatusSync: () => { called += 1; return { available: true, files: [] }; },
    });
    dispatcher.assign('PD-1', card('agy-gemini', { strengths: ['art'] }), 'owner');
    await wait();
    assert.equal(called, 0);
    assert.equal(store.get('PD-1').assignee.preDispatchChanges, undefined);
  });

  it('a git failure records 无 git，无法快照 and never fails the dispatch', async () => {
    const { store, dispatcher } = fixture({
      gitStatusSync: () => { throw new Error('git not found'); },
    });
    const result = dispatcher.assign('PD-1', card('codex-luna'), 'owner');
    assert.equal(result.status, 200, JSON.stringify(result.body));
    await wait();
    const snapshot = store.get('PD-1').assignee.preDispatchChanges;
    assert.equal(snapshot.available, false);
    assert.match(snapshot.note, /无 git，无法快照/);
    assert.match(snapshot.note, /git not found/);
    assert.equal(store.get('PD-1').status, 'dispatched', 'the worker still went out');
  });
});
