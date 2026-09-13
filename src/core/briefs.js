// Reads briefs: the file set a brief allows (the section under config.briefs.fileListHeading), its title
// line, and the recent briefs that nobody has posted or dispatched yet.
import fs from 'node:fs';
import path from 'node:path';
import { packageFromFileName } from './patterns.js';

const HEADING = /^#{1,6}\s/;
const PATH_TOKEN = /`([^`\s]+\/[^`\s]*|[^`\s/]+\.(?:cs|md|js|mjs|cjs|ts|tsx|json|asset|shader|uss|uxml|lua|sh|html|gd|tscn|py|rs))`/g;
const DAY_MS = 24 * 60 * 60 * 1000;

const cache = new Map();

export function parseFileSet(markdown, heading) {
  const files = new Set();
  let inside = false;
  for (const line of String(markdown || '').split(/\r?\n/)) {
    if (HEADING.test(line)) { inside = heading.test(line); continue; }
    if (!inside) continue;
    for (const match of line.matchAll(PATH_TOKEN)) {
      const token = match[1].replaceAll('\\', '/');
      // A bare directory ("Assets/Tests/EditMode/" for new tests) is shared by nearly every brief; counting it
      // as a conflict would queue unrelated work. Files and file patterns count.
      if (!token.endsWith('/')) files.add(token);
    }
  }
  return [...files];
}

export function titleLine(markdown) {
  const first = String(markdown || '').split(/\r?\n/).find((line) => line.trim()) || '';
  return first.replace(/^#+\s*/, '').trim().slice(0, 160);
}

function readBrief(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit;
  const entry = { mtimeMs: stat.mtimeMs, text: fs.readFileSync(file, 'utf8') };
  cache.set(file, entry);
  return entry;
}

export function fileSetFor(config, brief) {
  const entry = brief ? readBrief(path.join(config.root, brief)) : null;
  return entry ? parseFileSet(entry.text, config.briefs.fileListHeading) : [];
}

export function withFileSets(config, quests) {
  return quests.map((quest) => ({ ...quest, files: fileSetFor(config, quest.brief) }));
}

export function unpostedBriefs(config, { postedIds, dispatchedIds, now = Date.now() }) {
  const latest = new Map();
  const dirs = [...new Set(config.briefs.dispatchDirs)];
  for (const dir of dirs) {
    const directory = path.join(config.root, dir);
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory)) {
      if (!name.endsWith('.md')) continue;
      const id = packageFromFileName(config, name);
      if (!id || postedIds.has(id) || dispatchedIds.has(id)) continue;
      const brief = `${dir.replaceAll('\\', '/')}/${name}`;
      const entry = readBrief(path.join(directory, name));
      if (!entry || now - entry.mtimeMs > config.briefs.recentDays * DAY_MS) continue;
      const previous = latest.get(id);
      if (previous && previous.mtimeMs >= entry.mtimeMs) continue;
      latest.set(id, { mtimeMs: entry.mtimeMs, package: id, brief, title: titleLine(entry.text) });
    }
  }
  return [...latest.values()]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map(({ mtimeMs, ...rest }) => ({ ...rest, writtenAt: new Date(mtimeMs).toISOString() }));
}
