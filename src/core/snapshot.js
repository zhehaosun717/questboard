// Builds the one payload the board renders: quests, cards with effective statuses, who may take what and
// why not, live worker output, message-board threads per package, review pages with annotation progress,
// the verification strip, lane limits, and recent briefs nobody posted yet.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { eligibility } from './rules.js';
import { liveByName } from './sync.js';
import { effectiveRoster, visibleLaneLimits } from './overlay.js';
import { withFileSets, discoverBriefs, briefUsable, briefUnusableInfo } from './briefs.js';
import { isReviewable, reviewEligibility } from './reviewRequest.js';
import { recentFailuresByCard } from './failureContext.js';

// tools/review embeds the manifest as <script type="application/json" id="review-data">.
const MANIFEST_PATTERN = /<script[^>]*\bid="review-data"[^>]*>([\s\S]*?)<\/script>/;

export function lockPresent(config) {
  return fs.existsSync(config.paths.lock);
}

// True only when this quest's brief can actually be read and trusted right now, not just when the path
// exists: an oversized brief, one that fails to read, or one that has started resolving outside the project
// (see briefUsable/fileStatusFor in briefs.js) is exactly as unusable as a missing one, and must block
// dispatch through the same brief_missing reason rules.js already raises for env.briefExists === false —
// every caller of this function (the eligibility loop below, the dispatcher's assign/recheck, review
// requests) gets the fix for free, without any of them changing.
export function briefExists(config, quest) {
  if (quest.kind === 'owner' && !quest.brief) return true;
  return Boolean(quest.brief) && briefUsable(config, quest.brief);
}

// Non-null only when a brief is physically present but cannot be trusted right now (too large, a read
// error, or outside the project) — the distinct cause rules.js's brief_unusable reason names, as opposed to
// brief_missing's "there is no brief to read at all". See briefs.js's briefUnusableInfo.
export function briefUnusable(config, quest) {
  if (quest.kind === 'owner' && !quest.brief) return null;
  return briefUnusableInfo(config, quest.brief);
}

function walk(directory, pattern, found = []) {
  if (!fs.existsSync(directory)) return found;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, pattern, found);
    else if (pattern.test(entry.name) && !entry.name.includes('_static')) found.push(full);
  }
  return found;
}

function foldedAnnotations(file) {
  const latest = new Map();
  if (!fs.existsSync(file)) return latest;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      for (const item of JSON.parse(line).items || []) latest.set(item.id, item);
    } catch { /* a torn last line is skipped; the next save rewrites the state */ }
  }
  return latest;
}

export function reviewPages(config) {
  if (!config.reviewPages) return [];
  const root = config.reviewPages.dir;
  return walk(root, config.reviewPages.filePattern).map((file) => {
    const match = fs.readFileSync(file, 'utf8').match(MANIFEST_PATTERN);
    let manifest = null;
    try { manifest = match ? JSON.parse(match[1]) : null; } catch { manifest = null; }
    const relative = path.relative(root, file).split(path.sep).join('/');
    const url = `/review/${relative}`;
    if (!manifest || !manifest.page) return { page: null, title: relative, url, total: 0, answered: 0, error: '手工页面，无批注统计' };
    const total = (manifest.sections || []).length;
    const items = [...foldedAnnotations(path.join(config.paths.data, 'annotations', `${manifest.page}.jsonl`)).values()];
    const answered = items.filter((item) => item.verdict || (item.note && item.note.trim())).length;
    return { page: manifest.page, title: manifest.title, url, total, answered: Math.min(answered, total) };
  });
}

