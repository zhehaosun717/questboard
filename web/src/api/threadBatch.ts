// Thread bulk actions for the message board (POST /api/threads/bulk, src/server/boardRoutes.js).
// client.ts is the shared global module and stays untouched: this file owns its narrow fetch helpers,
// types and pure selection logic so the bulk UI is testable without a DOM.
import type { Thread, ThreadDetail, ThreadStatusFilter } from './types';

export type ThreadBulkAction =
  | 'close'
  | 'reopen'
  | 'pin'
  | 'unpin'
  | 'trash'
  | 'restore';

export const THREAD_BULK_ACTIONS: readonly ThreadBulkAction[] = [
  'close',
  'reopen',
  'pin',
  'unpin',
  'trash',
  'restore',
];

// Mirrors MAX_THREAD_BULK_IDS on the server (src/server/boardStore.js): one request never carries more.
export const MAX_THREAD_BULK_IDS = 100;

// Mirrors MAX_THREAD_ID_LENGTH on the server: over-long ids are refused with a reason, never truncated.
export const MAX_THREAD_ID_LENGTH = 128;

// The server answers a single thread read with the raw record; the trash flag is added on the store side
// and optional here so an older server build (no field yet) still type-checks until it restarts.
export type ThreadWithTrash = Thread & { trashed?: boolean };
// Same widening for a full thread detail (list row vs. open pane) — the shared `ThreadDetail` type
// predates the recycle bin too.
export type ThreadDetailWithTrash = ThreadDetail & { trashed?: boolean };

export interface ThreadBulkResult {
  id: string;
  ok: boolean;
  error?: string;
}

export interface ThreadBulkReport {
  action: ThreadBulkAction;
  changed: number;
  failed: number;
  results: ThreadBulkResult[];
}

// A thread the owner can act on: a trashed thread only takes `restore`, a live one never does.
export function canActOnThread(action: ThreadBulkAction, trashed: boolean): boolean {
  return action === 'restore' ? trashed : !trashed;
}

// Client-side mirror of the server's shape rules. The submitted ids are exactly what the UI currently
// shows selected, so a request never carries ids that the visible filter would refuse anyway.
export function validateBulkIds(ids: readonly string[]): string | null {
  if (!Array.isArray(ids) || ids.length === 0) return 'ids 必须是非空数组';
  if (ids.length > MAX_THREAD_BULK_IDS) return `一次最多处理 ${MAX_THREAD_BULK_IDS} 个主题`;
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string' || !id.trim()) return 'ids 里出现了空的或非字符串的 id';
    if (id.length > MAX_THREAD_ID_LENGTH) return `有 id 超过 ${MAX_THREAD_ID_LENGTH} 个字符，服务端会整批拒绝`;
    if (seen.has(id)) return 'ids 里有重复的 id';
    seen.add(id);
  }
  return null;
}

// Pure selection helpers: selection lives in the component, these keep it a bounded, duplicate-free
// list of ids that are actually visible right now. Adding past the cap is a visible no-op: the
// component watches for the unchanged length and tells the owner why.
export function toggleSelectedIds(
  selected: readonly string[],
  id: string,
): string[] {
  if (selected.includes(id)) return selected.filter((s) => s !== id);
  if (selected.length >= MAX_THREAD_BULK_IDS) return [...selected];
  return [...selected, id];
}

// The selection cap is explicit: at the cap no extra id can join (that request would be refused by
// the server anyway), and the UI says so instead of ignoring the click.
export function isAtBulkCap(selected: readonly string[]): boolean {
  return selected.length >= MAX_THREAD_BULK_IDS;
}

export function selectAllVisible(
  threads: readonly ThreadWithTrash[],
  selected: readonly string[],
): string[] {
  const next = [...selected];
  for (const t of threads) {
    if (next.includes(t.id)) continue;
    if (next.length >= MAX_THREAD_BULK_IDS) break;
    next.push(t.id);
  }
  return next;
}

// Drop every id the current filter no longer shows, so a bulk run can never quietly touch a
// row that scrolled out of the view (or vanished into the recycle bin in another tab).
export function pruneToVisible(
  selected: readonly string[],
  visibleIds: readonly string[],
): string[] {
  const visible = new Set(visibleIds);
  return selected.filter((id) => visible.has(id));
}

export const TRASH_EXPLANATION =
  '删除只是把主题放进回收站，不会永久清除：主题和它的全部消息都保留，随时可以在回收站里还原。';

// The Chinese action word used in feedback and button copy.
export function bulkActionLabel(action: ThreadBulkAction): string {
  return {
    close: '关闭',
    reopen: '重新打开',
    pin: '置顶',
    unpin: '取消置顶',
    trash: '放入回收站',
    restore: '还原',
  }[action];
}

