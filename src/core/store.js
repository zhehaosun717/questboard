// Quest store. One quest per package id. Snapshots are appended to <data>/quests.jsonl (replay keeps the
// latest per id); every state change is also appended to the events file the coordinator tails.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendJsonLine, readJsonLines } from './jsonl.js';
import { lastEventSeq } from './events.js';
import { packageIdPattern, briefPathAllowed } from './patterns.js';
import { holdsSlot } from './rules.js';

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

const now = () => new Date().toISOString();

function splitList(value) {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  return [...new Set(list.map((v) => String(v).trim()).filter(Boolean))];
}

export function validatePost(config, payload) {
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
  const allowedLanes = splitList(input.allowedLanes);
  const badLane = allowedLanes.find((lane) => !config.lanes[lane]);
  if (badLane) errors.allowedLanes = `unknown lane ${badLane}; this project defines ${Object.keys(config.lanes).join(', ')}`;
  const priority = input.priority === undefined || input.priority === '' ? 2 : Number(input.priority);
  if (![1, 2, 3].includes(priority)) errors.priority = 'priority must be 1, 2 or 3';
  const value = {
    package: pkg, kind, brief,
    title: String(input.title || '').trim().slice(0, 120),
    parents: ids('parents'),
    conflicts: ids('conflicts'),
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
    // Disk first, memory second: if the append throws (a locked file, EISDIR), the in-memory map must stay
    // exactly as it was, not jump ahead of what actually got persisted — a caller that reads it back after
    // a failed save must see the same state a restart would replay from disk, never a state that looks
    // further along (e.g. an assignee already cleared) than what is durable.
    appendJsonLine(this.questsPath, next);
    this.quests.set(next.id, next);
    return next;
  }

  emitEvent(quest, event, fields = {}) {
    const assignee = fields.assignee || quest.assignee || {};
    this.eventSeq += 1;
    const record = {
      seq: this.eventSeq, at: now(), event, package: quest.id,
      lane: assignee.lane || null, model: assignee.model || null, variant: assignee.variant || null, name: assignee.name || null,
      attemptId: assignee.attemptId || null,
      by: fields.by || 'board', detail: String(fields.detail || '').slice(0, 2000),
    };
    appendJsonLine(this.eventsFile, record);
    this.emit('event', record);
    return record;
  }

  post(payload) {
    const { errors, value } = validatePost(this.config, payload);
    if (Object.keys(errors).length) return { errors };
    const existing = this.quests.get(value.package);
    if (existing && existing.status === 'dispatched') return { errors: { package: `${value.package} is running; cancel it before re-posting` } };
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
      title: value.title || titleFromBrief(value.brief, value.package),
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
    // A second callback reporting the same terminal fact for the attempt already recorded (a duplicate
    // poll, a retried write) must not re-fire delivered/failed/bounced — that event already happened once,
    // and firing it again would read as a second, distinct attempt. Because assign()/adopt() always moves
    // the quest back through 'dispatched' before any new attempt can reach a terminal status again, seeing
    // the same terminal status twice in a row (no assign in between) can only be this same attempt. Extra
    // detail is not thrown away — it is kept as a note, actor preserved, while the first terminal evidence
    // (lastDetail, the assignee it happened under) stays exactly as first recorded.
    if (TERMINAL_STATUSES.has(status) && quest.status === status) {
      if (!detail || detail === quest.lastDetail) return quest;
      const next = this.save({ ...quest, updatedAt: now() });
      this.emitEvent(next, 'status_note', { by, detail, assignee: quest.assignee || {} });
      return next;
    }
    // A stall is silence, not a confirmed exit: the worker keeps the quest (and its slot and file
    // reservations) until release() says the process is gone. failed/bounced come from exit files.
    const stillAssigned = ['dispatched', 'delivered', 'reviewing', 'stalled'].includes(status);
    const next = this.save({ ...quest, status, assignee: stillAssigned ? quest.assignee : null, lastDetail: String(detail).slice(0, 2000), updatedAt: now() });
    this.emitEvent(next, STATUS_EVENTS[status] || `status_${status}`, { by, detail, assignee: quest.assignee || {} });
    return next;
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
}
