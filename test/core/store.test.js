import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { QuestStore } from '../../src/core/store.js';
import { readJsonLines } from '../../src/core/jsonl.js';
import { eventsAfter, readEvents } from '../../src/core/events.js';
import { makeProject, card } from '../helpers.js';

let project;
let store;
const events = () => readJsonLines(project.config.paths.events);

beforeEach(() => {
  project = makeProject();
  store = new QuestStore(project.config);
});

describe('QuestStore', () => {
  it('posts with a title from the brief and emits posted', () => {
    const { quest } = store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-the-way-back.md', conflicts: 'RUN-3', allowedLanes: 'codex,agy' });
    assert.equal(quest.title, 'the way back');
    assert.deepEqual(quest.conflicts, ['RUN-3']);
    assert.deepEqual(quest.allowedLanes, ['codex', 'agy']);
    assert.equal(events()[0].event, 'posted');
  });

  it('rejects bad fields, naming the project lanes and brief dirs', () => {
    const { errors } = store.post({ package: 'run4', brief: '../x.md', kind: 'poem', allowedLanes: 'ftp', priority: 9, parents: 'nope' });
    assert.ok(errors.package && errors.kind && errors.priority && errors.parents);
    assert.match(errors.allowedLanes, /this project defines codex, claude, agy, dsh, opencode/);
    assert.match(store.post({ package: 'RUN-4', brief: '../x.md' }).errors.brief, /docs\/briefs/);
  });

  it('accepts dispatchable briefs only in dispatchDirs, owner briefs also in ownerDirs', () => {
    for (const brief of ['.env', 'docs/briefs/../../.env', 'docs/briefs/sub/x.md', 'docs/design/RUN-7.md']) {
      assert.ok(store.post({ package: 'RUN-7', brief }).errors.brief, brief);
    }
    assert.equal(store.post({ package: 'ARC-3', kind: 'owner', brief: 'docs/design/ARC-3.md' }).quest.brief, 'docs/design/ARC-3.md');
  });

  it('holds a quest for a ruling and releases it on the ruling', () => {
    const { quest } = store.post({ package: 'ARC-3', brief: 'docs/briefs/ARC-3-x.md', needsOwner: '三个点选哪个' });
    assert.equal(quest.status, 'needs_owner');
    const ruled = store.rule('ARC-3', { text: '选第二个' });
    assert.equal(ruled.status, 'posted');
    assert.equal(ruled.rulings[0].question, '三个点选哪个');
    assert.equal(quest.status, 'needs_owner', 'earlier snapshot is not mutated');
  });

  it('assigns with an assigned event, adopts with dispatched, and refuses a re-post while running', () => {
    store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
    const running = store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4' });
    assert.equal(running.assignee.family, 'gpt-5.6-luna');
    assert.equal(events().at(-1).event, 'assigned');
    assert.ok(store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' }).errors.package);
    store.post({ package: 'RUN-3', brief: 'docs/briefs/RUN-3-x.md' });
    const adopted = store.assign('RUN-3', { adventurer: card('codex-luna'), name: 'run3', event: 'dispatched', adopted: true });
    assert.equal(adopted.assignee.adopted, true);
    assert.equal(events().at(-1).event, 'dispatched');
  });

  it('numbers events and bumps the revision on every change, continuing after a restart', () => {
    const { quest } = store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
    assert.equal(quest.revision, 1);
    const running = store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4', requestKey: 'k1' });
    assert.equal(running.revision, 2);
    assert.equal(running.assignee.requestKey, 'k1');
    assert.equal(store.setStatus('RUN-4', 'delivered').revision, 3);
    assert.deepEqual(events().map((e) => e.seq), [1, 2, 3]);
    const reopened = new QuestStore(project.config);
    assert.equal(reopened.get('RUN-4').revision, 3);
    reopened.setStatus('RUN-4', 'done');
    assert.equal(events().at(-1).seq, 4);
  });

  it('numbers legacy event lines by position so cursors stay lossless', () => {
    fs.mkdirSync(path.dirname(project.config.paths.events), { recursive: true });
    fs.writeFileSync(project.config.paths.events, '{"at":"2026-09-01T00:00:00Z","event":"posted","package":"OLD-1"}\n{"at":"2026-09-01T00:00:01Z","event":"done","package":"OLD-1"}\n');
    const fresh = new QuestStore(project.config);
    fresh.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
    assert.deepEqual(readEvents(project.config.paths.events).map((e) => e.seq), [1, 2, 3]);
    assert.deepEqual(eventsAfter(project.config.paths.events, { after: 2 }).map((e) => e.package), ['RUN-4']);
    assert.deepEqual(eventsAfter(project.config.paths.events, { after: 0, limit: 1, pkg: 'OLD-1' }).map((e) => e.event), ['posted']);
  });

  it('keeps the worker through a stall and frees it only on release', () => {
    store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
    store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4' });
    assert.throws(() => store.release('RUN-4', {}), /running/);
    assert.equal(store.setStatus('RUN-4', 'stalled', { detail: 'no output' }).assignee.name, 'run4');
    const freed = store.release('RUN-4', { by: 'owner', detail: 'process gone' });
    assert.deepEqual([freed.assignee, freed.status], [null, 'stalled']);
    assert.deepEqual([events().at(-1).event, events().at(-1).name, events().at(-1).detail], ['released', 'run4', 'process gone']);
    assert.throws(() => store.release('RUN-4', {}), /no worker/);
    assert.equal(store.setStatus('RUN-4', 'failed', { detail: 'exit 3' }).assignee, null, 'an exit still clears the worker');
  });

  it('keeps the assignee in the event when a status clears it, and replays after restart', () => {
    store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
    store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4' });
    assert.equal(store.setStatus('RUN-4', 'failed', { detail: 'exit 3' }).assignee, null);
    assert.equal(events().at(-1).model, 'gpt-5.6-luna');
    assert.throws(() => store.setStatus('RUN-4', 'exploded'));
    assert.equal(new QuestStore(project.config).get('RUN-4').status, 'failed');
  });
});