// Two projects may share a name and a port; the browser storage they reach is one. The board therefore
// also gets a stable, non-secret id: a digest of the canonical project root (separator and case folded on
// Windows, trailing slashes dropped). The root itself never leaves the server — the id is what names a
// project's storage namespace.
export function projectId(root) {
  if (typeof root !== 'string' || !root.trim()) throw new Error('projectId 需要项目根目录（config.root 缺失）。');
  let canonical = path.resolve(root).split(path.sep).join('/');
  if (path.sep === '\\') canonical = canonical.toLowerCase();
  canonical = canonical.replace(/\/+$/, '');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

export function threadsByPackage(boardStore, packageIds) {
  const result = {};
  if (!boardStore) return result;
  const threads = boardStore.listThreads({});
  for (const id of packageIds) {
    const pattern = new RegExp(`(^|[^A-Z0-9-])${id.replace(/-/g, '\\-')}([^A-Z0-9]|$)`);
    result[id] = threads.filter((t) => pattern.test(t.title) || t.tags.includes(id))
      .map((t) => ({ id: t.id, title: t.title, closed: t.closed, messageCount: t.messageCount, updatedAt: t.updatedAt }));
  }
  return result;
}

export function buildSnapshot({ config, store, adventurers, boardStore, lanes, downLanes = null }) {
  const quests = withFileSets(config, store.list());
  // Historical context only: the latest failed or bounced attempt per exact card id, omitted when empty.
  const recentFailures = recentFailuresByCard(quests);
  const roster = effectiveRoster(adventurers, lanes);
  // B5: the lane header must agree with the roster below it — a limit whose card is no longer limited
  // (owner acknowledged, paused/disabled, or removed) survives only as cleared evidence, never as a chip.
  const visibleLimits = visibleLaneLimits((lanes && lanes.laneLimits) || {}, roster, (lanes && lanes.laneEvidence) || {});
  const env = { treeLocked: lockPresent(config), laneIds: new Set(Object.keys(config.lanes)), ...(downLanes ? { downLanes } : {}) };
  const byQuest = {};
  for (const quest of quests) {
    byQuest[quest.id] = eligibility({ quest, roster, quests, policy: config.policy, env: { ...env, briefExists: briefExists(config, quest), briefUnusable: briefUnusable(config, quest) } });
  }
  // Dropping a card on returned work sends it to review that work, so those drops are judged as reviews.
  const forReview = {};
  for (const quest of quests) {
    if (isReviewable(quest)) forReview[quest.id] = reviewEligibility({ parent: quest, roster, quests, policy: config.policy, env });
  }
  const laneRows = (lanes && lanes.packages) || [];
  const briefScan = discoverBriefs(config, { postedIds: new Set(quests.map((q) => q.id)), dispatchedIds: new Set(laneRows.map((row) => row.package)) });
  // withFileSets' internal-only fields (the unknown-brief conflict key rules.js's runningConflict reads, and
  // the reason text it resolves to) exist purely to drive that one check — never sent to a client. A public
  // quest keeps its real .files only; conflictKeys/briefUnknownReason are never public, whatever kind of
  // request asks (the board, the CLI's `show`, or the MCP quest tool — all read this same snapshot).
  const publicQuests = quests.map(({ conflictKeys, briefUnknownReason, ...quest }) => quest);
  return {
    generatedAt: new Date().toISOString(),
    project: { name: config.name, id: projectId(config.root), lanes: Object.keys(config.lanes) },
    quests: publicQuests,
    ...(Object.keys(recentFailures).length ? { recentFailures } : {}),
    roster,
    eligibility: byQuest,
    reviewEligibility: forReview,
    env: { treeLocked: env.treeLocked },
    live: liveByName(laneRows, quests),
    threads: threadsByPackage(boardStore, quests.map((q) => q.id)),
    reviewPages: reviewPages(config),
    unpostedBriefs: briefScan.items,
    verification: (lanes && lanes.verification) || null,
    laneLimits: visibleLimits.laneLimits,
    laneEvidence: visibleLimits.laneEvidence,
    openQuestions: boardStore ? boardStore.listThreads({ status: 'open', tag: 'question' }).length : 0,
    // Diagnostics behind unpostedBriefs, so an empty shelf reads as "nothing new", never as "discovery is
    // broken": when it last scanned, which folders and recency window applied, why every skipped file was
    // skipped (capped at MAX_EXCLUDED rows), and — computed from every exclusion, never just that capped
    // slice — how many fall in each kind, so a folder with more than the cap never reads as "nothing was
    // old/dispatched/duplicate" just because none of those rows happened to survive it.
    briefDiscovery: {
      scannedAt: briefScan.scannedAt,
      folders: briefScan.folders,
      recentDays: briefScan.recentDays,
      excluded: briefScan.excluded,
      excludedTotal: briefScan.excludedTotal,
      excludedTruncated: briefScan.excludedTruncated,
      byKind: briefScan.byKind,
      errors: briefScan.errors,
      truncated: briefScan.truncated,
    },
  };
}
