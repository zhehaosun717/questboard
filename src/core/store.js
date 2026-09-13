// Quest store. One quest per package id. Snapshots are appended to <data>/quests.jsonl (replay keeps the
// latest per id); every state change is also appended to the events file the coordinator tails.
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { appendJsonLine, readJsonLines } from './jsonl.js';
import { packageIdPattern, briefPathAllowed } from './patterns.js';

export const KINDS = new Set(['code', 'review', 'art', 'tool', 'owner']);
export const QUEST_STATUSES = new Set(['posted', 'dispatched', 'delivered', 'reviewing', 'needs_owner', 'owner_playtest', 'lane_limited',
  'bounced', 'failed', 'stalled', 'done', 'superseded', 'cancelled']);
const STATUS_EVENTS = { delivered: 'delivered', failed: 'failed', bounced: 'bounced', stalled: 'stalled', cancelled: 'cancelled' };
const MAX_TEXT = 300;

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
  }

  list() {
    return [...this.quests.values()].map((q) => ({ ...q }));
  }

  get(id) {
    const quest = this.quests.get(id);
    return quest ? { ...quest } : null;
  }

  save(quest) {
    this.quests.set(quest.id, quest);
    appendJsonLine(this.questsPath, quest);
    return quest;
  }

  emitEvent(quest, event, fields = {}) {
    const assignee = fields.assignee || quest.assignee || {};
    const record = {
      at: now(), event, package: quest.id,
      lane: assignee.lane || null, model: assignee.model || null, variant: assignee.variant || null, name: assignee.name || null,
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
    const quest = this.save({
      ...(existing || { dispatches: [], rulings: [], assignee: null, createdAt: at, status: 'posted' }),
      ...fields,
      id: value.package,
      title: value.title || titleFromBrief(value.brief, value.package),
      status: value.needsOwner ? 'needs_owner' : (existing && !['done', 'superseded', 'cancelled'].includes(existing.status) ? existing.status : 'posted'),
      postedBy: by,
      updatedAt: at,
    });
    this.emitEvent(quest, value.kind === 'review' ? 'review_posted' : 'posted', { by, detail: quest.title });
    return { quest };
  }

  // Emits `assigned` (the owner picked a card); the server emits `dispatched` once the script started.
  // Adopting a worker that already runs passes event 'dispatched' and adopted: true.
  assign(id, { adventurer, name, by = 'owner', detail, event = 'assigned', adopted = false }) {
    const quest = this.quests.get(id);
    if (!quest) return null;
    const at = now();
    const assignee = { adventurerId: adventurer.id, family: adventurer.family || null, lane: adventurer.lane, model: adventurer.model, variant: adventurer.variant || '', name, at, by, ...(adopted ? { adopted: true } : {}) };
    const next = this.save({ ...quest, status: 'dispatched', assignee, dispatches: [...quest.dispatches, assignee], updatedAt: at });
    this.emitEvent(next, event, { by, detail: detail || `${adventurer.name} 接了任务` });
    return next;
  }

  setStatus(id, status, { detail = '', by = 'coordinator' } = {}) {
    if (!QUEST_STATUSES.has(status)) throw new Error(`status must be one of ${[...QUEST_STATUSES].join('|')}`);
    const quest = this.quests.get(id);
    if (!quest) return null;
    const stillAssigned = ['dispatched', 'delivered', 'reviewing'].includes(status);
    const next = this.save({ ...quest, status, assignee: stillAssigned ? quest.assignee : null, lastDetail: String(detail).slice(0, 2000), updatedAt: now() });
    this.emitEvent(next, STATUS_EVENTS[status] || `status_${status}`, { by, detail, assignee: quest.assignee || {} });
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
