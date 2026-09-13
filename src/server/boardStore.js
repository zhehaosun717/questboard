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
    for (const record of readJsonLines(this.threadsPath)) if (record.type === 'thread' && record.id) this.threads.set(record.id, record);
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
    const thread = { type: 'thread', id: this.makeId('t'), title: value.title, tags: value.tags, author: value.author, createdAt, updatedAt: createdAt, pinned: false, closed: false, messageCount: 0, lastMessageAt: null };
    this.threads.set(thread.id, thread);
    appendJsonLine(this.threadsPath, thread);
    const message = this.addMessage(thread.id, value);
    return { thread: this.getThread(thread.id), message };
  }

  addMessage(threadId, payload) {
    const thread = this.threads.get(threadId);
    if (!thread) return { notFound: true };
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
    const status = filters.status === 'closed' || filters.status === 'open' ? filters.status : 'all';
    return [...this.threads.values()]
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

  inbox(since, exceptAuthor) {
    return [...this.messages.values()]
      .filter((m) => !since || m.createdAt > since)
      .filter((m) => !exceptAuthor || m.author !== exceptAuthor)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((m) => ({ ...m }));
  }

  status() {
    return { threads: this.threads.size, messages: this.messages.size, openThreads: [...this.threads.values()].filter((t) => !t.closed).length, dataDirectory: this.dataDirectory };
  }
}
