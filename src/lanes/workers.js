// File-based workers: a lane script writes <outputDir>/<name>.out while running, <name>.exit when done,
// and optionally <name>.md as the final report.
import fs from 'node:fs';
import path from 'node:path';

export const STALE_MS = 20 * 60 * 1000;
export const BOUNCE_MAX_AGE_MS = 5 * 60 * 60 * 1000;
export const USAGE_RE = /(?:resource_exhausted|usage.limit|you've hit your usage limit|try again at|insufficient.balance|\b402\b)/i;
const BOUNCE_TIME_RE = /try again at\s+(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i;
// A wrapper writes .exit with `echo $? > f` (truncates first, so a poll can catch it empty) or
// fs.writeFileSync (which creates the file before any bytes land) — either leaves a moment where .exit
// exists but holds no real exit code. Only this shape is ever a terminal fact.
const EXIT_CODE_RE = /^\s*-?\d+\s*$/;
// The generic wrapper (examples/basic/scripts/run-worker.mjs) writes .exit, then copies the report — a
// poll landing in that gap must not call a successful worker terminally failed. Only once .exit has sat
// this long with still no usable report does "no report" become a fact instead of a race.
export const EXIT_REPORT_GRACE_MS = 30 * 1000;

function parseExitCode(text) {
  return EXIT_CODE_RE.test(text) ? parseInt(text.trim(), 10) : null;
}

export function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

export function readText(file, max) {
  try { const text = fs.readFileSync(file, 'utf8'); return max ? text.slice(-max) : text; } catch { return ''; }
}

// A bounce is a structured terminal fact, never a live guess: the wrapper's own exit code must be
// nonzero, and only then is the last line of its output checked for quota wording. Without an .exit file
// the worker might still be running — its output could just be quoting those words (a file it read, a
// tool result, code it wrote, this project's own quota-detection strings) and more output may follow, so
// no amount of substring matching on a live transcript is ever authoritative. Only staleness (no new
// output for a long time), never content, can call a still-running worker anything but running.
function lastLine(text) {
  const lines = String(text || '').trimEnd().split('\n');
  return lines.at(-1) || '';
}

function bounceFromExit(line) {
  if (!USAGE_RE.test(line)) return null;
  const match = line.match(BOUNCE_TIME_RE);
  return { state: 'bounced', reason: 'usage limit', bounceUntil: match ? match[1] : null };
}

// editCounter tells a stream-json lane's tool transcript apart from a lane whose .out is itself prose
// (codex prints its own summary to stdout with no separate report file) — the same signal countEdits uses.
export function workerState(basePath, now = Date.now(), { editCounter } = {}) {
  const outPath = `${basePath}.out`;
  const exitPath = `${basePath}.exit`;
  if (!fs.existsSync(outPath)) return { state: 'unknown', reason: 'no .out file' };
  const exitExists = fs.existsSync(exitPath);
  const code = exitExists ? parseExitCode(readText(exitPath)) : null;
  // A malformed or half-written .exit is not terminal evidence: treat it exactly like no .exit at all —
  // still running, or stalled once .out itself has gone quiet for a long time.
  if (code === null) {
    if (now - mtime(outPath) > STALE_MS) return { state: 'stalled', reason: exitExists ? 'malformed .exit, .out stale >20m' : 'no .exit, .out stale >20m' };
    return { state: 'running' };
  }
  const outText = readText(outPath, 4000);
  if (code !== 0) {
    const bounce = bounceFromExit(lastLine(outText));
    if (bounce) return bounce;
    return { state: 'failed', reason: `exit ${code}` };
  }
  const report = readText(`${basePath}.md`).trim();
  if (report) return { state: 'delivered' };
  // Exit 0 alone is not proof of a useful delivery, and a confirmed exit with nothing to show for it is
  // not a silent worker either — it already ended, so it must not keep its slot/file reservations the way
  // a genuinely stalled (still-running-or-unknown) worker does. But it must not be called failed while the
  // report could still be mid-copy either: give it EXIT_REPORT_GRACE_MS from .exit's own mtime first.
  const withinGrace = now - mtime(exitPath) < EXIT_REPORT_GRACE_MS;
  if (fs.existsSync(`${basePath}.md`)) return withinGrace ? { state: 'running' } : { state: 'failed', reason: 'exit 0 but .md report is empty' };
  if (editCounter === 'stream-json') return withinGrace ? { state: 'running' } : { state: 'failed', reason: 'exit 0 but output is a tool transcript, not a report' };
  if (outText.trim()) return { state: 'delivered', reason: 'exit 0 (no .md)' };
  return withinGrace ? { state: 'running' } : { state: 'failed', reason: 'exit 0 but no output and no report' };
}

export function countEdits(text, counter) {
  if (counter === 'stream-json') return (String(text || '').match(/"name":"(?:Edit|Write|MultiEdit)"/g) || []).length;
  if (counter === 'patch') return (text.match(/^apply patch/gm) || []).length + (text.match(/^\+\+\+/gm) || []).length;
  return 0;
}

export function bounceTimeMs(timeText, now) {
  const match = timeText && timeText.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  const date = new Date(now);
  if (match[3]) {
    if (hour > 12 || hour === 0) return null;
    date.setHours((hour % 12) + (match[3].toUpperCase() === 'PM' ? 12 : 0), minute, 0, 0);
  } else {
    date.setHours(hour, minute, 0, 0);
  }
  return date.getTime();
}

// The newest usage-limit bounce in a lane's output directory, unless a later run succeeded, it is older
// than five hours, or its "try again at" time has passed. Null means the lane is not limited. Only a
// worker that has actually exited nonzero counts as a bounce signal — a still-running worker's output is
// never authoritative evidence, exactly like workerState, so one live worker quoting the words can never
// grey out every other card on the same lane.
export function laneLimit(outputDir, now = Date.now()) {
  if (!fs.existsSync(outputDir)) return null;
  let newestBounce = null;
  let newestSuccess = 0;
  for (const file of fs.readdirSync(outputDir)) {
    if (!file.endsWith('.out')) continue;
    const outPath = path.join(outputDir, file);
    const outMtime = mtime(outPath);
    const exitPath = `${outPath.slice(0, -4)}.exit`;
    if (!fs.existsSync(exitPath)) continue;
    const code = parseExitCode(readText(exitPath));
    if (code === null) continue;
    if (code === 0) { newestSuccess = Math.max(newestSuccess, outMtime); continue; }
    const line = lastLine(readText(outPath, 4000));
    if (USAGE_RE.test(line) && (!newestBounce || outMtime > newestBounce.mtime)) newestBounce = { mtime: outMtime, text: line };
  }
  if (!newestBounce || now - newestBounce.mtime >= BOUNCE_MAX_AGE_MS || newestSuccess > newestBounce.mtime) return null;
  const match = newestBounce.text.match(BOUNCE_TIME_RE);
  const until = match ? match[1] : null;
  if (until && bounceTimeMs(until, now) <= now) return null;
  return { since: new Date(newestBounce.mtime).toISOString(), until };
}
