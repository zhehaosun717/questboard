// Dispatch-history logic (QB-FB-HISTORY). Pure helpers for the history tab: worker-table formatting,
// the project-wide test summary, filters that combine, task grouping, Chinese event labels, and a
// single strict timestamp parser shared by formatting/filtering/the invalid-count note. The event-page
// reading state machine lives in ./historyScan.ts (the production controller, B6) — nothing here
// touches fetch, React or storage.
import type { LaneHistoryEntry, LanePackage, Verification } from '../api/types';
import type { DispatchEvent } from '../api/historyEvents';
import { STATUS } from './labels';

export type { DispatchEvent };

// ── worker-summary helpers (package table and its rows) ──────────────────────

export function formatElapsed(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return '0s';
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

export function splitStale(packages: LanePackage[]): {
  active: LanePackage[];
  stale: LanePackage[];
} {
  const active: LanePackage[] = [];
  const stale: LanePackage[] = [];
  for (const p of packages) {
    if (p.stale) {
      stale.push(p);
    } else {
      active.push(p);
    }
  }
  return { active, stale };
}

/** A lane's id IS its configured name (CLAUDE.md: "anyone's own agent CLI, not a fixed list") — no
 * vendor rename table here, so a newly configured lane never shows as a raw-looking id one day and a
 * guessed vendor name the next. */
export function laneLabel(lane: string): string {
  return lane;
}

export function formatHistoryEvent(entry: LaneHistoryEntry): string {
  if (entry.event === 'dispatch') return `派出 → ${laneLabel(entry.lane)} ${entry.model}`;
  return entry.text;
}

// ── strict timestamp parsing (shared by clock formatting, time filters, invalid-count) ──────────────

/**
 * Matches two documented shapes only: a full ISO instant with an offset (`Z` or `±HH:mm`, the shape
 * every real event `at` uses — `src/core/store.js now()` writes `new Date().toISOString()`), and the
 * naive, no-offset, no-seconds shape a native `datetime-local` input supplies for the `from`/`to`
 * filter bounds. Seconds and milliseconds are optional in both; nothing else is a supported shape.
 */
const STRICT_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  const lengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return lengths[month - 1]!;
}

interface TimestampParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
  /** null = the naive, no-offset shape; otherwise 'Z' or a validated `±HH:mm` token. */
  offsetToken: string | null;
}

/** Matches and calendar-validates the two documented shapes; never delegates to `Date.parse`/
 * `new Date(string)` (both silently roll an impossible calendar date into a different real one, or
 * coerce a wholly non-date string into a plausible-looking one — review 73f4bd71 B2). Returns null for
 * anything that is not exactly one of the two shapes, or that names a moment which cannot exist. */
function matchTimestampParts(value: string): TimestampParts | null {
  const match = STRICT_TIMESTAMP.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] ? Number(match[6]) : 0;
  const ms = match[7] ? Number(match[7].padEnd(3, '0')) : 0;
  const offsetToken = match[8] ?? null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  if (offsetToken && offsetToken !== 'Z') {
    const offsetHours = Number(offsetToken.slice(1, 3));
    const offsetMinutes = Number(offsetToken.slice(4, 6));
    if (offsetHours > 23 || offsetMinutes > 59) return null;
  }
  return { year, month, day, hour, minute, second, ms, offsetToken };
}

/**
 * Builds the UTC instant for calendar parts without JS's legacy two-digit-year remap: the multi-arg
 * `new Date(year, ...)` constructor (and `Date.UTC`) silently turns any year 0–99 into 1900–1999, but
 * `setUTCFullYear` sets exactly the year it is given — years 0000–0099 are real, valid years for this
 * parser and must not be fabricated into the 1900s (revision 5 date note 6).
 */
function utcMsFromParts(p: TimestampParts): number {
  const date = new Date(0);
  date.setUTCFullYear(p.year, p.month - 1, p.day);
  date.setUTCHours(p.hour, p.minute, p.second, p.ms);
  return date.getTime();
}

/** Same fix for the naive/local branch (datetime-local's own shape, and local-interpreted filter bounds):
 * `setFullYear` (unlike the constructor) never remaps a 0–99 year into the 1900s either. */
function localMsFromParts(p: TimestampParts): number {
  const date = new Date(0);
  date.setFullYear(p.year, p.month - 1, p.day);
  date.setHours(p.hour, p.minute, p.second, p.ms);
  return date.getTime();
}

