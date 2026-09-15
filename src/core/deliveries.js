// A server-API lane (OpenCode) leaves no .out/.md file the way file-based lanes do. When one of its
// workers delivers, its final assistant message is written to <deliveryDir>/<name>.md so the coordinator
// reads every lane's delivery the same way.
import fs from 'node:fs';
import path from 'node:path';
import { fillTemplate } from './config.js';

const NAME_PATTERN = /^[a-z0-9_]{1,48}$/;

// Errors carrying one of these codes mean "not done yet, ask again later" — the session is still running,
// or the API that would tell us otherwise did not answer. Every other error (misconfiguration, a bad
// name, a completed session with nothing to deliver) is terminal: retrying it changes nothing.
export const TRANSIENT_DELIVERY_CODES = new Set(['STILL_RUNNING', 'BAD_RESPONSE', 'FETCH_FAILED']);

function transientError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const DELIVERY_FETCH_TIMEOUT_MS = 3000;

// Rejects once `signal` aborts, so a promise that a test double or a real fetch never settles on its own
// (it does not have to honor AbortSignal) is still bounded by our own timer.
function abortRejection(signal, message) {
  return new Promise((_, reject) => {
    if (signal.aborted) { reject(transientError(message, 'FETCH_FAILED')); return; }
    signal.addEventListener('abort', () => reject(transientError(message, 'FETCH_FAILED')), { once: true });
  });
}

// A bounded read of a live session's message list. The bound covers the whole exchange — opening the
// connection and reading the body — because either half hanging forever is just as fatal to a poll loop as
// an outright error: without it, the dispatcher's pendingDeliveries entry for this quest never clears and
// every later transition (including a real stall or bounce) is skipped (N8). Both phases are raced against
// our own abort signal rather than trusted to reject by themselves, so this also bounds a fetchImpl/`.json`
// that ignores AbortSignal entirely.
async function fetchMessages(fetchImpl, url, timeout, laneId, session) {
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
      throw transientError(`${laneId} unreachable for session ${session}: ${error.message}`, 'FETCH_FAILED');
    }
    if (!response.ok) throw transientError(`${laneId} answered ${response.status} for session ${session}`, 'BAD_RESPONSE');
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
      throw transientError(`${laneId} sent an unreadable response for session ${session}: ${error.message}`, 'BAD_RESPONSE');
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function writeApiDelivery(config, laneId, name, { fetchImpl = fetch, timeout = DELIVERY_FETCH_TIMEOUT_MS } = {}) {
  const lane = config.lanes[laneId];
  if (!lane || !lane.api) throw new Error(`lane ${laneId} has no api`);
  if (!lane.session || !lane.deliveryDir) throw new Error(`lane ${laneId} needs session.saveTo and deliveryDir to write deliveries`);
  if (!NAME_PATTERN.test(String(name))) throw new Error(`bad worker name ${name}`);
  const sessionFile = path.join(config.root, fillTemplate([lane.session.saveTo], { name }, `lanes.${laneId}.session.saveTo`)[0]);
  if (!fs.existsSync(sessionFile)) throw new Error(`no session file ${sessionFile}`);
  const session = fs.readFileSync(sessionFile, 'utf8').trim();
  const messages = await fetchMessages(fetchImpl, `${lane.api}/session/${encodeURIComponent(session)}/message`, timeout, laneId, session);
  const assistants = (Array.isArray(messages) ? messages : []).filter((m) => m && m.info && m.info.role === 'assistant');
  const last = assistants.at(-1);
  if (!last) throw transientError(`session ${session} has no assistant messages`, 'STILL_RUNNING');
  const info = last.info;
  if (!info.time || !info.time.completed) throw transientError(`session ${session} is still running, no completed final turn yet`, 'STILL_RUNNING');
  // `finish` is the AssistantMessage field the installed OpenCode SDK actually exposes (see
  // @opencode-ai/sdk's types.gen.d.ts), not a guessed name. "tool-calls" means this turn ended only to run
  // tools — another assistant turn follows once the tool result lands, exactly what a completed but
  // tool-only turn looks like mid-session. Only the last message is ever read: no walking back to an
  // earlier turn's text, which could be stale progress chatter rather than the real report.
  if (info.finish === 'tool-calls') throw transientError(`session ${session} ended on a tool call, not a final report yet`, 'STILL_RUNNING');
  const text = (last.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n\n').trim();
  // A structured error or a length cutoff on the message itself — never wording found inside its text — is
  // a real terminal fact from the adapter (N10). Either way this was not a clean final report: whatever
  // partial text exists is folded into the failure message so nothing is silently thrown away, and this is
  // thrown as an ordinary (non-transient) error, since retrying changes nothing the adapter already settled.
  if (info.error) {
    const detail = info.error.data ? info.error.data.message : info.error.name || 'no detail';
    throw new Error(`session ${session} ended with an error (${detail}), not a final report${text ? `: ${text}` : ''}`);
  }
  if (info.finish === 'length') throw new Error(`session ${session} was truncated by a length limit, not a final report${text ? `: ${text}` : ''}`);
  if (!text) {
    // `finish` absent on an otherwise-completed, text-empty turn is exactly what a tool-only step looks
    // like on an SDK build that does not always set the field (P1/N2-a) — indistinguishable here from a
    // genuine final turn with nothing to say. Treat it as uncertain, not terminal: a false terminal failure
    // would free the quest's slot while the session might still be running.
    if (info.finish === undefined) throw transientError(`session ${session} completed a tool-only step with no finish field — cannot tell yet if this is the final turn`, 'STILL_RUNNING');
    throw new Error(`session ${session} has no final assistant text`);
  }
  const out = path.join(config.root, lane.deliveryDir, `${name}.md`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${text}\n`, 'utf8');
  return out;
}
