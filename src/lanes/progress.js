// Verification strip: the newest progress.txt (lines "<step> exit <code>", "<step> errorCS <n>", "DONE")
// among the configured directories, plus NUnit edit.xml / play.xml totals beside it.
import fs from 'node:fs';
import path from 'node:path';
import { mtime, readText } from './workers.js';

export function parseProgress(text) {
  const steps = [];
  for (const line of String(text || '').trim().split('\n')) {
    const match = line.match(/^(\S+)\s+(exit|errorCS)\s*(.*)/);
    if (match) steps.push({ name: match[1], kind: match[2], value: match[3] });
    else if (line.trim() === 'DONE') steps.push({ name: 'DONE', kind: 'done', value: '' });
  }
  return { steps, done: steps.some((s) => s.kind === 'done') };
}

export function parseNUnit(file) {
  try {
    const match = fs.readFileSync(file, 'utf8').match(/<test-run[^>]*\btotal="(\d+)"[^>]*\bpassed="(\d+)"[^>]*\bfailed="(\d+)"/);
    if (match) return { total: Number(match[1]), passed: Number(match[2]), failed: Number(match[3]) };
  } catch { /* no results yet */ }
  return null;
}

export function latestProgress(dirs) {
  let best = null;
  for (const dir of dirs || []) {
    const file = path.join(dir, 'progress.txt');
    const ms = mtime(file);
    if (!ms || (best && ms <= best.mtime)) continue;
    best = { dir, mtime: ms, ...parseProgress(readText(file)), editXml: parseNUnit(path.join(dir, 'edit.xml')), playXml: parseNUnit(path.join(dir, 'play.xml')) };
  }
  return best;
}
