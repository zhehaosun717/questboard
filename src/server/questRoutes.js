// Quest board API: snapshot, roster with status records, quest writes, and the live event stream.
import fs from 'node:fs';
import { sendJson, readJsonBody, writeRefusal } from './http.js';
import { buildSnapshot } from '../core/snapshot.js';
import { loadRoster, loadRosterOrEmpty, saveRoster, upsertAdventurer } from '../core/roster.js';
import { applyStatuses, STATUSES } from '../core/status.js';
import { effectiveRoster } from '../core/overlay.js';
import { QUEST_STATUSES } from '../core/store.js';
import { createDispatcher } from './dispatcher.js';
import { eventsAfter } from '../core/events.js';
import { isReviewable, requestReview, reviewEligibility } from '../core/reviewRequest.js';
import { withFileSets } from '../core/briefs.js';
import { lockPresent } from '../core/snapshot.js';
import { laneServers } from '../core/laneServer.js';

const SYNC_INTERVAL_MS = 5000;
const HEARTBEAT_MS = 20000;
const MANUAL_STATUSES = new Set([...QUEST_STATUSES].filter((status) => status !== 'dispatched'));
const REQUEST_KEY_PATTERN = /^[\w.:-]{1,80}$/;
const EVENTS_MAX = 500;

// Same grouping the MCP get_quest answers with, so one read serves CLI, board and agents alike.
function eligibilitySummary(verdicts) {
  const canTake = [];
  const refused = {};
  for (const [card, verdict] of Object.entries(verdicts || {})) {
    if (verdict.ok) { canTake.push(card); continue; }
    for (const reason of verdict.reasons) (refused[reason.message] = refused[reason.message] || []).push(card);
  }
  return { canTake, refused };
}

