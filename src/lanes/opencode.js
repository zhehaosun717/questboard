// Server-API workers (OpenCode): state comes from the session's messages over HTTP.
import { USAGE_RE, STALE_MS } from './workers.js';

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

export function sessionState(messages, now = Date.now()) {
  const assistant = messages.filter((m) => m.info && m.info.role === 'assistant');
  if (!assistant.length) return { state: 'unknown', reason: 'no assistant messages' };
  const last = assistant.at(-1);
  const running = !last.info.time || !last.info.time.completed;
  const parts = last.parts || [];
  const toolParts = parts.filter((p) => p.type === 'tool');
  const toolCounts = {};
  for (const part of toolParts) toolCounts[part.tool || 'unknown'] = (toolCounts[part.tool || 'unknown'] || 0) + 1;
  const lastText = parts.filter((p) => p.type === 'text').map((p) => p.text).join(' ').trim().slice(-300);
  const edits = (toolCounts.edit || 0) + (toolCounts.write || 0);
  const errorDetail = last.info.error ? (last.info.error.data ? last.info.error.data.message : last.info.error.name || '') : '';
  const toolError = parts.find((p) => p.type === 'tool' && p.state && p.state.status === 'error');
  if (USAGE_RE.test(errorDetail) || (toolError && USAGE_RE.test(JSON.stringify(toolError.state)))) return { state: 'bounced', reason: 'usage limit', toolCounts, lastText, edits };
  const lastActivityMs = last.info.time ? last.info.time.completed || last.info.time.updated || 0 : 0;
  if (running) {
    const updated = last.info.time ? last.info.time.updated : 0;
    if (toolParts.length && updated && now - updated > STALE_MS) return { state: 'stalled', reason: 'running, no activity >20m', toolCounts, lastText, edits, lastActivityMs };
    return { state: 'running', toolCounts, lastText, edits, lastActivityMs };
  }
  return { state: 'delivered', toolCounts, lastText, edits, lastActivityMs };
}
