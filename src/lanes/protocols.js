// Registry mapping lanes.<id>.protocol (src/core/config.js) to the functions that speak that server API.
// The collector and the delivery writer dispatch through this file instead of branching on lane.api, so
// recognizing a different vendor's session protocol only ever means adding an entry here — including the
// URL shapes (messagesUrl, sessionUrl) and the delivery transport (fetchMessages), so collector.js and
// deliveries.js never hard-code one vendor's paths (M2).
import { fetchJson, sessionLimitReason, sessionModel, sessionState } from './opencode.js';

function transientDeliveryError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// OpenCode's session-message and session-detail paths. The collector reads a session's own id
// unencoded (it is never anything but what the registry/session file wrote); fetchMessages below is the
// one caller that encodes it, matching writeApiDelivery's pre-M2 behaviour exactly.
function messagesUrl(lane, session) {
  return `${lane.api}/session/${session}/message`;
}

function sessionUrl(lane, session) {
  return `${lane.api}/session/${session}`;
}

const DELIVERY_FETCH_TIMEOUT_MS = 3000;

// Rejects once `signal` aborts, so a promise that a test double or a real fetch never settles on its own
// (it does not have to honor AbortSignal) is still bounded by our own timer.
function abortRejection(signal, message) {
  return new Promise((_, reject) => {
    if (signal.aborted) { reject(transientDeliveryError(message, 'FETCH_FAILED')); return; }
    signal.addEventListener('abort', () => reject(transientDeliveryError(message, 'FETCH_FAILED')), { once: true });
  });
}

// A bounded read of a live session's message list, for writeApiDelivery (src/core/deliveries.js). The bound
// covers the whole exchange — opening the connection and reading the body — because either half hanging
// forever is just as fatal to a poll loop as an outright error: without it, the dispatcher's
// pendingDeliveries entry for this quest never clears and every later transition (including a real stall or
// bounce) is skipped (N8). Both phases are raced against our own abort signal rather than trusted to reject
// by themselves, so this also bounds a fetchImpl/`.json` that ignores AbortSignal entirely.
async function fetchMessages(fetchImpl, lane, session, { timeout = DELIVERY_FETCH_TIMEOUT_MS, laneId } = {}) {
  const url = messagesUrl(lane, encodeURIComponent(session));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    let response;
    try {
      response = await Promise.race([
        fetchImpl(url, { signal: controller.signal }),
        abortRejection(controller.signal, `${laneId} timed out waiting for session ${session}`),
      ]);
    } catch (error) {
      if (error.code) throw error;
      throw transientDeliveryError(`${laneId} unreachable for session ${session}: ${error.message}`, 'FETCH_FAILED');
    }
    if (!response.ok) throw transientDeliveryError(`${laneId} answered ${response.status} for session ${session}`, 'BAD_RESPONSE');
    try {
      return await Promise.race([
        response.json(),
        abortRejection(controller.signal, `${laneId} timed out reading a response for session ${session}`),
      ]);
    } catch (error) {
      if (error.code) throw error;
      // A truncated or malformed body (the server mid-restart, the connection dropped after headers) is
      // not proof the session ended badly — it is proof this one read failed (N7). The next poll gets a
      // fresh response.
      throw transientDeliveryError(`${laneId} sent an unreadable response for session ${session}: ${error.message}`, 'BAD_RESPONSE');
    }
  } finally {
    clearTimeout(timer);
  }
}

// Interprets one OpenCode session's message list into a delivery. Mirrors the terminal/transient split
// sessionState enforces for the collector (see opencode.js and delivery-terminal.test.js's "keeps the
// collector and the writer in one mind on the same messages") but reports a session-scoped message and a
// retry code instead of a board state, since a delivery attempt either writes a report or throws.
function parseOpencodeSessionDelivery(messages, session) {
  const assistants = (Array.isArray(messages) ? messages : []).filter((m) => m && m.info && m.info.role === 'assistant');
  const last = assistants.at(-1);
  if (!last) throw transientDeliveryError(`session ${session} has no assistant messages`, 'STILL_RUNNING');
  const info = last.info;
  const text = (last.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n\n').trim();
  // A structured error on the message itself — never wording found inside its text — is a real terminal
  // fact from the adapter (N10), read before `time.completed` and before `finish` (N13): the two are not
  // written together on every abort, so an error must decide the turn no matter which field is missing or
  // stale. Whatever partial text exists is folded into the failure message so nothing is silently thrown
  // away, and this is thrown as an ordinary (non-transient) error, since retrying changes nothing the
  // adapter already settled.
  if (info.error) {
    const detail = info.error.data ? info.error.data.message : info.error.name || 'no detail';
    throw new Error(`session ${session} ended with an error (${detail}), not a final report${text ? `: ${text}` : ''}`);
  }
  if (!info.time || !info.time.completed) throw transientDeliveryError(`session ${session} is still running, no completed final turn yet`, 'STILL_RUNNING');
  // "tool-calls" means this turn ended only to run tools — another assistant turn follows once the tool
  // result lands, exactly what a completed-but-tool-only turn looks like mid-session. Only the last message
  // is ever read: no walking back to an earlier turn's text, which could be stale progress chatter rather
  // than the real report.
  if (info.finish === 'tool-calls') throw transientDeliveryError(`session ${session} ended on a tool call, not a final report yet`, 'STILL_RUNNING');
  if (info.finish === 'length') throw new Error(`session ${session} was truncated by a length limit, not a final report${text ? `: ${text}` : ''}`);
  // Only "stop" is an explicit successful finish; a missing value with real text stays the compatibility
  // case. Every other value (content-filter, error, unknown, anything a future SDK adds) names an ending
  // that is not success (N12): a turn cut off by a filter is not a report, however much text it managed to
  // say first — so it fails with the value itself, and that partial text, as the evidence.
  if (info.finish !== undefined && info.finish !== 'stop') throw new Error(`session ${session} ended with finish "${info.finish}", not "stop", not a final report${text ? `: ${text}` : ''}`);
  if (!text) {
    // `finish` absent on an otherwise-completed, text-empty turn is exactly what a tool-only step looks
    // like on an SDK build that does not always set the field (P1/N2-a) — indistinguishable here from a
    // genuine final turn with nothing to say. Treat it as uncertain, not terminal: a false terminal failure
    // would free the quest's slot while the session might still be running.
    if (info.finish === undefined) throw transientDeliveryError(`session ${session} completed a tool-only step with no finish field — cannot tell yet if this is the final turn`, 'STILL_RUNNING');
    throw new Error(`session ${session} has no final assistant text`);
  }
  return text;
}

export const PROTOCOLS = {
  'opencode-session': {
    fetchJson,
    sessionLimitReason,
    sessionModel,
    sessionState,
    parseDelivery: parseOpencodeSessionDelivery,
    messagesUrl,
    sessionUrl,
    fetchMessages,
  },
};

// The protocol a lane speaks, or null for a file lane (no api) or an unregistered name — resolveConfig
// already refuses an unknown protocol at load time, so null in practice only ever means "not a server lane".
export function protocolFor(lane) {
  return (lane && lane.protocol && PROTOCOLS[lane.protocol]) || null;
}
