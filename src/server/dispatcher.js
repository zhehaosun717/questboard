// Turns owner picks into running workers and lane results into quest statuses.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canDispatch, OPEN_STATUSES } from '../core/rules.js';
import { workerName, planDispatch, executePlan, preflight, workerEvidence, recordedNames } from '../core/dispatch.js';
import { deriveTransitions } from '../core/sync.js';
import { withFileSets } from '../core/briefs.js';
import { lockPresent, briefExists, briefUnusable } from '../core/snapshot.js';
import { writeApiDelivery, TRANSIENT_DELIVERY_CODES } from '../core/deliveries.js';
import { sameAttempt } from '../core/store.js';
import { attemptEvidence } from '../core/cancellation.js';
import { captureAttemptReport } from '../core/reportEvidence.js';
import { createNonDurableBindings, sanitizeUnpersistedSession } from '../core/nonDurableBindings.js';
import { createGenericWrapperAdapter } from './workerControlAdapters.js';

const EVIDENCE_WAIT_MS = 10000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Terminal transitions are the only ones that may bind a report reference: stalled/dispatched are silence
// or a retry, not an ending, and a report captured for them would be partial evidence presented as final.
const TERMINAL_STATUSES = new Set(['delivered', 'failed', 'bounced']);

// A pending delivery write is tracked by the attempt it belongs to, not by quest id: two different attempts
// of the same quest (an old one whose write is still hung, a new one after a reassignment) must never share
// one slot. Keying by quest id alone let a hung old write block every later attempt's delivery indefinitely
// (applyLanes would skip the quest entirely while the entry existed), and let that old write's own .finally
// clear an entry that, by the time it settled, actually belonged to a newer attempt. attemptId is always
// minted by store.assign()/adopt(); the name+lane+at fallback only serves a legacy row that predates it.
function attemptKey({ attemptId, name, lane, at }) {
  return attemptId || `${name}:${lane || ''}:${at}`;
}

