// Lane collector: reads the project's dispatch registry and each worker's state, per the lane config.
// Read-only and never throws for a single bad worker — that worker gets state 'unknown' with the reason.
import path from 'node:path';
import { readJsonLines } from '../core/jsonl.js';
import { workerState, countEdits, readText, laneLimit, laneEvidence as readLaneEvidence, mtime, resetAt } from './workers.js';
import { fetchJson, sessionLimitReason, sessionModel, sessionState } from './opencode.js';
import { latestProgress } from './progress.js';
import { isCurrentRow, tailText } from '../core/sync.js';

const LAST_TEXT_MAX = 300;

const STALE_3D_MS = 3 * 24 * 60 * 60 * 1000;
const POLL_LIMIT = 4;
const TERMINAL_STATES = new Set(['bounced', 'delivered', 'failed']);

function fileLimitReason(entry, lane) {
  return lane.limits?.maxMinutes !== undefined && entry.elapsed > lane.limits.maxMinutes * 60 * 1000
    ? `超过时长上限 ${lane.limits.maxMinutes} 分钟` : null;
}

function stallForLimit(entry, reason, lane) {
  if (!reason) return false;
  Object.assign(entry, { state: 'stalled', reason, limitReason: reason,
    ...(lane.control?.type !== 'generic-wrapper' ? { manualRequired: true } : {}) });
  return true;
}

function groupRegistry(rows) {
  const packages = new Map();
  for (const row of rows) {
    if (!row || !row.package || !['dispatch', 'note'].includes(row.event)) continue;
    if (!packages.has(row.package)) packages.set(row.package, { dispatches: [], notes: [] });
    packages.get(row.package)[row.event === 'dispatch' ? 'dispatches' : 'notes'].push(row);
  }
  return packages;
}

function currentQuestRows(config) {
  const latest = new Map();
  for (const row of readJsonLines(path.join(config.paths.data, 'quests.jsonl'))) if (row && row.id) latest.set(row.id, row);
  return latest;
}

function rememberIdentity(identitiesByName, name, adventurerId) {
  if (!name || !adventurerId) return;
  const key = String(name);
  const id = String(adventurerId);
  if (!identitiesByName.has(key)) identitiesByName.set(key, id);
  else if (identitiesByName.get(key) !== id) identitiesByName.set(key, null);
}

function packageIdentity(quest, dispatch, identitiesByName) {
  if (identitiesByName.has(dispatch.name)) return identitiesByName.get(dispatch.name);
  if (quest && quest.assignee && quest.assignee.name === dispatch.name && quest.assignee.adventurerId) return String(quest.assignee.adventurerId);
  return dispatch.adventurerId ? String(dispatch.adventurerId) : null;
}

function attemptStartAt(quest, dispatch) {
  return quest?.assignee?.at || dispatch.at;
}

function baseEntry(pkg, dispatch, data, now, adventurerId, quest) {
  const history = [
    ...data.dispatches.map((d) => ({ at: d.at, lane: d.lane, model: d.model, event: 'dispatch' })),
    ...data.notes.map((n) => ({ at: n.at, event: 'note', text: n.text })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const current = Boolean(
    quest?.assignee
    && quest.assignee.name === dispatch.name
    && isCurrentRow({ dispatchedAt: dispatch.at }, quest.assignee, quest),
  );
  const startedAt = current ? attemptStartAt(quest, dispatch) : dispatch.at;
  return {
    package: pkg, lane: dispatch.lane, model: dispatch.model, variant: dispatch.variant || '', name: dispatch.name,
    session: dispatch.session || null, dispatchedAt: dispatch.at,
    ...(current ? { attemptAt: startedAt } : {}), elapsed: Math.max(0, now - Date.parse(startedAt)),
    state: 'unknown', reason: '', stale: false, edits: 0, tokens: null, lastText: '', bounceUntil: null, history,
    ...(adventurerId ? { adventurerId } : {}),
  };
}

async function pollAll(jobs) {
  const results = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(POLL_LIMIT, jobs.length) }, async () => {
    while (next < jobs.length) { const index = next++; results[index] = await jobs[index](); }
  }));
  return results;
}

