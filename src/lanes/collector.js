// Lane collector: reads the project's dispatch registry and each worker's state, per the lane config.
// Read-only and never throws for a single bad worker — that worker gets state 'unknown' with the reason.
import fs from 'node:fs';
import path from 'node:path';
import { readJsonLines } from '../core/jsonl.js';
import { workerState, countEdits, readText, laneLimitFromEvidence, active, laneEvidence as readLaneEvidence, mtime, resetAt, limitEntry } from './workers.js';
import { protocolFor, parseAgyVerdict } from './protocols.js';
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

// N9: an API lane (no outputDir, e.g. OpenCode) has no output directory to re-scan for terminal evidence
// the way a file lane does, so a bounce would otherwise live only in the reassigned package's *current*
// row and vanish the moment a new dispatch replaces it. The evidence belongs to the card and lane, not the
// assignment, so it is remembered here across polls until the same identity later succeeds.
function rememberApiEvidence(cache, lane, entry, now) {
  const key = `${lane}:${entry.adventurerId}`;
  const observed = entry.observedAt ? Date.parse(entry.observedAt) : now;
  if (!Number.isFinite(observed)) return;
  if (entry.state === 'bounced') {
    const prior = cache.get(key);
    if (prior && prior.observedMs > observed) return;
    cache.set(key, { observedMs: observed, entry: limitEntry({ at: observed, bounceUntil: entry.bounceUntil, adventurerId: entry.adventurerId, name: entry.name, code: entry.code }) });
  } else if (entry.state === 'delivered') {
    const prior = cache.get(key);
    if (prior && observed > prior.observedMs) cache.delete(key);
  }
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
    ...(current ? { attemptAt: startedAt, current: true } : {}), elapsed: Math.max(0, now - Date.parse(startedAt)),
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

export function createCollector(config, { fetchImpl = fetch, verifyProcessTree = null } = {}) {
  const lastSeen = new Map();
  const models = new Map();
  const apiEvidence = new Map();

  // The board's job-object verifier (wired in by the server, see src/server/server.js) reports whether the
  // process tree of one attempt is gone, still alive, or unknown. The collector itself never spawns or
  // inspects processes: it only asks, and only a verified 'empty' turns a silent worker into a terminal
  // failure. Anything else (alive, unknown, the callback itself throwing) leaves the existing
  // stall-after-minutes behaviour untouched.
  async function workerDied(entry, lane, quest, basePath, outText) {
    if (!verifyProcessTree || !quest || !entry.current) return false;
    if (quest.status !== 'dispatched' && quest.status !== 'stalled') return false;
    if (TERMINAL_STATES.has(entry.state)) return false;
    // Death detection needs the total absence of terminal evidence: a .exit or a .md on disk is the
    // worker's own last word and wins, whatever the process tree says.
    if (fs.existsSync(`${basePath}.exit`) || fs.existsSync(`${basePath}.md`)) return false;
    let verdict = 'unknown';
    try {
      verdict = await verifyProcessTree({
        attemptId: (quest.assignee && quest.assignee.attemptId) || null,
        name: entry.name, lane: entry.lane, package: entry.package,
      });
    } catch {
      verdict = 'unknown';
    }
    if (verdict !== 'empty') return false;
    const tail = tailText(outText, LAST_TEXT_MAX);
    entry.state = 'failed';
    entry.reason = `进程树已空，worker 已不在${tail ? `：${tail}` : '（没有输出）'}`;
    entry.lastText = '';
    return true;
  }

  async function fileWorker(entry, lane, now, registryToken, quest) {
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
    const outText = readText(`${basePath}.out`, 20000);
    // A verified-dead worker fails now — no waiting for stallAfterMinutes, and an already-stalled row flips
    // to failed the same way, since the empty tree is a terminal fact about this attempt.
    if (await workerDied(entry, lane, quest, basePath, outText)) return;
    if (!TERMINAL_STATES.has(entry.state) && stallForLimit(entry, fileLimitReason(entry, lane), lane)) return;
    entry.edits = countEdits(outText, lane.editCounter);
    // FB2-01.4: an agy-style VERDICT line at the .out tail is the review's conclusion, read straight into
    // the row (条目 21.1). No line, no field — an absent verdict stays honestly absent.
    const verdict = parseAgyVerdict(outText);
    if (verdict) entry.verdict = verdict;
    const report = readText(`${basePath}.md`, LAST_TEXT_MAX + 200).trim();
    // A stream-json lane's .out is a tool transcript, never a report — showing its raw tail as a "summary"
    // is exactly the bloated, mid-token cut this replaces; a text-only lane's own stdout still stands in
    // for one, cut at a word boundary instead of mid-word/mid-token.
    entry.lastText = tailText(report || entry.streamResult || (lane.editCounter === 'stream-json' ? '' : outText), LAST_TEXT_MAX);
  }

  async function apiWorker(entry, lane, skipStale, now, protocol) {
    const seen = lastSeen.get(entry.session);
    if (skipStale && seen && now - seen > STALE_3D_MS) {
      Object.assign(entry, { state: 'stale', reason: 'session inactive >3 days', stale: true });
      return;
    }
    if (!entry.session) { entry.reason = 'no session id'; return; }
    const result = await protocol.fetchJson(protocol.messagesUrl(lane, entry.session), { fetchImpl });
    if (!result.ok) { entry.reason = `${entry.lane} api unreachable：${result.reason}`; return; }
    const messages = result.data;
    if (!models.has(entry.session)) models.set(entry.session, protocol.sessionModel(messages));
    const info = protocol.sessionState(messages, now, { stallAfterMinutes: config.policy?.stallAfterMinutes });
    if (info.lastActivityMs) lastSeen.set(entry.session, info.lastActivityMs);
    Object.assign(entry, info);
    // FB2-10 item 3: the token story rides the delivered row only — a mid-run poll's partial sums would
    // read as the attempt's final usage.
    if (info.state === 'delivered' && typeof protocol.sessionUsage === 'function') {
      const usage = protocol.sessionUsage(messages);
      if (usage) entry.usage = usage;
    }
    if (!TERMINAL_STATES.has(entry.state) && stallForLimit(entry, protocol.sessionLimitReason(messages, entry.elapsed, lane.limits), lane)) return;
    if (TERMINAL_STATES.has(entry.state)) {
      const observed = info.observedAt || info.lastActivityMs || now;
      entry.observedAt = new Date(observed).toISOString();
      if (entry.state === 'bounced' && entry.bounceUntil) {
        const parsedReset = resetAt(entry.bounceUntil, observed);
        entry.resetsAt = parsedReset ? new Date(parsedReset).toISOString() : null;
      }
    }
    const sessionResult = await protocol.fetchJson(protocol.sessionUrl(lane, entry.session), { fetchImpl });
    if (sessionResult.ok && sessionResult.data && sessionResult.data.tokens) entry.tokens = sessionResult.data.tokens;
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
        const protocol = lane ? protocolFor(lane) : null;
        if (!lane) entry.reason = `lane ${entry.lane} is not configured`;
        else if (protocol) jobs.push(() => apiWorker(entry, lane, skipStale, now, protocol).catch((error) => { entry.reason = error.message; }));
        else jobs.push(() => fileWorker(entry, lane, now, dispatch.token, questRows.get(pkg)).catch((error) => { entry.state = 'unknown'; entry.reason = error.message; }));
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
      const lane = config.lanes[entry.lane];
      if (lane && !lane.outputDir && entry.adventurerId) rememberApiEvidence(apiEvidence, entry.lane, entry, now);
    }
    const laneLimits = {};
    const laneEvidence = {};
    for (const [id, lane] of Object.entries(config.lanes)) {
      if (!lane.outputDir) {
        const prefix = `${id}:`;
        const cards = {};
        for (const [key, cached] of apiEvidence) if (key.startsWith(prefix)) cards[key.slice(prefix.length)] = cached.entry;
        if (!Object.keys(cards).length) continue;
        const limit = laneLimitFromEvidence({ cards, unidentified: [] }, now);
        if (limit) laneLimits[id] = limit;
        const expiredCards = Object.fromEntries(Object.entries(cards).filter(([, entry]) => !active(entry, now)));
        if (Object.keys(expiredCards).length) laneEvidence[id] = { cards: expiredCards, unidentified: [] };
        continue;
      }
      const options = { identityByName: (name) => identitiesByName.get(name) || null, bouncePatterns: config.policy.bouncePatterns };
      // One read of the output folder serves both the lane-wide limit and the expired/unidentified
      // evidence below — laneLimitFromEvidence and the `active` filter share this same evidence object
      // instead of each re-reading the directory or re-deciding expiry on their own.
      const evidence = readLaneEvidence(path.join(config.root, lane.outputDir), now, options);
      if (!evidence) continue;
      const limit = laneLimitFromEvidence(evidence, now);
      if (limit) laneLimits[id] = limit;
      const expiredCards = Object.fromEntries(Object.entries(evidence.cards).filter(([, entry]) => !active(entry, now)));
      if (Object.keys(expiredCards).length || evidence.unidentified.length) {
        laneEvidence[id] = { cards: expiredCards, unidentified: evidence.unidentified };
      }
    }
    const verification = config.verification ? latestProgress(config.verification.progressDirs) : null;
    return { packages: rows, laneLimits, laneEvidence, verification, generatedAt: new Date(now).toISOString() };
  }

  return { collect };
}
