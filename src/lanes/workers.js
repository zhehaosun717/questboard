// File-based workers: a lane script writes <outputDir>/<name>.out while running, <name>.exit when done,
// and optionally <name>.md as the final report.
import fs from 'node:fs';
import path from 'node:path';

export const STALE_MS = 20 * 60 * 1000;
export const BOUNCE_MAX_AGE_MS = 5 * 60 * 60 * 1000;
export const USAGE_RE = /(?:resource_exhausted|usage.limit|you've hit your usage limit|try again at|insufficient.balance|\b402\b)/i;
const BOUNCE_TIME_RE = /try again at\s+(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i;

export function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

export function readText(file, max) {
  try { const text = fs.readFileSync(file, 'utf8'); return max ? text.slice(-max) : text; } catch { return ''; }
}

export function workerState(basePath, now = Date.now()) {
  const outPath = `${basePath}.out`;
  const exitPath = `${basePath}.exit`;
  if (!fs.existsSync(outPath)) return { state: 'unknown', reason: 'no .out file' };
  const outText = readText(outPath, 4000);
  const ms = mtime(outPath);
  if (!fs.existsSync(exitPath)) {
    if (USAGE_RE.test(outText)) {
      if (now - ms >= BOUNCE_MAX_AGE_MS) return { state: 'superseded', reason: `bounced ${new Date(ms).toISOString()}, never resumed` };
      const match = outText.match(BOUNCE_TIME_RE);
      return { state: 'bounced', reason: 'usage limit', bounceUntil: match ? match[1] : null };
    }
    if (now - ms > STALE_MS) return { state: 'stalled', reason: 'no .exit, .out stale >20m' };
    return { state: 'running' };
  }
  const code = parseInt(readText(exitPath).trim(), 10);
  if (code !== 0) return { state: 'failed', reason: `exit ${code}` };
  if (fs.existsSync(`${basePath}.md`) || outText.length > 200) return { state: 'delivered' };
  return { state: 'delivered', reason: 'exit 0 (no .md)' };
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
// than five hours, or its "try again at" time has passed. Null means the lane is not limited.
export function laneLimit(outputDir, now = Date.now()) {
  if (!fs.existsSync(outputDir)) return null;
  let newestBounce = null;
  let newestSuccess = 0;
  for (const file of fs.readdirSync(outputDir)) {
    if (!file.endsWith('.out')) continue;
    const outPath = path.join(outputDir, file);
    const outMtime = mtime(outPath);
    const text = readText(outPath, 4000);
    const exitPath = `${outPath.slice(0, -4)}.exit`;
    if (fs.existsSync(exitPath) && parseInt(readText(exitPath).trim(), 10) === 0) newestSuccess = Math.max(newestSuccess, outMtime);
    if (USAGE_RE.test(text) && (!newestBounce || outMtime > newestBounce.mtime)) newestBounce = { mtime: outMtime, text };
  }
  if (!newestBounce || now - newestBounce.mtime >= BOUNCE_MAX_AGE_MS || newestSuccess > newestBounce.mtime) return null;
  const match = newestBounce.text.match(BOUNCE_TIME_RE);
  const until = match ? match[1] : null;
  if (until && bounceTimeMs(until, now) <= now) return null;
  return { since: new Date(newestBounce.mtime).toISOString(), until };
}
