// Message board store: threads and messages as JSON lines under the project data directory. Thread records
// are snapshots (replay keeps the latest per id); message records are immutable.
import path from 'node:path';
import { appendJsonLine, readJsonLines } from '../core/jsonl.js';

const MAX_TITLE = 120;
const MAX_BODY = 20000;
const MAX_AUTHOR = 80;
const MAX_TAG = 40;
const TAG_PATTERN = /^[\p{L}\p{N}_-]+$/u;

const now = () => new Date().toISOString();
const text = (value) => (typeof value === 'string' ? value.trim() : '');

// Bulk thread actions. Trash is a recoverable flag, never a data purge: threads and their messages stay
// in the JSONL files and a restore flips the flag back. `restore` is the only action that works on a
// trashed thread; every other bulk action refuses one, so a stale selection cannot mutate an invisible row.
// Restore never fabricates state: it only clears the trash flag and returns the thread as it actually is
// right now (its closed/pinned flags are whatever they are). A ruling posted while a question thread sat
// in the bin skips that thread (it is excluded from the open list), so a restored thread can surface an
// already-answered question still open; the owner sees the truth and closes or replies — nothing here
// invents a closing ruling to hide that.
export const THREAD_BULK_ACTIONS = ['close', 'reopen', 'pin', 'unpin', 'trash', 'restore'];
export const MAX_THREAD_BULK_IDS = 100;
// Each id is bounded like an annotation id (boardRoutes.js): over-long ids are a whole-request refusal,
// never a silent truncation. Real store ids are ~20 characters; 128 leaves generous room.
export const MAX_THREAD_ID_LENGTH = 128;

// Shape validation only: wrong action, bad, duplicate or over-bounded ids are a whole-request refusal.
// Whether an id still exists is answered per id by applyThreadBulk, never by failing all ids.
export function validateThreadBulkRequest(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { error: 'JSON body must be an object' };
  if (!THREAD_BULK_ACTIONS.includes(payload.action)) return { error: `action must be one of ${THREAD_BULK_ACTIONS.join(', ')}` };
  if (!Array.isArray(payload.ids) || payload.ids.length === 0) return { error: 'ids must be a non-empty array' };
  if (payload.ids.length > MAX_THREAD_BULK_IDS) return { error: `ids must have at most ${MAX_THREAD_BULK_IDS} entries` };
  const ids = [];
  for (let index = 0; index < payload.ids.length; index += 1) {
    const id = payload.ids[index];
    if (typeof id !== 'string' || !id.trim()) return { error: `ids[${index}] must be a non-empty string` };
    if (id.length > MAX_THREAD_ID_LENGTH) return { error: `ids[${index}] must be ${MAX_THREAD_ID_LENGTH} characters or fewer` };
    if (ids.includes(id)) return { error: `ids[${index}] repeats an earlier id` };
    ids.push(id);
  }
  return { value: { action: payload.action, ids } };
}

export function validateBoardPayload(payload, { requireTitle = true } = {}) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const errors = {};
  if (requireTitle) {
    const title = text(input.title);
    if (!title) errors.title = 'title is required';
    else if (title.length > MAX_TITLE) errors.title = `title must be ${MAX_TITLE} characters or fewer`;
  }
  const body = text(input.body);
  if (!body) errors.body = 'body is required';
  else if (body.length > MAX_BODY) errors.body = `body must be ${MAX_BODY} characters or fewer`;
  const author = text(input.author);
  if (!author) errors.author = 'author is required';
  else if (author.length > MAX_AUTHOR) errors.author = `author must be ${MAX_AUTHOR} characters or fewer`;
  const raw = input.tags === undefined ? input.tag : input.tags;
  const list = raw === undefined || raw === '' ? [] : Array.isArray(raw) ? raw : [raw];
  const tags = [];
  for (const value of list) {
    const tag = text(value);
    if (!tag || tag.length > MAX_TAG || !TAG_PATTERN.test(tag)) {
      errors.tag = `tag must use letters, numbers, underscores, or hyphens and be ${MAX_TAG} characters or fewer`;
      break;
    }
    if (!tags.includes(tag)) tags.push(tag);
  }
  return { errors, value: { title: text(input.title), body, author, tags } };
}

