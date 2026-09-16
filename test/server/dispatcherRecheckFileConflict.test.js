// B1 (revision 4, the queued-recheck fail-closed gap the independent review found): a quest already
// dispatched and queued behind a serialized lane still has its own slot when the queued recheck runs
// (store.assign ran before it was enqueued) — but for the purpose of judging conflicts against *other* held
// quests it must still be treated as the fresh candidate it actually is. Before this fix, withFileSets only
// ever gave such a quest its own conflict token back, never another held quest's, so a real conflict that
// only became visible after the initial check (a held quest's brief turning unknown mid-queue) went
// undetected. Reproduces the independent review's probe3b shape: RUN-1 dispatched, RUN-2 queued behind it on
// a serialized lane, then RUN-1's brief changes while RUN-2 waits its turn.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createDispatcher } from '../../src/server/dispatcher.js';
import { QuestStore } from '../../src/core/store.js';
import { MAX_BRIEF_BYTES } from '../../src/core/briefs.js';
import { makeProject, card } from '../helpers.js';

const wait = () => new Promise((r) => setTimeout(r, 10));
const okRunners = { session: async () => ({ code: 0 }), run: async () => ({ code: 0 }) };
const FILES_ELSEWHERE = '# T\n\n## Files you may edit\n- `src/elsewhere.js`\n';
const FILES_CANDIDATE = '# T\n\n## Files you may edit\n- `src/candidate.js`\n';

// RUN-1 is already dispatched (holding its slot) with a healthy, disjoint brief before RUN-2 is ever
// assigned, exactly like the review's repro — the initial check must pass cleanly for every scenario below.
function setupHeldAndCandidate(write, store) {
  const run1File = write('docs/briefs/RUN-1-running.md', FILES_ELSEWHERE);
  write('docs/briefs/RUN-2-candidate.md', FILES_CANDIDATE);
  store.post({ package: 'RUN-1', brief: 'docs/briefs/RUN-1-running.md', by: 'owner' });
  store.post({ package: 'RUN-2', brief: 'docs/briefs/RUN-2-candidate.md', by: 'owner' });
  store.assign('RUN-1', { adventurer: card('codex-luna'), name: 'run1', by: 'owner' });
  return run1File;
}

describe('dispatcher.assign queued-start recheck: another held quest turning unknown mid-queue (B1)', () => {
  it('fails RUN-2 when RUN-1\'s brief is padded past the size cap while RUN-2 waits its turn', async () => {
    const { config: realConfig, write } = makeProject();
    const store = new QuestStore(realConfig);
    const run1File = setupHeldAndCandidate(write, store);
    const dispatcher = createDispatcher({ config: realConfig, store, runners: okRunners });
    const result = dispatcher.assign('RUN-2', card('oc-mimo'), 'owner');
    assert.equal(result.status, 200, 'RUN-1 is healthy and disjoint at the initial check');
    fs.writeFileSync(run1File, `${FILES_ELSEWHERE}\n${'x'.repeat(MAX_BRIEF_BYTES + 1024)}\n`);
    await wait();
    const quest = store.get('RUN-2');
    assert.equal(quest.status, 'failed', 'an oversized held quest must block the queued recheck, not let it through');
    assert.match(quest.lastDetail, /RUN-1/);
  });

  it('fails RUN-2 when RUN-1\'s brief is deleted while RUN-2 waits its turn', async () => {
    const { config: realConfig, write } = makeProject();
    const store = new QuestStore(realConfig);
    const run1File = setupHeldAndCandidate(write, store);
    const dispatcher = createDispatcher({ config: realConfig, store, runners: okRunners });
    const result = dispatcher.assign('RUN-2', card('oc-mimo'), 'owner');
    assert.equal(result.status, 200);
    fs.rmSync(run1File);
    await wait();
    const quest = store.get('RUN-2');
    assert.equal(quest.status, 'failed', 'a deleted held quest brief must block the queued recheck too');
    assert.match(quest.lastDetail, /RUN-1/);
  });

  it('control: still fails RUN-2 when RUN-1\'s brief changes to a genuinely overlapping file', async () => {
    const { config: realConfig, write } = makeProject();
    const store = new QuestStore(realConfig);
    const run1File = setupHeldAndCandidate(write, store);
    const dispatcher = createDispatcher({ config: realConfig, store, runners: okRunners });
    const result = dispatcher.assign('RUN-2', card('oc-mimo'), 'owner');
    assert.equal(result.status, 200);
    fs.writeFileSync(run1File, FILES_CANDIDATE);
    await wait();
    const quest = store.get('RUN-2');
    assert.equal(quest.status, 'failed', 'a genuine overlap must still be caught (known-conflict control)');
    assert.match(quest.lastDetail, /RUN-1/);
  });

  it('control: an unchanged, healthy RUN-1 lets RUN-2 start', async () => {
    const { config: realConfig, write } = makeProject();
    const store = new QuestStore(realConfig);
    setupHeldAndCandidate(write, store);
    const dispatcher = createDispatcher({ config: realConfig, store, runners: okRunners });
    const result = dispatcher.assign('RUN-2', card('oc-mimo'), 'owner');
    assert.equal(result.status, 200);
    await wait();
    assert.equal(store.get('RUN-2').status, 'dispatched', 'nothing changed, so the queued recheck must let it start');
  });
});
