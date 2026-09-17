// Reads briefs: the file set a brief allows (the section under config.briefs.fileListHeading), its title
// line, which briefs are ready to post (discoverBriefs), and per-quest file conflicts (withFileSets).
//
// Fail-closed contract: a brief this module cannot fully read (too large, a read error, outside the
// project) must never quietly turn into an empty, "no files" result for anything that matters for dispatch
// safety. withFileSets marks such a brief `unknown`, and — while it belongs to a quest currently holding a
// dispatch slot (dispatched/stalled) — makes every other quest's file set conflict with it, so rules.js's
// ordinary file-overlap check (never modified by this module) refuses any dispatch that might collide with
// it instead of silently allowing it through an empty file list.
import fs from 'node:fs';
import path from 'node:path';
import { packageFromFileName } from './patterns.js';
import { realpathContainmentIssue } from './config.js';
import { holdsSlot } from './rules.js';

const HEADING = /^#{1,6}\s/;
const PATH_TOKEN = /`([^`\s]+\/[^`\s]*|[^`\s/]+\.(?:cs|md|js|mjs|cjs|ts|tsx|json|asset|shader|uss|uxml|lua|sh|html|gd|tscn|py|rs))`/g;
const DAY_MS = 24 * 60 * 60 * 1000;

// Never read a brief past this many bytes: a scan or a dispatch check must stay fast and bounded even if
// something enormous lands in a briefs folder. Documented unit, not configurable — nothing here has ever
// needed a brief anywhere near this size.
export const MAX_BRIEF_BYTES = 2 * 1024 * 1024;
// Never keep more than this many *.md candidates per configured folder, applied after a deterministic sort
// (never raw directory order), so which files "win" when a folder has too many is always the same answer.
export const MAX_SCAN_ENTRIES = 2000;
// A hard safety cap on raw directory entries examined per folder, independent of MAX_SCAN_ENTRIES: without
// this, a folder holding far more than MAX_SCAN_ENTRIES non-.md files would still make every scan walk the
// whole thing before the .md-only cap ever applies.
const MAX_DIR_ITERATE = 50000;
// Cap on how many excluded/diagnostic rows one discovery call returns over the wire. The full accounting
// still happens — excludedTotal and byKind below are computed from every exclusion, never just this slice —
// this only bounds the response body on every snapshot poll.
export const MAX_EXCLUDED = 300;
// Bounds on the readBrief cache (used by fileSetFor/briefStatus for actual quest briefs, never by the
// discovery scan below — see peekTitle). Both an entry count and a total-bytes cap, so neither "many small
// briefs" nor "a few large ones" can grow the cache without limit; oldest-touched entries are evicted first.
const MAX_CACHE_ENTRIES = 500;
const MAX_CACHE_BYTES = 20 * 1024 * 1024;
// A title only ever needs the first non-blank line; reading (and, worse, caching) an entire 2MB body just to
// show a title would waste both. Comfortably larger than any real title-bearing preamble.
const TITLE_PEEK_BYTES = 4096;

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

function oversizedMessage(size) {
  return `文件过大（${(size / 1024 / 1024).toFixed(1)}MB，上限 ${MAX_BRIEF_BYTES / 1024 / 1024}MB）`;
}

function unreadableMessage(err) {
  return `文件读取失败（${(err && (err.code || err.message)) || '未知错误'}）`;
}

// Reads just enough of a file to get its title line, without ever populating the shared fileSetFor cache —
// a discovery scan may look at thousands of candidates, most of which will never be posted, and none of
// which need their full file-list parsed; caching their full bodies for that would be exactly the unbounded
// memory growth requirement 6 exists to prevent. Returns { title } on success or { error } on failure —
// never throws, and never reads past TITLE_PEEK_BYTES.
function peekTitle(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    return { error: unreadableMessage(err) };
  }
  try {
    const buf = Buffer.alloc(TITLE_PEEK_BYTES);
    const bytesRead = fs.readSync(fd, buf, 0, TITLE_PEEK_BYTES, 0);
    return { title: titleLine(buf.toString('utf8', 0, bytesRead)) };
  } catch (err) {
    return { error: unreadableMessage(err) };
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed by the failure above */ }
  }
}

// Bounded LRU cache for fileSetFor/briefStatus: file -> { mtimeMs, size, text } | { mtimeMs, size, error }.
// A Map's iteration order is insertion order, so re-inserting an entry on every hit turns "iterate from the
// front" into "oldest touched first" for eviction, without a separate structure.
const cache = new Map();
let cacheBytes = 0;

function memBytes(entry) {
  return entry.text ? Buffer.byteLength(entry.text) : 0;
}

function cacheGet(file) {
  const hit = cache.get(file);
  if (!hit) return undefined;
  cache.delete(file);
  cache.set(file, hit);
  return hit;
}

function cacheDelete(file) {
  const previous = cache.get(file);
  if (!previous) return;
  cacheBytes -= memBytes(previous);
  cache.delete(file);
}

function cacheSet(file, entry) {
  cacheDelete(file);
  cache.set(file, entry);
  cacheBytes += memBytes(entry);
  while ((cache.size > MAX_CACHE_ENTRIES || cacheBytes > MAX_CACHE_BYTES) && cache.size > 1) {
    const oldestKey = cache.keys().next().value;
    cacheDelete(oldestKey);
  }
}

// Cache contract: an entry is valid only while both mtimeMs and size still match the file on disk. mtimeMs
// alone is not enough on filesystems with coarse (one-second) mtime resolution — an edit landing in the same
// tick as the previous one would otherwise keep serving stale content. A file that no longer exists (or
// whose stat itself fails) has any previous cache entry for it evicted immediately, not left to expire on
// its own — nothing else would ever prune it, since a deleted file is never looked at again by a scan.
function readBrief(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    cacheDelete(file);
    return null;
  }
  const hit = cacheGet(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit;
  if (stat.size > MAX_BRIEF_BYTES) {
    const entry = { mtimeMs: stat.mtimeMs, size: stat.size, error: oversizedMessage(stat.size), oversized: true };
    cacheSet(file, entry);
    return entry;
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // Not cached: a read failure (EBUSY, a permission hiccup) may well be transient, and caching it by
    // mtimeMs would keep reporting it as unreadable forever even after whatever locked the file lets go.
    return { mtimeMs: stat.mtimeMs, size: stat.size, error: unreadableMessage(err) };
  }
  const entry = { mtimeMs: stat.mtimeMs, size: stat.size, text };
  cacheSet(file, entry);
  return entry;
}

// The one place that decides whether a specific brief's content can be trusted at all: readable, within
// size, and still (freshly re-checked, not just at post time) inside the project root. `unknown: true` means
// exactly what it says — this call could not establish what files, if any, the brief allows — and must never
// be treated the same as "reads fine and lists no files".
function fileStatusFor(config, brief) {
  if (!brief) return { unknown: false, files: [] };
  const absolute = path.join(config.root, brief);
  const containment = realpathContainmentIssue(config.root, absolute);
  if (containment) return { unknown: true, files: [], reason: containment, kind: 'unusable' };
  const entry = readBrief(absolute);
  if (!entry) return { unknown: true, files: [], reason: '文件不存在或状态不可读', kind: 'missing' };
  if (entry.error) return { unknown: true, files: [], reason: entry.error, kind: 'unusable' };
  return { unknown: false, files: parseFileSet(entry.text, config.briefs.fileListHeading) };
}

// True only when this brief can actually be read and trusted right now — never just "the path exists".
// Used by snapshot.js's briefExists (which feeds rules.js's brief_missing reason) so an oversized, unreadable
// or newly-outside-root brief blocks dispatch the same way a missing one always has.
export function briefUsable(config, brief) {
  return !fileStatusFor(config, brief).unknown;
}

// Distinguishes "no usable brief because there never was one to trust" (a missing path — brief_missing,
// unchanged) from "a brief is physically there but cannot be trusted right now" (too large, a read error, or
// outside the project — brief_unusable, which names the file and the actual cause instead of claiming it is
// missing). null for a usable brief or a genuinely missing one; only non-null when the file is present but
// unusable, since only that case has a real cause worth surfacing separately from "missing".
export function briefUnusableInfo(config, brief) {
  if (!brief) return null;
  const status = fileStatusFor(config, brief);
  return status.unknown && status.kind === 'unusable' ? { reason: status.reason } : null;
}

export function fileSetFor(config, brief) {
  return fileStatusFor(config, brief).files;
}

// A key that stands in for "this quest's real files are unknown" inside the plain set-overlap check
// rules.js does (runningConflict, which reads a quest's conflictKeys alongside its files — never mixed into
// the public files list itself, see conflictKeys below). Deterministic in its questId, so every quest that
// gets this key for the same held quest gets the exact same string, and the overlap check finds it like any
// other shared token. The leading control character can never appear in a real extracted file (PATH_TOKEN
// above only ever keeps a token containing "/" or ending in a known code-file extension), so a real conflict
// is never masked by this one, and — unlike embedding the human-readable reason in the token itself — it
// never needs to leak into anything public; the reason lives on the held quest's own briefUnknownReason.
function unknownConflictKey(questId) {
  return `\u0000unknown-brief\u0000${questId}`;
}

// quests, each annotated with .files (real, public file list only — never a token) and, only when relevant,
// .conflictKeys (an internal-only array rules.js's runningConflict reads alongside files) and
// .briefUnknownReason (the human reason, for the message conflictKeys' match resolves to). A brief this
// module cannot trust is never silently `[]`: while it belongs to a quest currently holding a dispatch slot
// (dispatched/stalled — see rules.js holdsSlot, not duplicated here) — except a review, which holds no files
// and so never receives or contributes a conflict key, real or hypothetical alike (reviewRequest.js's
// hypotheticalReview is judged by the same rules this produces, since neither ever carries one) — every
// quest that could be dispatched now (anything not itself holding a slot, or the one attempt whose own
// queued recheck this call is for — see recheckingId) has that held quest's key added to its own
// conflictKeys too, so rules.js's overlap check refuses the dispatch as a conflict against that quest by
// name — conservative by design: we do not know whether the two briefs' real file lists actually overlap,
// so we do not allow the dispatch to assume they do not. A held quest with fully-known files is never given
// another held quest's key, so an unrelated, healthy dispatched quest is never blamed for a conflict it has
// nothing to do with.
//
// recheckingId: the id of the one quest, if any, whose own queued recheck this call is computing fresh
// eligibility for (dispatcher.js's recheckOpen). That quest already holds its slot (store.assign ran before
// it was enqueued), but for the purpose of receiving *other* held quests' conflict keys it must still be
// judged as the fresh candidate it actually is — not as an already-settled occupant that only ever gets its
// own key back. Every other held quest is completely unaffected by this id.
export function withFileSets(config, quests, { recheckingId } = {}) {
  const resolved = quests.map((quest) => ({ quest, status: fileStatusFor(config, quest.brief) }));
  const unknownHeld = resolved.filter(({ quest, status }) => status.unknown && holdsSlot(quest) && quest.kind !== 'review');
  return resolved.map(({ quest, status }) => {
    const base = { ...quest, files: status.files };
    if (status.unknown) base.briefUnknownReason = status.reason;
    if (quest.kind === 'review' || !unknownHeld.length) return base;
    const isHeld = holdsSlot(quest) && quest.id !== recheckingId;
    const keys = unknownHeld
      .filter(({ quest: other }) => other.id === quest.id || !isHeld)
      .map(({ quest: other }) => unknownConflictKey(other.id));
    return keys.length ? { ...base, conflictKeys: keys } : base;
  });
}

// Canonical form of a configured folder: forward slashes, "." and ".." segments and duplicate slashes
// collapsed, no trailing slash, case-folded on a case-insensitive filesystem (Windows). Two config entries
// that normalize the same way are the same folder and must be scanned once, not several times with the
// same files reported under whichever spelling happens to be listed — the first spelling seen is kept for
// display.
function canonicalFolderKey(dir) {
  let posix = path.posix.normalize(String(dir).replaceAll('\\', '/')).replace(/\/+$/, '');
  if (posix === '' || posix === '.') posix = '.';
  return process.platform === 'win32' ? posix.toLowerCase() : posix;
}

function displayFolder(dir) {
  const posix = path.posix.normalize(String(dir).replaceAll('\\', '/')).replace(/\/+$/, '');
  return posix === '' ? '.' : posix;
}

function normalizedFolders(dirs) {
  const seen = new Map();
  for (const dir of dirs) {
    const key = canonicalFolderKey(dir);
    if (!seen.has(key)) seen.set(key, displayFolder(dir));
  }
  return [...seen.values()];
}

// One configured folder's *.md file names, top level only (dispatchDirs is never walked recursively —
// briefPathAllowed in patterns.js only ever allows a brief directly inside a configured folder, so a nested
// file could be discovered but never posted; better to not discover it than to show something permanently
// undispatchable). A symlink is never followed, file or directory, so a link planted inside a configured
// folder cannot surface a file from outside it.
//
// Reads the whole raw listing in one call (name plus type, no per-entry stat) and sorts it by name before
// classifying anything, so which entries fall inside MAX_DIR_ITERATE — and therefore which .md files are even
// candidates for the MAX_SCAN_ENTRIES cap — is always the same alphabetically-first slice of the directory,
// never an accident of whatever order the filesystem happens to hand back raw entries in. Only the names are
// kept and sorted: the caps bound what is kept (the returned slice), not what is read, because a stable
// slice needs every name — a sort cannot finish before the last entry arrives, and the streaming version that
// stopped early could not promise the same first slice. The single read call is wrapped: a mid-read failure
// (EIO, a permission change) reports as this one folder's diagnostic (discoverBriefs then moves on to the
// next configured folder) instead of throwing past a caller that has no per-folder boundary to catch it at,
// which would fail every folder's discovery for one folder's fault.
function scanDirectory(directory) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (err) {
    return { files: [], skippedLinks: [], error: err.code === 'ENOENT' ? '目录不存在' : `目录不可读（${err.code || err.message}）`, seen: 0, mdSeen: 0, returned: 0, truncated: false, iterationCapped: false };
  }
  // Project the dirents down to what matters right away: each name is classified once into this lookup and
  // dropped, so the sorted array and everything held afterwards is plain strings, not objects.
  const kindOf = new Map();
  for (const entry of entries) {
    if (entry.isSymbolicLink()) kindOf.set(entry.name, 'link');
    else if (entry.isFile() && entry.name.endsWith('.md')) kindOf.set(entry.name, 'md');
  }
  const names = entries.map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
  const mdFiles = [];
  const skippedLinks = [];
  let seen = 0;
  let iterationCapped = false;
  for (const name of names) {
    seen += 1;
    if (seen > MAX_DIR_ITERATE) { iterationCapped = true; break; }
    const kind = kindOf.get(name);
    if (kind === 'link') skippedLinks.push(name);
    else if (kind === 'md') mdFiles.push(name);
  }
  const mdSeen = mdFiles.length;
  const files = mdFiles.slice(0, MAX_SCAN_ENTRIES);
  return {
    files, skippedLinks, error: null, seen, mdSeen, returned: files.length,
    truncated: mdSeen > MAX_SCAN_ENTRIES || iterationCapped, iterationCapped,
  };
}

// The full picture behind "brief discovery": which briefs are ready to post (items), and, honestly, every
// file that was looked at and skipped, with why (excluded), plus which configured folders could not be
// scanned at all (errors) — so an empty items list reads as "nothing new" and never as "discovery is broken"
// or "folder is empty" when it is really missing or misconfigured.
//
// Dedup precedes read classification: every physical file for the same package id, across every folder, is
// collected first (candidates), and only the single newest-by-mtime copy (primary) is ever classified as
// ready/old/posted/dispatched — the newest copy governs even when it is the one that turns out to be
// oversized or unreadable, so a stale but readable older copy is never presented as ready just because a
// newer, broken copy loses a read attempt. Every other copy is reported as `duplicate`, pointing at primary.
export function discoverBriefs(config, { postedIds, dispatchedIds, now = Date.now() }) {
  const dirs = normalizedFolders(config.briefs.dispatchDirs);
  const excluded = [];
  const errors = [];
  let truncated = false;
  const candidates = new Map();

  for (const dir of dirs) {
    const directory = path.join(config.root, dir);
    // Realpath containment needs something to realpath; scanDirectory's own ENOENT below already covers a
    // folder that plain does not exist. This only ever fires for a folder that exists but resolves outside
    // the project (a symlink or junction) — resolveConfig already refuses a lexically escaping dispatchDirs
    // entry, so this is the "legacy diagnostic" for the one escape it cannot see: one only visible on disk.
    const realpathIssue = realpathContainmentIssue(config.root, directory);
    if (realpathIssue) { errors.push({ folder: dir, reason: realpathIssue }); continue; }

    const scan = scanDirectory(directory);
    if (scan.error) { errors.push({ folder: dir, reason: scan.error }); continue; }
    if (scan.truncated) {
      truncated = true;
      const reason = scan.iterationCapped
        ? `目录里的条目超过扫描上限 ${MAX_DIR_ITERATE} 个，已停止扫描：看到 .md 文件 ${scan.mdSeen} 个，列出了 ${scan.returned} 个；剩下还有多少不知道`
        : `发现 ${scan.mdSeen} 个 .md 文件，超过上限 ${MAX_SCAN_ENTRIES}，仅返回按文件名排序的前 ${scan.returned} 个`;
      errors.push({ folder: dir, reason });
    }
    for (const link of scan.skippedLinks) {
      excluded.push({ brief: `${dir}/${link}`, reason: '这是链接，跳过了，没有跟进去', kind: 'symlink' });
    }
    for (const name of scan.files) {
      const brief = `${dir}/${name}`;
      const id = packageFromFileName(config, name);
      if (!id) { excluded.push({ brief, reason: '文件名不像委托编号', kind: 'badId' }); continue; }
      const full = path.join(directory, name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch (err) {
        excluded.push({ package: id, brief, reason: unreadableMessage(err), kind: 'unreadable' });
        continue;
      }
      const candidate = { brief, mtimeMs: stat.mtimeMs };
      if (stat.size > MAX_BRIEF_BYTES) {
        candidate.error = oversizedMessage(stat.size);
        candidate.kind = 'oversized';
      } else {
        const peek = peekTitle(full);
        if (peek.error) { candidate.error = peek.error; candidate.kind = 'unreadable'; } else { candidate.title = peek.title; }
      }
      const list = candidates.get(id);
      if (list) list.push(candidate); else candidates.set(id, [candidate]);
    }
  }

  const items = [];
  for (const [id, list] of candidates) {
    list.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const [primary, ...superseded] = list;
    for (const dup of superseded) {
      excluded.push({
        package: id,
        brief: dup.brief,
        ...(dup.error ? {} : { title: dup.title, writtenAt: new Date(dup.mtimeMs).toISOString() }),
        reason: `已被同编号的更新副本取代：${primary.brief}`,
        kind: 'duplicate',
      });
    }
    if (primary.error) { excluded.push({ package: id, brief: primary.brief, reason: primary.error, kind: primary.kind }); continue; }
    if (postedIds.has(id)) { excluded.push({ package: id, brief: primary.brief, reason: '已经发布过', kind: 'posted' }); continue; }
    const writtenAt = new Date(primary.mtimeMs).toISOString();
    if (dispatchedIds.has(id)) {
      excluded.push({ package: id, brief: primary.brief, title: primary.title, writtenAt, reason: '已经在别处登记过派遣', kind: 'dispatched' });
      continue;
    }
    if (now - primary.mtimeMs > config.briefs.recentDays * DAY_MS) {
      excluded.push({ package: id, brief: primary.brief, title: primary.title, writtenAt, reason: `超出最近 ${config.briefs.recentDays} 天的窗口`, kind: 'old' });
      continue;
    }
    items.push({ mtimeMs: primary.mtimeMs, package: id, brief: primary.brief, title: primary.title, writtenAt });
  }
  items.sort((a, b) => b.mtimeMs - a.mtimeMs);

  // Counted from every exclusion before MAX_EXCLUDED truncates what is actually sent, so a folder with more
  // than 300 skipped files never reads as "nothing was old/dispatched/duplicate" just because none of those
  // rows happened to survive the cap.
  const byKind = {};
  for (const row of excluded) byKind[row.kind] = (byKind[row.kind] || 0) + 1;
  const excludedTotal = excluded.length;

  // The shelf's reveal checkboxes (old/dispatched) only ever work on rows that actually survive MAX_EXCLUDED,
  // regardless of byKind's truthful (uncapped) counts above. A folder with hundreds of badId/unreadable/
  // duplicate rows must never crowd the handful of old/dispatched ones out of the capped slice — so those
  // "soft", revealable rows go first, and every "hard" diagnostic row fills whatever room is left.
  const REVEALABLE_KINDS = new Set(['old', 'dispatched']);
  const revealable = excluded.filter((row) => REVEALABLE_KINDS.has(row.kind));
  const hardDiagnostics = excluded.filter((row) => !REVEALABLE_KINDS.has(row.kind));

  return {
    items: items.map(({ mtimeMs, ...rest }) => rest),
    excluded: [...revealable, ...hardDiagnostics].slice(0, MAX_EXCLUDED),
    excludedTotal,
    excludedTruncated: excludedTotal > MAX_EXCLUDED,
    byKind,
    errors,
    truncated,
    scannedAt: new Date(now).toISOString(),
    folders: dirs,
    recentDays: config.briefs.recentDays,
  };
}

export function unpostedBriefs(config, opts) {
  return discoverBriefs(config, opts).items;
}