export class BoardStore {
  constructor(dataDirectory) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.threadsPath = path.join(this.dataDirectory, 'threads.jsonl');
    this.messagesPath = path.join(this.dataDirectory, 'messages.jsonl');
    this.threads = new Map();
    this.messages = new Map();
    for (const record of readJsonLines(this.threadsPath)) {
      if (record.type !== 'thread' || !record.id) continue;
      // Snapshots written before the trash flag exist on disk; replaying them as `trashed: false` keeps
      // every later filter check on a real boolean instead of undefined leaking into responses.
      this.threads.set(record.id, { ...record, trashed: Boolean(record.trashed) });
    }
    for (const record of readJsonLines(this.messagesPath)) if (record.type === 'message' && record.id) this.messages.set(record.id, record);
    this.sequence = this.threads.size + this.messages.size;
  }

  makeId(prefix) {
    this.sequence += 1;
    return `${prefix}_${Date.now().toString(36)}_${this.sequence.toString(36)}`;
  }

  createThread(payload) {
    const { errors, value } = validateBoardPayload(payload);
    if (Object.keys(errors).length) return { errors };
    const createdAt = now();
    const thread = { type: 'thread', id: this.makeId('t'), title: value.title, tags: value.tags, author: value.author, createdAt, updatedAt: createdAt, pinned: false, closed: false, trashed: false, messageCount: 0, lastMessageAt: null };
    this.threads.set(thread.id, thread);
    appendJsonLine(this.threadsPath, thread);
    const message = this.addMessage(thread.id, value);
    return { thread: this.getThread(thread.id), message };
  }

  addMessage(threadId, payload) {
    const thread = this.threads.get(threadId);
    if (!thread) return { notFound: true };
    if (thread.trashed) return { trashed: true };
    const { errors, value } = validateBoardPayload(payload, { requireTitle: false });
    if (Object.keys(errors).length) return { errors };
    const createdAt = now();
    const message = { type: 'message', id: this.makeId('m'), threadId, body: value.body, author: value.author, createdAt };
    this.messages.set(message.id, message);
    appendJsonLine(this.messagesPath, message);
    const updated = { ...thread, updatedAt: createdAt, messageCount: thread.messageCount + 1, lastMessageAt: createdAt };
    this.threads.set(threadId, updated);
    appendJsonLine(this.threadsPath, updated);
    return message;
  }

  getThread(threadId) {
    const thread = this.threads.get(threadId);
    if (!thread) return null;
    const messages = [...this.messages.values()].filter((m) => m.threadId === threadId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { ...thread, messages };
  }

  listThreads(filters = {}) {
    const query = text(filters.q).toLocaleLowerCase();
    const tag = text(filters.tag);
    let status = filters.status === 'closed' || filters.status === 'open' ? filters.status : 'all';
    // The normal list never shows trashed threads; the recycle view asks for them with trash=only.
    const trashOnly = filters.trash === 'only' || filters.trash === 'true';
    // The recycle bin always lists every status: most trashed question threads were closed before the
    // bin, so honoring open/closed there is how closed trash hid behind a falsely empty 回收站是空的.
    if (trashOnly) status = 'all';
    return [...this.threads.values()]
      .filter((thread) => Boolean(thread.trashed) === trashOnly)
      .filter((thread) => !query || `${thread.title} ${thread.author} ${thread.tags.join(' ')} ${[...this.messages.values()].filter((m) => m.threadId === thread.id).map((m) => m.body).join(' ')}`.toLocaleLowerCase().includes(query))
      .filter((thread) => !tag || thread.tags.includes(tag))
      .filter((thread) => status === 'all' || (status === 'closed' ? thread.closed : !thread.closed))
      .filter((thread) => filters.pinned === undefined || thread.pinned === (filters.pinned === 'true'))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt))
      .map((thread) => ({ ...thread }));
  }

  setFlag(threadId, flag, value) {
    const thread = this.threads.get(threadId);
    if (!thread) return null;
    const updated = { ...thread, [flag]: Boolean(value), updatedAt: now() };
    this.threads.set(threadId, updated);
    appendJsonLine(this.threadsPath, updated);
    return updated;
  }

  // Bulk thread operations, one independent outcome per id: a missing or wrongly-signed id is a per-id
  // failure, not a rollback of the ids that worked. Only `restore` acts on a trashed thread and only the
  // other actions touch a live one, so a stale selection cannot quietly flip the flag of an invisible row.
  applyThreadBulk(ids, action) {
    return ids.map((id) => {
      const thread = this.threads.get(id);
      if (!thread) return { id, ok: false, error: 'thread not found' };
      if (action === 'restore') {
        if (!thread.trashed) return { id, ok: false, error: 'thread is not in the recycle bin' };
        return { id, ok: true, thread: this.setFlag(id, 'trashed', false) };
      }
      if (action === 'trash') {
        if (thread.trashed) return { id, ok: false, error: 'thread is already in the recycle bin' };
        return { id, ok: true, thread: this.setFlag(id, 'trashed', true) };
      }
      if (thread.trashed) return { id, ok: false, error: 'thread is in the recycle bin; restore it first' };
      const [flag, value] = { close: ['closed', true], reopen: ['closed', false], pin: ['pinned', true], unpin: ['pinned', false] }[action];
      return { id, ok: true, thread: this.setFlag(id, flag, value) };
    });
  }

  // The inbox is the coordinator's append-only history: messages from a trashed thread stay in it.
  // Deleting to the recycle bin hides the thread, never retracts what was said — a restored thread
  // returns with the same messages, and coordinators keep seeing them in the meantime.
  inbox(since, exceptAuthor) {
    return [...this.messages.values()]
      .filter((m) => !since || m.createdAt > since)
      .filter((m) => !exceptAuthor || m.author !== exceptAuthor)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((m) => ({ ...m }));
  }

  status() {
    const all = [...this.threads.values()];
    return { threads: this.threads.size, messages: this.messages.size, openThreads: all.filter((t) => !t.closed && !t.trashed).length, trashedThreads: all.filter((t) => t.trashed).length, dataDirectory: this.dataDirectory };
  }
}