function offsetMsFromParts(p: TimestampParts): number {
  const { offsetToken } = p;
  if (!offsetToken || offsetToken === 'Z') return utcMsFromParts(p);
  const sign = offsetToken[0] === '-' ? -1 : 1;
  const offsetHours = Number(offsetToken.slice(1, 3));
  const offsetMinutes = Number(offsetToken.slice(4, 6));
  return utcMsFromParts(p) - sign * (offsetHours * 60 + offsetMinutes) * 60000;
}

/**
 * Strict timestamp parsing for FILTER BOUNDS (`parseTimeBounds`): accepts either documented shape, an
 * offset-bearing instant or the naive, no-offset shape `datetime-local` supplies (interpreted as local
 * wall-clock time — that IS what the input means). Kept separate from `parseEventInstant` below: a
 * filter bound's naive shape is the expected, documented one, while a naive event `at` is not.
 */
export function parseStrictTimestamp(value: string): number | null {
  const parts = matchTimestampParts(value);
  if (!parts) return null;
  return parts.offsetToken ? offsetMsFromParts(parts) : localMsFromParts(parts);
}

/**
 * Event `at` values only. `src/core/store.js now()` always writes a full instant with an explicit `Z`
 * offset — a naive, no-offset string is not that documented shape, so it is never accepted here: doing
 * so would silently guess a timezone for the log rather than admitting the record doesn't match what the
 * writer produces (revision 5 date note 6). Filter bounds keep accepting the naive shape through
 * `parseStrictTimestamp` above, because that one IS the shape `datetime-local` supplies.
 */
export function parseEventInstant(value: string): number | null {
  const parts = matchTimestampParts(value);
  if (!parts || !parts.offsetToken) return null;
  return offsetMsFromParts(parts);
}

/** Timeline clock: history spans days, so the month and day ride along with the time. Unrecognised
 * (never fabricated): an unparseable `at` shows verbatim rather than inventing a plausible-looking clock. */
