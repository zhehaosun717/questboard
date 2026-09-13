// Lane collector: reads the project's dispatch registry and each worker's state, per the lane config.
// Read-only and never throws for a single bad worker — that worker gets state 'unknown' with the reason.
import path from 'node:path';
import { readJsonLines } from '../core/jsonl.js';
import { workerState, countEdits, readText, laneLimit } from './workers.js';
import { fetchJson, sessionModel, sessionState } from './opencode.js';
import { latestProgress } from './progress.js';

const STALE_3D_MS = 3 * 24 * 60 * 60 * 1000;
const POLL_LIMIT = 4;

function groupRegistry(rows) {
  const packages = new Map();
  for (const row of rows) {
    if (!row || !row.package || !['dispatch', 'note'].includes(row.event)) continue;
    if (!packages.has(row.package)) packages.set(row.package, { dispatches: [], notes: [] });
    packages.get(row.package)[row.event === 'dispatch' ? 'dispatches' : 'notes'].push(row);
  }
  return packages;
}

function baseEntry(pkg, dispatch, data, now) {
  const history = [
    ...data.dispatches.map((d) => ({ at: d.at, lane: d.lane, model: d.model, event: 'dispatch' })),
    ...data.notes.map((n) => ({ at: n.at, event: 'note', text: n.text })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return {
    package: pkg, lane: dispatch.lane, model: dispatch.model, variant: dispatch.variant || '', name: dispatch.name,
    session: dispatch.session || null, dispatchedAt: dispatch.at, elapsed: Math.max(0, now - Date.parse(dispatch.at)),
    state: 'unknown', reason: '', stale: false, edits: 0, tokens: null, lastText: '', bounceUntil: null, history,
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

  function fileWorker(entry, lane) {
    const basePath = path.join(config.root, lane.outputDir, entry.name);
    Object.assign(entry, workerState(basePath));
    const outText = readText(`${basePath}.out`, 20000);
    entry.edits = countEdits(outText, lane.editCounter);
    entry.lastText = readText(`${basePath}.md`, 300) || outText.slice(-300);
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
    const info = sessionState(messages, now);
    if (info.lastActivityMs) lastSeen.set(entry.session, info.lastActivityMs);
    Object.assign(entry, info);
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
    for (const [pkg, data] of groupRegistry(readJsonLines(config.paths.registry))) {
      const dispatch = data.dispatches.at(-1);
      if (!dispatch) continue;
      const entry = baseEntry(pkg, dispatch, data, now);
      const lane = config.lanes[entry.lane];
      rows.push(entry);
      try {
        if (!lane) entry.reason = `lane ${entry.lane} is not configured`;
        else if (lane.api) jobs.push(() => apiWorker(entry, lane, skipStale, now).catch((error) => { entry.reason = error.message; }));
        else fileWorker(entry, lane);
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
    for (const [id, lane] of Object.entries(config.lanes)) {
      if (!lane.outputDir) continue;
      const limit = laneLimit(path.join(config.root, lane.outputDir), now);
      if (limit) laneLimits[id] = limit;
    }
    const verification = config.verification ? latestProgress(config.verification.progressDirs) : null;
    return { packages: rows, laneLimits, verification, generatedAt: new Date(now).toISOString() };
  }

  return { collect };
}
