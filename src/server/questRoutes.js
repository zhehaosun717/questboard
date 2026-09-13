// Quest board API: snapshot, roster with status records, quest writes, and the live event stream.
import fs from 'node:fs';
import { sendJson, readJsonBody, writeRefusal } from './http.js';
import { buildSnapshot } from '../core/snapshot.js';
import { loadRoster, saveRoster, upsertAdventurer } from '../core/roster.js';
import { applyStatuses, STATUSES } from '../core/status.js';
import { effectiveRoster } from '../core/overlay.js';
import { QUEST_STATUSES } from '../core/store.js';
import { createDispatcher } from './dispatcher.js';

const SYNC_INTERVAL_MS = 5000;
const HEARTBEAT_MS = 20000;
const MANUAL_STATUSES = new Set([...QUEST_STATUSES].filter((status) => status !== 'dispatched'));

export function createQuestRoutes({ config, store, boardStore, statusLog, rosterFile, getLanes = () => null, runners, evidenceWaitMs, writeDelivery }) {
  const dispatcher = createDispatcher({ config, store, runners, evidenceWaitMs, writeDelivery });
  const clients = new Set();
  const timers = [];
  let lastLanes = null;

  store.on('event', (event) => {
    const frame = `event: quest\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) client.write(frame);
  });

  const adventurers = () => applyStatuses(loadRoster(rosterFile).adventurers, statusLog.current());
  const snapshot = () => buildSnapshot({ config, store, adventurers: adventurers(), boardStore, lanes: getLanes() });
  const findCard = (id) => effectiveRoster(adventurers(), getLanes()).find((a) => a.id === id);

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

  function replyOnThreads(questId, text) {
    if (!boardStore) return;
    for (const thread of boardStore.listThreads({ status: 'open' }).filter((t) => t.title.includes(questId) || t.tags.includes(questId))) {
      boardStore.addMessage(thread.id, { body: `裁决（任务板）：${text}`, author: 'owner' });
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
      const roster = fs.existsSync(rosterFile) ? loadRoster(rosterFile) : { adventurers: [] };
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
      const result = parts[3] === 'assign' ? dispatcher.assign(questId, card, by) : dispatcher.adopt(questId, card, body.name, by);
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
    if (parts[3] === 'ruling') {
      const next = store.rule(questId, { text: body.text, by });
      replyOnThreads(questId, String(body.text).trim());
      sendJson(response, 200, { quest: next });
      return;
    }
    sendJson(response, 404, { error: 'not found' });
  }

  async function handle(request, response, url, parts) {
    if (parts[0] !== 'api' || !['quests', 'roster', 'lanes'].includes(parts[1])) return false;
    try {
      if (url.pathname === '/api/quests/stream' && request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
        response.write('event: hello\ndata: {}\n\n');
        clients.add(response);
        request.on('close', () => clients.delete(response));
      } else if (url.pathname === '/api/quests' && request.method === 'GET') {
        sendJson(response, 200, snapshot());
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
    timers.push(setInterval(applyLanes, SYNC_INTERVAL_MS));
    timers.push(setInterval(() => { for (const client of clients) client.write(': ping\n\n'); }, HEARTBEAT_MS));
    for (const timer of timers) timer.unref();
  }

  function stop() {
    for (const timer of timers.splice(0)) clearInterval(timer);
    for (const client of clients) client.end();
    clients.clear();
  }

  return { handle, start, stop, applyLanes, snapshot };
}