export function formatEventClock(iso: string): string {
  const ms = parseEventInstant(iso);
  if (ms === null) return iso;
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ── event vocabulary ─────────────────────────────────────────────────────────

const EVENT_LABELS: Record<string, string> = {
  posted: '发布委托',
  review_posted: '发布复核委托',
  assigned: '指派冒险者',
  dispatched: '派出开工',
  delivered: '交差了，待验收',
  failed: '任务失败了',
  bounced: '限额退回',
  stalled: '失联了',
  released: '释放了冒险者',
  cancelled: '取消了委托',
  owner_ruling: '老板裁决了',
  delivery_write_failed: '交差文件没写成',
};

/** Every `status_<quest status>` line the board writes (src/core/store.js setStatus). */
export function isStatusLine(event: string): boolean {
  return event.startsWith('status_');
}

/** Plain Chinese for every contract event name; anything else shows verbatim (never invented). */
export function eventKindLabel(event: string): string {
  if (isStatusLine(event)) {
    const rest = event.slice('status_'.length);
    const quest = STATUS[rest as keyof typeof STATUS];
    if (quest) return `委托状态：${quest}`;
    return `状态记录：${rest}`;
  }
  return EVENT_LABELS[event] ?? event;
}

/** The kind-filter value that means "every status_* line". */
export const STATUS_KIND_FILTER = 'status_*';

// ── filters ──────────────────────────────────────────────────────────────────

export interface HistoryFilters {
  /** free text matched against the task (package) id */
  packageText: string;
  /** '' = all; otherwise an exact lane value from the loaded events */
  lane: string;
  /** '' = all; otherwise an exact model value from the loaded events */
  model: string;
  /** '' = all kinds; STATUS_KIND_FILTER = the system group; otherwise one exact event name */
  eventKind: string;
  /** datetime-local strings; '' = unbounded. `to` covers the whole selected minute (see parseTimeBounds). */
  from: string;
  to: string;
  /** Narrow to only the records whose own `at` could not be parsed — the "inspect them" view for the
   * filter bar's unrecognised-time note (revision 4). */
  onlyInvalidAt: boolean;
}

export const emptyHistoryFilters: HistoryFilters = {
  packageText: '',
  lane: '',
  model: '',
  eventKind: '',
  from: '',
  to: '',
  onlyInvalidAt: false,
};

export function historyFiltersActive(filters: HistoryFilters): boolean {
  return (
    filters.packageText.trim() !== '' ||
    filters.lane !== '' ||
    filters.model !== '' ||
    filters.eventKind !== '' ||
    filters.from !== '' ||
    filters.to !== '' ||
    filters.onlyInvalidAt
  );
}

export interface TimeBounds {
  startMs: number | null;
  endMs: number | null;
  /** Chinese problem text; while set the caller must surface it and not pretend time is filtered. */
  error: string | null;
}

/** datetime-local has no seconds, so a chosen end time means "through the end of that minute": the
 * span from the start of a minute to its last millisecond. */
const END_OF_MINUTE_SPAN_MS = 59_999;

export function parseTimeBounds(from: string, to: string): TimeBounds {
  let startMs: number | null = null;
  let endMs: number | null = null;
  if (from) {
    startMs = parseStrictTimestamp(from);
    // Wording matches the filter bar's own field labels (开始时间/结束时间), not "日期" — the fields
    // carry a time-of-day, and the two must read as the same thing (revision 5 note 3).
    if (startMs === null) return { startMs: null, endMs: null, error: '开始时间不是有效时间' };
  }
  if (to) {
    const toMs = parseStrictTimestamp(to);
    if (toMs === null) return { startMs, endMs: null, error: '结束时间不是有效时间' };
    endMs = toMs + END_OF_MINUTE_SPAN_MS;
  }
  if (startMs !== null && endMs !== null && startMs > endMs) {
    return { startMs, endMs, error: '开始时间晚于结束时间' };
  }
  return { startMs, endMs, error: null };
}

/** Whether `at` cannot be parsed as a date — such a record can never be judged against a time window. */
export function hasInvalidAt(event: DispatchEvent): boolean {
  return parseEventInstant(event.at) === null;
}

/** How many of these records have an unparseable `at`; used to explain, not fabricate, a time filter's coverage. */
export function countInvalidAt(events: readonly DispatchEvent[]): number {
  return events.reduce((n, event) => n + (hasInvalidAt(event) ? 1 : 0), 0);
}

function withinBounds(event: DispatchEvent, bounds: TimeBounds): boolean {
  if (bounds.startMs === null && bounds.endMs === null) return true;
  const at = parseEventInstant(event.at);
  // An unparseable `at` can't be placed in or out of the window; never invent a date to decide for it,
  // and never let it vanish silently either — it stays in the result (the filter bar explains why).
  if (at === null) return true;
  if (bounds.startMs !== null && at < bounds.startMs) return false;
  if (bounds.endMs !== null && at > bounds.endMs) return false;
  return true;
}

/** One event against the whole filter set; conditions combine (AND). */
export function matchesHistoryFilters(
  event: DispatchEvent,
  filters: HistoryFilters,
  bounds: TimeBounds | null,
): boolean {
  const text = filters.packageText.trim().toLowerCase();
  if (text && !event.package.toLowerCase().includes(text)) return false;
  if (filters.lane && event.lane !== filters.lane) return false;
  if (filters.model && event.model !== filters.model) return false;
  if (filters.eventKind === STATUS_KIND_FILTER && !isStatusLine(event.event)) return false;
  if (filters.eventKind && filters.eventKind !== STATUS_KIND_FILTER && event.event !== filters.eventKind) return false;
  if (bounds && bounds.error === null && !withinBounds(event, bounds)) return false;
  if (filters.onlyInvalidAt && !hasInvalidAt(event)) return false;
  return true;
}

/**
 * Every loaded record the filter matches, status lines included: a card/model filter must show all
 * loaded matching records honestly. There is no folding/noise concept here — every real state change
 * (including a stall recovery or a manual reopen) is a main line; display never deletes a record.
 */
export function filterHistoryEvents(
  events: readonly DispatchEvent[],
  filters: HistoryFilters,
  bounds: TimeBounds | null,
): DispatchEvent[] {
  return events.filter((event) => matchesHistoryFilters(event, filters, bounds));
}

/** Options drawn from the LOADED events only, so a choice never promises records that were never read. */
export function historyFilterOptions(events: readonly DispatchEvent[]): {
  lanes: string[];
  models: string[];
  kinds: string[];
} {
  const lanes = new Set<string>();
  const models = new Set<string>();
  const kinds = new Set<string>();
  for (const event of events) {
    if (event.lane) lanes.add(event.lane);
    if (event.model) models.add(event.model);
    kinds.add(isStatusLine(event.event) ? STATUS_KIND_FILTER : event.event);
  }
  const order = [
    'posted', 'review_posted', 'assigned', 'dispatched', 'delivered', 'failed',
    'bounced', 'stalled', 'released', 'cancelled', 'owner_ruling', 'delivery_write_failed', STATUS_KIND_FILTER,
  ];
  // Known kinds keep the story order above; anything not on that list is unknown and sorts after all of
  // them (never first — indexOf's -1 would otherwise put unknowns ahead of the story it describes).
  const rank = (kind: string) => {
    const i = order.indexOf(kind);
    return i === -1 ? order.length : i;
  };
  const sortedKinds = [...kinds].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return { lanes: [...lanes].sort(), models: [...models].sort(), kinds: sortedKinds };
}

// ── grouping ─────────────────────────────────────────────────────────────────

export interface TaskGroup {
  key: string;
  /** seq order (oldest first) inside the task; the view renders exactly this list, every record. */
  events: DispatchEvent[];
}

/**
 * Group by task (package). Groups sort newest-first by their latest record; inside a task the story
 * reads forward. seq is the file order, so this never invents a timeline.
 */
/** Every group holds at least the event that created it; a group with no events would be a bug here. */
function lastSeq(events: readonly DispatchEvent[]): number {
  const last = events.at(-1);
  if (!last) throw new Error('task group has no events');
  return last.seq;
}

export function groupEventsByTask(events: readonly DispatchEvent[]): TaskGroup[] {
  const groups = new Map<string, DispatchEvent[]>();
  for (const event of events) {
    const list = groups.get(event.package);
    if (list) {
      list.push(event);
    } else {
      groups.set(event.package, [event]);
    }
  }
  const result: TaskGroup[] = [];
  for (const [key, list] of groups) {
    result.push({ key, events: [...list].sort((a, b) => a.seq - b.seq) });
  }
  return result.sort((a, b) => lastSeq(b.events) - lastSeq(a.events));
}

// ── project-wide test summary (replaces the duplicate per-step chips) ────────

export interface ProjectTestLine {
  name: string;
  verdict: 'pass' | 'fail' | 'done';
  value: string;
}

export interface ProjectTestSummary {
  /** Latest verdict per step name: repeated progress lines collapse into one line each. */
  lines: ProjectTestLine[];
  suites: { label: string; passed: number; total: number }[];
  done: boolean;
  overall: 'pass' | 'fail' | 'running';
}

/**
 * The lanes report carries the project's OWN latest verification (from its progress files). Present it
 * as one labelled project-wide result — never as proof of any single task.
 */
export function summarizeProjectTests(verification: Verification): ProjectTestSummary {
  const latest = new Map<string, ProjectTestLine>();
  for (const step of verification.steps) {
    const value = String(step.value ?? '');
    if (step.kind === 'done') {
      latest.set(step.name, { name: step.name, verdict: 'done', value: '完成' });
    } else if (step.kind === 'exit') {
      latest.set(step.name, { name: step.name, verdict: value === '0' ? 'pass' : 'fail', value: `退出码 ${value || '?'}` });
    } else {
      const clean = value === '0' || value === '';
      latest.set(step.name, {
        name: step.name,
        verdict: clean ? 'pass' : 'fail',
        value: clean ? '无错误' : `${value} 处报错`,
      });
    }
  }
  const suites: ProjectTestSummary['suites'] = [];
  if (verification.editXml) {
    suites.push({ label: 'Edit 场景', passed: verification.editXml.passed, total: verification.editXml.total });
  }
  if (verification.playXml) {
    suites.push({ label: 'Play 场景', passed: verification.playXml.passed, total: verification.playXml.total });
  }
  const anyFail =
    [...latest.values()].some((line) => line.verdict === 'fail') ||
    suites.some((suite) => suite.passed < suite.total);
  const overall: ProjectTestSummary['overall'] = anyFail ? 'fail' : verification.done ? 'pass' : 'running';
  return { lines: [...latest.values()], suites, done: verification.done, overall };
}