export function createCollector(config, { fetchImpl = fetch } = {}) {
  const lastSeen = new Map();
  const models = new Map();

  function fileWorker(entry, lane, now, registryToken) {
    const basePath = path.join(config.root, lane.outputDir, entry.name);
    Object.assign(entry, workerState(basePath, now, {
      editCounter: lane.editCounter,
      stallAfterMinutes: config.policy.stallAfterMinutes,
      bouncePatterns: config.policy.bouncePatterns,
      token: registryToken,
    }));
    if (TERMINAL_STATES.has(entry.state)) {
      const observed = mtime(`${basePath}.exit`) || mtime(`${basePath}.out`);
      if (observed) {
        entry.observedAt = new Date(observed).toISOString();
        if (entry.state === 'bounced' && entry.bounceUntil) {
          const parsedReset = resetAt(entry.bounceUntil, observed);
          entry.resetsAt = parsedReset ? new Date(parsedReset).toISOString() : null;
        }
      }
    }
    if (!TERMINAL_STATES.has(entry.state) && stallForLimit(entry, fileLimitReason(entry, lane), lane)) return;
    const outText = readText(`${basePath}.out`, 20000);
    entry.edits = countEdits(outText, lane.editCounter);
    const report = readText(`${basePath}.md`, LAST_TEXT_MAX + 200).trim();
    // A stream-json lane's .out is a tool transcript, never a report — showing its raw tail as a "summary"
    // is exactly the bloated, mid-token cut this replaces; a text-only lane's own stdout still stands in
    // for one, cut at a word boundary instead of mid-word/mid-token.
    entry.lastText = tailText(report || (lane.editCounter === 'stream-json' ? '' : outText), LAST_TEXT_MAX);
  }

  async function apiWorker(entry, lane, skipStale, now) {
    const seen = lastSeen.get(entry.session);
    if (skipStale && seen && now - seen > STALE_3D_MS) {
      Object.assign(entry, { state: 'stale', reason: 'session inactive >3 days', stale: true });
      return;
    }
    if (!entry.session) { entry.reason = 'no session id'; return; }
    const messages = await fetchJson(`${lane.api}/session/${entry.session}/message`, { fetchImpl });
    if (!messages) { entry.reason = `${entry.lane} api unreachable`; return; }
    if (!models.has(entry.session)) models.set(entry.session, sessionModel(messages));
    const info = sessionState(messages, now, { stallAfterMinutes: config.policy?.stallAfterMinutes });
    if (info.lastActivityMs) lastSeen.set(entry.session, info.lastActivityMs);
    Object.assign(entry, info);
    if (!TERMINAL_STATES.has(entry.state) && stallForLimit(entry, sessionLimitReason(messages, entry.elapsed, lane.limits), lane)) return;
    if (TERMINAL_STATES.has(entry.state)) {
      const observed = info.observedAt || info.lastActivityMs || now;
      entry.observedAt = new Date(observed).toISOString();
      if (entry.state === 'bounced' && entry.bounceUntil) {
        const parsedReset = resetAt(entry.bounceUntil, observed);
        entry.resetsAt = parsedReset ? new Date(parsedReset).toISOString() : null;
      }
    }
    const session = await fetchJson(`${lane.api}/session/${entry.session}`, { fetchImpl });
    if (session && session.tokens) entry.tokens = session.tokens;
  }

  function recoverModel(entry, lane) {
    if (entry.model !== 'unknown') return;
    const recovered = entry.session && models.get(entry.session);
    if (recovered) Object.assign(entry, { model: recovered.model, variant: entry.variant || recovered.variant, modelSource: 'session' });
    else if (lane && lane.defaultModel) Object.assign(entry, { model: lane.defaultModel, modelSource: 'inferred' });
  }

  async function collect({ skipStale = true, now = Date.now() } = {}) {
    const rows = [];
    const jobs = [];
    const questRows = currentQuestRows(config);
    const registryRows = readJsonLines(config.paths.registry);
    const registry = groupRegistry(registryRows);
    const identitiesByName = new Map();
    for (const quest of questRows.values()) {
      for (const dispatch of quest.dispatches || []) rememberIdentity(identitiesByName, dispatch && dispatch.name, dispatch && dispatch.adventurerId);
    }
    for (const row of registryRows) rememberIdentity(identitiesByName, row && row.name, row && row.adventurerId);
    for (const [pkg, data] of registry) {
      const dispatch = data.dispatches.at(-1);
      if (!dispatch) continue;
      const adventurerId = packageIdentity(questRows.get(pkg), dispatch, identitiesByName);
      const entry = baseEntry(pkg, dispatch, data, now, adventurerId, questRows.get(pkg));
      const lane = config.lanes[entry.lane];
      rows.push(entry);
      try {
        if (!lane) entry.reason = `lane ${entry.lane} is not configured`;
        else if (lane.api) jobs.push(() => apiWorker(entry, lane, skipStale, now).catch((error) => { entry.reason = error.message; }));
        else fileWorker(entry, lane, now, dispatch.token);
      } catch (error) {
        entry.state = 'unknown';
        entry.reason = error.message;
      }
    }
    await pollAll(jobs);
    for (const entry of rows) {
      recoverModel(entry, config.lanes[entry.lane]);
      const newest = entry.history.at(-1);
      if (!entry.stale && newest && now - Date.parse(newest.at) > STALE_3D_MS) entry.stale = true;
    }
    const laneLimits = {};
    const laneEvidence = {};
    for (const [id, lane] of Object.entries(config.lanes)) {
      if (!lane.outputDir) continue;
      const options = { identityByName: (name) => identitiesByName.get(name) || null, bouncePatterns: config.policy.bouncePatterns };
      const limit = laneLimit(path.join(config.root, lane.outputDir), now, options);
      if (limit) laneLimits[id] = limit;
      const evidence = readLaneEvidence(path.join(config.root, lane.outputDir), now, options);
      if (evidence) {
        const expiredCards = Object.fromEntries(Object.entries(evidence.cards).filter(([, entry]) => {
          const reset = Date.parse(entry.resetsAt || '');
          return Number.isFinite(reset) && reset <= now;
        }));
        if (Object.keys(expiredCards).length || evidence.unidentified.length) {
          laneEvidence[id] = { cards: expiredCards, unidentified: evidence.unidentified };
        }
      }
    }
    const verification = config.verification ? latestProgress(config.verification.progressDirs) : null;
    return { packages: rows, laneLimits, laneEvidence, verification, generatedAt: new Date(now).toISOString() };
  }

  return { collect };
}
