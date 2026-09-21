// Turns the outcome of a started dispatch plan into durable quest state: the "dispatched" announcement,
// the verified-never-started failure, and the preserve-as-unresolved paths for every ambiguous outcome (a
// queued recheck that changed the world, a session step whose effect is unknown, a run step with no
// evidence either way, a wrapper that reported an error). Extracted from dispatcher.js (FB2-S1) so the
// dispatcher stays within its file-size budget — the bodies are byte-for-byte the original.
import { workerEvidence } from '../core/dispatch.js';
import { attemptEvidence } from '../core/cancellation.js';

export function createDispatchSettlement({ config, store, stillOurs, safeguard, reportPersistenceFailure, nonDurable, evidenceWaitMs, delay }) {
  // A real start already happened (or, for a stalled quest, is presumed to still be running) — this is only
  // ever a supplementary "dispatched" event confirming it; the status itself is already 'dispatched' from
  // store.assign() before this attempt was even enqueued. An event-append failure here (F2: quests.jsonl or
  // events unwritable right after a real start) must never reach failIfStillOurs — nothing upstream of this
  // call turns a thrown error into a normal result the way executePlan's own onPhase awaits do, so an
  // unguarded throw would either become an unhandled rejection or bubble to the enqueue chain's top-level
  // `.catch`, which would then wrongly decide the attempt failed just because a *report* of the start could
  // not be written. Guarding it leaves the quest exactly as assign() already left it: 'dispatched', slot held.
  function announceStarted(questId, attempt, detail = `脚本已启动，worker ${attempt.name}`) {
    const current = stillOurs(questId, attempt);
    if (!current) return;
    const annotation = attempt.annotationSnapshot;
    safeguard('announceStarted', detail, () => store.emitEvent(current, 'dispatched', {
      by: 'board', detail,
      ...(annotation ? { annotationCount: annotation.count, annotationPage: annotation.page } : {}),
      ...(attempt.redoBackups?.length ? { backupCount: attempt.redoBackups.length, backupDirs: attempt.redoBackups.map((b) => b.backup) } : {}),
    }));
  }

  // One shared rendering for the warnings canDispatch returned for this attempt, so every path that
  // announces a start carries the variant warnings identically — the normal start and the "wrapper
  // reported an error but the worker started" fallback alike. With no warnings the join leaves the single
  // headline string, byte-identical to the announcements before this helper existed.
  function withWarnings(detail, warnings) {
    return [detail, ...(warnings || []).map(({ code, message }) => `警告 ${code}：${message}`)].join('\n');
  }

  function failIfStillOurs(questId, attempt, detail, evidence = { kind: 'never_started', attempt: attemptEvidence(attempt) }) {
    if (!stillOurs(questId, attempt)) return;
    safeguard('failIfStillOurs', detail, () => store.setStatus(questId, 'failed', { detail, by: 'board', source: 'dispatcher', evidence }));
  }

  // The enqueue chain's own generic top-level `.catch` (below, in assign()) is the last boundary before an
  // otherwise-unhandled rejection: every native callback and recheck path is already guarded and returns a
  // normal blocked/failed result executePlan or the .then above can judge by phase (R2's own inventory found
  // no realistic native path reaching here after an effect) — but an inventory of "nothing does this today"
  // is not a structural guarantee, and a runner override, a test double, or a future change could still throw
  // something unexpected after a step already ran. This boundary must not decide by enumeration; it decides
  // by the durable phase actually on record. Only a still-'queued' phase with no known session is verified
  // proof this attempt's plan never reached a single effect (executePlan's own onPhase write-ahead only ever
  // advances phase to 'session_creating'/'launching' strictly before the effect it announces runs) — anything
  // else (an unknown/'session_creating'/'launching' phase, or a known session regardless of phase) means an
  // effect may already have happened upstream, so the reservation is preserved and marked unresolved instead
  // of freed, exactly like every other ambiguous outcome in this file.
  function settleUnexpectedFailure(questId, attempt, detail) {
    const current = stillOurs(questId, attempt);
    if (!current) return;
    const assignee = current.assignee || {};
    const provenNeverStarted = assignee.phase === 'queued' && !(assignee.session && assignee.session.id);
    if (provenNeverStarted) { failIfStillOurs(questId, attempt, detail); return; }
    safeguard('settleUnexpectedFailure recordPhase', detail, () => store.recordPhase(questId, attempt, { unresolved: true }));
    safeguard('settleUnexpectedFailure status_note', detail, () => store.emitEvent(current, 'status_note', { by: 'board', detail }));
  }

  // A queued recheck (or a phase-persistence failure) that stopped the plan *after* a step already ran
  // (executePlan's phase is 'session_creating' or 'launching', not 'queued') is not proof this attempt never
  // started anything — a session step can create a real resource upstream even though the run step that
  // would have used it never fired. Calling failIfStillOurs here would clear the assignee and free the slot
  // as if nothing happened; instead this leaves status/assignee untouched (still 'dispatched', still holding
  // its slot) and records what's known as a note, so the ambiguity is visible rather than silently resolved
  // either way. A pure queue-not-started block (phase 'queued') has no such side effect to preserve and
  // keeps using failIfStillOurs, unchanged.
  function preserveAmbiguous(questId, attempt, result) {
    const current = stillOurs(questId, attempt);
    if (!current) return;
    const knownSessionId = result.session && !result.session.unknown && result.session.id ? result.session.id : null;
    const binding = !result.session ? '' : result.session.unknown ? '（session 是否建立不确定）' : `（已建 session ${result.session.id}）`;
    const detail = `排队等待期间条件变了，但前面的步骤可能已经生效${binding}，先保留占用，需要手动确认：${result.detail}`;
    // Both writes are guarded independently: a note event failing to persist must never fall through to
    // failIfStillOurs (that would flip an ambiguous, preserved attempt to a definite 'failed' just because
    // the *report* of the ambiguity could not be written), and neither write's failure may throw back out
    // of this function — see safeguard above. A known session's persistence-failure branch (executePlan's
    // own onPhase('session', ...) rejecting) is exactly what noted a non-durable stopgap for this attempt
    // (see requirement 5 in dispatch.js/nonDurableBindings.js). requirement 1 fix: a bare `{unresolved:
    // true}` retry that merely succeeds is not enough to call the durable record "current again" — it never
    // carries the session id anywhere (store.save() only updates the in-memory copy from what actually got
    // appended, and this write never mentions `session`), so the retry itself must re-offer the known
    // session id, and the stopgap is cleared only once *that exact* write durably lands.
    const recorded = safeguard('preserveAmbiguous recordPhase', detail, () => store.recordPhase(questId, attempt, { unresolved: true, ...(knownSessionId ? { session: result.session } : {}) }));
    if (recorded && knownSessionId) {
      const noted = nonDurable.getUnpersistedSession(questId, attempt.attemptId);
      // Only clear when this attempt's own noted id is the one that just landed durably — an entry that
      // already names a different id (should never happen: one attempt, one session) is left alone rather
      // than silently discarded on a coincidental match of quest+attempt alone.
      if (!noted || noted.sessionId === knownSessionId) nonDurable.clearUnpersistedSession(questId, attempt.attemptId);
    }
    safeguard('preserveAmbiguous status_note', detail, () => store.emitEvent(current, 'status_note', { by: 'board', detail }));
  }

  // A session step's own failure (nonzero exit, timeout, a caught throw) is not the wrapper-script failure
  // settleFailedWrapper is built for: workerEvidence only recognizes a dispatch script's registry row or
  // output file, which a session step never produces, so settleFailedWrapper would always time out and call
  // failIfStillOurs — definitively failing and freeing the slot on a step whose real-world effect is unknown.
  // Whenever the session binding itself is unknown (no captured id, so no proof either way), preserve the
  // reservation and mark the attempt unresolved instead, the same way a recheck's ambiguous block does.
  function settleAmbiguousSession(questId, attempt, result) {
    const current = stillOurs(questId, attempt);
    if (!current) return;
    const detail = `session 步骤失败但可能已经生效（session 是否建立不确定），先保留占用，需要手动确认：${result.detail}`;
    safeguard('settleAmbiguousSession recordPhase', detail, () => store.recordPhase(questId, attempt, { unresolved: true }));
    safeguard('settleAmbiguousSession status_note', detail, () => store.emitEvent(current, 'status_note', { by: 'board', detail }));
  }

  // A run step's own failure never erases a session that actually got created — the captured id already
  // names a real, possibly billable resource upstream, so the reservation stays exactly like an unknown
  // session binding does, regardless of what the run step itself proves or fails to prove.
  function preserveKnownSessionRun(questId, attempt, result) {
    const current = stillOurs(questId, attempt);
    if (!current) return;
    const detail = `已建 session ${result.session.id}，启动步骤失败或找不到证据证明没启动，先保留占用，需要手动确认：${result.detail}`;
    safeguard('preserveKnownSessionRun recordPhase', detail, () => store.recordPhase(questId, attempt, { unresolved: true }));
    safeguard('preserveKnownSessionRun status_note', detail, () => store.emitEvent(current, 'status_note', { by: 'board', detail }));
  }

  // The run step's own exit code, timeout or caught throw is not proof nothing started upstream (see
  // workerEvidence) — and after settleFailedWrapper waited and still found no evidence either way, that
  // absence is not proof of the opposite. Only a verified-never-started signal (runScript's own spawn
  // catch, surfaced as result.neverStarted — see settleFailedWrapper) may free the slot; anything else keeps
  // the reservation and marks it unresolved, the same way every other ambiguous outcome does.
  function preserveRunAmbiguous(questId, attempt, result) {
    const current = stillOurs(questId, attempt);
    if (!current) return;
    const detail = `启动步骤失败，等了一段时间也没找到证据证明没启动，先保留占用，需要手动确认：${result.detail}`;
    safeguard('preserveRunAmbiguous recordPhase', detail, () => store.recordPhase(questId, attempt, { unresolved: true }));
    safeguard('preserveRunAmbiguous status_note', detail, () => store.emitEvent(current, 'status_note', { by: 'board', detail }));
  }

  // workerEvidence reads the registry file directly (fs.readFileSync via readJsonLines) — a Windows sharing
  // violation, an EBUSY read against a registry the dispatch script is mid-write on, or any other read fault
  // throws. That throw is not evidence of absence any more than a read that cleanly returns nothing is: both
  // mean "we don't know", never "verified not started". Treating a read failure as if it were proof — by
  // letting it escape uncaught into this async function's rejection, which the enqueue chain's top-level
  // `.catch` would then hand to failIfStillOurs — is exactly the false failed/free state requirement 3 rules
  // out. Folding it into the same "no evidence this iteration" path a clean miss takes keeps the one honest
  // fallback (preserveRunAmbiguous, once the deadline passes) as the only outcome a read fault can ever reach.
  function readWorkerEvidence(laneId, name, sinceIso) {
    try {
      return { evidence: workerEvidence(config, laneId, name, sinceIso), readFailed: false };
    } catch (error) {
      reportPersistenceFailure('workerEvidence read', `${laneId}/${name}`, error, '读取失败');
      // F3: a read fault is "we don't know", never "verified not started" — callers must not treat it
      // like a clean miss.
      return { evidence: null, readFailed: true };
    }
  }

  // A wrapper's exit code is not the truth about its worker; wait for the registry row or output first.
  async function settleFailedWrapper(quest, laneId, attempt, result, warnings) {
    // A verified-never-started run step (runScript's own spawn-level catch, never an arbitrary throw from
    // some other layer — see dispatch.js) is the one signal strong enough to free the slot outright: nothing
    // could have started, so there is no evidence worth waiting for.
    if (result.neverStarted) { failIfStillOurs(quest.id, attempt, result.detail); return; }
    const started = (evidence) => announceStarted(quest.id, attempt, withWarnings(`脚本报错但 worker 已启动（${evidence}）：${result.detail.split('\n')[0]}`, warnings));
    // FB2-01.5 (条目 17.2): a genuine non-zero wrapper exit settles immediately. The wrapper appends its
    // registry row synchronously before it ever launches the worker, so once the wrapper process itself
    // has exited, the row and the .out it would have produced are either already there or never coming —
    // a single check is decisive, not a guess: no stall wait, no evidence deadline. Nothing there means
    // verified startup failure; fail now, with the wrapper log's own tail (result.detail already carries
    // tail(logFile)) as lastDetail.
    if (!result.thrown) {
      const read = readWorkerEvidence(laneId, attempt.name, quest.assignee.at);
      if (read.evidence) { started(read.evidence); return; }
      if (!read.readFailed) {
        failIfStillOurs(quest.id, attempt, `启动即败：包装脚本非零退出，注册表没有新登记、.out 也没出现。\n${result.detail}`);
        return;
      }
      // A registry read fault (F3) is not the clean absence FB2-01.5 needs: fall through to the bounded
      // wait below, where a recovering read can still find the row; preserve unresolved if none appears.
    }
    // A caught throw from a runner override (never runScript itself — its spawn failure arrives as
    // neverStarted) proves nothing about whether something started: keep the bounded evidence wait, and
    // preserve the reservation as unresolved if none appears.
    const deadline = Date.now() + evidenceWaitMs;
    for (;;) {
      const read = readWorkerEvidence(laneId, attempt.name, quest.assignee.at);
      if (read.evidence) { started(read.evidence); return; }
      if (Date.now() >= deadline) break;
      await delay(Math.min(2000, Math.max(0, deadline - Date.now())));
    }
    // No evidence by the deadline is absence, not proof: keep the reservation and mark it unresolved rather
    // than declaring the attempt failed and freeing its slot.
    preserveRunAmbiguous(quest.id, attempt, result);
  }

  return { announceStarted, withWarnings, failIfStillOurs, settleUnexpectedFailure, preserveAmbiguous, settleAmbiguousSession, preserveKnownSessionRun, preserveRunAmbiguous, settleFailedWrapper };
}
