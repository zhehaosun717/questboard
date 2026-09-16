// File-based workers: a lane script writes <outputDir>/<name>.out while running, <name>.exit when done,
// and optionally <name>.md as the final report.
import fs from 'node:fs';
import path from 'node:path';

export const STALE_MS = 20 * 60 * 1000;
// Kept for import compatibility; expiry is intentionally disabled for unknown-duration bounces.
export const BOUNCE_MAX_AGE_MS = Number.POSITIVE_INFINITY;
// 402 and "try again at" occur in ordinary test output and HTTP failures. Quota evidence must start with
// one of the known CLI diagnostics, and is accepted only after a valid nonzero exit has been observed.
export const USAGE_RE = /^\s*(?:error:\s*)?(?:resource[_ -]?exhausted\b|insufficient[_ -]?balance\b|quota(?:\s+exceeded|\s+limit(?:\s+reached)?)?\b|usage\s+limit\b|you(?:'|’)ve\s+hit\s+your\s+usage\s+limit\b|you have\s+hit\s+your\s+usage\s+limit\b)[^\r\n]*$/i;
const BOUNCE_TIME_RE = /try again at\s+(.+?)\s*[.!]?\s*$/i;
const FULL_RESET_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
const QUOTA_REASON_RE = /^(?:quota(?:[_ -]?(?:exceeded|limit))?|rate[_ -]?limit(?:[_ -]?exceeded)?|usage[_ -]?limit(?:[_ -]?reached)?|resource[_ -]?exhausted|insufficient[_ -]?balance)$/i;
// The generic wrapper writes a plain integer. A future wrapper may write JSON or an integer followed by a
// bounded reason marker; malformed/partial files remain non-terminal.
const EXIT_CODE_RE = /^\s*-?\d+\s*$/;
export const EXIT_REPORT_GRACE_MS = 30 * 1000;

function parseExitRecord(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && Number.isInteger(parsed.code)) {
      const resetAt = parsed.resetAt || parsed.resetsAt || parsed.retryAt || parsed.retry_at || parsed.reset_at;
      return {
        code: parsed.code,
        reason: typeof parsed.reason === 'string' ? parsed.reason.trim() : '',
        resetAt: typeof resetAt === 'string' ? resetAt.trim() : '',
        ...(typeof parsed.requestId === 'string' && parsed.requestId && parsed.scope === 'direct-child'
          ? { cancelRequestId: parsed.requestId, cancelScope: parsed.scope } : {}),
      };
    }
  } catch { /* the normal wrapper format is a plain integer */ }
  if (EXIT_CODE_RE.test(value)) return { code: parseInt(value, 10), reason: '', resetAt: '' };
  const marked = value.match(/^(-?\d+)\s+(quota(?:[_ -]?(?:exceeded|limit))?|rate[_ -]?limit(?:[_ -]?exceeded)?|usage[_ -]?limit(?:[_ -]?reached)?|resource[_ -]?exhausted|insufficient[_ -]?balance)\s*$/i);
  if (marked) return { code: Number(marked[1]), reason: marked[2], resetAt: '' };
  const lines = value.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (!lines.length || !EXIT_CODE_RE.test(lines[0]) || lines.length > 2) return null;
  if (lines.length === 1) return { code: parseInt(lines[0].trim(), 10), reason: '', resetAt: '' };
  try {
    const metadata = JSON.parse(lines[1]);
    if (metadata && typeof metadata === 'object' && typeof metadata.requestId === 'string' && metadata.requestId && metadata.scope === 'direct-child') {
      return { code: parseInt(lines[0].trim(), 10), reason: '', resetAt: '', cancelRequestId: metadata.requestId, cancelScope: metadata.scope };
    }
  } catch {}
  return null;
}

export function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

export function readText(file, max) {
  try { const text = fs.readFileSync(file, 'utf8'); return max ? text.slice(-max) : text; } catch { return ''; }
}

function lastLine(text) {
  const lines = String(text || '').trimEnd().split('\n');
  return lines.at(-1) || '';
}

