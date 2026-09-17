// Quest store. One quest per package id. Snapshots are appended to <data>/quests.jsonl (replay keeps the
// latest per id); every state change is also appended to the events file the coordinator tails.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { realpathContainmentIssue } from './config.js';
import { appendJsonLine, readJsonLines } from './jsonl.js';
import { lastEventSeq } from './events.js';
import { packageIdPattern, briefPathAllowed } from './patterns.js';
import { holdsSlot } from './rules.js';
import {
  CANCELLATION_RESULTS, attemptEvidence, cancellationError, cancellationReason, cancellationSource, manualResolution, resolutionSource,
} from './cancellation.js';
import {
  validateMetadataUpdate, validateParents, sameList,
  reviewTargetLockedMessage, findReviewAncestorLock, reviewAncestorLockedMessage, kindLockReason,
} from './metadataUpdate.js';
import { validateRoleCard } from './roleCard.js';
import { validateAcceptanceShape } from './acceptance.js';
import { validateHookRecord } from './verificationHooks.js';

export const KINDS = new Set(['code', 'review', 'art', 'tool', 'owner']);
export const QUEST_STATUSES = new Set(['posted', 'dispatched', 'delivered', 'reviewing', 'needs_owner', 'owner_playtest', 'lane_limited',
  'bounced', 'failed', 'stalled', 'done', 'superseded', 'cancelled']);
const STATUS_EVENTS = { delivered: 'delivered', failed: 'failed', bounced: 'bounced', stalled: 'stalled', cancelled: 'cancelled' };
// Once one of these is reached for an attempt, a repeat of the exact same status is the same fact arriving
// twice (a duplicate poll, a retried callback), not a second real transition.
const TERMINAL_STATUSES = new Set(['delivered', 'failed', 'bounced']);
const MAX_TEXT = 300;
const ANNOTATION_PAGE_PATTERN = /^[a-z0-9_-]{1,64}$/;
const ANNOTATION_DIGEST_PATTERN = /^[a-f0-9]{64}$/;

// Identity for one dispatch attempt. requestKey stays the caller's idempotency key for a single API call;
// attemptId is the attempt itself, so a callback can tell "this exact assignment" apart from a same-named
// or same-timestamped one that replaced it. Older stored rows have no attemptId — for those, name (and at,
// when both sides carry one) is the most conservative identity available, not a licence to trust any future
// row with the same name.
export function sameAttempt(assignee, attempt) {
  if (!assignee || !attempt || !assignee.name || assignee.name !== attempt.name) return false;
  if (assignee.attemptId && attempt.attemptId) return assignee.attemptId === attempt.attemptId;
  // The legacy fallback (no attemptId on one or both sides) is name+at; when both sides also carry a lane,
  // require it to match too — two attempts sharing a name and a coarse timestamp but running on different
  // lanes are not the same attempt, and this fallback must not be more willing to conflate them than the
  // attemptId path ever would be.
  if (assignee.lane && attempt.lane && assignee.lane !== attempt.lane) return false;
  // The legacy fallback only counts as identity when both sides actually carry an `at` to compare — a name
  // match alone (or a name match where one side never recorded an `at`) is not strong enough proof to gate
  // a mutation (recordPhase, stillOurs): it must never authorize a late callback to touch a newer or
  // unrelated attempt just because nothing to disagree with was recorded. (A looser, name-only heuristic
  // might be defensible for read-only legacy display somewhere — that would be a separate, explicitly
  // labelled function, never this one.)
  return Boolean(assignee.at) && Boolean(attempt.at) && assignee.at === attempt.at;
}

// A terminal fact belongs to the attempt it was recorded under. An older row that never carried an
// attemptId must not shadow a newer attempt that does: the two sides have to agree on whether they even
// have an attemptId (both or neither) before sameAttempt is allowed to decide the rest.
function factMatchesAttempt(fact, attempt) {
  if (!fact || !attempt) return false;
  if (Boolean(fact.attemptId) !== Boolean(attempt.attemptId)) return false;
  return sameAttempt(fact, attempt);
}

function evidenceMatchesAttempt(assignee, evidence) {
  if (!assignee || !evidence) return false;
  // New dispatcher evidence carries the complete identity. Keep accepting the existing attemptId-only
  // shape for current-attempt callers: the id is the strongest identity when both sides have one. Legacy
  // evidence must use sameAttempt's name+at fallback, never name alone.
  const attempt = evidence.attempt || (evidence.name || evidence.at ? evidence : null);
  if (attempt) return sameAttempt(assignee, attempt);
  return Boolean(assignee.attemptId && evidence.attemptId) && assignee.attemptId === evidence.attemptId;
}

function sameCancellationEvidenceScope(left, right) {
  if ((left?.kind || right?.kind) === 'opencode-session') {
    return left?.kind === right?.kind && left?.sessionId === right?.sessionId && left?.followupEnded === right?.followupEnded;
  }
  return (left?.exitRequestId ?? null) === (right?.exitRequestId ?? null)
    && (left?.scope ?? null) === (right?.scope ?? null);
}

const now = () => new Date().toISOString();

function splitList(value) {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  return [...new Set(list.map((v) => String(v).trim()).filter(Boolean))];
}

function pathInside(root, target) {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  const normalize = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  const baseN = normalize(base);
  const targetN = normalize(resolved);
  return targetN === baseN || targetN.startsWith(`${baseN}${path.sep}`);
}

