// Event records carry a sequence number so a reader can resume exactly where it stopped, with nothing lost
// between two events written in the same second. Lines written before numbering existed (the first-generation
// board shared this file) are numbered by position, which is stable because the file is append-only.
import { readJsonLines } from './jsonl.js';

export function readEvents(file) {
  return readJsonLines(file).map((event, index) => (Number.isInteger(event.seq) ? event : { ...event, seq: index + 1 }));
}

export function lastEventSeq(file) {
  const events = readEvents(file);
  return events.length ? events.at(-1).seq : 0;
}

// Forward pagination: the first `limit` events after `after`, oldest first.
export function eventsAfter(file, { after = 0, limit = 50, pkg = null } = {}) {
  return readEvents(file).filter((e) => e.seq > after && (!pkg || e.package === pkg)).slice(0, limit);
}