export function createDispatcher({ config, store, runners, evidenceWaitMs = EVIDENCE_WAIT_MS, writeDelivery = writeApiDelivery, getDownLanes = () => null, getAdventurer }) {
  const queues = new Map();
  const pendingDeliveries = new Set();
  const controlHandles = new Map();
  const dispatcherInstanceId = randomUUID();
  const genericWrapper = createGenericWrapperAdapter({ config });
  // One instance per project/dispatcher, never a module-level singleton (requirement 5/R3): two projects'
  // dispatchers sharing a process (the desktop app, a shared MCP server) must never see or clear each
  // other's noted sessions just because both happen to run here.
  const nonDurable = createNonDurableBindings();
  // The last transient delivery-write notice per quest id, so a fast poll loop reports "still running"
  // once per attempt instead of every tick. Bounded: an entry exists only while that quest is stuck in a
  // transient retry, and is dropped the moment the attempt resolves (delivered, terminally failed, or the
  // quest moves on to a new assignment) — never accumulates across quests or attempts.
  const transientNotices = new Map();

  // Clears this attempt's own transient-notice entry only when it is still the one actually recorded there —
  // a stale attempt's late-settling write (a slow success or failure that finally resolves after the quest
  // moved on to a newer attempt) must never wipe out a newer attempt's own de-dup entry just because both
  // happen to share the same quest id; that would only cause the newer attempt's next identical failure to
  // be reported again instead of folded.
  function clearOwnNotice(questId, ownKey) {
    const last = transientNotices.get(questId);
    if (last && last.key === ownKey) transientNotices.delete(questId);
  }

  // A stalled quest still belongs to its worker, so a late callback from it counts. `attempt` is the
  // specific assignment's own identity (store.assign mints a fresh attemptId every time, even a same-named
  // re-adopt or a re-assignment landing in the same millisecond), so a stale async completion from an old
  // attempt can never land on a newer assignment or a cancellation — compared by attempt, never by name alone.
  const stillOurs = (questId, attempt) => {
    const current = store.get(questId);
    return current && (current.status === 'dispatched' || current.status === 'stalled') && sameAttempt(current.assignee, attempt) ? current : null;
  };

  // Lanes marked serialize run one dispatch at a time (OpenCode's send script shares a session file);
  // spacingMs waits between starts (the DeepSeek harness races on simultaneous starts).
  function enqueue(laneId, job) {
    const lane = config.lanes[laneId];
    if (!lane.serialize && !lane.spacingMs) return job();
    const previous = queues.get(laneId) || Promise.resolve();
    const run = previous.then(job);
    queues.set(laneId, run.catch(() => null).then(() => delay(lane.spacingMs)));
    return run;
  }

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
    safeguard('announceStarted', detail, () => store.emitEvent(current, 'dispatched', { by: 'board', detail }));
  }

  // A bounded, guarded diagnostic sink for a persistence op that failed inside one of the settle/preserve
  // paths below — never raw secrets (env values, tokens), just the human-facing detail already produced for
  // the quest itself. Wrapped in its own try/catch: even the sink can be gone (a closed stderr) and that must
  // not become yet another throw.
  function reportPersistenceFailure(label, detail, error) {
    try { process.stderr.write(`[dispatcher] ${label} 没能写盘（${error && error.message}）：${String(detail).slice(0, 500)}\n`); } catch { /* nothing left to report to */ }
  }

  // Runs a store write (recordPhase/emitEvent/setStatus) from inside an async settle/preserve callback,
  // where nothing upstream is left to turn a thrown error into a normal blocked/ambiguous result the way
  // executePlan's own onPhase awaits do. Left unguarded, a disk failure here would either become an
  // unhandled rejection (killing the process) or escape to the enqueue chain's own top-level `.catch`, which
  // would then wrongly decide the attempt failed just because a *report* of what actually happened could
  // not be written. Swallowing it here — after reporting it — is what keeps "we could not persist this" from
  // ever silently deciding an ambiguous outcome either way. Returns whether fn actually completed, so a
  // caller that needs to know (e.g. to clear a non-durable stopgap once the durable write finally succeeds)
  // can, without every other caller having to look at a return value it doesn't need.
  function safeguard(label, detail, fn) {
    try { fn(); return true; } catch (error) { reportPersistenceFailure(label, detail, error); return false; }
  }

  // Binds a terminal transition to the report file the attempt actually left behind (item 7): resolved
  // only through the lane's own configured delivery/output directories and this attempt's worker name,
  // never a caller-supplied path (see core/reportEvidence.js). Never throws — a capture failure (an
  // unreadable directory, a broken symlink, a file vanishing mid-read) must not replace the durable status
  // decision the caller is about to make; it is reported like any other persistence shortfall and the
  // transition proceeds with no reference, which the surfaces render as 报告不可用.
  function captureReportFor(quest) {
    try { return captureAttemptReport({ config, quest }); } catch (error) { reportPersistenceFailure('captureAttemptReport', quest.id, error); return null; }
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
    const detail = `排队等待期间条件变了，但前面的步骤可能已经生效${binding}，先保留占用，需要人工确认：${result.detail}`;
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
    const detail = `session 步骤失败但可能已经生效（session 是否建立不确定），先保留占用，需要人工确认：${result.detail}`;
    safeguard('settleAmbiguousSession recordPhase', detail, () => store.recordPhase(questId, attempt, { unresolved: true }));
    safeguard('settleAmbiguousSession status_note', detail, () => store.emitEvent(current, 'status_note', { by: 'board', detail }));
  }

  // A run step's own failure never erases a session that actually got created — the captured id already
  // names a real, possibly billable resource upstream, so the reservation stays exactly like an unknown
  // session binding does, regardless of what the run step itself proves or fails to prove.
  function preserveKnownSessionRun(questId, attempt, result) {
    const current = stillOurs(questId, attempt);
    if (!current) return;
    const detail = `已建 session ${result.session.id}，启动步骤失败或找不到证据证明没启动，先保留占用，需要人工确认：${result.detail}`;
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
    const detail = `启动步骤失败，等了一段时间也没找到证据证明没启动，先保留占用，需要人工确认：${result.detail}`;
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
    try { return workerEvidence(config, laneId, name, sinceIso); } catch (error) { reportPersistenceFailure('workerEvidence read', `${laneId}/${name}`, error); return null; }
  }

  // A wrapper's exit code is not the truth about its worker; wait for the registry row or output first.
  async function settleFailedWrapper(quest, laneId, attempt, result) {
    // A verified-never-started run step (runScript's own spawn-level catch, never an arbitrary throw from
    // some other layer — see dispatch.js) is the one signal strong enough to free the slot outright: nothing
    // could have started, so there is no evidence worth waiting for.
    if (result.neverStarted) { failIfStillOurs(quest.id, attempt, result.detail); return; }
    const deadline = Date.now() + evidenceWaitMs;
    for (;;) {
      const evidence = readWorkerEvidence(laneId, attempt.name, quest.assignee.at);
      if (evidence) { announceStarted(quest.id, attempt, `脚本报错但 worker 已启动（${evidence}）：${result.detail.split('\n')[0]}`); return; }
      if (Date.now() >= deadline) break;
      await delay(Math.min(2000, Math.max(0, deadline - Date.now())));
    }
    // No evidence by the deadline is absence, not proof: keep the reservation and mark it unresolved rather
    // than declaring the attempt failed and freeing its slot.
    preserveRunAmbiguous(quest.id, attempt, result);
  }

  // The same request sent twice (a retried MCP call, a double click) must not start a second worker.
  function repeated(quest, requestKey) {
    return Boolean(requestKey) && (quest.dispatches || []).some((d) => d.requestKey === requestKey);
  }

  // A caller that decided on revision N gets a refusal, not a dispatch, if the quest changed since.
  function staleRevision(quest, ifRevision) {
    if (ifRevision === undefined || ifRevision === null) return null;
    const current = quest.revision || 0;
    if (Number(ifRevision) === current) return null;
    return { status: 409, body: { error: 'stale', revision: current, reasons: [{ code: 'stale_revision', message: `任务在你读取之后改过（现在是第 ${current} 版，你按第 ${ifRevision} 版派的），重新读一次再派` }] } };
  }

  // Same set of values as key(field) for every entry of both objects: order-insensitive, and a key present
  // on only one side (added or removed) counts as a difference just like a changed value would.
  function sameEnv(a = {}, b = {}) {
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const key of keys) if (a[key] !== b[key]) return false;
    return true;
  }

  // The plan already built (its command, its env) describes the card exactly as it was at assign time — not
  // whatever the card looks like now. A lane, model, variant or agent change since then means running that
  // plan would spawn the wrong thing entirely; an env change means the plan carries stale credentials/config
  // even if the command looks the same. None of that is a live-appropriate detail for canDispatch to weigh
  // against the fresh card — comparing them is a plain equality check against what was captured, and a
  // mismatch is always a refusal, never a silent "run the fresh version instead" reroute.
  function samePlannedExecution(planned, fresh) {
    return planned.lane === fresh.lane && planned.model === fresh.model && (planned.variant || '') === (fresh.variant || '')
      && (planned.agent || '') === (fresh.agent || '') && sameEnv(planned.env, fresh.env);
  }

  // Builds the env canDispatch needs, fresh each time it's called — once at drop time and again, from a
  // fresh read, for every queued recheck.
  function dispatchEnv(quest) {
    return { treeLocked: lockPresent(config), briefExists: briefExists(config, quest), briefUnusable: briefUnusable(config, quest), laneIds: new Set(Object.keys(config.lanes)), ...(getDownLanes() ? { downLanes: getDownLanes() } : {}) };
  }

  // Re-read the quest and re-run canDispatch in full right before this attempt actually spawns something —
  // called from inside executePlan, so it runs once before the session step and again before the run step,
  // catching a lane-queue wait and the async gap between the two alike. A job whose attempt is no longer
  // the quest's current one (reassigned, released, cancelled while queued) never starts, full stop — no
  // predicate below that point matters. One still current is judged by canDispatch's complete, unfiltered
  // reason set (selfAttemptId only tells it this quest's own 'dispatched'/'stalled' state is not a foreign
  // block) — a newly posted needs_owner, a card paused or banned meanwhile, a changed allowedLanes, a
  // parent/reviewer constraint, are all still live here exactly as they would be for a fresh assign(). The
  // adventurer itself is re-resolved fresh (roster status, lane, policy) rather than reusing the object
  // captured at drop time, so a card paused after the drop is caught even though nothing about the local
  // closure changed. `getAdventurer` being absent entirely (no resolver wired — the default, e.g. in a unit
  // test that never passes one) is a different fact from a resolver that *is* wired reporting the card gone:
  // no resolver means this dispatcher has no way to know better, so it stays on the captured object, exactly
  // as before this fix. A real resolver returning nothing means the roster no longer has this card — refuse
  // to start rather than silently reuse the stale captured card for a removed adventurer.
  function recheckOpen(questId, attempt, adventurer, planned) {
    const current = store.get(questId);
    if (current?.cancelRequest?.attemptId === attempt.attemptId) return { ok: false, detail: '该派遣已有取消请求，取消确认前不会启动新的效果' };
    if (!stillOurs(questId, attempt)) return { ok: false, detail: '排队等待期间任务被改派、释放或取消，这次派遣不会执行' };
    // withFileSets, same as the initial check: runningConflict (behind conflict_running) reads quest.files
    // and quest.conflictKeys. This attempt already holds its own slot (store.assign ran before it was
    // enqueued), so without recheckingId it would be treated as an already-settled occupant and only ever
    // receive its own conflict key back — never another held quest's — masking exactly the conflict this
    // recheck exists to catch (B1). Passing questId here judges it as the fresh candidate it actually is.
    const quests = withFileSets(config, store.list(), { recheckingId: questId });
    const quest = quests.find((q) => q.id === questId);
    let fresh = adventurer;
    if (getAdventurer) {
      let resolved;
      try {
        resolved = getAdventurer(adventurer.id);
      } catch (error) {
        // A resolver that IS wired but cannot answer (a locked roster file, a thrown error) is no more
        // trustworthy than one that answered "gone" — fail closed the same way, never let the exception
        // silently fall through to the stale captured card.
        return { ok: false, detail: `排队等待期间条件变了，这次不派遣了：查询名册出错，先不派（${error.message}）` };
      }
      if (!resolved) return { ok: false, detail: `排队等待期间条件变了，这次不派遣了：${adventurer.name} 这张卡已经不在名册里了` };
      fresh = resolved;
      // The card itself changed since the plan was built (a different lane, model, variant, agent or env) —
      // refuse outright rather than judge the fresh card's own new lane's health (that would check the wrong
      // lane entirely, since the plan that is actually about to run still targets the old one) or silently
      // rebuild a plan for the new configuration (which could reroute onto a different, possibly paid, lane
      // nobody asked for). The message never echoes the actual values, env included.
      if (planned && !samePlannedExecution(planned, fresh)) {
        return { ok: false, detail: `排队等待期间条件变了，这次不派遣了：卡片配置变了（通道/模型/变体/人格或环境变量），重新派一次` };
      }
    }
    const verdict = canDispatch({ quest, adventurer: fresh, quests, policy: config.policy, env: dispatchEnv(quest), selfAttemptId: attempt.attemptId });
    if (!verdict.ok) return { ok: false, detail: `排队等待期间条件变了，这次不派遣了：${verdict.reasons.map((r) => r.message).join('；')}` };
    return { ok: true };
  }

  // Synchronous from the fresh read to store.assign, so two quick drops cannot both pass the checks.
  function assign(questId, adventurer, by, { requestKey = null, ifRevision } = {}) {
    const quests = withFileSets(config, store.list());
    const quest = quests.find((q) => q.id === questId);
    if (!quest) return { status: 404, body: { error: 'quest not found' } };
    if (repeated(quest, requestKey)) return { status: 200, body: { quest: store.get(questId), repeated: true } };
    const stale = staleRevision(quest, ifRevision);
    if (stale) return stale;
    const verdict = canDispatch({ quest, adventurer, quests, policy: config.policy, env: dispatchEnv(quest) });
    if (!verdict.ok) return { status: 409, body: { error: 'refused', reasons: verdict.reasons } };
    // Every name this project has ever recorded, not just currently-held ones: a finished quest's name is
    // still its report/session/output file on disk, and package-id normalization can land two different
    // quests (one now finished) on the same base name.
    const name = workerName(quest, recordedNames(quests));
    let plan;
    try {
      plan = planDispatch(config, quest, adventurer, name);
      if (!runners) preflight(config, plan);
    } catch (error) {
      return { status: 409, body: { error: 'refused', reasons: [{ code: 'preflight', message: error.message }] } };
    }
    const running = store.assign(quest.id, { adventurer, name, by, requestKey });
    const attempt = { attemptId: running.assignee.attemptId, name, lane: running.assignee.lane, at: running.assignee.at };
    const controlToken = config.lanes[adventurer.lane]?.control?.type === 'generic-wrapper' ? randomUUID() : null;
    if (controlToken) controlHandles.set(attempt.attemptId, { token: controlToken, child: null, lane: attempt.lane, name: attempt.name });
    // Snapshot of exactly what the plan above was built from, immutable for the life of this attempt — every
    // recheck compares the fresh card against this, never against whatever the plan happened to capture on a
    // prior recheck, so a change is always judged against the one thing that is actually about to run.
    const planned = { lane: adventurer.lane, model: adventurer.model, variant: adventurer.variant || '', agent: adventurer.agent || '', env: adventurer.env || {} };
    const recheck = () => recheckOpen(quest.id, attempt, adventurer, planned);
    // The write-ahead persistence hook: executePlan awaits this before a step's own effect ever runs (and
    // once more once a session step resolves), so the phase/session binding lands in the quest's own durable
    // record (store.recordPhase → quests.jsonl) before, never after, the thing it describes. Throwing here
    // (a stale attempt, a disk error) is exactly how executePlan learns "do not spawn this step" — it never
    // catches this itself, so the plan stops there instead of running an effect nothing could record.
    // A session binding's own persistence failing (disk-first save() throws after a real id was captured) is
    // the one case worth a stopgap for (requirement 5): store.save() only updates its in-memory Map after the
    // append succeeds, so a captured id that cannot be durably recorded here is not in memory either — the
    // only place it would otherwise survive is a stderr line. Noting it here, before rethrowing, never
    // changes what executePlan or the caller below does with the failure; it only keeps the id queryable
    // in-process for as long as the durable record stays behind. This never claims durability: it is exactly
    // the persisted flag says, `persisted: false`.
    const onPhase = (phase, detail) => {
      try {
        return store.recordPhase(quest.id, attempt, phase === 'session' ? { session: detail } : { phase });
      } catch (error) {
        if (phase === 'session' && detail && detail.id) nonDurable.noteUnpersistedSession(quest.id, attempt.attemptId, detail.id, error);
        throw error;
      }
    };
    const onChild = (child, step) => {
      if (!controlToken || step.control?.type !== 'generic-wrapper') return;
      const handle = controlHandles.get(attempt.attemptId);
      if (handle) {
        controlHandles.set(attempt.attemptId, { ...handle, child });
        child.once?.('exit', () => { if (controlHandles.get(attempt.attemptId)?.child === child) controlHandles.delete(attempt.attemptId); });
      }
    };
    if (controlToken) {
      plan = plan.map((step) => step.kind === 'run'
        ? { ...step, env: { ...step.env, QUESTBOARD_ATTEMPT_ID: attempt.attemptId, QUESTBOARD_CONTROL_TOKEN: controlToken } }
        : step);
    }
    enqueue(adventurer.lane, () => executePlan(config, plan, { name, runners, recheck, onPhase, onChild }))
      .then((result) => {
        if (result.blocked) {
          if (result.phase !== 'queued') {
            const current = store.get(quest.id);
            if (current?.cancelRequest?.attemptId === attempt.attemptId) {
              safeguard('cancel queued ambiguity', result.detail, () => store.recordCancellationResult(quest.id, { requestId: current.cancelRequest.requestId, result: 'unknown', detail: result.detail, evidence: { kind: 'dispatcher', attempt: attemptEvidence(attempt), phase: result.phase } }));
            }
            preserveAmbiguous(quest.id, attempt, result);
          } else if (store.get(quest.id)?.cancelRequest?.attemptId === attempt.attemptId) {
            const request = store.get(quest.id).cancelRequest;
            safeguard('cancel never_started', result.detail, () => store.recordCancellationResult(quest.id, { requestId: request.requestId, result: 'never_started', detail: result.detail, evidence: { kind: 'dispatcher', attempt: attemptEvidence(attempt), phase: 'queued', noEffect: true } }));
          } else failIfStillOurs(quest.id, attempt, result.detail);
          return undefined;
        }
        if (result.ok) return announceStarted(quest.id, attempt, [`脚本已启动，worker ${attempt.name}`, ...(verdict.warnings || []).map(({ code, message }) => `警告 ${code}：${message}`)].join('\n'));
        if (result.session && result.session.unknown) return settleAmbiguousSession(quest.id, attempt, result);
        // A known session binding (a real captured id) already names a resource that may exist upstream
        // regardless of what the run step itself did — always preserved, never routed through
        // settleFailedWrapper's evidence wait/neverStarted logic, which is about the run step alone.
        if (result.session && result.session.id) return preserveKnownSessionRun(quest.id, attempt, result);
        return settleFailedWrapper(running, adventurer.lane, attempt, result);
      })
      .catch((error) => settleUnexpectedFailure(quest.id, attempt, `派遣异常：${error.message}`));
    return { status: 200, body: { quest: running } };
  }

  // Records a worker started by hand so the board tracks it; runs nothing.
  function adopt(questId, adventurer, name, by, { requestKey = null, ifRevision } = {}) {
    const quest = store.get(questId);
    if (!quest) return { status: 404, body: { error: 'quest not found' } };
    if (repeated(quest, requestKey)) return { status: 200, body: { quest, repeated: true } };
    const stale = staleRevision(quest, ifRevision);
    if (stale) return stale;
    if (quest.kind === 'owner') return { status: 409, body: { error: `${questId} is an owner quest` } };
    if (!OPEN_STATUSES.has(quest.status)) return { status: 409, body: { error: `${questId} is ${quest.status}; only an open quest can adopt a worker` } };
    if (!/^[a-z0-9_]{1,48}$/.test(String(name || ''))) return { status: 400, body: { error: 'name must be the worker name given to the dispatch script (e.g. run3)' } };
    // Adopting the name that is already this quest's own current, still-tracked attempt is a reconnect, not
    // a new one: observe what is already recorded rather than mint a fresh attemptId and dispatches entry
    // under a name that is already live here.
    if (quest.assignee && quest.assignee.name === name) return { status: 200, body: { quest } };
    // A name already recorded against a *different* quest is ambiguous: the collector is name-keyed, so
    // adopting it here would tell the board this worker's past/future output belongs to this quest instead,
    // silently reassigning or overwriting whatever the other quest's own attempt already produced. Only the
    // same quest re-adopting its own current name (handled above) is unambiguous; a genuinely repeated
    // request already returned above via requestKey, before this check ever runs.
    const owner = store.list().find((q) => q.id !== questId && recordedNames([q]).has(name));
    if (owner) return { status: 409, body: { error: `worker ${name} 已经是 ${owner.id} 的记录，接管会认错任务；确认这不是同一个 worker 再改名重试` } };
    // A name recorded on THIS quest but belonging to a distinct, earlier attempt (the assignee moved on, or
    // was cleared by a terminal status) is just as ambiguous as a different quest's name: its registry rows
    // and output belong to that earlier attempt, and letting a new adoption reuse the name is exactly how
    // an old attempt's outcome gets reattributed to a fresh one (see sync.js's isCurrentRow). A genuinely
    // new name — never recorded on this quest at all — stays adoptable without qualification.
    const priorAttempt = (quest.dispatches || []).some((d) => d && d.name === name);
    if (priorAttempt) return { status: 409, body: { error: `worker ${name} 是这个任务更早一次派遣用过的名字，接管会认错那次的记录；换个新名字` } };
    return { status: 200, body: { quest: store.assign(questId, { adventurer, name, by, detail: `接管已在跑的 worker ${name}`, event: 'dispatched', adopted: true, requestKey }) } };
  }

  // Frees a stalled quest after someone confirmed its worker is gone; refuses everything else.
  function release(questId, by, detail, { source = by, ack = false } = {}) {
    if (!store.get(questId)) return { status: 404, body: { error: 'quest not found' } };
    try {
      return { status: 200, body: { quest: store.release(questId, { by: source, detail, source, ack }) } };
    } catch (error) {
      return { status: 409, body: { error: error.message } };
    }
  }

  async function cancel(questId, source, reason) {
    const current = store.get(questId);
    if (!current) return { status: 404, body: { error: 'quest not found' } };
    let requested;
    try { requested = store.requestCancellation(questId, { source, reason, instanceId: dispatcherInstanceId, deadlineAt: new Date(Date.now() + 5000).toISOString() }); }
    catch (error) { return { status: 409, body: { error: 'refused', reasons: [{ code: error.code || 'cancel_refused', message: error.message }] } }; }
    const request = requested.cancelRequest;
    if (request.result !== 'pending') return { status: 200, body: { quest: requested, result: request.result, request } };
    // A queued attempt is settled by executePlan's next write-ahead recheck. No adapter is needed and no
    // control message is sent before the queue has proved that no effect happened.
    if (requested.assignee?.phase === 'queued') return { status: 202, body: { quest: requested, result: 'pending', request } };
    const lane = config.lanes[requested.assignee?.lane];
    if (lane?.control?.type !== 'generic-wrapper') {
      const next = store.recordCancellationResult(questId, { requestId: request.requestId, result: 'manual_required', detail: '该 lane 没有可验证的 generic wrapper 控制，需要人工确认' });
      return { status: 200, body: { quest: next, result: 'manual_required', request: next.cancelRequest } };
    }
    const result = await genericWrapper({ attempt: requested.assignee, request, handle: controlHandles.get(request.attemptId) });
    const next = store.recordCancellationResult(questId, { requestId: request.requestId, ...result });
    return { status: 202, body: { quest: next, result: result.result, request: next.cancelRequest } };
  }

  function resolve(questId, source, reason, ack) {
    if (!store.get(questId)) return { status: 404, body: { error: 'quest not found' } };
    try { return { status: 200, body: { quest: store.resolveManually(questId, { source, reason, ack }) } }; }
    catch (error) { return { status: 409, body: { error: 'refused', reasons: [{ code: error.code || 'manual_ack_required', message: error.message }] } }; }
  }

  // A write failure (including an empty/no-report session) is never "delivered" — that would hide the
  // real state behind a fake success. It only counts against the attempt that started it: if the quest
  // moved on (reassigned, released, cancelled) before the write settles, this attempt changes nothing.
  function deliverFromApi(quest, transition) {
    const { name, lane, at, attemptId } = quest.assignee;
    const attempt = { attemptId, name, lane, at };
    const key = attemptKey(attempt);
    pendingDeliveries.add(key);
    // writeDelivery may throw synchronously (a bad argument, a test double, a buggy override) rather than
    // reject; routing the call through a resolved promise turns that into a normal rejection so .catch
    // below still runs and .finally still releases the pending-delivery slot instead of leaking it forever.
    // The identity check runs before the write starts too, not just after: applyLanes calls in with a
    // fresh quest so this is normally a no-op, but it means a caller that reuses this function never sends
    // a write for an attempt it already knows is stale.
    // Every store write below is guarded (safeguard, F4): with nothing upstream left to turn a thrown error
    // into a normal result, an unguarded throw from any of these — either sink down, or (the F4 native case)
    // quests.jsonl and the events file both down at once — would escape this `.catch` itself as an unhandled
    // rejection, since nothing follows it but `.finally`. A guarded failure here simply leaves the quest in
    // whatever its last successfully durable state was (store.save() is disk-first, so a failed setStatus
    // never advances the in-memory copy past what actually got written) — no slot lost, no crash, and the
    // failure is still reported via reportPersistenceFailure even when the events sink that would normally
    // carry it is itself the thing that is down.
    Promise.resolve()
      .then(() => (stillOurs(quest.id, attempt) ? writeDelivery(config, lane, name) : null))
      .then((out) => {
        if (out === null) return;
        clearOwnNotice(quest.id, key);
        const current = stillOurs(quest.id, attempt);
        if (!current) return;
        const note = `交付已写入 ${path.relative(config.root, out).split(path.sep).join('/')}`;
        const detail = [note, transition.detail].filter(Boolean).join(' | ');
        // Capture before the status write so the reference lands in the same durable record as the
        // 'delivered' fact; a captured failure simply carries no reference.
        const report = captureReportFor(current);
        safeguard('deliverFromApi setStatus delivered', detail, () => store.setStatus(quest.id, 'delivered', {
          detail, by: 'lanes', source: 'collector', evidence: { kind: 'collector', attempt: attemptEvidence(attempt) },
          ...(report ? { report } : {}),
        }));
      })
      .catch((error) => {
        const current = stillOurs(quest.id, attempt);
        if (!current) { clearOwnNotice(quest.id, key); return; }
        // "Still running", an HTTP error or an unreachable API is not proof the worker died — it is
        // positive evidence it (or the thing polling it) is still there. Leave the assignee alone so the
        // next poll retries, and note it once per attempt (keyed on this attempt's identity and the exact
        // message) so a tight poll loop cannot spam the same notice forever.
        if (TRANSIENT_DELIVERY_CODES.has(error.code)) {
          const last = transientNotices.get(quest.id);
          if (!last || last.key !== key || last.message !== error.message) {
            safeguard('deliverFromApi transient notice', error.message, () => store.emitEvent(current, 'delivery_write_failed', { by: 'board', detail: error.message }));
            transientNotices.set(quest.id, { key, message: error.message });
          }
          return;
        }
        clearOwnNotice(quest.id, key);
        safeguard('deliverFromApi delivery_write_failed', error.message, () => store.emitEvent(current, 'delivery_write_failed', { by: 'board', detail: error.message }));
        // A failed delivery still binds whatever the attempt actually left on disk (a partial report or an
        // exit-file summary), so the failure is readable next to real evidence instead of only a message.
        const report = captureReportFor(current);
        safeguard('deliverFromApi setStatus failed', error.message, () => store.setStatus(quest.id, 'failed', {
          detail: `交付文件没写成：${error.message}`, by: 'lanes', source: 'collector', evidence: { kind: 'collector', attempt: attemptEvidence(attempt) },
          ...(report ? { report } : {}),
        }));
      })
      .finally(() => pendingDeliveries.delete(key));
  }

  // pendingDeliveries is checked against the quest's *current* assignee's attempt key, not the transition's
  // quest id alone — a hung write for an old, superseded attempt must never block a new attempt's own
  // delivery from ever starting (see attemptKey above); it can only ever block a second write for that same
  // attempt, which is exactly what it is for.
  function applyLanes(lanes) {
    for (const transition of deriveTransitions(store.list(), lanes.packages)) {
      try {
        const quest = store.get(transition.id);
        if (!quest) continue;
        if (quest.assignee && pendingDeliveries.has(attemptKey(quest.assignee))) continue;
        const lane = quest.assignee && config.lanes[quest.assignee.lane];
        if (transition.status === 'delivered' && lane && lane.api && lane.deliveryDir) { deliverFromApi(quest, transition); continue; }
        // Only an ending binds a report reference; stalled/dispatched pass through untouched.
        const current = store.get(transition.id);
        if (transition.cancellationResult && current?.cancelRequest) {
          store.recordCancellationResult(transition.id, { requestId: current.cancelRequest.requestId, result: transition.cancellationResult, detail: transition.detail, evidence: transition.evidence });
        } else {
          const report = current?.assignee && TERMINAL_STATUSES.has(transition.status) ? captureReportFor(current) : null;
          store.setStatus(transition.id, transition.status, {
            detail: transition.detail, by: 'lanes', source: 'collector', evidence: { kind: 'collector', attempt: attemptEvidence(current?.assignee) },
            ...(report ? { report } : {}),
          });
        }
      } catch (error) {
        // A refusal or persistence fault for one quest must not abort the rest of this collector snapshot.
        try { process.stderr.write(`questboard: lane transition skipped for ${transition.id}: ${error.message}\n`); } catch {}
      }
    }
  }

  // Read-only diagnostic surface for an HTTP consumer (requirement 5/R3): a quest's own detail/snapshot can
  // show that this process still remembers a session id for the quest's current attempt that never became
  // durable, without ever exposing the raw error text (a path, a command's stderr) behind it.
  function getUnpersistedSession(questId, attemptId) {
    return sanitizeUnpersistedSession(nonDurable.getUnpersistedSession(questId, attemptId));
  }

  // Test/diagnostic hook for the process handle this dispatcher itself spawned. It never discovers or
  // reaches unrelated PIDs; callers only receive the current attempt's own in-memory wrapper handle.
  function getControlHandle(attemptId) {
    return controlHandles.get(attemptId) || null;
  }

  return { assign, adopt, release, cancel, resolve, applyLanes, getUnpersistedSession, getControlHandle };
}