// The snapshot reference is plain, non-secret metadata. It is validated at the persistence boundary as well
// as when it is created, so a malformed caller cannot turn the detail route into a path or digest oracle.
export function validateAnnotationSnapshot(config, questId, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('annotationSnapshot must be an object');
  if (typeof value.page !== 'string' || !ANNOTATION_PAGE_PATTERN.test(value.page)) throw new Error('annotationSnapshot.page has an invalid page id');
  if (typeof value.title !== 'string' || value.title.length > 1000) throw new Error('annotationSnapshot.title must be a string of at most 1000 characters');
  if (!Number.isSafeInteger(value.count) || value.count < 0) throw new Error('annotationSnapshot.count must be a non-negative integer');
  if (typeof value.capturedAt !== 'string' || !Number.isFinite(Date.parse(value.capturedAt))) throw new Error('annotationSnapshot.capturedAt must be a valid date string');
  if (typeof value.digest !== 'string' || !ANNOTATION_DIGEST_PATTERN.test(value.digest)) throw new Error('annotationSnapshot.digest must be a SHA-256 hex digest');
  if (typeof value.path !== 'string' || !value.path.trim() || value.path.includes('\0') || path.isAbsolute(value.path)) throw new Error('annotationSnapshot.path must be a relative path');
  const absolutePath = path.resolve(config.root, value.path);
  if (!pathInside(config.root, absolutePath)) throw new Error('annotationSnapshot.path must stay under the project root');
  const projectIssue = realpathContainmentIssue(config.root, absolutePath);
  if (projectIssue) throw new Error('annotationSnapshot.path must stay under the project root');
  const expected = path.join(config.paths.data, 'dispatch-briefs', questId);
  if (!pathInside(expected, absolutePath)) throw new Error('annotationSnapshot.path must stay under the quest dispatch-brief directory');
  return { page: value.page, title: value.title, count: value.count, capturedAt: value.capturedAt, digest: value.digest, path: value.path };
}

export function validatePost(config, payload, quests = []) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const errors = {};
  const idPattern = packageIdPattern(config);
  const pkg = String(input.package || '').trim();
  if (!idPattern.test(pkg)) errors.package = `package must match ${idPattern}`;
  const kind = String(input.kind || 'code').trim();
  if (!KINDS.has(kind)) errors.kind = `kind must be one of ${[...KINDS].join('|')}`;
  const brief = String(input.brief || '').trim().replaceAll('\\', '/');
  if (kind !== 'owner' && !brief) errors.brief = 'brief is required';
  if (brief && !briefPathAllowed(config, brief, kind)) {
    const dirs = kind === 'owner' ? [...config.briefs.dispatchDirs, ...config.briefs.ownerDirs] : config.briefs.dispatchDirs;
    errors.brief = `brief must be <dir>/<file>.md with <dir> one of ${[...new Set(dirs)].join(', ')}`;
  }
  const ids = (field) => {
    const list = splitList(input[field]);
    const bad = list.find((id) => !idPattern.test(id));
    if (bad) errors[field] = `${field} must be package ids, got ${bad}`;
    return list;
  };
  const parents = ids('parents');
  const conflicts = ids('conflicts');
  // A pattern-valid parent list can still name a package that was never posted, itself, or a chain that
  // loops back to itself — all three are rejected before this quest is ever written, the same as an update
  // (see validateParents): an unusable task is never allowed onto the board in the first place, "post the
  // child, then post the parent later" is not a supported ordering.
  if (!errors.parents && parents.length) {
    const err = validateParents(pkg, parents, new Map(quests.map((q) => [q.id, q])));
    if (err) errors.parents = err;
  }
  const allowedLanes = splitList(input.allowedLanes);
  const badLane = allowedLanes.find((lane) => !config.lanes[lane]);
  if (badLane) errors.allowedLanes = `unknown lane ${badLane}; this project defines ${Object.keys(config.lanes).join(', ')}`;
  const priority = input.priority === undefined || input.priority === '' ? 2 : Number(input.priority);
  if (![1, 2, 3].includes(priority)) errors.priority = 'priority must be 1, 2 or 3';
  const value = {
    package: pkg, kind, brief,
    title: String(input.title || '').trim().slice(0, 120),
    parents,
    conflicts,
    allowedLanes,
    priority,
    needsOwner: String(input.needsOwner || '').trim().slice(0, MAX_TEXT),
    reviewPage: String(input.reviewPage || '').trim().slice(0, 64),
    by: String(input.by || 'coordinator').trim().slice(0, 40),
  };
  return { errors, value };
}

function titleFromBrief(brief, pkg) {
  const base = path.basename(brief || '', '.md');
  const rest = base.startsWith(pkg) ? base.slice(pkg.length).replace(/^-/, '') : base;
  return rest ? rest.replaceAll('-', ' ') : pkg;
}

