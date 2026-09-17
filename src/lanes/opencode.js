// Server-API workers (OpenCode): state comes from the session's messages over HTTP.
import { resetAt, STALE_MS } from './workers.js';

export async function fetchJson(url, { fetchImpl = fetch, timeout = 3000 } = {}) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const response = await fetchImpl(url, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

// The model a session actually ran, from its own messages (old registry rows may say "unknown").
export function sessionModel(messages) {
  for (const message of Array.isArray(messages) ? messages : []) {
    const info = message && message.info;
    if (!info) continue;
    const requested = info.model && info.model.providerID && info.model.modelID ? info.model : null;
    const source = requested || (info.providerID && info.modelID ? info : null);
    if (source) return { model: `${source.providerID}/${source.modelID}`, variant: (requested && requested.variant) || '' };
  }
  return null;
}

const QUOTA_FIELD_RE = /^(?:rate[_ -]?limit(?:[_ -]?exceeded)?|quota(?:[_ -]?(?:exceeded|limit))?|usage[_ -]?limit|resource[_ -]?exhausted|insufficient[_ -]?balance)(?:error)?$/i;

function structuredQuotaError(error) {
  if (!error || typeof error !== 'object') return false;
  const data = error.data && typeof error.data === 'object' ? error.data : null;
  // A plain HTTP 402 (Payment Required) is itself the quota signal, even with no quota-named code/type —
  // it must come from a real status field, never guessed from free text elsewhere in the message.
  if ([error.status, error.statusCode, data && data.status, data && data.statusCode].some((value) => Number(value) === 402)) return true;
  return [error.code, error.type, error.name, data && data.code, data && data.type, data && data.name]
    .some((value) => typeof value === 'string' && QUOTA_FIELD_RE.test(value.trim()));
}

function structuredResetText(error) {
  const data = error && error.data && typeof error.data === 'object' ? error.data : null;
  const explicit = [error && error.resetAt, error && error.resetsAt, error && error.retryAt, data && data.resetAt, data && data.resetsAt, data && data.retryAt, data && data.retry_at, data && data.reset_at]
    .find((value) => typeof value === 'string' && value.trim());
  if (explicit) return explicit.trim();
  const message = data && typeof data.message === 'string' ? data.message : '';
  const match = message.match(/try again at\s+(.+?)\s*[.!]?\s*$/i);
  return match ? match[1].trim() : null;
}

export function sessionState(messages, now = Date.now(), { stallAfterMinutes } = {}) {
  const assistant = messages.filter((m) => m.info && m.info.role === 'assistant');
  if (!assistant.length) return { state: 'unknown', reason: 'no assistant messages' };
  const last = assistant.at(-1);
  const info = last.info;
  const parts = last.parts || [];
  const toolParts = parts.filter((p) => p.type === 'tool');
  const toolCounts = {};
  for (const part of toolParts) toolCounts[part.tool || 'unknown'] = (toolCounts[part.tool || 'unknown'] || 0) + 1;
  const lastText = parts.filter((p) => p.type === 'text').map((p) => p.text).join(' ').trim().slice(-300);
  const edits = (toolCounts.edit || 0) + (toolCounts.write || 0);
  const errorDetail = info.error ? (info.error.data ? info.error.data.message : info.error.name || '') : '';
  // Actual last activity, never the nonexistent `info.time.updated` — the SDK's AssistantMessage only ever
  // carries `{created, completed?}` (N9). `completed` is the newest fact once a turn ends; `created` is all
  // there is while it is still running. Without this a stale completed tool-calls turn stayed "running"
  // forever instead of ever going "stalled".
  const lastActivityMs = info.time ? info.time.completed || info.time.created || 0 : 0;
  // A structured quota code/type/name on the message itself is the only OpenCode bounce evidence. The free
  // text message is retained for an ordinary failure but is never regex-tested for 402 or quota wording.
  if (structuredQuotaError(info.error)) {
    const bounceUntil = structuredResetText(info.error);
    const observedAt = lastActivityMs || now;
    const parsedReset = bounceUntil ? resetAt(bounceUntil, observedAt) : null;
    return {
      state: 'bounced', reason: 'usage limit', toolCounts, lastText, edits,
      ...(bounceUntil ? { bounceUntil } : {}),
      ...(parsedReset ? { resetsAt: new Date(parsedReset).toISOString() } : {}),
      ...(lastActivityMs ? { lastActivityMs } : {}),
    };
  }
  // An explicit structured error is terminal whenever it appears (N13): OpenCode leaves `time.completed`
  // unset on some aborts and keeps an earlier `finish` value on others, so checking completion or
  // tool-calls first hid the failure and kept the slot for a worker that will never speak again. Only the
  // message's own error field counts — wording inside a tool's state is not evidence, checked above or
  // not at all, never here.
  if (info.error) return { state: 'failed', reason: errorDetail || info.error.name || 'assistant error', toolCounts, lastText, edits, lastActivityMs };
  const completed = Boolean(info.time && info.time.completed);
  // `finish` is the AssistantMessage field the installed OpenCode SDK actually exposes (see
  // @opencode-ai/sdk's types.gen.d.ts), not a guessed name. "tool-calls" means this turn only ended to run
  // tools — another assistant turn follows once the tool result lands, so a completed-but-tool-only turn
  // is still mid-session, not a delivery. Same finality rule as the writeApiDelivery fix.
  const midStep = info.finish === 'tool-calls';
  // A completed turn with no text and no `finish` field at all is exactly what a tool-only step looks like
  // on an SDK build that does not always set `finish` (P1/N2-a) — indistinguishable here from a genuine
  // final turn with nothing to say. Same call as writeApiDelivery: uncertain, not a delivery, so a live
  // worker never loses its slot on a guess made from an absent field.
  const ambiguousToolOnly = !lastText && info.finish === undefined;
  const running = !completed || midStep || ambiguousToolOnly;
  if (running) {
    // A real timestamp is all staleness needs (N14): a turn with no tool parts — text-only and never
    // completed, or reasoning-only with no finish — went as quiet as a wedged tool call once STALE_MS
    // passes, and it must surface as stalled instead of holding its slot invisibly forever.
    const staleMinutes = Number.isInteger(stallAfterMinutes) && stallAfterMinutes > 0 ? stallAfterMinutes : 20;
    if (lastActivityMs && now - lastActivityMs > staleMinutes * 60 * 1000) return { state: 'stalled', reason: `running, no activity >${staleMinutes}m`, toolCounts, lastText, edits, lastActivityMs };
    // With no usable timestamp at all, "just started" and "lost track of" are indistinguishable: stay
    // running (uncertain, slot held) but name the missing fact, so the board reads a diagnosis instead of
    // an unexplained silence — and a turn is never called successful on a guess.
    if (!lastActivityMs) return { state: 'running', reason: 'turn carries no created or completed timestamp', toolCounts, lastText, edits };
    return { state: 'running', toolCounts, lastText, edits, lastActivityMs };
  }
  // A length cutoff is a real terminal fact from the adapter, never a guess made from text — and it is not
  // a successful delivery either: a truncated turn must not masquerade as a finished report (N10).
  // `lastText` still carries whatever partial text existed, so nothing is lost from the quest's detail
  // even though no delivery file is written for it.
  if (info.finish === 'length') return { state: 'failed', reason: 'assistant reply truncated by a length limit', toolCounts, lastText, edits, lastActivityMs };
  // Only "stop" is an explicit successful finish, and a missing value with real text is the one tolerated
  // compatibility case. Every other value the adapter reports — content-filter, error, unknown, anything
  // a future SDK adds — is a terminal non-delivery with the value itself as the reason (N12), whatever
  // text rides along: a filtered or errored turn is not a report no matter what it managed to say.
  if (info.finish !== undefined && info.finish !== 'stop') return { state: 'failed', reason: `assistant turn ended with finish "${info.finish}", not "stop"`, toolCounts, lastText, edits, lastActivityMs };
  if (!lastText) return { state: 'failed', reason: 'no final assistant text', toolCounts, lastText, edits, lastActivityMs };
  return { state: 'delivered', toolCounts, lastText, edits, lastActivityMs };
}

export function sessionLimitReason(messages, elapsed, limits = {}) {
  if (limits.maxMessages !== undefined && messages.length > limits.maxMessages) return `超过消息上限 ${limits.maxMessages} 条`;
  if (limits.maxMinutes !== undefined && elapsed > limits.maxMinutes * 60 * 1000) return `超过时长上限 ${limits.maxMinutes} 分钟`;
  return null;
}

// The abort adapter performs one bounded follow-up read through this same lane API. A terminal
// message state is enough to show that the session ended; running, stalled and unknown remain
// deliberately inconclusive. Only the documented message-array shape is proof: an object or error
// envelope must not be mistaken for a session result.
export function sessionEnded(value) {
  return Array.isArray(value) && ['delivered', 'failed', 'bounced'].includes(sessionState(value).state);
}