function resetText(line) {
  const match = String(line || '').match(BOUNCE_TIME_RE);
  return match ? match[1].trim() : null;
}

function bounceFromExit(line, exitRecord) {
  const structured = Boolean(exitRecord && QUOTA_REASON_RE.test(exitRecord.reason || ''));
  if (!structured && !USAGE_RE.test(line)) return null;
  return { state: 'bounced', reason: 'usage limit', bounceUntil: resetText(line) || (exitRecord && exitRecord.resetAt) || null };
}

// editCounter tells a stream-json lane's tool transcript apart from a lane whose .out is itself prose.
export function workerState(basePath, now = Date.now(), { editCounter } = {}) {
  const outPath = `${basePath}.out`;
  const exitPath = `${basePath}.exit`;
  if (!fs.existsSync(outPath)) return { state: 'unknown', reason: 'no .out file' };
  const exitExists = fs.existsSync(exitPath);
  const exitRecord = exitExists ? parseExitRecord(readText(exitPath)) : null;
  const code = exitRecord ? exitRecord.code : null;
  // A malformed or half-written .exit is not terminal evidence: treat it exactly like no .exit at all —
  // still running, or stalled once .out itself has gone quiet for a long time.
  if (code === null) {
    if (now - mtime(outPath) > STALE_MS) return { state: 'stalled', reason: exitExists ? 'malformed .exit, .out stale >20m' : 'no .exit, .out stale >20m' };
    return { state: 'running' };
  }
  const outText = readText(outPath, 4000);
  if (code !== 0) {
    const bounce = bounceFromExit(lastLine(outText), exitRecord);
    const cancel = exitRecord?.cancelRequestId ? { cancelRequestId: exitRecord.cancelRequestId, cancelScope: exitRecord.cancelScope } : {};
    if (bounce) return { ...bounce, ...cancel };
    return { state: 'failed', reason: `exit ${code}`, ...cancel };
  }
  const report = readText(`${basePath}.md`).trim();
  // Exit 0 alone is not proof of a useful delivery, and a confirmed exit with nothing to show for it is
  // not a silent worker either — it already ended, so it must not keep its slot/file reservations the way
  // a genuinely stalled (still-running-or-unknown) worker does. But it must not be called failed while the
  // report could still be mid-copy either: give it EXIT_REPORT_GRACE_MS from .exit's own mtime first.
  const cancel = exitRecord?.cancelRequestId ? { cancelRequestId: exitRecord.cancelRequestId, cancelScope: exitRecord.cancelScope } : {};
  if (report) return { state: 'delivered', ...cancel };
  const withinGrace = now - mtime(exitPath) < EXIT_REPORT_GRACE_MS;
  if (fs.existsSync(`${basePath}.md`)) return withinGrace ? { state: 'running', ...cancel } : { state: 'failed', reason: 'exit 0 but .md report is empty', ...cancel };
  if (editCounter === 'stream-json') return withinGrace ? { state: 'running', ...cancel } : { state: 'failed', reason: 'exit 0 but output is a tool transcript, not a report', ...cancel };
  if (outText.trim()) return { state: 'delivered', reason: 'exit 0 (no .md)', ...cancel };
  return withinGrace ? { state: 'running', ...cancel } : { state: 'failed', reason: 'exit 0 but no output and no report', ...cancel };
}

export function countEdits(text, counter) {
  if (counter === 'stream-json') return (String(text || '').match(/"name":"(?:Edit|Write|MultiEdit)"/g) || []).length;
  if (counter === 'patch') return (text.match(/^apply patch/gm) || []).length + (text.match(/^\+\+\+/gm) || []).length;
  return 0;
}

