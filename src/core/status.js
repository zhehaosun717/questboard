// Runtime status records for adventurers. A model's status is a dated fact with a reason and an author
// ("paused since 9/12 because of cost, set by owner"), not text baked into the roster, so the roster
// stays reusable and the card can say why and since when.
import { appendJsonLine, readJsonLines } from './jsonl.js';

export const STATUSES = Object.freeze(['available', 'limited', 'broke', 'paused', 'disabled']);
const ID_PATTERN = /^[a-z0-9-]{1,48}$/;

export function validateStatusRecord(record) {
  if (!record || typeof record !== 'object') throw new Error('status record must be an object');
  if (!ID_PATTERN.test(record.adventurerId || '')) throw new Error(`status record adventurerId must match ${ID_PATTERN}`);
  if (!STATUSES.includes(record.status)) throw new Error(`status must be one of ${STATUSES.join('|')}, got ${record.status}`);
  if (!Number.isFinite(Date.parse(record.at))) throw new Error('status record at must be an ISO date');
  if (typeof record.setBy !== 'string' || !record.setBy.trim()) throw new Error('status record setBy is required');
  if (record.reason !== undefined && typeof record.reason !== 'string') throw new Error('status record reason must be a string');
  return record;
}

// Latest record per adventurer; `since` is when the current status began, so repeating a status with a
// fresh reason keeps the original start date.
export function foldStatuses(records) {
  const current = new Map();
  for (const record of records) {
    const previous = current.get(record.adventurerId);
    const since = previous && previous.status === record.status ? previous.since : record.at;
    current.set(record.adventurerId, { status: record.status, since, reason: record.reason || '', setBy: record.setBy, at: record.at });
  }
  return current;
}

export class StatusLog {
  constructor(file) {
    this.file = file;
  }

  records() {
    return readJsonLines(this.file);
  }

  current() {
    return foldStatuses(this.records());
  }

  set(adventurerId, { status, reason = '', setBy, at = new Date().toISOString() }) {
    const record = validateStatusRecord({ at, adventurerId, status, reason: String(reason).slice(0, 300), setBy: String(setBy || '').slice(0, 40) });
    appendJsonLine(this.file, record);
    return this.current().get(adventurerId);
  }
}

// Adventurers with no record are available: a new card starts usable.
export function applyStatuses(adventurers, current) {
  return adventurers.map((adventurer) => {
    const entry = current.get(adventurer.id);
    return entry
      ? { ...adventurer, status: entry.status, statusSince: entry.since, statusReason: entry.reason, statusSetBy: entry.setBy }
      : { ...adventurer, status: 'available', statusSince: null, statusReason: '', statusSetBy: null };
  });
}
