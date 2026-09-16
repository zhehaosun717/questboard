import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { QuestStore } from '../../src/core/store.js';
import { appendJsonLine, readJsonLines } from '../../src/core/jsonl.js';
import { makeProject, card } from '../helpers.js';

// Scenarios S1-S8 from the delivery-dedup review, kept as executable regression tests. A terminal
// status (delivered/failed/bounced) is a fact of one attempt: it fires its event once, and any later
// report of the same fact is a note, never a second event.

let project;
let store;

const events = () => readJsonLines(project.config.paths.events);
const deliveredCount = () => events().filter((event) => event.event === 'delivered').length;
const questsPath = () => path.join(project.config.paths.data, 'quests.jsonl');

const assigned = () => {
  store.post({ package: 'RUN-4', brief: 'docs/briefs/RUN-4-x.md' });
  return store.assign('RUN-4', { adventurer: card('codex-luna'), name: 'run4' });
};

beforeEach(() => {
  project = makeProject();
  store = new QuestStore(project.config);
});

describe('terminal status dedup', () => {
  it('keeps one delivered event when a failed quest is re-delivered for the same attempt (S1)', () => {
    assigned();
    store.setStatus('RUN-4', 'delivered', { detail: 'report A' });
    store.setStatus('RUN-4', 'failed', { detail: 'owner killed it', by: 'owner' });
    const back = store.setStatus('RUN-4', 'delivered', { detail: 'report A' });

    assert.equal(back.status, 'delivered');
    assert.equal(back.lastDetail, 'report A');
    assert.equal(deliveredCount(), 1);
    assert.equal(events().filter((event) => event.event === 'failed').length, 1);
    assert.equal(events().at(-1).event, 'status_note');

    const reopened = new QuestStore(project.config);
    assert.equal(reopened.get('RUN-4').status, 'delivered');
    assert.equal(reopened.get('RUN-4').lastDetail, 'report A');

    const before = events().length;
    const revision = reopened.get('RUN-4').revision;
    const again = reopened.setStatus('RUN-4', 'delivered', { detail: 'report A' });
    assert.equal(again.revision, revision);
    assert.equal(events().length, before);
    assert.equal(deliveredCount(), 1);
  });

  it('restores the first delivered detail when work comes back from reviewing (S2)', () => {
    assigned();
    store.setStatus('RUN-4', 'delivered', { detail: 'report A' });
    store.setStatus('RUN-4', 'reviewing', { detail: '' });
    const back = store.setStatus('RUN-4', 'delivered', { detail: 'report A' });

    assert.equal(back.lastDetail, 'report A');
    assert.equal(deliveredCount(), 1);
    assert.equal(events().at(-1).event, 'status_note');

    const reopened = new QuestStore(project.config);
    assert.equal(reopened.get('RUN-4').lastDetail, 'report A');
    reopened.setStatus('RUN-4', 'reviewing', { detail: 'still checking' });
    reopened.setStatus('RUN-4', 'delivered', { detail: 'report A' });
    assert.equal(reopened.get('RUN-4').lastDetail, 'report A');
    assert.equal(deliveredCount(), 1);
  });

  it('names the move back to a terminal status when no detail is given (S2b)', () => {
    assigned();
    store.setStatus('RUN-4', 'delivered', { detail: 'report A' });
    store.setStatus('RUN-4', 'reviewing', { detail: 'checking' });
    store.setStatus('RUN-4', 'delivered', { detail: '' });

    assert.equal(deliveredCount(), 1);
    assert.equal(store.get('RUN-4').lastDetail, 'report A');
    const note = events().at(-1);
    assert.equal(note.event, 'status_note');
    assert.equal(note.detail, '状态改回 delivered');
  });

  it('emits nothing while quests.jsonl cannot be written and delivers once after recovery (S3)', () => {
    assigned();
    const file = questsPath();
    const original = fs.readFileSync(file, 'utf8');
    fs.rmSync(file);
    fs.mkdirSync(file);

    for (let i = 0; i < 3; i += 1) {
      assert.throws(() => store.setStatus('RUN-4', 'delivered', { detail: 'done' }), /EISDIR/);
    }
    assert.equal(store.get('RUN-4').status, 'dispatched');
    assert.equal(deliveredCount(), 0);

    fs.rmSync(file, { recursive: true });
    fs.writeFileSync(file, original);

    const next = store.setStatus('RUN-4', 'delivered', { detail: 'done' });
    assert.equal(next.status, 'delivered');
    assert.equal(deliveredCount(), 1);
    assert.equal(new QuestStore(project.config).get('RUN-4').status, 'delivered');
  });

  it('keeps the pending fact durable when the events file cannot be appended, then appends once (S4)', () => {
    assigned();
    const file = project.config.paths.events;
    const original = fs.readFileSync(file, 'utf8');
    fs.rmSync(file);
    fs.mkdirSync(file);

    assert.throws(() => store.setStatus('RUN-4', 'delivered', { detail: 'done' }), /EISDIR/);
    const held = store.get('RUN-4');
    assert.equal(held.status, 'dispatched');
    assert.equal(held.terminalFact.eventPending.status, 'delivered');

    fs.rmSync(file, { recursive: true });
    fs.writeFileSync(file, original);

    const reopened = new QuestStore(project.config);
    assert.equal(reopened.get('RUN-4').terminalFact.eventPending.status, 'delivered');
    const next = reopened.setStatus('RUN-4', 'delivered', { detail: 'done' });
    assert.equal(next.status, 'delivered');
    assert.equal(next.terminalFact.eventPending, undefined);
    assert.equal(deliveredCount(), 1);
  });

  it('survives a listener that throws and still records the event once (S5)', () => {
    assigned();
    let thrown = false;
    store.on('event', (event) => {
      if (event.event === 'delivered' && !thrown) {
        thrown = true;
        throw new Error('listener boom');
      }
    });

    const chunks = [];
    const original = process.stderr.write;
    process.stderr.write = (chunk) => {
      chunks.push(String(chunk));
      return true;
    };
    let next;
    try {
      next = store.setStatus('RUN-4', 'delivered', { detail: 'done' });
    } finally {
      process.stderr.write = original;
    }

    assert.equal(next.status, 'delivered');
    assert.equal(next.terminalFact.eventPending, undefined);
    assert.equal(deliveredCount(), 1);
    assert.match(chunks.join(''), /listener/);

    const again = store.setStatus('RUN-4', 'delivered', { detail: 'done' });
    assert.equal(again.status, 'delivered');
    assert.equal(deliveredCount(), 1);
  });

  it('re-appends one duplicate delivered event after a double fault (documented at-least-once)', () => {
    assigned();
    const realSave = store.save.bind(store);
    let trips = 1;
    store.save = (...args) => {
      if (trips > 0) {
        trips -= 1;
        throw new Error('disk full');
      }
      return realSave(...args);
    };

    assert.throws(() => store.setStatus('RUN-4', 'delivered', { detail: 'done' }), /disk full/);
    assert.equal(store.get('RUN-4').status, 'dispatched');
    assert.equal(store.get('RUN-4').terminalFact.eventPending.status, 'delivered');
    // The append already landed before the final save failed, so the retry re-sends it exactly once.
    assert.equal(deliveredCount(), 1);

    store.save = realSave;
    const retried = store.setStatus('RUN-4', 'delivered', { detail: 'done' });
    assert.equal(retried.status, 'delivered');
    assert.equal(retried.terminalFact.eventPending, undefined);
    assert.equal(deliveredCount(), 2);
  });

  it('never lets a legacy fact without an attemptId suppress a newer attempt (S7)', () => {
    assigned();
    const legacyAttempt = { ...store.get('RUN-4').assignee };
    delete legacyAttempt.attemptId;
    appendJsonLine(questsPath(), {
      ...store.get('RUN-4'),
      assignee: legacyAttempt,
      dispatches: [legacyAttempt],
      revision: store.get('RUN-4').revision + 1,
    });

    const legacy = new QuestStore(project.config);
    legacy.setStatus('RUN-4', 'delivered', { detail: 'legacy done' });
    assert.equal(legacy.get('RUN-4').terminalFact.attemptId, null);

    const fresh = { ...legacyAttempt, attemptId: 'fresh-uuid' };
    appendJsonLine(questsPath(), {
      ...legacy.get('RUN-4'),
      status: 'dispatched',
      assignee: fresh,
      dispatches: [legacyAttempt, fresh],
      revision: legacy.get('RUN-4').revision + 1,
    });

    const rebuilt = new QuestStore(project.config);
    const before = deliveredCount();
    rebuilt.setStatus('RUN-4', 'reviewing', { detail: 'checking' });
    rebuilt.setStatus('RUN-4', 'delivered', { detail: 'report B' });

    assert.equal(deliveredCount() - before, 1);
    assert.equal(rebuilt.get('RUN-4').terminalFact.attemptId, 'fresh-uuid');
  });
});
