// Turns owner picks into running workers and lane results into quest statuses.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { canDispatch, coordinatorFastTrackRefusal, OPEN_STATUSES } from '../core/rules.js';
import { workerName, planDispatch, executePlan, preflight, recordedNames } from '../core/dispatch.js';
import { prepareWorktree } from '../core/worktrees.js';
import { deriveTransitions } from '../core/sync.js';
import { withFileSets, briefUsable } from '../core/briefs.js';
import { writeApiDelivery } from '../core/deliveries.js';
import { lockPresent, briefExists, briefUnusable } from '../core/snapshot.js';
import { sameAttempt } from '../core/store.js';
import { attemptEvidence } from '../core/cancellation.js';
import { captureAttemptReport } from '../core/reportEvidence.js';
import { createNonDurableBindings, sanitizeUnpersistedSession } from '../core/nonDurableBindings.js';
import { prepareAnnotationSnapshot, writeAnnotationSnapshot, writeAnnotationsMaterial } from '../core/annotationSnapshot.js';
import { backupPreviousAttempts } from '../core/dispatchBackup.js';
import { writeRoleCard } from '../core/roleCard.js';
import { createGenericWrapperAdapter, createOpenCodeSessionAdapter } from './workerControlAdapters.js';
import { createVerificationHookRunner } from '../core/verificationHooks.js';
import { assignJobObject, closeJobObject, countJobObject, createJobObject, terminateJobObject } from '../core/jobObject.js';
import { laneCapabilities } from '../core/config.js';
import { createDeliveryGate } from './deliveryGate.js';
import { createDispatchSettlement } from './dispatchSettlement.js';
import { createDeliveryWriter, attemptKey } from './deliveryWriter.js';

const EVIDENCE_WAIT_MS = 10000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Terminal transitions are the only ones that may bind a report reference: stalled/dispatched are silence
// or a retry, not an ending, and a report captured for them would be partial evidence presented as final.
const TERMINAL_STATUSES = new Set(['delivered', 'failed', 'bounced']);

function laneUsesRole(lane) {
  return Boolean(lane && (lane.roleInPrompt === true || [
    ...(lane.run || []),
    ...(lane.session?.run || []),
  ].some((value) => typeof value === 'string' && value.includes('{role}'))));
}

