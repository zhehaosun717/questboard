// Builds the one payload the board renders: quests, cards with effective statuses, who may take what and
// why not, live worker output, message-board threads per package, review pages with annotation progress,
// the verification strip, lane limits, and recent briefs nobody posted yet.
import fs from 'node:fs';
import path from 'node:path';
import { eligibility } from './rules.js';
import { liveByName } from './sync.js';
import { effectiveRoster } from './overlay.js';
import { withFileSets, unpostedBriefs } from './briefs.js';
import { isReviewable, reviewEligibility } from './reviewRequest.js';

// tools/review embeds the manifest as <script type="application/json" id="review-data">.
const MANIFEST_PATTERN = /<script[^>]*\bid="review-data"[^>]*>([\s\S]*?)<\/script>/;

export function lockPresent(config) {
  return fs.existsSync(config.paths.lock);
}

export function briefExists(config, quest) {
  if (quest.kind === 'owner' && !quest.brief) return true;
  return Boolean(quest.brief) && fs.existsSync(path.join(config.root, quest.brief));
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
  const roster = effectiveRoster(adventurers, lanes);
  const env = { treeLocked: lockPresent(config), laneIds: new Set(Object.keys(config.lanes)), ...(downLanes ? { downLanes } : {}) };
  const byQuest = {};
  for (const quest of quests) {
    byQuest[quest.id] = eligibility({ quest, roster, quests, policy: config.policy, env: { ...env, briefExists: briefExists(config, quest) } });
  }
  // Dropping a card on returned work sends it to review that work, so those drops are judged as reviews.
  const forReview = {};
  for (const quest of quests) {
    if (isReviewable(quest)) forReview[quest.id] = reviewEligibility({ parent: quest, roster, quests, policy: config.policy, env });
  }
  const laneRows = (lanes && lanes.packages) || [];
  return {
    generatedAt: new Date().toISOString(),
    project: { name: config.name, lanes: Object.keys(config.lanes) },
    quests,
    roster,
    eligibility: byQuest,
    reviewEligibility: forReview,
    env: { treeLocked: env.treeLocked },
    live: liveByName(laneRows, quests),
    threads: threadsByPackage(boardStore, quests.map((q) => q.id)),
    reviewPages: reviewPages(config),
    unpostedBriefs: unpostedBriefs(config, { postedIds: new Set(quests.map((q) => q.id)), dispatchedIds: new Set(laneRows.map((row) => row.package)) }),
    verification: (lanes && lanes.verification) || null,
    laneLimits: (lanes && lanes.laneLimits) || {},
    openQuestions: boardStore ? boardStore.listThreads({ status: 'open', tag: 'question' }).length : 0,
  };
}