// Known refusals from src/server/boardStore.js / boardRoutes.js, in plain Chinese (CLAUDE.md: refusals
// say why, in the UI language). R5-5: anything NOT in this map — or not one of the two fixed shapes below
// — is NEVER shown verbatim. A raw, unrecognized server/network body may carry a path, a token, a stray
// stack fragment (e.g. `EACCES open /srv/private/threads.jsonl token=abc123`, the shape the P9c browser
// probe sends) — none of that belongs in the DOM, a toast, or the page title. Only a fixed public code (an
// HTTP status this client already formats itself, never the server's own text) or an exact match in this
// map is ever echoed; everything else gets `UNKNOWN_ERROR_ZH`.
const SERVER_ERROR_ZH: Readonly<Record<string, string>> = {
  'thread not found': '主题不存在（可能已被删除）',
  'thread is not in the recycle bin': '这个主题不在回收站里，无需还原',
  'thread is already in the recycle bin': '这个主题已经在回收站里了',
  'thread is in the recycle bin; restore it first': '主题在回收站里，请先还原再操作',
  'thread is in the recycle bin': '主题在回收站里，请先还原再操作',
  'thread is closed': '主题已关闭，重新打开后才能回复',
  'ids must be a non-empty array': 'ids 必须是非空数组',
  // The create/reply validation refusal (src/server/boardRoutes.js, wrapping boardStore.js's
  // `validateBoardPayload` field errors) carries this exact top-level message alongside `fields`. Without
  // an entry here it fell through to `UNKNOWN_ERROR_ZH`
  // — accurate (never raw server text) but silent about *why*, so a refusal with no per-field detail of its
  // own (reply has no allowlisted fields) said nothing actionable at all.
  'validation failed': '填写内容有误，请检查后重试',
};

// A bare `HTTP <status>` string is never server-supplied text — this client only ever synthesizes it
// itself (see `request` and `client.ts`'s `call`) when a failed response carried no `error` field at all.
// A three-digit status code cannot itself carry a secret, so it is the one shape besides the map above
// that is safe to show as-is.
const HTTP_STATUS_RE = /^HTTP \d{3}$/;

export const UNKNOWN_ERROR_ZH = '出了点问题，请稍后重试';

// D3: NewThreadModal's create-form field errors (server's `{error, fields}` validation shape,
// src/server/boardStore.js's `validateBoardPayload`) are runtime data from an HTTP response, not a
// compile-time-checked contract — a differently-behaving server build (or anything sitting in front of it)
// can send whatever it wants there. Only these four keys are ever read; anything else in the object is
// ignored outright rather than iterated and rendered, so an unexpected key can never reach the DOM even
// indirectly (and never risks a prototype-pollution-style key like `__proto__`, since only allowlisted own
// keys are ever looked up).
const FIELD_ERROR_ALLOWLIST = ['author', 'title', 'body', 'tag'] as const;
export type ThreadFormField = (typeof FIELD_ERROR_ALLOWLIST)[number];

const GENERIC_FIELD_ERROR_ZH = '该字段有误，请检查后重试';

// The exact messages src/server/boardStore.js's `validateBoardPayload` actually sends today, mapped to
// fixed Chinese — never the server's own string, even when it happens to be one of these exact messages
// (defense in depth: a value that happens to collide with a known key still only ever produces text this
// client authored itself).
const FIELD_ERROR_ZH: Readonly<Record<ThreadFormField, Readonly<Record<string, string>>>> = {
  author: {
    'author is required': '请填写你的名字',
    'author must be 80 characters or fewer': '名字最多 80 个字符',
  },
  title: {
    'title is required': '请填写标题',
    'title must be 120 characters or fewer': '标题最多 120 个字符',
  },
  body: {
    'body is required': '请填写第一条消息',
    'body must be 20000 characters or fewer': '消息最多 20000 个字符',
  },
  tag: {
    'tag must use letters, numbers, underscores, or hyphens and be 40 characters or fewer':
      '标签只能使用字母、数字、下划线或连字符，最多 40 个字符',
  },
};

// R11/R11b: a create-form field error is untrusted runtime data — only an allowlisted field name is ever
// read, only a string value is ever considered (an object or array is a shape a real client never sends
// and previously reached React as a child, crashing the whole app — error #31), and only an exact match
// against the known messages above is ever echoed; anything else (an unrecognized string — a path, a
// token, a stray stack fragment — or a non-string value) becomes the one generic per-field fallback, never
// the raw text. This mirrors `bulkErrorLabel`'s allow-known/generic-otherwise shape one level down, for
// data keyed by field name instead of by a single top-level message.
export function describeFieldErrors(fields: unknown): Partial<Record<ThreadFormField, string>> {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return {};
  const source = fields as Record<string, unknown>;
  const result: Partial<Record<ThreadFormField, string>> = {};
  for (const field of FIELD_ERROR_ALLOWLIST) {
    const value = source[field];
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      result[field] = GENERIC_FIELD_ERROR_ZH;
      continue;
    }
    const trimmed = value.trim();
    result[field] = FIELD_ERROR_ZH[field][trimmed] ?? GENERIC_FIELD_ERROR_ZH;
  }
  return result;
}

