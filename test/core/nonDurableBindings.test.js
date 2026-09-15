// Requirement 5: a tiny, explicitly non-durable stopgap for a session id captured right before its durable
// write-ahead record failed to persist. These are unit tests of the module in isolation, not of the
// dispatcher wiring (see test/server/dispatcherFaultRecovery.test.js for the integration path).
//
// R3: the bindings live behind a factory (createNonDurableBindings), one instance per dispatcher/project —
// never a module-level Map two unrelated projects sharing a process (the desktop app, a shared MCP server)
// could otherwise see or clear entries in for each other.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createNonDurableBindings, sanitizeUnpersistedSession } from '../../src/core/nonDurableBindings.js';

describe('nonDurableBindings', () => {
  it('remembers a session id keyed by quest and attempt, marked explicitly not persisted', () => {
    const bindings = createNonDurableBindings();
    const questId = `NDB-${Math.random()}`;
    const attemptId = 'attempt-1';
    assert.equal(bindings.getUnpersistedSession(questId, attemptId), null, 'nothing noted yet');
    bindings.noteUnpersistedSession(questId, attemptId, 'ses_abc', new Error('EISDIR: illegal operation on a directory'));
    const note = bindings.getUnpersistedSession(questId, attemptId);
    assert.equal(note.sessionId, 'ses_abc');
    assert.equal(note.persisted, false, 'never mistaken for a confirmed, restart-safe fact');
    assert.match(note.error, /EISDIR/);
    assert.ok(note.notedAt);
  });

  it('an old attempt can never collide with, or be overwritten by, a newer attempt on the same quest', () => {
    const bindings = createNonDurableBindings();
    const questId = `NDB-${Math.random()}`;
    bindings.noteUnpersistedSession(questId, 'attempt-old', 'ses_old', new Error('disk full'));
    bindings.noteUnpersistedSession(questId, 'attempt-new', 'ses_new', new Error('disk full again'));
    assert.equal(bindings.getUnpersistedSession(questId, 'attempt-old').sessionId, 'ses_old', 'the old attempt\'s own entry is untouched');
    assert.equal(bindings.getUnpersistedSession(questId, 'attempt-new').sessionId, 'ses_new');
    // Clearing the newer attempt's entry must never touch the older one's — they were never the same key.
    bindings.clearUnpersistedSession(questId, 'attempt-new');
    assert.equal(bindings.getUnpersistedSession(questId, 'attempt-new'), null);
    assert.equal(bindings.getUnpersistedSession(questId, 'attempt-old').sessionId, 'ses_old', 'clearing a different attempt never replaces or removes this one\'s metadata');
  });

  it('ignores a note with no quest id, attempt id or session id — never a stopgap for nothing', () => {
    const bindings = createNonDurableBindings();
    const questId = `NDB-${Math.random()}`;
    bindings.noteUnpersistedSession(questId, null, 'ses_x', new Error('x'));
    bindings.noteUnpersistedSession(null, 'attempt-1', 'ses_x', new Error('x'));
    bindings.noteUnpersistedSession(questId, 'attempt-1', null, new Error('x'));
    assert.equal(bindings.getUnpersistedSession(questId, null), null);
    assert.equal(bindings.getUnpersistedSession(questId, 'attempt-1'), null);
  });

  it('lists every attempt this process currently remembers a session for', () => {
    const bindings = createNonDurableBindings();
    const questId = `NDB-${Math.random()}`;
    bindings.noteUnpersistedSession(questId, 'attempt-list', 'ses_list', new Error('x'));
    const all = bindings.listUnpersistedSessions();
    assert.ok(all.some((entry) => entry.questId === questId && entry.attemptId === 'attempt-list' && entry.sessionId === 'ses_list'));
  });

  it('R3: two separate instances (as two projects\' dispatchers would each own) never share entries', () => {
    const questId = 'C-6';
    const projectA = createNonDurableBindings();
    const projectB = createNonDurableBindings();
    projectA.noteUnpersistedSession(questId, 'attempt-1', 'ses_a', new Error('a down'));
    projectB.noteUnpersistedSession(questId, 'attempt-1', 'ses_b', new Error('b down'));
    assert.equal(projectA.getUnpersistedSession(questId, 'attempt-1').sessionId, 'ses_a');
    assert.equal(projectB.getUnpersistedSession(questId, 'attempt-1').sessionId, 'ses_b');
    assert.deepEqual(projectA.listUnpersistedSessions().map((e) => e.sessionId), ['ses_a'], 'project A\'s listing never includes project B\'s entries');
    assert.deepEqual(projectB.listUnpersistedSessions().map((e) => e.sessionId), ['ses_b'], 'and vice versa');
    projectA.clearUnpersistedSession(questId, 'attempt-1');
    assert.equal(projectA.getUnpersistedSession(questId, 'attempt-1'), null);
    assert.equal(projectB.getUnpersistedSession(questId, 'attempt-1').sessionId, 'ses_b', 'clearing project A\'s entry never touches project B\'s identical (quest, attempt) key');
  });

  describe('sanitizeUnpersistedSession', () => {
    it('strips the raw error text, keeping only what a diagnostic reader needs', () => {
      const bindings = createNonDurableBindings();
      bindings.noteUnpersistedSession('Q-1', 'attempt-1', 'ses_x', new Error('ENOENT: /secret/path/env-with-token'));
      const sanitized = sanitizeUnpersistedSession(bindings.getUnpersistedSession('Q-1', 'attempt-1'));
      assert.deepEqual(Object.keys(sanitized).sort(), ['attemptId', 'notedAt', 'persisted', 'questId', 'sessionId']);
      assert.equal(sanitized.sessionId, 'ses_x');
      assert.equal(sanitized.persisted, false);
    });

    it('is null for nothing noted', () => {
      assert.equal(sanitizeUnpersistedSession(null), null);
    });
  });
});
