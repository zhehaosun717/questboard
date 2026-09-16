// Quest store. One quest per package id. Snapshots are appended to <data>/quests.jsonl (replay keeps the
// latest per id); every state change is also appended to the events file the coordinator tails.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendJsonLine, readJsonLines } from './jsonl.js';
import { lastEventSeq } from './events.js';
import { packageIdPattern, briefPathAllowed } from './patterns.js';
import { holdsSlot } from './rules.js';
import {
  validateMetadataUpdate, validateParents, sameList,
  reviewTargetLockedMessage, findReviewAncestorLock, reviewAncestorLockedMessage, kindLockReason,
} from './metadataUpdate.js';

export const KINDS = new Set(['code', 'review', 'art', 'tool', 'owner']);
export const QUEST_STATUSES = new Set(['posted', 'dispatched', 'delivered', 'reviewing', 'needs_owner', 'owner_playtest', 'lane_limited',
  'bounced', 'failed', 'stalled', 'done', 'superseded', 'cancelled']);
const STATUS_EVENTS = { delivered: 'delivered', failed: 'failed', bounced: 'bounced', stalled: 'stalled', cancelled: 'cancelled' };
// Once one of these is reached for an attempt, a repeat of the exact same status is the same fact arriving
// twice (a duplicate poll, a retried callback), not a second real transition.
const TERMINAL_STATUSES = new Set(['delivered', 'failed', 'bounced']);
const MAX_TEXT = 300;

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

const now = () => new Date().toISOString();

function splitList(value) {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  return [...new Set(list.map((v) => String(v).trim()).filter(Boolean))];
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
    const next = this.save({ ...quest, status: 'dispatched', assignee, dispatches: [...quest.dispatches, assignee], updatedAt: at });
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

  setStatus(id, status, { detail = '', by = 'coordinator' } = {}) {
    if (!QUEST_STATUSES.has(status)) throw new Error(`status must be one of ${[...QUEST_STATUSES].join('|')}`);
    const quest = this.quests.get(id);
    if (!quest) return null;
    // Terminal statuses go through setTerminalStatus, which owns the durable ordering (persist the fact,
    // then append the event, then confirm it) that keeps a crash between writes from losing or duplicating
    // the delivered/failed/bounced event.
    if (TERMINAL_STATUSES.has(status)) return this.setTerminalStatus(quest, status, { detail, by });
    // A stall is silence, not a confirmed exit: the worker keeps the quest (and its slot and file
    // reservations) until release() says the process is gone. failed/bounced come from exit files.
    const stillAssigned = ['dispatched', 'delivered', 'reviewing', 'stalled'].includes(status);
    const next = this.save({ ...quest, status, assignee: stillAssigned ? quest.assignee : null, lastDetail: String(detail).slice(0, 2000), updatedAt: now() });
    this.emitEvent(next, STATUS_EVENTS[status] || `status_${status}`, { by, detail, assignee: quest.assignee || {} });
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
  setTerminalStatus(quest, status, { detail, by }) {
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
      const record = this.emitEvent(quest, eventName, {
        by: fact.eventPending.by, detail: fact.eventPending.detail, assignee,
      }, { notify: false });
      const next = this.finishTerminal(quest, status, fact, fact.eventPending.detail);
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
      eventPending: { status, detail: evidence, by, at },
    };
    const pending = this.savePendingFact(quest, factNext, at);
    const record = this.emitEvent(pending, eventName, { by, detail, assignee }, { notify: false });
    const next = this.finishTerminal(pending, status, factNext, evidence);
    this.notify(record);
    return next;
  }

  // Confirms a terminal transition once its event is durable: the status moves, the marker is dropped
  // (without leaving an `eventPending: undefined` key behind), and the assignee follows the same hold rules
  // as any other status (kept for delivered/reviewing, cleared for failed/bounced/done).
  finishTerminal(quest, status, fact, detail) {
    const { eventPending, ...clearedFact } = fact;
    const stillAssigned = ['dispatched', 'delivered', 'reviewing', 'stalled'].includes(status);
    return this.save({
      ...quest,
      status,
      assignee: stillAssigned ? quest.assignee : null,
      lastDetail: String(detail).slice(0, 2000),
      terminalFact: clearedFact,
      updatedAt: now(),
    });
  }

  // Frees a stalled quest once someone has confirmed its worker is gone. A running quest is cancelled, not released.
  release(id, { by = 'owner', detail = '' } = {}) {
    const quest = this.quests.get(id);
    if (!quest) return null;
    if (!quest.assignee) throw new Error(`${id} has no worker to release`);
    if (quest.status !== 'stalled') throw new Error(`${id} is ${quest.status === 'dispatched' ? 'running; cancel it instead of releasing it' : `${quest.status}; only a stalled quest is released`}`);
    const next = this.save({ ...quest, assignee: null, lastDetail: String(detail).slice(0, 2000), updatedAt: now() });
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