export function createDispatcher({ config, store, runners, evidenceWaitMs = EVIDENCE_WAIT_MS, writeDelivery = writeApiDelivery, getDownLanes = () => null, getAdventurer, fetchImpl = fetch, genericWrapperAdapter = null, gitStatusSync = null, runCheck = null, runMechanical = null, verifyTree = null, notifyInbox = null }) {
  // FB2-04 item 1: code dispatches snapshot the worktree before the worker starts (git status
  // --porcelain) so the reviewer can tell pre-existing edits from the worker's own. Sync on purpose:
  // assign() is sync all the way down, and this runs once per dispatch, never in a poll loop.
  const capturePreDispatch = gitStatusSync || ((cfg) => {
    if (!fs.existsSync(path.join(cfg.root, '.git'))) return { available: false, note: '无 git，无法快照（项目目录没有 .git）' };
    const out = execFileSync('git', ['-C', cfg.root, 'status', '--porcelain'], { timeout: 10000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const files = out.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean).map((line) => {
      const body = line.slice(3);
      const arrow = body.lastIndexOf(' -> ');
      return arrow === -1 ? body : body.slice(arrow + 4);
    });
    return { available: true, files };
  });
  const queues = new Map();
  // FB2-05: one delivery check/settle at a time per attempt (the poll tick can replay the same delivered
  // transition while the check is still running), and the per-attempt fix plan — the exact run step this
  // attempt was dispatched with, kept in memory so a failed self-check can re-run the same wrapper command
  // with a fix hint. Deliberately not persisted: the env it carries is dispatch-time card/lane state, and
  // a board restart already loses the control channel for an old attempt (see controlHandles); the honest
  // fallback then is a status_note naming that no re-run command is left, never a silent skip.
  const pendingChecks = new Set();
  const fixPlans = new Map();
  const controlHandles = new Map();
  const dispatcherInstanceId = randomUUID();
  const genericWrapper = genericWrapperAdapter || createGenericWrapperAdapter({ config });
  const openCodeSession = createOpenCodeSessionAdapter({ fetchImpl });
  const sentCancellationRequests = new Set();
  const verificationHooks = createVerificationHookRunner({ config, store, instanceId: dispatcherInstanceId });
  // One instance per project/dispatcher, never a module-level singleton (requirement 5/R3): two projects'
  // dispatchers sharing a process (the desktop app, a shared MCP server) must never see or clear each
  // other's noted sessions just because both happen to run here.
  const nonDurable = createNonDurableBindings();
  // A stalled quest still belongs to its worker, so a late callback from it counts. `attempt` is the
  // specific assignment's own identity (store.assign mints a fresh attemptId every time, even a same-named
  // re-adopt or a re-assignment landing in the same millisecond), so a stale async completion from an old
  // attempt can never land on a newer assignment or a cancellation — compared by attempt, never by name alone.
  const stillOurs = (questId, attempt) => {
    const current = store.get(questId);
    return current && (current.status === 'dispatched' || current.status === 'stalled') && sameAttempt(current.assignee, attempt) ? current : null;
  };

  // Binds a spawned wrapper child to its attempt's control handle — the initial dispatch and the FB2-05
  // fix re-run alike, so a cancel request reaches whichever wrapper is live for this attempt right now.
  function attachChild(attemptId, child, step) {
    if (step.control?.type !== 'generic-wrapper') return;
    const handle = controlHandles.get(attemptId);
    if (!handle || !handle.token) return;
    controlHandles.set(attemptId, { ...handle, child });
    child.once?.('exit', () => {
      // The job object stays open after the wrapper's own exit: it is the only process-tree evidence
      // the collector's death check can count later (a taskkill'd tree leaves no .exit behind). The
      // child handle is dropped so a later cancel request correctly reports "no live control channel",
      // and the job itself is closed only once the attempt settles (see closeSettledJobs in applyLanes).
      const current = controlHandles.get(attemptId);
      if (!current || current.child !== child) return;
      controlHandles.set(attemptId, { ...current, child: null });
    });
    if (typeof child.on === 'function' && process.platform === 'win32') {
      child.on('message', (message) => {
        if (!message || message.type !== 'questboard-job-ready' || message.attemptId !== attemptId) return;
        const current = controlHandles.get(attemptId);
        if (!current || current.jobId) return;
        (async () => {
          try {
            const jobId = await createJobObject('qb-' + attemptId);
            await assignJobObject(jobId, child.pid);
            const next = controlHandles.get(attemptId);
            if (next && next.child === child) controlHandles.set(attemptId, { ...next, jobId });
            try { child.send({ type: 'questboard-job-go', attemptId }); } catch {}
          } catch {
            try { child.send({ type: 'questboard-job-go', attemptId }); } catch {}
          }
        })();
      });
    }
  }

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

  // A bounded, guarded diagnostic sink for a persistence op that failed inside one of the settle/preserve
  // paths below — never raw secrets (env values, tokens), just the human-facing detail already produced for
  // the quest itself. `failure` says what actually failed: a write that did not land (没写成) or a read that
  // could not come back (读取失败), so a report that could not be read is never logged as if something had
  // failed to be written. Wrapped in its own try/catch: even the sink can be gone (a closed stderr) and that
  // must not become yet another throw.
  function reportPersistenceFailure(label, detail, error, failure = '没写成') {
    try { process.stderr.write(`[dispatcher] ${label} ${failure}（${error && error.message}）：${String(detail).slice(0, 500)}\n`); } catch { /* nothing left to report to */ }
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
    try { return captureAttemptReport({ config, quest }); } catch (error) { reportPersistenceFailure('captureAttemptReport', quest.id, error, '读取失败'); return null; }
  }

  function triggerDeliveredHooks(quest) {
    try { verificationHooks.onDelivered(quest); } catch (error) { reportPersistenceFailure('verification hook trigger', quest.id, error, '触发失败'); }
  }

  // FB2-S1: the worker-start settlement (announce/fail/preserve paths) lives in dispatchSettlement.js.
  const settlement = createDispatchSettlement({ config, store, stillOurs, safeguard, reportPersistenceFailure, nonDurable, evidenceWaitMs, delay });

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

  function samePlan(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  // Builds the env canDispatch needs, fresh each time it's called — once at drop time and again, from a
  // fresh read, for every queued recheck.
  function dispatchEnv(quest) {
    return { treeLocked: lockPresent(config), briefExists: briefExists(config, quest), briefUnusable: briefUnusable(config, quest), laneIds: new Set(Object.keys(config.lanes)), laneCapabilities: laneCapabilities(config), ...(getDownLanes() ? { downLanes: getDownLanes() } : {}) };
  }

  function roleCardBriefReason(quest, adventurer, quests) {
    if (quest.kind === 'owner' && !quest.brief) return null;
    if (quest.brief && briefUsable(config, quest.brief)) return null;
    const verdict = canDispatch({ quest, adventurer, quests, policy: config.policy, env: dispatchEnv(quest) });
    return verdict.reasons.find(({ code }) => code === 'brief_missing' || code === 'brief_unusable')
      || { code: 'brief_missing', message: `找不到 brief 文件：${quest.brief || '（未填写）'}` };
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
    if (current?.cancelRequest?.attemptId === attempt.attemptId) return { ok: false, detail: '这次派遣已经在等取消结果，确认之前不会再启动新的 worker' };
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
  function assign(questId, adventurer, by, { requestKey = null, ifRevision, maxFiles } = {}) {
    const quests = withFileSets(config, store.list());
    const quest = quests.find((q) => q.id === questId);
    if (!quest) return { status: 404, body: { error: 'quest not found' } };
    if (repeated(quest, requestKey)) return { status: 200, body: { quest: store.get(questId), repeated: true } };
    const stale = staleRevision(quest, ifRevision);
    if (stale) return stale;
    const verdict = canDispatch({ quest, adventurer, quests, policy: config.policy, env: dispatchEnv(quest) });
    if (!verdict.ok) return { status: 409, body: { error: 'refused', reasons: verdict.reasons } };
    // FB2-12 items 33/34: a dispatch under the coordinator's own identity must be the machine-check fast
    // track (rules.js coordinatorFastTrackRefusal). Judged AFTER canDispatch on purpose: a card that is
    // paused, limited or otherwise unusable must still answer with its own, more specific reason first, and
    // the fast-track rule is the extra condition on top of every ordinary one. `by` is the identity the
    // request was recorded under (the board sends 'owner' for a drag, the CLI and the MCP tool send
    // 'coordinator'), so the owner's own dispatch never reaches this line. `maxFiles` is the caller's own
    // --max-files (the CLI default lives there); anything not a positive integer was already refused by the
    // route, and the default here keeps direct callers on the same number the CLI advertises.
    if (by === 'coordinator') {
      const refusal = coordinatorFastTrackRefusal({ quest, adventurer, ...(maxFiles === undefined ? {} : { maxFiles }) });
      if (refusal) return { status: 409, body: { error: 'refused', reasons: [refusal] } };
    }
    const roleBriefReason = roleCardBriefReason(quest, adventurer, quests);
    if (roleBriefReason) return { status: 409, body: { error: 'refused', reasons: [roleBriefReason] } };
    let annotationPreparation = null;
    if (quest.kind === 'art' && String(quest.reviewPage || '').trim()) {
      try {
        // This reads and folds only; no directory or snapshot file is created until after store.assign has
        // minted the attempt id. Every refusal here therefore leaves the quest and its events untouched.
        annotationPreparation = prepareAnnotationSnapshot({ config, quest });
      } catch (error) {
        return { status: 409, body: { error: 'refused', reasons: [{ code: error.code || 'annotation_snapshot', message: error.message }] } };
      }
    }
    // Every name this project has ever recorded, not just currently-held ones: a finished quest's name is
    // still its report/session/output file on disk, and package-id normalization can land two different
    // quests (one now finished) on the same base name.
    const name = workerName(quest, recordedNames(quests));
    const needsRole = laneUsesRole(config.lanes[adventurer.lane]);
    let plan;
    try {
      plan = planDispatch(config, quest, adventurer, name, quest.brief, needsRole ? '{role}' : undefined);
      if (!runners) preflight(config, plan);
    } catch (error) {
      return { status: 409, body: { error: 'refused', reasons: [{ code: 'preflight', message: error.message }] } };
    }
    let running = store.assign(quest.id, { adventurer, name, by, requestKey });
    const assignedAttempt = { attemptId: running.assignee.attemptId, name: running.assignee.name, lane: running.assignee.lane, at: running.assignee.at };
    let annotationSnapshot = null;
    let annotationsMaterial = null;
    if (annotationPreparation) {
      try {
        annotationSnapshot = writeAnnotationSnapshot({
          config, packageId: quest.id, attemptId: assignedAttempt.attemptId,
          briefText: annotationPreparation.briefText, page: annotationPreparation.page,
          title: annotationPreparation.title, capturedAt: annotationPreparation.capturedAt,
          items: annotationPreparation.items, content: annotationPreparation.content,
        });
        // FB2-02: the standalone annotations.md the role card points at, written before the snapshot
        // is recorded so each failure in this block has exactly one state: no snapshot yet, a written
        // snapshot without its material, or both files written with only the record step left.
        annotationsMaterial = writeAnnotationsMaterial({
          config, packageId: quest.id, attemptId: assignedAttempt.attemptId,
          page: annotationPreparation.page, title: annotationPreparation.title,
          capturedAt: annotationPreparation.capturedAt, items: annotationPreparation.items,
        });
        running = store.recordAnnotationSnapshot(quest.id, assignedAttempt, annotationSnapshot);
      } catch (error) {
        // Assignment is already durable, but no child effect has started. Settle this verified
        // never-started attempt through the normal failed transition so a 409 cannot hide a held slot.
        // The detail names the step that actually failed: the snapshot write itself when no file came out,
        // or the recording of the snapshot's metadata onto the attempt once the file was already written —
        // never one blanket "write failed" for both.
        const what = annotationsMaterial ? '批注快照记录没写成' : (annotationSnapshot ? '批注材料没写成' : '批注快照没写成');
        const detail = `${what}（派遣 ${assignedAttempt.attemptId}），worker 没有启动：${error.message}`;
        try {
          store.setStatus(quest.id, 'failed', {
            detail, by: 'board', source: 'dispatcher',
            evidence: { kind: 'dispatcher', attempt: attemptEvidence(assignedAttempt) },
          });
          return { status: 503, body: { error: 'snapshot_failed_after_assign', attemptId: assignedAttempt.attemptId, settled: true, reasons: [{ code: error.code || 'annotation_snapshot', message: error.message }] } };
        } catch (settleError) {
          // If the failure transition itself cannot be persisted, name the still-visible attempt explicitly;
          // callers must not misread this as an ordinary pre-assign refusal.
          return { status: 503, body: { error: 'snapshot_failed_after_assign', attemptId: assignedAttempt.attemptId, settled: false, reasons: [{ code: error.code || 'annotation_snapshot', message: error.message }, { code: 'settlement_failed', message: settleError.message }] } };
        }
      }
    }
    let roleCard = null;
    try {
      roleCard = writeRoleCard({
        config, quest, attempt: { ...assignedAttempt, kind: quest.kind },
        annotations: annotationSnapshot && annotationsMaterial ? { path: annotationsMaterial.path, count: annotationSnapshot.count } : null,
      });
      running = store.recordRoleCard(quest.id, assignedAttempt, roleCard);
    } catch (error) {
      // Same honesty as the snapshot settle above: a failed record of an already-written card is named as
      // the record step, not as a card write that actually succeeded.
      const what = roleCard ? '角色卡记录没写成' : '角色卡写入失败';
      const detail = `${what}（派遣 ${assignedAttempt.attemptId}，worker 还没启动）：${error.message}`;
      try {
        store.setStatus(quest.id, 'failed', {
          detail, by: 'board', source: 'dispatcher',
          evidence: { kind: 'dispatcher', attempt: attemptEvidence(assignedAttempt) },
        });
        return { status: 503, body: { error: 'role_card_failed_after_assign', attemptId: assignedAttempt.attemptId, settled: true, reasons: [{ code: error.code || 'role_card', message: error.message }] } };
      } catch (settleError) {
        return { status: 503, body: { error: 'role_card_failed_after_assign', attemptId: assignedAttempt.attemptId, settled: false, reasons: [{ code: error.code || 'role_card', message: error.message }, { code: 'settlement_failed', message: settleError.message }] } };
      }
    }
    if (needsRole || annotationPreparation) {
      let rebuilt = false;
      try {
        const effectiveBrief = annotationSnapshot?.path || quest.brief;
        const rebuiltPlan = planDispatch(config, quest, adventurer, name, effectiveBrief, roleCard.path);
        rebuilt = true;
        if (!runners && !samePlan(plan, rebuiltPlan)) preflight(config, rebuiltPlan);
        plan = rebuiltPlan;
      } catch (error) {
        // Name the step that actually failed: planDispatch reads the role card into a session prompt only for
        // a roleInPrompt lane, so any other throw while rebuilding belongs to the rebuilt plan.
        const roleStep = !rebuilt && Boolean(config.lanes[adventurer.lane]?.session) && config.lanes[adventurer.lane]?.roleInPrompt === true;
        const what = roleStep ? '角色卡计划失败' : '派遣计划重建失败';
        const detail = `${what}（派遣 ${assignedAttempt.attemptId}，worker 还没启动）：${error.message}`;
        try {
          store.setStatus(quest.id, 'failed', {
            detail, by: 'board', source: 'dispatcher',
            evidence: { kind: 'dispatcher', attempt: attemptEvidence(assignedAttempt) },
          });
          return { status: 503, body: { error: 'role_card_plan_failed_after_assign', attemptId: assignedAttempt.attemptId, settled: true, reasons: [{ code: 'role_card_plan', message: error.message }] } };
        } catch (settleError) {
          return { status: 503, body: { error: 'role_card_plan_failed_after_assign', attemptId: assignedAttempt.attemptId, settled: false, reasons: [{ code: 'role_card_plan', message: error.message }, { code: 'settlement_failed', message: settleError.message }] } };
        }
      }
    }
    // FB2-02 item 3: a redo must never bury what came back last time. Earlier attempts' artifacts are
    // copied aside before any step of this plan may run; if the backup cannot be made, the attempt
    // settles as failed here and nothing spawns.
    let redoBackups = [];
    if ((quest.dispatches || []).length) {
      try {
        redoBackups = backupPreviousAttempts({ config, quest, lane: config.lanes[adventurer.lane] });
      } catch (error) {
        const detail = '旧交付备份失败，重派没有启动：' + (error && error.message ? error.message : String(error));
        try {
          store.setStatus(quest.id, 'failed', {
            detail, by: 'board', source: 'dispatcher',
            evidence: { kind: 'dispatcher', attempt: attemptEvidence(assignedAttempt) },
          });
          return { status: 503, body: { error: 'backup_failed_after_assign', attemptId: assignedAttempt.attemptId, settled: true, reasons: [{ code: error.code || 'dispatch_backup', message: error.message }] } };
        } catch (settleError) {
          return { status: 503, body: { error: 'backup_failed_after_assign', attemptId: assignedAttempt.attemptId, settled: false, reasons: [{ code: error.code || 'dispatch_backup', message: error.message }, { code: 'settlement_failed', message: settleError.message }] } };
        }
      }
    }
    // FB2-04 item 1: a code dispatch snapshots the worktree before anything spawns. A git failure is
    // recorded as 无 git，无法快照 — noted for the reviewer, never a reason to stop the dispatch.
    let preDispatchChanges = null;
    if (quest.kind === 'code') {
      try {
        preDispatchChanges = capturePreDispatch(config);
      } catch (error) {
        preDispatchChanges = { available: false, note: '无 git，无法快照（' + (error && error.message ? error.message : String(error)) + '）' };
      }
      try {
        store.recordPreDispatchChanges(quest.id, assignedAttempt, preDispatchChanges);
      } catch {
        // A stale attempt or a disk hiccup here must not stop the dispatch either; the reviewer
        // simply sees no snapshot for this attempt.
        preDispatchChanges = null;
      }
    }
    // FB2-13 (条目 29): with policy.worktrees on, the attempt edits its own detached copy of the project.
    // Created after assign minted the attempt id and before any step may spawn; a creation failure settles
    // the verified never-started attempt exactly like the role-card failure above, and the copy is removed.
    let worktree = null;
    if (config.policy.worktrees?.enabled) {
      try {
        worktree = prepareWorktree({ config, name, brief: quest.brief });
        store.recordWorktree(quest.id, assignedAttempt, worktree);
      } catch (error) {
        const detail = `worktree 副本没建成（派遣 ${assignedAttempt.attemptId}，worker 没有启动）：${error.message}`;
        try {
          store.setStatus(quest.id, 'failed', {
            detail, by: 'board', source: 'dispatcher',
            evidence: { kind: 'dispatcher', attempt: attemptEvidence(assignedAttempt) },
          });
          return { status: 503, body: { error: 'worktree_failed_after_assign', attemptId: assignedAttempt.attemptId, settled: true, reasons: [{ code: 'worktree', message: error.message }] } };
        } catch (settleError) {
          return { status: 503, body: { error: 'worktree_failed_after_assign', attemptId: assignedAttempt.attemptId, settled: false, reasons: [{ code: 'worktree', message: error.message }, { code: 'settlement_failed', message: settleError.message }] } };
        }
      }
    }
    const attempt = { ...assignedAttempt, roleCard, ...(annotationSnapshot ? { annotationSnapshot } : {}), ...(redoBackups.length ? { redoBackups } : {}), ...(preDispatchChanges ? { preDispatchChanges: store.get(quest.id)?.assignee?.preDispatchChanges || preDispatchChanges } : {}), ...(worktree ? { worktree } : {}) };
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
    const onChild = (child, step) => attachChild(attempt.attemptId, child, step);
    // FB2-05 item 3: remember the exact run step this attempt executes, so a failed self-check can re-run
    // the same wrapper command with a fix hint later. The env captured here is the dispatch env (lane +
    // card) as planDispatch built it, before the control vars below are added — the re-run adds its own.
    const fixStep = plan.find((step) => step.kind === 'run');
    if (fixStep) fixPlans.set(attempt.attemptId, { command: [...fixStep.command], env: { ...(fixStep.env || {}) } });
    if (controlToken) {
      plan = plan.map((step) => step.kind === 'run'
        ? { ...step, env: { ...step.env, QUESTBOARD_ATTEMPT_ID: attempt.attemptId, QUESTBOARD_CONTROL_TOKEN: controlToken, ...(process.platform === 'win32' ? { QUESTBOARD_JOB_GATE: '1' } : {}) } }
        : step);
    }
    enqueue(adventurer.lane, () => executePlan(config, plan, { name, runners, recheck, onPhase, onChild, ...(worktree ? { cwd: worktree.path } : {}) }))
      .then((result) => {
        if (result.blocked) {
          if (result.phase !== 'queued') {
            const current = store.get(quest.id);
            if (current?.cancelRequest?.attemptId === attempt.attemptId) {
              safeguard('cancel queued ambiguity', result.detail, () => store.recordCancellationResult(quest.id, { requestId: current.cancelRequest.requestId, result: 'unknown', detail: result.detail, evidence: { kind: 'dispatcher', attempt: attemptEvidence(attempt), phase: result.phase } }));
            }
            settlement.preserveAmbiguous(quest.id, attempt, result);
          } else if (store.get(quest.id)?.cancelRequest?.attemptId === attempt.attemptId) {
            const request = store.get(quest.id).cancelRequest;
            safeguard('cancel never_started', result.detail, () => store.recordCancellationResult(quest.id, { requestId: request.requestId, result: 'never_started', detail: result.detail, evidence: { kind: 'dispatcher', attempt: attemptEvidence(attempt), phase: 'queued', noEffect: true } }));
          } else settlement.failIfStillOurs(quest.id, attempt, result.detail);
          return undefined;
        }
        if (result.ok) return settlement.announceStarted(quest.id, attempt, settlement.withWarnings(`脚本已启动，worker ${attempt.name}`, verdict.warnings));
        if (result.session && result.session.unknown) return settlement.settleAmbiguousSession(quest.id, attempt, result);
        // A known session binding (a real captured id) already names a resource that may exist upstream
        // regardless of what the run step itself did — always preserved, never routed through
        // settleFailedWrapper's evidence wait/neverStarted logic, which is about the run step alone.
        if (result.session && result.session.id) return settlement.preserveKnownSessionRun(quest.id, attempt, result);
        return settlement.settleFailedWrapper(running, adventurer.lane, attempt, result, verdict.warnings);
      })
      .catch((error) => settlement.settleUnexpectedFailure(quest.id, attempt, `派遣异常：${error.message}`));
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
    const roleBriefReason = roleCardBriefReason(quest, adventurer, withFileSets(config, store.list()));
    if (roleBriefReason) return { status: 409, body: { error: 'refused', reasons: [roleBriefReason] } };
    let assigned = store.assign(questId, { adventurer, name, by, detail: `接管已在跑的 worker ${name}`, event: 'dispatched', adopted: true, requestKey });
    const attempt = { attemptId: assigned.assignee.attemptId, name: assigned.assignee.name, lane: assigned.assignee.lane, at: assigned.assignee.at };
    try {
      const roleCard = writeRoleCard({ config, quest, attempt: { ...attempt, kind: quest.kind } });
      assigned = store.recordRoleCard(questId, attempt, roleCard);
      return { status: 200, body: { quest: assigned } };
    } catch (error) {
      // Adoption represents a worker that is already running. A card I/O failure cannot prove that worker
      // failed, so preserve its dispatched state and slot; only the card is unavailable for this attempt.
      return { status: 503, body: { error: 'role_card_failed_after_adopt', attemptId: attempt.attemptId, settled: false, cardUnavailable: true, reasons: [{ code: error.code || 'role_card', message: `角色卡不可用：${error.message}` }] } };
    }
  }

  // Frees a stalled quest after someone confirmed its worker is gone. A still-dispatched quest is refused
  // with the cancel-first explanation — except when this board's own process-tree verification says the
  // worker's tree is empty (FB2-06 item 4): then the verified death stands in for the cancel step and the
  // release proceeds with the same acknowledgement/detail as any release. A tree that is alive or cannot
  // be verified still refuses, naming which case it was; the store is never told a tree is empty it did not ask.
  async function release(questId, by, detail, { source = by, ack = false } = {}) {
    const quest = store.get(questId);
    if (!quest) return { status: 404, body: { error: 'quest not found' } };
    if (quest.status === 'dispatched' && quest.assignee) {
      const verdict = await (verifyTree || verifyProcessTree)({ attemptId: quest.assignee.attemptId });
      if (verdict === 'alive') {
        return { status: 409, body: { error: 'refused', reasons: [{ code: 'tree_alive', message: '进程树里还有活着的进程，先 cancel 再 release' }] } };
      }
      if (verdict !== 'empty') {
        return { status: 409, body: { error: 'refused', reasons: [{ code: 'tree_unknown', message: '无法确认进程树是否为空（看板没有这次派遣的作业对象，或数进程失败），先 cancel 再 release' }] } };
      }
      try {
        return { status: 200, body: { quest: store.release(questId, { by: source, detail, source, ack, verifiedEmpty: true }) } };
      } catch (error) {
        return { status: 409, body: { error: error.message } };
      }
    }
    try {
      return { status: 200, body: { quest: store.release(questId, { by: source, detail, source, ack }) } };
    } catch (error) {
      return { status: 409, body: { error: error.message } };
    }
  }

  async function cancel(questId, source, reason) {
    const current = store.get(questId);
    if (!current) return { status: 404, body: { error: '找不到任务' } };
    const lane = config.lanes[current.assignee?.lane];
    const adapter = lane?.control?.type === 'generic-wrapper' ? 'generic-wrapper'
      : lane?.control?.type === 'opencode-session' ? 'opencode-session' : 'unsupported';
    let requested;
    try { requested = store.requestCancellation(questId, {
      source, reason, instanceId: dispatcherInstanceId, adapter,
      deadlineAt: new Date(Date.now() + 5000).toISOString(),
    }); }
    catch (error) { return { status: 409, body: { error: 'refused', reasons: [{ code: error.code || 'cancel_refused', message: error.message }] } }; }
    const request = requested.cancelRequest;
    if (request.result !== 'pending') return { status: 200, body: { quest: requested, result: request.result, request } };
    if (request.instanceId && request.instanceId !== dispatcherInstanceId) {
      return { status: 202, body: { quest: requested, result: 'pending', request, note: '由其他看板实例发起，等待其结果' } };
    }
    if (sentCancellationRequests.has(request.requestId)) {
      return { status: 202, body: { quest: requested, result: 'pending', request } };
    }
    // A queued attempt is settled by executePlan's next write-ahead recheck. No adapter is needed and no
    // control message is sent before the queue has proved that no effect happened.
    if (requested.assignee?.phase === 'queued') return { status: 202, body: { quest: requested, result: 'pending', request } };
    sentCancellationRequests.add(request.requestId);
    if (lane?.control?.type === 'opencode-session') {
      const result = await openCodeSession({ attempt: requested.assignee, assignee: requested.assignee, request, laneConfig: lane });
      const beforeRecord = store.get(questId);
      const sameRequest = beforeRecord?.cancelRequest
        && beforeRecord.cancelRequest.requestId === request.requestId
        && (beforeRecord.cancelRequest.attemptId ?? null) === (request.attemptId ?? null)
        && (beforeRecord.assignee?.attemptId ?? null) === (request.attemptId ?? null);
      if (!sameRequest) {
        return { status: 202, body: { quest: beforeRecord, result: 'unknown', request: beforeRecord?.cancelRequest || null, detail: '取消已变更，取消结果未记录' } };
      }
      if (beforeRecord.cancelRequest.result !== 'pending') {
        return { status: 200, body: { quest: beforeRecord, result: beforeRecord.cancelRequest.result, request: beforeRecord.cancelRequest } };
      }
      const next = store.recordCancellationResult(questId, { requestId: request.requestId, ...result, instanceId: dispatcherInstanceId, adapter: 'opencode-session' });
      if (!next?.cancelRequest || next.cancelRequest.requestId !== request.requestId || (next.assignee?.attemptId ?? null) !== (request.attemptId ?? null)) {
        return { status: 202, body: { quest: next, result: 'unknown', request: next?.cancelRequest || null, detail: '取消已变更，取消结果未记录' } };
      }
      return { status: 202, body: { quest: next, result: next.cancelRequest.result, request: next.cancelRequest } };
    }
    if (lane?.control?.type !== 'generic-wrapper') {
      if (source === 'limit') {
        const next = store.recordCancellationResult(questId, { requestId: request.requestId, result: 'manual_required', detail: '无法自动停止，请手动处理', instanceId: dispatcherInstanceId, adapter: 'unsupported' });
        return { status: 200, body: { quest: next, result: 'manual_required', request: next.cancelRequest } };
      }
      const next = store.recordCancellationResult(questId, { requestId: request.requestId, result: 'manual_required', detail: '这个通道的包装脚本不支持可核实的停止，需要手动确认', instanceId: dispatcherInstanceId, adapter: 'unsupported' });
      return { status: 200, body: { quest: next, result: 'manual_required', request: next.cancelRequest } };
    }
    const result = await genericWrapper({ attempt: requested.assignee, request, handle: controlHandles.get(request.attemptId) });
    const cancellation = source === 'limit' && result.result === 'manual_required'
      ? { ...result, detail: '无法自动停止，请手动处理' } : result;
    const beforeRecord = store.get(questId);
    const sameRequest = beforeRecord?.cancelRequest
      && beforeRecord.cancelRequest.requestId === request.requestId
      && (beforeRecord.cancelRequest.attemptId ?? null) === (request.attemptId ?? null)
      && (beforeRecord.assignee?.attemptId ?? null) === (request.attemptId ?? null);
    if (!sameRequest) {
      return { status: 202, body: { quest: beforeRecord, result: 'unknown', request: beforeRecord?.cancelRequest || null, detail: '取消已变更，取消结果未记录' } };
    }
    if (beforeRecord.cancelRequest.result !== 'pending') {
      return { status: 200, body: { quest: beforeRecord, result: beforeRecord.cancelRequest.result, request: beforeRecord.cancelRequest } };
    }
    const next = store.recordCancellationResult(questId, { requestId: request.requestId, ...cancellation, instanceId: dispatcherInstanceId, adapter: 'generic-wrapper' });
    if (!next?.cancelRequest || next.cancelRequest.requestId !== request.requestId || (next.assignee?.attemptId ?? null) !== (request.attemptId ?? null)) {
      return { status: 202, body: { quest: next, result: 'unknown', request: next?.cancelRequest || null, detail: '取消已变更，取消结果未记录' } };
    }
    return { status: 202, body: { quest: next, result: next.cancelRequest.result, request: next.cancelRequest } };
  }

  function resolve(questId, source, reason, ack) {
    if (!store.get(questId)) return { status: 404, body: { error: 'quest not found' } };
    try { return { status: 200, body: { quest: store.resolveManually(questId, { source, reason, ack }) } }; }
    catch (error) { return { status: 409, body: { error: 'refused', reasons: [{ code: error.code || 'manual_ack_required', message: error.message }] } }; }
  }

  // FB2-S1: the API/stream delivery writes live in deliveryWriter.js; the gate consumes them.
  const deliveryWriter = createDeliveryWriter({ config, store, stillOurs, safeguard, reportPersistenceFailure, captureReportFor, triggerDeliveredHooks, writeDelivery, attemptEvidence });

  // FB2-05: the delivered-transition settlement — gate, bounce, review modes — lives in deliveryGate.js
  // (the dispatcher was past its file-size budget); it receives exactly the pieces of this scope it needs.
  const deliveryGate = createDeliveryGate({
    config, store, runners, fetchImpl, runCheck, runMechanical,
    stillOurs, attemptKey, attachChild, fixPlans, controlHandles,
    safeguard, reportPersistenceFailure, captureReportFor, triggerDeliveredHooks, notifyInbox,
    deliverFromApi: deliveryWriter.deliverFromApi, deliverStreamResult: deliveryWriter.deliverStreamResult, attemptEvidence,
  });

  // pendingDeliveries is checked against the quest's *current* assignee's attempt key, not the transition's
  // quest id alone — a hung write for an old, superseded attempt must never block a new attempt's own
  // delivery from ever starting (see attemptKey above); it can only ever block a second write for that same
  // attempt, which is exactly what it is for.
  function applyLanes(lanes) {
    store.expirePendingCancellations?.({ instanceId: dispatcherInstanceId });
    for (const transition of deriveTransitions(store.list(), lanes.packages)) {
      try {
        const quest = store.get(transition.id);
        if (!quest) continue;
        if (quest.assignee && deliveryWriter.isPending(quest.assignee)) continue;
        const lane = quest.assignee && config.lanes[quest.assignee.lane];
        // FB2-05: a delivered transition is the one moment the delivery gate, the review mode and the
        // ordinary delivery write all meet. Everything from the self-check through the settled status runs
        // through deliveryGate.settleWithCheck (src/server/deliveryGate.js) — once per attempt at a time, with the delivery evidence
        // fingerprinted so a poll replay of an already-bounced delivery is never re-checked.
        if (transition.status === 'delivered' && quest.assignee) {
          const key = attemptKey(quest.assignee);
          if (pendingChecks.has(key)) continue;
          // A failed round already consumed this exact delivery evidence (same text, same artifact
          // mtimes): this poll is a replay while the worker fixes, never a fresh delivery — skip it so the
          // round count is not re-checked against the same failure. A changed fingerprint (the worker's
          // new delivery after a fix) starts the next round.
          const lastCheck = [...(quest.assignee.checkResults || [])].at(-1);
          if (lastCheck && !lastCheck.ok && lastCheck.evidence === deliveryGate.deliveryFingerprint(quest, transition, lane)) continue;
          pendingChecks.add(key);
          deliveryGate.settleWithCheck(quest, transition, lane)
            .catch((error) => reportPersistenceFailure('settleWithCheck', quest.id, error))
            .finally(() => pendingChecks.delete(key));
          continue;
        }
        // Only an ending binds a report reference; stalled/dispatched pass through untouched.
        const current = store.get(transition.id);
        if (transition.cancellationResult && current?.cancelRequest) {
          store.recordCancellationResult(transition.id, {
            requestId: current.cancelRequest.requestId, result: transition.cancellationResult, detail: transition.detail,
            evidence: transition.evidence, instanceId: dispatcherInstanceId, adapter: current.cancelRequest.adapter || 'generic-wrapper',
          });
        } else {
          const report = current?.assignee && TERMINAL_STATUSES.has(transition.status) ? captureReportFor(current) : null;
          const next = store.setStatus(transition.id, transition.status, {
            detail: transition.detail, by: 'lanes', source: 'collector', evidence: { kind: 'collector', attempt: attemptEvidence(current?.assignee) },
            ...(report ? { report } : {}),
          });
          if (transition.status === 'delivered' && next) triggerDeliveredHooks(next);
          if (transition.limitReason && !current?.cancelRequest && ['generic-wrapper', 'opencode-session'].includes(lane?.control?.type)) {
            void cancel(transition.id, 'limit', transition.limitReason).catch((error) => {
              reportPersistenceFailure('limit cancellation', transition.id, error, '取消失败');
            });
          }
        }
      } catch (error) {
        // A refusal or persistence fault for one quest must not abort the rest of this collector snapshot.
        try { process.stderr.write(`questboard: lane transition skipped for ${transition.id}: ${error.message}\n`); } catch {}
      }
    }
    // Job objects deliberately outlive their wrapper for the collector's death check (see onChild above):
    // close them here once the attempt they belong to is no longer live (settled, released, reassigned),
    // so they neither accumulate nor keep breakaway processes contained forever.
    for (const [attemptId, handle] of controlHandles) {
      const quest = store.list().find((q) => q.assignee && q.assignee.attemptId === attemptId);
      if (quest && (quest.status === 'dispatched' || quest.status === 'stalled')) continue;
      if (handle.jobId) closeJobObject(handle.jobId).catch(() => {});
      controlHandles.delete(attemptId);
      fixPlans.delete(attemptId);
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

  // The collector's death check (FB2-01): 'empty' only when the board's own job object for this attempt
  // exists and counts zero processes. A missing job (an adopted worker, a lane without the job gate, a
  // board restart) or a counting failure is 'unknown' — never proof of death.
  async function verifyProcessTree({ attemptId } = {}) {
    const handle = controlHandles.get(attemptId);
    if (!handle || !handle.jobId) return 'unknown';
    try {
      return (await countJobObject(handle.jobId)) === 0 ? 'empty' : 'alive';
    } catch {
      return 'unknown';
    }
  }

  return { assign, adopt, release, cancel, resolve, applyLanes, getUnpersistedSession, getControlHandle, verifyProcessTree, cancelHook: verificationHooks.cancel };
}