export function bulkErrorLabel(error: string | undefined | null): string {
  if (!error) return '未知错误';
  const trimmed = error.trim();
  if (SERVER_ERROR_ZH[trimmed]) return SERVER_ERROR_ZH[trimmed];
  if (trimmed.startsWith('cross-site request refused')) return '跨站请求被拒绝：只有本机的板页能写入';
  if (trimmed.startsWith('origin ') && trimmed.endsWith(' refused')) return '该来源被拒绝：只有本机的板页能写入';
  if (HTTP_STATUS_RE.test(trimmed)) return `请求失败（${trimmed}）`;
  return UNKNOWN_ERROR_ZH;
}

// Every raw server/network error that reaches a thread-view read or write goes through here first: known
// refusals come back in plain Chinese (the same map a per-id bulk failure uses), a bare HTTP status is
// shown as-is, and anything else — an unrecognized message, a thrown non-Error value — becomes the one
// generic fallback (R5-5). Shared by ThreadsView's reads (list/detail) and useThreadWriteOperations's
// writes (reply/pin/close/bulk/restore) so there is exactly one place this decision is made.
export function describeThreadError(err: unknown): string {
  const raw = err instanceof Error ? err.message || '操作失败' : String(err);
  return bulkErrorLabel(raw);
}

// `report.changed` is runtime data off an HTTP response, same trust level as `report.results[].error` — a
// differently-behaving server (or anything sitting in front of it) can send anything there, and this
// client's own `ThreadBulkReport` type only describes the shape a well-behaved server sends today. A
// non-integer, negative or unsafe value (the P9c-style probe sends a path/token string) is never shown
// as-is; the count of `results` this same report marks `ok` is what the UI actually means by "changed"
// anyway, so it is the fallback rather than a generic placeholder.
function safeChangedCount(report: ThreadBulkReport): number {
  const raw: unknown = report.changed;
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return raw;
  return report.results.filter((r) => r.ok).length;
}

// One honest line about a finished run. A partial run says which ids failed — never「全部成功」.
// R13: `sentIds` is exactly what this client asked the server to act on — the request it captured before
// sending, never derived from the response. A result id the server echoes back that isn't in that set is
// unconfirmed identity (server-echoed data, same trust level as a raw error string) and is never named
// directly; only ids this exact request actually sent are ever shown.
export function describeBulkReport(report: ThreadBulkReport, sentIds: readonly string[]): string {
  const label = bulkActionLabel(report.action);
  const sent = new Set(sentIds);
  const failures = report.results.filter((r) => !r.ok);
  const changed = safeChangedCount(report);
  if (failures.length === 0) return `已${label} ${changed} 个主题`;
  const detail = failures
    .slice(0, 5)
    .map((f) => `${sent.has(f.id) ? f.id : '未知 id'}：${f.error ? bulkErrorLabel(f.error) : '失败'}`)
    .join('；');
  const more = failures.length > 5 ? `；另有 ${failures.length - 5} 个失败` : '';
  if (changed === 0) return `${label}没有成功：${detail}${more}`;
  return `部分完成：${changed} 个已${label}，${failures.length} 个失败（${detail}${more}）`;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const value = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok) {
    // D2: throw the raw refusal text (or a client-synthesized bare status) exactly once — the same
    // contract client.ts's `call()` already follows for ApiError. `describeThreadError` is the one place
    // that maps a raw message to Chinese; translating here too made a known refusal (already turned into
    // Chinese) fail to match anything in `SERVER_ERROR_ZH` by the time it got there, so it fell through to
    // the generic fallback instead — a real user-facing regression, not just a naming nit.
    throw new Error(value?.error || `HTTP ${response.status}`);
  }
  return value;
}

export interface ThreadListFilters {
  status: ThreadStatusFilter;
  q?: string;
  trash?: boolean;
}

// The shared client's api.threads() predates the recycle bin, so the bulk view lists through here:
// trash=true asks the store for the recycle bin only; the server's default list hides it. The bin
// always lists every status — filtering it 开放/已关闭 is how closed trashed threads vanished behind
// a falsely empty recycle bin, so the caller's status filter is deliberately ignored here.
export function listThreads(filters: ThreadListFilters): Promise<{
  threads: ThreadWithTrash[];
}> {
  const params = new URLSearchParams({ status: filters.trash ? 'all' : filters.status });
  if (filters.q?.trim()) params.set('q', filters.q.trim());
  if (filters.trash) params.set('trash', 'only');
  return request<{ threads: ThreadWithTrash[] }>(`/api/threads?${params}`);
}

export function bulkThreads(
  action: ThreadBulkAction,
  ids: readonly string[],
): Promise<ThreadBulkReport> {
  const problem = validateBulkIds(ids);
  if (problem) return Promise.reject(new Error(problem));
  const body = JSON.stringify({
    action,
    ids: [...ids],
  });
  return request<ThreadBulkReport>('/api/threads/bulk', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}
