// A small, explicitly non-durable record of "what we last saw" for one dispatch attempt's session binding.
// It exists for exactly one situation: a session step captured a real id, but the durable write-ahead record
// of it (store.recordPhase, disk-first) failed to persist — the in-memory QuestStore map never advanced
// either (save() sets memory only after the append succeeds), so without this the id survives nowhere but a
// stderr line. This module never becomes a substitute for that durable record: nothing reads it to decide a
// transition, nothing replays it into the store, and after a restart it is gone like any other process
// memory — nothing here is ever reconstructed into a durable fact. It is a live, in-process diagnostic
// surface only: nothing more than what reportPersistenceFailure already writes to stderr, kept queryable in
// structured form instead of prose while the process is still running.
//
// Keyed by (questId, attemptId): every attempt gets a fresh attemptId (store.assign()/adopt()), so an old
// attempt's entry can never collide with, or be overwritten by, a newer attempt's. No ordering or "is this
// newer" logic is needed to protect against that — they simply never share a key.
//
// A factory, not a module-level singleton: one project's dispatcher must never see, or be able to clear,
// another project's noted sessions just because both happen to run in the same process (the desktop app and
// a shared MCP server both host more than one project's dispatcher). createDispatcher owns exactly one of
// these per project/config; nothing outside this module or its owner ever reaches into another instance.
export function createNonDurableBindings() {
  const bindings = new Map();

  function key(questId, attemptId) {
    return `${questId}::${attemptId}`;
  }

  // Records the last known session id for an attempt whose durable persistence just failed. `persisted:
  // false` is part of the record on purpose — a reader must never mistake this for a confirmed, restart-safe
  // fact, only for "this process still remembers seeing it".
  function noteUnpersistedSession(questId, attemptId, sessionId, error) {
    if (!questId || !attemptId || !sessionId) return;
    bindings.set(key(questId, attemptId), {
      questId, attemptId, sessionId, persisted: false,
      error: error ? String(error.message || error) : null,
      notedAt: new Date().toISOString(),
    });
  }

  function getUnpersistedSession(questId, attemptId) {
    return bindings.get(key(questId, attemptId)) || null;
  }

  // Called only once a later durable write for this same attempt lands the same session id — a bare
  // `{unresolved: true}` phase write, or a status-only note, never mentions `session` at all, so it can
  // never make the durable record "current again" on its own and must never clear this entry. Never a
  // time- or status-driven sweep: an attempt that never gets that exact durable write keeps its entry for
  // as long as this process runs, which is the honest answer for "was this ever durably resolved".
  function clearUnpersistedSession(questId, attemptId) {
    bindings.delete(key(questId, attemptId));
  }

  // Diagnostic-only: every attempt this process currently remembers a session for that its own durable record
  // does not (yet, or ever) confirm.
  function listUnpersistedSessions() {
    return [...bindings.values()];
  }

  return { noteUnpersistedSession, getUnpersistedSession, clearUnpersistedSession, listUnpersistedSessions };
}

// A sanitized, read-only view fit for an HTTP response: the raw note's `error` can carry a filesystem path,
// a command's stderr, or other operational detail never meant for a quest-detail consumer — only the
// questId/attemptId/sessionId/persisted/notedAt facts a diagnostic reader needs ("this process still
// remembers a session id here that never became durable") are exposed. Never session secrets, commands or
// env: this module never stored those to begin with.
export function sanitizeUnpersistedSession(note) {
  if (!note) return null;
  const { questId, attemptId, sessionId, persisted, notedAt } = note;
  return { questId, attemptId, sessionId, persisted, notedAt };
}