export class QuestStore extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.questsPath = path.join(config.paths.data, 'quests.jsonl');
    this.eventsFile = config.paths.events;
    this.quests = new Map();
    for (const record of readJsonLines(this.questsPath)) if (record && record.id) this.quests.set(record.id, record);
    this.eventSeq = lastEventSeq(this.eventsFile);
    this.instanceId = randomUUID();
    this.expirePendingCancellations({ instanceId: this.instanceId });
  }

  list() {
    return [...this.quests.values()].map((q) => ({ ...q }));
  }

  get(id) {
    const quest = this.quests.get(id);
    return quest ? { ...quest } : null;
  }

  // Every save bumps the revision, so a caller that read revision N can ask for its write to apply only if the
  // quest is still at N (a re-posted brief, a ruling or a status change in between makes it stale).
  save(quest) {
    const next = { ...quest, revision: (quest.revision || 0) + 1 };
    return this.appendSnapshot(next);
  }

  // The one durable write every save goes through: disk first, memory second. If the append throws (a locked
  // file, EISDIR), the in-memory map must stay exactly as it was, not jump ahead of what actually got
  // persisted — a caller that reads it back after a failed save must see the same state a restart would
  // replay from disk, never a state that looks further along (e.g. an assignee already cleared) than what
  // is durable.
  appendSnapshot(next) {
    appendJsonLine(this.questsPath, next);
    this.quests.set(next.id, next);
    return next;
  }

  // Records the intent to report a terminal status before the event is appended, and deliberately without a
  // revision bump: the status itself has not moved yet, and the revision a caller just read must stay the one
  // that still identifies this open transition (a polling retry re-derives it and tries again).
  savePendingFact(quest, terminalFact, updatedAt) {
    return this.appendSnapshot({ ...quest, terminalFact, updatedAt });
  }

  emitEvent(quest, event, fields = {}, { notify = true } = {}) {
    const assignee = fields.assignee || quest.assignee || {};
    this.eventSeq += 1;
    const record = {
      seq: this.eventSeq, at: now(), event, package: quest.id,
      lane: assignee.lane || null, model: assignee.model || null, variant: assignee.variant || null, name: assignee.name || null,
      attemptId: assignee.attemptId || null,
      by: fields.by || 'board', detail: String(fields.detail || '').slice(0, 2000),
      // Additive, never on any other event: metadata_update's own bounded record of which fields changed
      // and their non-secret old/new values (every metadata field is plain text/id lists, never a secret).
      // Omitted entirely unless a caller actually passes one, so every existing event's own shape on disk
      // stays byte-identical to before this was added.
      ...(fields.changedFields ? { changedFields: fields.changedFields } : {}),
      ...(fields.changes ? { changes: fields.changes } : {}),
      // Additive, only on a terminal event whose caller captured one: the structured reference to the report
      // this attempt produced ({source, ref, digest, capturedAt, ...}). Omitted entirely otherwise, so every
      // existing event's own shape on disk stays byte-identical to before this was added.
      ...(fields.report ? { report: fields.report } : {}),
      // Annotation provenance belongs only to the dispatched event for an art attempt. Omit both keys when
      // callers do not pass them, preserving every unaffected event's serialized shape.
      ...(fields.annotationCount !== undefined ? { annotationCount: fields.annotationCount } : {}),
      ...(fields.annotationPage !== undefined ? { annotationPage: fields.annotationPage } : {}),
      // Cancellation audit fields are additive and only appear on the two cancellation event types.
      ...(fields.quest !== undefined ? { quest: fields.quest } : {}),
      ...(fields.requestId !== undefined ? { requestId: fields.requestId } : {}),
      ...(fields.source !== undefined ? { source: fields.source } : {}),
      ...(fields.result !== undefined ? { result: fields.result } : {}),
      ...(fields.adapter !== undefined ? { adapter: fields.adapter } : {}),
      ...(fields.instanceId !== undefined ? { instanceId: fields.instanceId } : {}),
      // Verification hook events carry only the fixed, non-stdout payload. The ordinary event envelope remains
      // intact so existing tails and SSE consumers keep their required fields.
      ...(fields.hookEvent ? { ...fields.hookEvent } : {}),
    };
    appendJsonLine(this.eventsFile, record);
    if (notify) this.notify(record);
    return record;
  }

  // Listeners (the SSE feed) must never be able to abort or duplicate a store write: a listener that throws
  // would otherwise surface as a failed setStatus whose retry re-appends the event that already landed. The
  // report follows the server's existing pattern, and the writes above are already durable.
  notify(record) {
    try {
      this.emit('event', record);
    } catch (error) {
      process.stderr.write(`questboard: event listener failed: ${error.stack || error.message}\n`);
    }
  }

  post(payload) {
    const { errors, value } = validatePost(this.config, payload, this.list());
    if (Object.keys(errors).length) return { errors };
    const existing = this.quests.get(value.package);
    if (existing && existing.status === 'dispatched') return { errors: { package: `${value.package} is running; cancel it before re-posting` } };
    const titleSent = Boolean(payload) && typeof payload === 'object' && payload.title !== undefined;
    // An omitted title normally falls back to titleFromBrief (old MAIN behaviour, unchanged here) — but while
    // a worker still holds this quest's slot, that fallback is not a harmless default, it is a hidden change:
    // a re-post that only raises needsOwner (or otherwise never mentions title) must never silently overwrite
    // a custom title with one derived from the brief. Only while held does the omitted case keep the existing
    // title instead; the holds_slot guard below only ever compares this same `title`, so the two can never
    // disagree about whether title "changed".
    const title = titleSent ? value.title
      : (existing && holdsSlot(existing) ? (existing.title || '') : (value.title || titleFromBrief(value.brief, value.package)));
    // A posted review's own identity (what it targets, and that it *is* a review) is fixed the moment it is
    // posted — never through a re-post upsert either, or a coordinator could bypass reviewer_coded_parent in
    // three calls: turn the review into kind:'code' (which this same upsert would otherwise allow, since
    // kind defaults to 'code' whenever a caller omits it), drop the now-unprotected parents, then post it back
    // as kind:'review' as if it were fresh. The same laundering also runs the other way — relabel an authored
    // *ancestor* of an existing review as a review, or an existing review's authored ancestor's kind away and
    // back — so the kind lock below applies to any existing quest a kind-change is attempted on, not only an
    // existing review; and the parent lock below applies to any existing quest a posted review's own ancestor
    // walk already reaches, not only the review's own declared parent. A genuinely new review, or a quest kind
    // change untouched by any of this, still gets its own missing/self/cycle checks in validatePost above.
    if (existing && value.kind !== existing.kind) {
      const lockMessage = kindLockReason(existing, this.list());
      if (lockMessage) return { errors: { kind: lockMessage } };
    }
    if (existing && !sameList(value.parents, existing.parents || [])) {
      if (existing.kind === 'review') return { errors: { parents: reviewTargetLockedMessage(existing.id) } };
      const protectingReview = findReviewAncestorLock(existing.id, this.list());
      if (protectingReview) return { errors: { parents: reviewAncestorLockedMessage(existing.id, protectingReview) } };
    }
    // The re-post path must obey the same holds_slot guard updateMetadata does for the same identity fields
    // (title/brief/parents/conflicts/allowedLanes): a dispatched or stalled-but-owned quest is not repointed
    // at different work out from under its worker. needsOwner is deliberately exempt — raising a question
    // about a stalled attempt (see the test for this) must keep working through a re-post exactly as before.
    if (existing && holdsSlot(existing)) {
      const identityChanges = [
        ['title', titleSent && title !== (existing.title || '')],
        ['brief', value.brief !== (existing.brief || '')],
        ['parents', !sameList(value.parents, existing.parents || [])],
        ['conflicts', !sameList(value.conflicts, existing.conflicts || [])],
        ['allowedLanes', !sameList(value.allowedLanes, existing.allowedLanes || [])],
      ].filter(([, changed]) => changed).map(([field]) => field);
      if (identityChanges.length) {
        const message = `${existing.id} 有 worker 占着（${existing.status}），先释放再改`;
        return { errors: Object.fromEntries(identityChanges.map((field) => [field, message])) };
      }
    }
    const at = now();
    const { by, ...fields } = value;
    // A stalled worker is silence, not a confirmed exit (see release()): it still holds its slot and file
    // reservations, so a re-post (say, an updated brief) must not knock it out of that status just because
    // this post also carries a needsOwner question — the question is recorded, but the attempt is not freed.
    const owned = Boolean(existing) && holdsSlot(existing);
    const quest = this.save({
      ...(existing || { dispatches: [], rulings: [], assignee: null, createdAt: at, status: 'posted' }),
      ...fields,
      id: value.package,
      title,
      status: value.needsOwner && !owned ? 'needs_owner' : (existing && !['done', 'superseded', 'cancelled'].includes(existing.status) ? existing.status : 'posted'),
      postedBy: by,
      updatedAt: at,
    });
    this.emitEvent(quest, value.kind === 'review' ? 'review_posted' : 'posted', { by, detail: quest.title });
    return { quest };
  }

  // Emits `assigned` (the owner picked a card); the server emits `dispatched` once the script started.
  // Adopting a worker that already runs passes event 'dispatched' and adopted: true.
  // requestKey is the caller's own id for this attempt, for the caller's own retry safety — it never stands
  // in for identity. attemptId does: every assign/adopt mints a fresh one, so two attempts that happen to
  // land on the same worker name (a re-adopt, a normalization collision) or the same timestamp (coarse
  // clocks, two quick drops) are still told apart by whoever compares against it later (sameAttempt).
  assign(id, { adventurer, name, by = 'owner', detail, event = 'assigned', adopted = false, requestKey = null }) {
    const quest = this.quests.get(id);
    if (!quest) return null;
    const at = now();
    const assignee = {
      adventurerId: adventurer.id, family: adventurer.family || null, lane: adventurer.lane, model: adventurer.model, variant: adventurer.variant || '',
      name, at, by, attemptId: randomUUID(),
      // Write-ahead phase, durable from the moment the attempt exists (saved to quests.jsonl below, replayed
      // on restart): 'queued' for a fresh assign — executePlan's onPhase advances it to 'session_creating'
      // then 'launching' via recordPhase, before each effect actually runs, never after. An adopted worker
      // was never queued by this board at all; it starts at 'launching' since it is already running by hand.
      phase: adopted ? 'launching' : 'queued',
      ...(adopted ? { adopted: true } : {}), ...(requestKey ? { requestKey } : {}),
    };
    const next = this.save({ ...quest, status: 'dispatched', assignee, cancelRequest: null, manualResolution: null, dispatches: [...quest.dispatches, assignee], updatedAt: at });
    this.emitEvent(next, event, { by, detail: detail || `${adventurer.name} 接了任务` });
    return next;
  }

  // The durable write-ahead record of one attempt's execution phase and, once known, its session binding —
  // called from executePlan's onPhase, strictly before the effect it announces runs. Persisted on the quest
  // itself (quests.jsonl, replayed on restart from the latest row per id), not only as a prose status_note
  // event or an in-memory executePlan return value, so a crash or reload after this call still shows what
  // was attempted. Refuses (throws, rather than silently writing over the wrong record) when `attempt` is no
  // longer this quest's current assignee — the caller must treat that exactly like a real disk failure: the
  // phase could not be durably recorded, so the effect it would have gated must not run.
  // `unresolved: true` is the structured write-ahead marker for "this attempt's real-world effect is not
  // known either way" (a session step's nonzero exit, timeout or throw; a queued recheck refused after an
  // effect already ran) — persisted on the assignee itself, not only as a prose status_note event, so it
  // survives reload and a caller checking the record later does not have to parse event text to see it.
  recordPhase(id, attempt, { phase, session, unresolved } = {}) {
    const quest = this.quests.get(id);
    if (!quest || !sameAttempt(quest.assignee, attempt)) throw new Error(`${id} 的这次派遣已经不是当前记录了，阶段没法登记`);
    const assignee = { ...quest.assignee, ...(phase !== undefined ? { phase } : {}), ...(session !== undefined ? { session } : {}), ...(unresolved !== undefined ? { unresolved } : {}) };
    return this.save({ ...quest, assignee, updatedAt: now() });
  }

  // Writes the immutable annotation reference after assign() has minted the attempt id and before the
  // dispatcher queues any child effect. The matching dispatch history row is updated too, so a later detail
  // read still has the provenance after this attempt no longer holds the current assignee slot.
  recordAnnotationSnapshot(id, attempt, annotationSnapshot) {
    const quest = this.quests.get(id);
    if (!quest || !sameAttempt(quest.assignee, attempt)) throw new Error(`${id} 的这次派遣已经不是当前记录了，批注快照没法登记`);
    const value = validateAnnotationSnapshot(this.config, id, annotationSnapshot);
    if (quest.assignee.annotationSnapshot) throw new Error(`${id} 的这次派遣已经登记过批注快照了`);
    const assignee = { ...quest.assignee, annotationSnapshot: value };
    const dispatches = (quest.dispatches || []).map((dispatch) => sameAttempt(dispatch, attempt)
      ? { ...dispatch, annotationSnapshot: value } : dispatch);
    return this.save({ ...quest, assignee, dispatches, updatedAt: now() });
  }

  // The role card reference is the durable write-ahead binding for every dispatch attempt. The file is
  // created first by the dispatcher; this second write records exactly which immutable bytes belong to the
  // assignee and to its historical dispatch row.
  recordRoleCard(id, attempt, roleCard) {
    const quest = this.quests.get(id);
    if (!quest || !sameAttempt(quest.assignee, attempt)) throw new Error(`${id} 的这次派遣已经不是当前记录了，角色卡没法登记`);
    const value = validateRoleCard(this.config, id, attempt.attemptId, roleCard);
    if (quest.assignee.roleCard) throw new Error(`${id} 的这次派遣已经登记过角色卡`);
    const assignee = { ...quest.assignee, roleCard: value };
    const dispatches = (quest.dispatches || []).map((dispatch) => sameAttempt(dispatch, attempt)
      ? { ...dispatch, roleCard: value } : dispatch);
    return this.save({ ...quest, assignee, dispatches, updatedAt: now() });
  }

  // Hook state is append-only: every queued/running/result change is a new exact S2 element. The current
  // assignee and the matching historical dispatch row receive the same array so the evidence slot survives a
  // later assignee clear. A recovery update may target a historical row after the assignee is gone.
  recordHook(id, attempt, hookRecord) {
    const quest = this.quests.get(id);
    if (!quest) throw new Error(`${id} not found`);
    const value = validateHookRecord(this.config, hookRecord);
    let matched = false;
    let currentHooks = null;
    const current = quest.assignee && sameAttempt(quest.assignee, attempt);
    const dispatches = (quest.dispatches || []).map((dispatch) => {
      if (!sameAttempt(dispatch, attempt)) return dispatch;
      matched = true;
      const hooks = currentHooks || [...(dispatch.hooks || []), value];
      currentHooks = hooks;
      return { ...dispatch, hooks };
    });
    if (!matched) throw new Error(`${id} has no matching dispatch for hook attempt`);
    const assignee = current ? { ...quest.assignee, hooks: currentHooks } : quest.assignee;
    return this.save({ ...quest, assignee, dispatches, updatedAt: now() });
  }

  setStatus(id, status, { detail = '', by = 'coordinator', report = null, source, ack = false, evidence, acceptance } = {}) {
    if (!QUEST_STATUSES.has(status)) throw new Error(`status must be one of ${[...QUEST_STATUSES].join('|')}`);
    const quest = this.quests.get(id);
    if (!quest) return null;
    // Feedback 15: an additive, validated acceptance record — shape only here (actor/evidenceRefs/note); the
    // match against this quest's real current-attempt evidence is the caller's job (src/server/questRoutes.js,
    // src/core/acceptance.js buildAcceptance), since store.js never sees the project-verification/hook data
    // questEvidence() needs. Carried only on done; every other status ignores it.
    const acceptanceRecord = status === 'done' ? validateAcceptanceShape(acceptance) : undefined;
    let current = quest;
    if (this.freesSlot(status) && holdsSlot(current)) current = this.authorizeFreeTransition(current, status, { detail, by, source, ack, evidence });
    // Terminal statuses go through setTerminalStatus, which owns the durable ordering (persist the fact,
    // then append the event, then confirm it) that keeps a crash between writes from losing or duplicating
    // the delivered/failed/bounced event. `report` rides along additively so the terminal write can also
    // bind the attempt's final-report reference; callers without one pass nothing and nothing changes.
    if (TERMINAL_STATUSES.has(status)) return this.setTerminalStatus(current, status, { detail, by, report });
    // A stall is silence, not a confirmed exit: the worker keeps the quest (and its slot and file
    // reservations) until release() says the process is gone. failed/bounced come from exit files.
    const stillAssigned = ['dispatched', 'delivered', 'reviewing', 'stalled'].includes(status);
    const next = this.save({
      ...current, status, assignee: stillAssigned ? current.assignee : null, lastDetail: String(detail).slice(0, 2000), updatedAt: now(),
      ...(acceptanceRecord ? { acceptance: acceptanceRecord } : {}),
    });
    this.emitEvent(next, STATUS_EVENTS[status] || `status_${status}`, { by, detail, assignee: current.assignee || {} });
    return next;
  }

  freesSlot(status) {
    return status !== 'dispatched' && status !== 'stalled';
  }

  authorizeFreeTransition(quest, status, { detail = '', by = 'coordinator', source, ack = false, evidence } = {}) {
    // Missing, legacy, and unknown callers are deliberately not a compatibility bypass. They are
    // anonymous evidence and may free the reservation only after the same explicit acknowledgement and
    // reason as a named UI/CLI/MCP caller; the audit records that the source was unknown.
    const operationSource = source === 'collector' || source === 'dispatcher'
      ? source
      : cancellationSource(source) || 'unknown';
    const trustedEvidence = (operationSource === 'collector' || operationSource === 'dispatcher')
      && evidenceMatchesAttempt(quest.assignee, evidence);
    if (trustedEvidence) return quest;
    if (!ack || !cancellationReason(detail)) {
      throw cancellationError('manual_ack_required', `${quest.id} 仍占用 worker；释放前必须明确确认并填写非空原因`);
    }
    const audit = manualResolution(operationSource, quest.assignee, detail);
    const audited = this.save({ ...quest, manualResolution: audit, updatedAt: now() });
    try { this.emitEvent(audited, 'manual_resolution', { by: operationSource, detail, assignee: quest.assignee }); } catch (error) {
      try { process.stderr.write(`questboard: manual resolution event append failed: ${error.message}\n`); } catch {}
    }
    return audited;
  }

  requestCancellation(id, { source, reason, instanceId = null, deadlineAt = null, adapter = null } = {}) {
    const quest = this.quests.get(id);
    if (!quest) return null;
    const bySource = cancellationSource(source);
    const why = cancellationReason(reason);
    if (!bySource) throw cancellationError('invalid_source', '取消来源只能是 ui、cli、mcp 或 limit');
    if (!why) throw cancellationError('reason_required', '取消原因不能为空');
    if (!quest.assignee || !['dispatched', 'stalled'].includes(quest.status)) {
      throw cancellationError('not_cancellable', `${id} 没有仍在运行、可以请求取消的 worker`);
    }
    const existing = quest.cancelRequest;
    // Legacy rows may omit attemptId entirely while the current normalized request carries null. Treat
    // both representations as the same attempt so a retry cannot create a request/event storm.
    if (existing && (existing.attemptId ?? null) === (quest.assignee.attemptId ?? null)) return quest;
    const request = {
      requestId: randomUUID(), attemptId: quest.assignee.attemptId || null, at: now(), bySource, reason: why,
      result: 'pending', ...(instanceId ? { instanceId } : {}), ...(deadlineAt ? { deadlineAt } : {}),
      adapter: adapter || 'unknown',
    };
    const next = this.save({ ...quest, cancelRequest: request, assignee: { ...quest.assignee, cancelRequest: request }, updatedAt: now() });
    try { this.emitEvent(next, 'cancel_requested', {
      by: bySource, detail: why, quest: id, requestId: request.requestId, source: bySource,
      result: 'pending', adapter: request.adapter, instanceId: request.instanceId || null,
    }); } catch (error) {
      try { process.stderr.write(`questboard: cancellation event append failed: ${error.message}\n`); } catch {}
    }
    return next;
  }

  expirePendingCancellations({ nowMs = Date.now(), instanceId = this.instanceId, adapter = null } = {}) {
    for (const quest of this.quests.values()) {
      const request = quest.cancelRequest;
      const deadline = Date.parse(request?.deadlineAt || '');
      if (request?.result !== 'pending' || !Number.isFinite(deadline) || deadline > nowMs) continue;
      const expiredDetail = `取消请求已超过截止时间 ${request.deadlineAt}，未收到可验证结果，状态记为 unknown`;
      if (holdsSlot(quest)) {
        this.recordCancellationResult(quest.id, {
          requestId: request.requestId, result: 'unknown', detail: expiredDetail,
          instanceId, adapter: adapter || request.adapter || 'unknown',
        });
        continue;
      }
      // A collector may clear the old attempt while its cancellation call is still in flight. There is
      // then no current assignee for recordCancellationResult to match, but the stale request itself is
      // still durable state that must be closed on the next poll.
      const detail = '取消已结束，取消请求作废';
      const resultAt = now();
      const resultInstanceId = instanceId || this.instanceId || request.instanceId || null;
      const resultAdapter = adapter || request.adapter || 'unknown';
      const settledRequest = { ...request, result: 'unknown', detail, resultAt, resultInstanceId, adapter: resultAdapter };
      const settled = this.save({ ...quest, cancelRequest: settledRequest, updatedAt: now() });
      const eventFields = {
        by: 'board', detail, quest: quest.id, requestId: request.requestId, source: request.bySource,
        result: 'unknown', adapter: resultAdapter, instanceId: resultInstanceId,
      };
      try { this.emitEvent(settled, 'cancel_result', eventFields); } catch (error) {
        try { process.stderr.write(`questboard: cancellation result event append failed: ${error.message}\n`); } catch {}
      }
      try { this.emitEvent(settled, 'cancel_acknowledged', { by: 'board', detail: 'unknown' }); } catch (error) {
        try { process.stderr.write(`questboard: cancellation acknowledgement append failed: ${error.message}\n`); } catch {}
      }
    }
    return this.list();
  }

  recordCancellationResult(id, { requestId, result, detail = '', evidence = null, instanceId = null, adapter = null } = {}) {
    const quest = this.quests.get(id);
    if (!quest) return null;
    const request = quest.cancelRequest;
    if (!request || request.requestId !== requestId) return quest;
    if (!CANCELLATION_RESULTS.has(result)) throw cancellationError('invalid_cancel_result', `未知的取消结果：${result}`);
    const safeEvidence = evidence ? Object.fromEntries(Object.entries(evidence).filter(([key, value]) => key !== 'token' && value !== undefined)) : null;
    // Collector polls replay the same exit row. Once the result and its request-scoped evidence are already
    // durable, the replay is a true no-op: no snapshot revision and no duplicate acknowledgement event.
    if (request.result === result && sameCancellationEvidenceScope(request.evidence, safeEvidence)) return quest;
    const sameAttempt = quest.assignee && (quest.assignee.attemptId ?? null) === (request.attemptId ?? null);
    if (!sameAttempt || !holdsSlot(quest)) return quest;
    const proof = evidenceMatchesAttempt(quest.assignee, evidence);
    // Matching wrapper acknowledgement and exit metadata prove only that the wrapper acted on its direct
    // child handle. Descendants may still be editing, so this evidence stays held for manual resolution
    // (or a later independent collector terminal fact); it is never a free transition.
    const canFree = result === 'never_started'
      && proof && evidence.phase === 'queued' && evidence.noEffect === true;
    const scopedWrapperEvidence = result === 'stopped_by_wrapper'
      && proof && evidence.ack === true && evidence.exitRequestId === requestId && evidence.scope === 'direct-child';
    const scopedApiEvidence = result === 'stopped_by_api'
      && proof && evidence.kind === 'opencode-session' && evidence.ack === true && evidence.followupEnded === true
      && Boolean(quest.assignee.session?.id || quest.assignee.sessionId)
      && evidence.sessionId === (quest.assignee.session?.id || quest.assignee.sessionId);
    const storedResult = canFree ? result
      : scopedWrapperEvidence ? 'stopped_by_wrapper'
        : scopedApiEvidence ? 'stopped_by_api'
        : (result === 'stopped_by_wrapper' || result === 'stopped_by_api' || result === 'never_started' ? 'unknown' : result);
    const resultAt = now();
    const resultInstanceId = instanceId || this.instanceId || request.instanceId || null;
    const resultAdapter = adapter || request.adapter || 'unknown';
    const audit = { result: storedResult, resultAt, resultInstanceId, adapter: resultAdapter };
    const eventFields = {
      by: 'board', detail: detail || `取消结果：${storedResult}`, assignee: quest.assignee,
      quest: id, requestId, source: request.bySource, result: storedResult, adapter: resultAdapter,
      instanceId: resultInstanceId,
    };
    if (canFree) {
      const resolvedAt = now();
      const recorded = this.save({
        ...quest,
        cancelRequest: { ...request, ...audit, ...(detail ? { detail: String(detail).slice(0, 2000) } : {}), ...(safeEvidence ? { evidence: safeEvidence } : {}), resolvedAt },
        assignee: { ...quest.assignee, cancelRequest: { ...request, ...audit, resolvedAt } },
        updatedAt: now(),
      });
      const next = this.setStatus(id, 'cancelled', {
        detail: detail || `取消结果：${storedResult}`, by: 'board', source: 'dispatcher',
        evidence: { kind: 'dispatcher', attempt: attemptEvidence(quest.assignee) },
      });
      try { this.emitEvent(next || recorded, 'cancel_result', eventFields); } catch (error) {
        try { process.stderr.write(`questboard: cancellation result event append failed: ${error.message}\n`); } catch {}
      }
      try { this.emitEvent(next, 'cancel_acknowledged', { by: 'board', detail: result }); } catch (error) {
        try { process.stderr.write(`questboard: cancellation acknowledgement append failed: ${error.message}\n`); } catch {}
      }
      return next || recorded;
    }
    const nextRequest = { ...request, ...audit, ...(detail ? { detail: String(detail).slice(0, 2000) } : {}), ...(safeEvidence ? { evidence: safeEvidence } : {}) };
    const next = this.save({ ...quest, cancelRequest: nextRequest, assignee: { ...quest.assignee, cancelRequest: nextRequest }, updatedAt: now() });
    try { this.emitEvent(next, 'cancel_result', eventFields); } catch (error) {
      try { process.stderr.write(`questboard: cancellation result event append failed: ${error.message}\n`); } catch {}
    }
    try { this.emitEvent(next, 'cancel_acknowledged', { by: 'board', detail: result }); } catch (error) {
      try { process.stderr.write(`questboard: cancellation acknowledgement append failed: ${error.message}\n`); } catch {}
    }
    return next;
  }

  resolveManually(id, { source, reason, ack = false } = {}) {
    const quest = this.quests.get(id);
    if (!quest) return null;
    const bySource = resolutionSource(source);
    const why = cancellationReason(reason);
    if (!ack || !why) throw cancellationError('manual_ack_required', '人工处理必须确认 --ack，并填写非空原因');
    if (!quest.assignee || !holdsSlot(quest)) throw cancellationError('not_cancellable', `${id} 没有仍被占用、可以人工处理的 worker`);
    const audit = manualResolution(bySource, quest.assignee, why);
    const audited = this.save({ ...quest, manualResolution: audit, updatedAt: now() });
    const next = this.save({ ...audited, status: audited.status === 'stalled' ? 'stalled' : 'cancelled', assignee: null, lastDetail: why, updatedAt: now() });
    try { this.emitEvent(next, 'manual_resolution', { by: bySource, detail: why, assignee: quest.assignee }); } catch (error) {
      try { process.stderr.write(`questboard: manual resolution event append failed: ${error.message}\n`); } catch {}
    }
    return next;
  }

  // One terminal report for one attempt. The order of the three durable steps is the contract:
  //   1. persist the quest with terminalFact {..., eventPending:{status,detail,by}} — intent recorded, status untouched;
  //   2. append the terminal event (the fact alone is not the event);
  //   3. persist the quest again with the pending marker cleared.
  // A failure in (1) emits nothing and leaves memory untouched, so the retry starts clean. A failure in (2)
  // throws with the marker durable, so the retry re-appends exactly the event that never landed. A failure in
  // (3) — the append already happened — can duplicate that event when the retry re-appends it: at-least-once
  // is the documented limit of two writes that cannot be made atomic without an outbox.
  setTerminalStatus(quest, status, { detail, by, report = null }) {
    const attempt = quest.dispatches?.length ? quest.dispatches[quest.dispatches.length - 1] : null;
    const fact = quest.terminalFact;
    const sameFact = factMatchesAttempt(fact, attempt);
    const assignee = quest.assignee || {};
    const eventName = STATUS_EVENTS[status] || `status_${status}`;

    // A previous run for this same attempt got as far as the pending marker and then died before (or during)
    // the append: re-append exactly the event it was about to write, not the retry's own text — the retry (a
    // status poll, a manual re-click) may carry different or empty detail, but the event being retried is the
    // original one. Confirm durably, and only then tell listeners.
    if (sameFact && fact.eventPending && fact.eventPending.status === status) {
      const pendingReport = report || fact.eventPending.report || null;
      const record = this.emitEvent(quest, eventName, {
        by: fact.eventPending.by, detail: fact.eventPending.detail, assignee,
        ...(pendingReport ? { report: pendingReport } : {}),
      }, { notify: false });
      const next = this.finishTerminal(quest, status, fact, fact.eventPending.detail, pendingReport);
      this.notify(record);
      return next;
    }

    // Already recorded for this attempt (or an identical consecutive repeat from the pre-fact era): never
    // re-fire the terminal event — that event already happened once, and firing it again would read as a
    // second, distinct attempt. New text is kept as a status_note; a status that had moved on (reviewing,
    // stalled, done) is moved back with the first evidence restored from the fact, and a move back with no
    // text still says what happened.
    const recorded = sameFact && fact.statuses ? fact.statuses[status] : null;
    if (recorded || quest.status === status) {
      const firstText = String((recorded ? recorded.detail : quest.lastDetail) ?? '');
      const statusChanging = quest.status !== status;
      const hasNewText = Boolean(detail) && detail !== firstText;
      if (!statusChanging && !hasNewText) return quest;
      const next = this.save({
        ...quest,
        status,
        ...(statusChanging ? { lastDetail: firstText.slice(0, 2000) } : {}),
        updatedAt: now(),
      });
      const record = this.emitEvent(next, 'status_note', { by, detail: detail || `状态改回 ${status}`, assignee }, { notify: false });
      this.notify(record);
      return next;
    }

    // A first terminal fact for this attempt (or a different attempt than the last fact described — identity
    // changed, so the old set is not evidence about this one). The fact keeps a SET of per-status evidence:
    // delivered then failed then delivered for one attempt is one delivered event, and the rest are notes.
    // A marker left by a status whose event never landed is dropped from the set — it was never evidence.
    const statuses = sameFact && fact.statuses ? { ...fact.statuses } : {};
    if (fact && fact.eventPending) delete statuses[fact.eventPending.status];
    const at = now();
    const evidence = String(detail).slice(0, 2000);
    const factNext = {
      attemptId: attempt?.attemptId || null,
      name: attempt?.name || null,
      at: attempt?.at || null,
      lane: attempt?.lane || null,
      statuses: { ...statuses, [status]: { at, detail: evidence } },
      eventPending: { status, detail: evidence, by, at, ...(report ? { report } : {}) },
    };
    const pending = this.savePendingFact(quest, factNext, at);
    const record = this.emitEvent(pending, eventName, { by, detail, assignee, ...(report ? { report } : {}) }, { notify: false });
    const next = this.finishTerminal(pending, status, factNext, evidence, report);
    this.notify(record);
    return next;
  }

  // Confirms a terminal transition once its event is durable: the status moves, the marker is dropped
  // (without leaving an `eventPending: undefined` key behind), and the assignee follows the same hold rules
  // as any other status (kept for delivered/reviewing, cleared for failed/bounced/done).
  finishTerminal(quest, status, fact, detail, report = null) {
    const { eventPending, ...clearedFact } = fact;
    const stillAssigned = ['dispatched', 'delivered', 'reviewing', 'stalled'].includes(status);
    return this.save({
      ...quest,
      status,
      assignee: stillAssigned ? quest.assignee : null,
      lastDetail: String(detail).slice(0, 2000),
      terminalFact: clearedFact,
      updatedAt: now(),
      // Additive: the reference to the report this attempt actually produced, keyed to its attemptId.
      // Absent for every legacy terminal quest and for callers that captured nothing, so old rows and old
      // event shapes stay byte-identical; presence only ever grows a row by this one small object.
      ...(report ? { attemptReport: report } : {}),
    });
  }

  // Frees a stalled quest once someone has confirmed its worker is gone. A running quest is cancelled, not released.
  release(id, { by = 'owner', detail = '', source, ack = false } = {}) {
    const quest = this.quests.get(id);
    if (!quest) return null;
    if (!quest.assignee) throw new Error(`${id} has no worker to release`);
    if (quest.status !== 'stalled') throw new Error(`${id} is ${quest.status === 'dispatched' ? 'running; cancel it instead of releasing it' : `${quest.status}; only a stalled quest is released`}`);
    const audited = this.authorizeFreeTransition(quest, 'stalled', { detail, by, source, ack });
    const next = this.save({ ...audited, assignee: null, lastDetail: String(detail).slice(0, 2000), updatedAt: now() });
    this.emitEvent(next, 'released', { by, detail: detail || `worker ${quest.assignee.name} 已确认停止，释放`, assignee: quest.assignee });
    return next;
  }

  rule(id, { text, by = 'owner' }) {
    const quest = this.quests.get(id);
    if (!quest) return null;
    const ruling = String(text || '').trim().slice(0, 2000);
    if (!ruling) throw new Error('ruling text is required');
    const at = now();
    const next = this.save({
      ...quest,
      needsOwner: '',
      status: quest.status === 'needs_owner' || quest.status === 'owner_playtest' ? 'posted' : quest.status,
      rulings: [...(quest.rulings || []), { at, by, text: ruling, question: quest.needsOwner }],
      updatedAt: at,
    });
    this.emitEvent(next, 'owner_ruling', { by, detail: ruling });
    return next;
  }

  // Suggestion S3: a recorded exception to a review's own upstream-evidence refusal (src/core/rules.js
  // reviewUpstreamEvidence) — never marks any evidence as passed and never touches it; it only lets a
  // review that check would otherwise refuse proceed anyway, with why on record. parentAttempts is computed
  // by the caller from the parents' live current-attempt ids (never trusted from the request body — see
  // src/server/questRoutes.js), so a later re-dispatch of any parent changes its current attempt id and
  // rules.js's own check stops matching this override on its own, without this record ever being touched.
  recordReviewOverride(id, { reason, by = 'owner', parentAttempts = {} }) {
    const quest = this.quests.get(id);
    if (!quest) return null;
    if (quest.kind !== 'review') {
      const error = new Error(`${id} 不是审核委托，不能记录审核例外`);
      error.code = 'not_review';
      throw error;
    }
    const text = String(reason || '').trim().slice(0, 2000);
    if (!text) throw new Error('例外原因不能为空');
    const at = now();
    const next = this.save({ ...quest, reviewOverride: { reason: text, by, at, parentAttempts }, updatedAt: at });
    this.emitEvent(next, 'review_override', { by, detail: text });
    return next;
  }

  // Revision-guarded correction of title/brief/parents/conflicts/allowedLanes/needsOwner — never assignee,
  // status or dispatch history (those change only through assign/adopt/setStatus/release/rule). Refuses
  // outright (throws, .code 'holds_slot') while the quest actually holds a worker's slot (dispatched or
  // stalled with an assignee): the fix is to release the worker first, never to silently clear it here just
  // to let an edit through. `ifRevision`, when passed, must match the quest's current revision (throws,
  // .code 'stale_revision', .revision otherwise) — the same guard assign/adopt use, so a coordinator or the
  // UI editing from a stale read never clobbers a change made in between. Every field left out of `payload`
  // is untouched (see validateMetadataUpdate): a quest already carrying a legacy issue in a field this call
  // does not touch is never blocked or silently re-saved by an edit to something else.
  updateMetadata(id, payload, { by = 'owner', ifRevision } = {}) {
    const quest = this.quests.get(id);
    if (!quest) return null;
    if (holdsSlot(quest)) {
      const error = new Error(`${id} 有 worker 占着（${quest.status}），先释放再改`);
      error.code = 'holds_slot';
      throw error;
    }
    if (ifRevision !== undefined && ifRevision !== null) {
      const current = quest.revision || 0;
      if (Number(ifRevision) !== current) {
        const error = new Error(`任务在你读取之后改过（现在是第 ${current} 版，你按第 ${ifRevision} 版改的），重新读一次再改`);
        error.code = 'stale_revision';
        error.revision = current;
        throw error;
      }
    }
    const { errors, value, changes } = validateMetadataUpdate(this.config, quest, this.list(), payload);
    if (Object.keys(errors).length) return { errors };
    const changedFields = Object.keys(value);
    if (!changedFields.length) return { quest };
    const next = this.save({ ...quest, ...value, updatedAt: now() });
    this.emitEvent(next, 'metadata_update', { by, detail: `改了 ${changedFields.join('、')}`, changedFields, changes });
    return { quest: next };
  }
}