export function bounceTimeMs(timeText, now = Date.now()) {
  const reference = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const full = String(timeText || '').trim();
  if (FULL_RESET_RE.test(full)) {
    const parsed = Date.parse(full);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const match = full.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  const date = new Date(reference);
  if (match[3]) {
    if (hour > 12 || hour === 0) return null;
    date.setHours((hour % 12) + (match[3].toUpperCase() === 'PM' ? 12 : 0), minute, 0, 0);
  } else {
    date.setHours(hour, minute, 0, 0);
  }
  // Time-only resets use the bounce's local calendar date; a reset already passed at the bounce rolls to
  // tomorrow, never to a same-day time that would expire immediately.
  if (date.getTime() <= reference) date.setDate(date.getDate() + 1);
  return date.getTime();
}

export function resetAt(timeText, reference = Date.now()) {
  const value = String(timeText || '').trim();
  if (FULL_RESET_RE.test(value)) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return bounceTimeMs(value, reference);
}

function identityResolver(options = {}) {
  if (typeof options.identityByName === 'function') return options.identityByName;
  if (typeof options.identityFor === 'function') return options.identityFor;
  if (options.identities instanceof Map) return (name) => options.identities.get(name) || null;
  return () => null;
}

function limitEntry(bounce) {
  const until = bounce.bounceUntil || null;
  const parsedReset = until ? resetAt(until, bounce.at) : null;
  return {
    since: new Date(bounce.at).toISOString(), until,
    at: new Date(bounce.at).toISOString(), resetsAt: parsedReset ? new Date(parsedReset).toISOString() : null,
    ...(bounce.adventurerId ? { adventurerId: bounce.adventurerId } : {}), name: bounce.name,
  };
}

// Keep the newest quota bounce for every verified card identity. Unknown evidence is retained separately as
// advisory data; it must never replace a card's evidence when an unrelated worker happens to be newer.
export function laneEvidence(outputDir, now = Date.now(), options = {}) {
  if (!fs.existsSync(outputDir)) return null;
  const resolveIdentity = identityResolver(options);
  const newestByIdentity = new Map();
  let newestUnknown = null;
  const successes = [];
  for (const file of fs.readdirSync(outputDir)) {
    if (!file.endsWith('.out')) continue;
    const outPath = path.join(outputDir, file);
    const outMtime = mtime(outPath);
    const exitPath = `${outPath.slice(0, -4)}.exit`;
    if (!fs.existsSync(exitPath)) continue;
    const exitRecord = parseExitRecord(readText(exitPath));
    if (!exitRecord) continue;
    const terminalAt = mtime(exitPath) || outMtime;
    const name = file.slice(0, -4);
    const adventurerId = resolveIdentity(name);
    if (exitRecord.code === 0) { successes.push({ at: terminalAt, adventurerId }); continue; }
    const bounce = bounceFromExit(lastLine(readText(outPath, 4000)), exitRecord);
    if (!bounce) continue;
    const evidence = { ...bounce, at: terminalAt, name, adventurerId: adventurerId || null };
    if (evidence.adventurerId) {
      const prior = newestByIdentity.get(evidence.adventurerId);
      if (!prior || evidence.at > prior.at) newestByIdentity.set(evidence.adventurerId, evidence);
    } else if (!newestUnknown || evidence.at > newestUnknown.at) newestUnknown = evidence;
  }
  const cards = {};
  for (const [adventurerId, bounce] of newestByIdentity) {
    const laterSameCard = successes.some((success) => success.adventurerId === adventurerId && success.at > bounce.at);
    if (!laterSameCard) cards[adventurerId] = limitEntry(bounce);
  }
  const unidentified = newestUnknown ? [limitEntry(newestUnknown)] : [];
  return Object.keys(cards).length || unidentified.length ? { cards, unidentified } : null;
}

function active(entry, now) {
  const reset = Date.parse(entry.resetsAt || '');
  return !Number.isFinite(reset) || reset > now;
}

// The lane-wide chip is allowed to see only active, identified card evidence. Expired card entries and
// unidentified evidence are intentionally not copied here; callers that need diagnostics use laneEvidence.
export function laneLimit(outputDir, now = Date.now(), options = {}) {
  const evidence = laneEvidence(outputDir, now, options);
  if (!evidence) return null;
  const cards = Object.fromEntries(Object.entries(evidence.cards).filter(([, entry]) => active(entry, now)));
  if (!Object.keys(cards).length) return null;
  const newest = Object.values(cards).reduce((prior, entry) => (!prior || entry.at > prior.at ? entry : prior), null);
  return { ...newest, cards };
}
