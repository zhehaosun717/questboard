import type { QuestEvent } from './types';

/**
 * Event reading for the dispatch history (GET /api/events). The endpoint is cursor-paged forward only
 * (`after=<seq>`), oldest-first, and the server clamps `limit` to its own cap — so a reader must track
 * what it has NOT seen. The server returns no hasMore/end metadata (questRoutes.js `/api/events`), so a
 * page can only prove the log ended by coming back empty with an unchanged cursor (review 73f4bd71 B5);
 * a short-but-non-empty page never proves it, because a future server could clamp lower than today's.
 * These types are local because the event file adds `seq` and can null the lane fields, which the
 * global QuestEvent type does not model.
 */

/** One raw event line: the board's contract fields plus the file-position seq used as the cursor. */
export interface DispatchEvent extends Omit<QuestEvent, 'lane' | 'model' | 'variant' | 'name' | 'by'> {
  seq: number;
  lane: string | null;
  model: string | null;
  variant: string | null;
  name: string | null;
  by: string;
}

export interface EventsPage {
  events: DispatchEvent[];
  nextAfter: number;
  /** An empty page whose cursor did not move: the log ended here, proven, not guessed. */
  atEnd: boolean;
}

export const HISTORY_PAGE_SIZE = 500;
export const HISTORY_MAX_PAGES_PER_LOAD = 10; // one load touches at most 10 × 500 records

/**
 * The cursor contract itself was violated: a missing/non-integer/regressing `nextAfter`, or an empty
 * page whose cursor moved anyway. Retrying at the same `after` will fail the same way every time, so
 * the only real recovery is starting over from the beginning — never inferred from the last event's
 * own seq, and never spun on forever (project rule: missing data fails loudly, never invented).
 */
export class HistoryProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HistoryProtocolError';
  }
}

type FetchLike = (input: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

function text(value: unknown, field: string, seq: number): string {
  if (typeof value !== 'string' || !value) throw new Error(`事件 #${seq} 缺少 ${field}`);
  return value;
}

function nullable(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/** Validate at the boundary: a record without a usable seq/at/event is refused, naming what is missing. */
export function parseDispatchEvent(value: unknown): DispatchEvent {
  if (typeof value !== 'object' || value === null) throw new Error('事件记录不是对象');
  const row = value as Record<string, unknown>;
  if (!Number.isInteger(row.seq)) throw new Error(`事件记录缺少整数 seq（收到类型 ${typeof row.seq}），已停止读取`);
  const seq = row.seq as number;
  return {
    seq,
    at: text(row.at, 'at', seq),
    event: text(row.event, 'event', seq),
    package: typeof row.package === 'string' ? row.package : '',
    lane: nullable(row.lane),
    model: nullable(row.model),
    variant: nullable(row.variant),
    name: nullable(row.name),
    by: typeof row.by === 'string' ? row.by : '',
    detail: typeof row.detail === 'string' ? row.detail : '',
  };
}

/** Read one bounded page after the cursor. Throws on HTTP or shape errors; honours the AbortSignal. */
export async function fetchEventsPage(
  after: number,
  options: { limit?: number; signal?: AbortSignal; fetchImpl?: FetchLike } = {},
): Promise<EventsPage> {
  const limit = options.limit ?? HISTORY_PAGE_SIZE;
  const doFetch: FetchLike = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const response = await doFetch(`/api/events?after=${after}&limit=${limit}`, { signal: options.signal });
  if (!response.ok) {
    let reason = '';
    try {
      const body = (await response.json()) as { error?: string };
      reason = body.error ? `：${body.error}` : '';
    } catch {
      /* the status alone is the message */
    }
    throw new Error(`事件接口返回 ${response.status}${reason}`);
  }
  const body = (await response.json()) as Record<string, unknown>;
  if (!Array.isArray(body.events)) throw new Error('事件接口响应缺少 events 数组');
  const events = body.events.map(parseDispatchEvent);

  // The cursor is the only thing that proves progress or completion; a missing or non-numeric value
  // is never inferred from the page's own last seq (that would hide a real server-side contract
  // break behind a plausible-looking guess).
  const rawNextAfter = body.nextAfter;
  if (typeof rawNextAfter !== 'number' || !Number.isInteger(rawNextAfter)) {
    // A missing/non-numeric nextAfter is a broken cursor contract, exactly like a stalled or regressed
    // one below: retrying at the same `after` will fail the same way every time (revision 5 D1), so it
    // must classify as HistoryProtocolError too, not a plain HTTP-shaped Error.
    const kind = rawNextAfter === undefined ? '缺失' : typeof rawNextAfter !== 'number' ? '类型不对' : '不是整数';
    throw new HistoryProtocolError(
      `事件接口响应的 nextAfter 游标${kind}，读取已停止；同一游标重试无法恢复，请点击"从头重新读取"`,
    );
  }

  if (events.length === 0) {
    // Only an empty page whose cursor did not move proves the log ended here (B5). If the cursor
    // moved anyway despite no events, the server broke its own contract — that is not a page we can
    // trust to mean anything, so it fails loudly instead of silently accepting a new position.
    if (rawNextAfter !== after) {
      throw new HistoryProtocolError(
        `事件接口游标异常：空页却把游标从 ${after} 移到了 ${rawNextAfter}，读取已停止；` +
          '同一游标重试无法恢复，请点击"从头重新读取"',
      );
    }
    return { events, nextAfter: rawNextAfter, atEnd: true };
  }

  if (rawNextAfter <= after) {
    throw new HistoryProtocolError(
      '事件接口游标没有前进，读取已停止以避免重复请求；同一游标重试无法恢复，请点击"从头重新读取"',
    );
  }

  // A non-empty page never proves the end by itself, however short: the server clamps `limit` to its
  // OWN current cap (questRoutes.js EVENTS_MAX today, but that value is not this client's to assume),
  // so a page shorter than what we asked for only means "the server's cap is lower than our request",
  // never "nothing more exists". Only the empty-page check above may declare the end.
  return { events, nextAfter: rawNextAfter, atEnd: false };
}

/** Union by seq — same seq is the same record once; distinct seqs stay separate even if identical. */
export function mergeEventsBySeq(
  current: readonly DispatchEvent[],
  incoming: readonly DispatchEvent[],
): DispatchEvent[] {
  const bySeq = new Map<number, DispatchEvent>();
  for (const event of current) bySeq.set(event.seq, event);
  for (const event of incoming) if (!bySeq.has(event.seq)) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}