export function createQuestRoutes({ config, store, boardStore, statusLog, rosterFile, getLanes = () => null, runners, evidenceWaitMs, writeDelivery, checkLaneServers = () => laneServers(config) }) {
  let downLanes = null;
  // findCard is defined below; this closure is only ever called later, from a queued recheck, by which
  // point it's assigned — passing it lets the recheck re-resolve the adventurer's roster status, lane and
  // policy fresh at spawn time instead of trusting the object captured at drop time.
  const dispatcher = createDispatcher({ config, store, runners, evidenceWaitMs, writeDelivery, getDownLanes: () => downLanes, getAdventurer: (id) => findCard(id) });
  const clients = new Set();
  const timers = [];
  let lastLanes = null;

  store.on('event', (event) => {
    const frame = `event: quest\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) client.write(frame);
  });

  // Missing roster: the board still opens, empty, so the first card can be added from the 冒险者 tab.
  const adventurers = () => applyStatuses(loadRosterOrEmpty(rosterFile).adventurers, statusLog.current());
  const snapshot = () => buildSnapshot({ config, store, adventurers: adventurers(), boardStore, lanes: getLanes(), downLanes });
  const findCard = (id) => effectiveRoster(adventurers(), getLanes()).find((a) => a.id === id);

  async function refreshLaneHealth() {
    try {
      const rows = await checkLaneServers();
      downLanes = new Map(rows.filter((r) => !r.up).map((r) => [r.id, r.api]));
    } catch (error) {
      process.stderr.write(`questboard: lane health check failed: ${error.stack || error.message}\n`);
    }
  }

  function applyLanes() {
    try {
      const lanes = getLanes();
      if (!lanes || lanes === lastLanes) return;
      lastLanes = lanes;
      dispatcher.applyLanes(lanes);
    } catch (error) {
      // A failed sync must not take the server down with every running quest; the next tick retries.
      lastLanes = null;
      process.stderr.write(`questboard: lane sync failed: ${error.stack || error.message}\n`);
    }
  }

  // A ruling is the answer, so the question thread it answers is closed with it — otherwise the "待答" count
  // only ever grows. Threads that merely mention the quest without asking anything stay open.
  function replyOnThreads(questId, text) {
    if (!boardStore) return;
    for (const thread of boardStore.listThreads({ status: 'open' }).filter((t) => t.title.includes(questId) || t.tags.includes(questId))) {
      boardStore.addMessage(thread.id, { body: `裁决（任务板）：${text}`, author: 'owner' });
      if (thread.tags.includes('question')) boardStore.setFlag(thread.id, 'closed', true);
    }
  }

  async function post(request, response, parts) {
    const body = await readJsonBody(request, 256 * 1024);
    if (parts[1] === 'quests' && parts.length === 2) {
      const result = store.post(body);
      if (result.errors) sendJson(response, 400, { error: 'validation failed', fields: result.errors }); else sendJson(response, 201, result);
      return;
    }
    if (parts[1] === 'roster' && parts.length === 2) {
      // Add or replace one card. Facts only: validateAdventurer refuses a status field.
      const roster = loadRosterOrEmpty(rosterFile);
      const entry = body.adventurer;
      if (entry && entry.lane && !config.lanes[entry.lane]) { sendJson(response, 400, { error: `lane ${entry.lane} is not configured in this project` }); return; }
      const next = upsertAdventurer(roster, entry);
      saveRoster(rosterFile, next);
      sendJson(response, 200, { adventurer: next.adventurers.find((a) => a.id === entry.id) });
      return;
    }
    if (parts[1] === 'roster' && parts[3] === 'delete') {
      const roster = loadRoster(rosterFile);
      if (!roster.adventurers.some((a) => a.id === parts[2])) { sendJson(response, 404, { error: `no adventurer ${parts[2]}` }); return; }
      const running = store.list().filter((q) => q.status === 'dispatched' && q.assignee && q.assignee.adventurerId === parts[2]).map((q) => q.id);
      if (running.length) { sendJson(response, 409, { error: `${parts[2]} is working on ${running.join(', ')}; wait until it finishes` }); return; }
      saveRoster(rosterFile, { ...roster, adventurers: roster.adventurers.filter((a) => a.id !== parts[2]) });
      sendJson(response, 200, { removed: parts[2] });
      return;
    }
    if (parts[1] === 'roster' && parts[3] === 'status') {
      if (!loadRoster(rosterFile).adventurers.some((a) => a.id === parts[2])) { sendJson(response, 404, { error: `no adventurer ${parts[2]}` }); return; }
      if (!STATUSES.includes(body.status)) { sendJson(response, 400, { error: `status must be one of ${STATUSES.join('|')}` }); return; }
      sendJson(response, 200, { status: statusLog.set(parts[2], { status: body.status, reason: body.reason || '', setBy: body.setBy || 'owner' }) });
      return;
    }
    const questId = parts[1] === 'quests' ? parts[2] : null;
    if (!questId || !store.get(questId)) { sendJson(response, 404, { error: 'quest not found' }); return; }
    const by = String(body.by || (parts[3] === 'status' ? 'coordinator' : 'owner')).slice(0, 40);
    if (parts[3] === 'assign' || parts[3] === 'adopt') {
      const card = findCard(body.adventurer);
      if (!card) { sendJson(response, 400, { error: `no adventurer ${body.adventurer}` }); return; }
      const requestKey = body.requestKey === undefined || body.requestKey === null || body.requestKey === '' ? null : String(body.requestKey);
      if (requestKey !== null && !REQUEST_KEY_PATTERN.test(requestKey)) { sendJson(response, 400, { error: `requestKey must match ${REQUEST_KEY_PATTERN}` }); return; }
      const ifRevision = body.ifRevision === undefined || body.ifRevision === null || body.ifRevision === '' ? undefined : Number(body.ifRevision);
      if (ifRevision !== undefined && !Number.isInteger(ifRevision)) { sendJson(response, 400, { error: 'ifRevision must be an integer' }); return; }
      const options = { requestKey, ifRevision };
      const result = parts[3] === 'assign' ? dispatcher.assign(questId, card, by, options) : dispatcher.adopt(questId, card, body.name, by, options);
      sendJson(response, result.status, result.body);
      return;
    }
    if (parts[3] === 'release') {
      const result = dispatcher.release(questId, by, String(body.detail || '').slice(0, 2000));
      sendJson(response, result.status, result.body);
      return;
    }
    if (parts[3] === 'status') {
      if (!MANUAL_STATUSES.has(body.status)) { sendJson(response, 400, { error: `status must be one of ${[...MANUAL_STATUSES].join('|')}; dispatch goes through assign` }); return; }
      sendJson(response, 200, { quest: store.setStatus(questId, body.status, { detail: body.detail || '', by }) });
      return;
    }
    if (parts[3] === 'review') {
      // With an adventurer this is a drop: judge that card against the review first, so a refused drop writes
      // no brief and posts nothing; then post the review and dispatch it in one step.
      let card = null;
      if (body.adventurer) {
        card = findCard(body.adventurer);
        if (!card) { sendJson(response, 400, { error: `no adventurer ${body.adventurer}` }); return; }
        const parent = store.get(questId);
        if (isReviewable(parent)) {
          const env = { treeLocked: lockPresent(config), laneIds: new Set(Object.keys(config.lanes)), ...(downLanes ? { downLanes } : {}) };
          const quests = withFileSets(config, store.list());
          const verdict = reviewEligibility({ parent, roster: [card], quests, policy: config.policy, env })[card.id];
          if (!verdict.ok) { sendJson(response, 409, { error: 'refused', reasons: verdict.reasons }); return; }
        }
      }
      const result = requestReview({ config, store, parentId: questId, note: String(body.note || '').trim().slice(0, 2000), by });
      if (result.status !== 201 || !card) { sendJson(response, result.status, result.body); return; }
      const assigned = dispatcher.assign(result.body.review.id, card, by);
      if (assigned.status !== 200) {
        sendJson(response, assigned.status, { ...assigned.body, review: result.body.review });
        return;
      }
      sendJson(response, 201, { review: assigned.body.quest, quest: result.body.quest });
      return;
    }
    if (parts[3] === 'ruling') {
      const next = store.rule(questId, { text: body.text, by });
      replyOnThreads(questId, String(body.text).trim());
      sendJson(response, 200, { quest: next });
      return;
    }
    sendJson(response, 404, { error: 'not found' });
  }

  async function handle(request, response, url, parts) {
    if (parts[0] !== 'api' || !['quests', 'roster', 'lanes', 'events'].includes(parts[1])) return false;
    try {
      if (url.pathname === '/api/events' && request.method === 'GET') {
        // Forward pagination by seq; pass the last seq you saw as `after`.
        const after = Number(url.searchParams.get('after') || 0);
        const limit = Number(url.searchParams.get('limit') || 50);
        if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1) { sendJson(response, 400, { error: 'after must be a non-negative integer and limit a positive integer' }); return true; }
        const events = eventsAfter(config.paths.events, { after, limit: Math.min(limit, EVENTS_MAX), pkg: url.searchParams.get('package') });
        sendJson(response, 200, { events, nextAfter: events.length ? events.at(-1).seq : after });
      } else if (url.pathname === '/api/quests/stream' && request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
        response.write('event: hello\ndata: {}\n\n');
        clients.add(response);
        request.on('close', () => clients.delete(response));
      } else if (url.pathname === '/api/quests' && request.method === 'GET') {
        sendJson(response, 200, snapshot());
      } else if (parts[1] === 'quests' && parts.length === 3 && request.method === 'GET') {
        // One quest, enriched exactly as the MCP questboard_get_quest contract: the snapshot's quest (with
        // its file set), the worker's live output, linked threads, and grouped eligibility. Reads mutate nothing.
        const snap = snapshot();
        const quest = snap.quests.find((q) => q.id === parts[2]);
        if (!quest) { sendJson(response, 404, { error: 'quest not found' }); return true; }
        sendJson(response, 200, { quest: {
          ...quest,
          live: quest.assignee ? snap.live[quest.assignee.name] || null : null,
          threads: snap.threads[quest.id] || [],
          eligibility: eligibilitySummary(snap.eligibility[quest.id]),
          // Requirement 5/R3: a sanitized, process-local, explicitly not restart-durable diagnostic — this
          // process still remembers a session id for the quest's current attempt that its own durable
          // record does not (yet, or ever) confirm. null once there is nothing to report, or once a later
          // durable write makes it current again. Never secrets/commands/env/raw error text.
          unpersistedSession: quest.assignee ? dispatcher.getUnpersistedSession(quest.id, quest.assignee.attemptId) : null,
        } });
      } else if (url.pathname === '/api/roster' && request.method === 'GET') {
        sendJson(response, 200, { adventurers: effectiveRoster(adventurers(), getLanes()) });
      } else if (url.pathname === '/api/lanes' && request.method === 'GET') {
        const lanes = getLanes() || { packages: [], laneLimits: {}, verification: null };
        sendJson(response, 200, { ...lanes, board: { openQuestions: boardStore ? boardStore.listThreads({ status: 'open', tag: 'question' }).length : 0 } });
      } else if (request.method === 'POST') {
        const refusal = writeRefusal(request);
        if (refusal) sendJson(response, 403, { error: refusal }); else await post(request, response, parts);
      } else {
        sendJson(response, 404, { error: 'not found' });
      }
    } catch (error) {
      if (!response.headersSent) sendJson(response, 400, { error: error.message });
    }
    return true;
  }

  function start() {
    refreshLaneHealth();
    timers.push(setInterval(refreshLaneHealth, SYNC_INTERVAL_MS));
    timers.push(setInterval(applyLanes, SYNC_INTERVAL_MS));
    timers.push(setInterval(() => { for (const client of clients) client.write(': ping\n\n'); }, HEARTBEAT_MS));
    for (const timer of timers) timer.unref();
  }

  function stop() {
    for (const timer of timers.splice(0)) clearInterval(timer);
    for (const client of clients) client.end();
    clients.clear();
  }

  return { handle, start, stop, applyLanes, snapshot, refreshLaneHealth };
}
