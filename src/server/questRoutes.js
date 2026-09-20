// Quest board API: snapshot, roster with status records, quest writes, and the live event stream.
import fs from 'node:fs';
import { sendJson, readJsonBody, writeRefusal } from './http.js';
import { buildSnapshot } from '../core/snapshot.js';
import { envPolicyViolation, loadRoster, loadRosterOrEmpty, saveRoster, upsertAdventurer } from '../core/roster.js';
import { applyStatuses, STATUSES } from '../core/status.js';
import { effectiveRoster, visibleLaneLimits } from '../core/overlay.js';
import { QUEST_STATUSES } from '../core/store.js';
import { createDispatcher } from './dispatcher.js';
import { eventsAfter } from '../core/events.js';
import { isReviewable, requestReview, reviewEligibility } from '../core/reviewRequest.js';
import { withFileSets } from '../core/briefs.js';
import { briefExists, briefUnusable, lockPresent, projectId } from '../core/snapshot.js';
import { laneServers } from '../core/laneServer.js';
import { attemptOf, questReportView, readCapturedReport } from '../core/reportEvidence.js';
import { questEvidence } from '../core/evidence.js';
import { buildAcceptance } from '../core/acceptance.js';
import { canDispatch, reviewUpstreamEvidence } from '../core/rules.js';
import { hookLogRelativePath, readHookLog } from '../core/verificationHooks.js';
import { createRosterBulkRoutes } from './rosterBulkRoutes.js';
import { foldAnnotations, summarizeAnnotations } from '../core/annotationSnapshot.js';

const SYNC_INTERVAL_MS = 5000;
const HEARTBEAT_MS = 20000;
const MANUAL_STATUSES = new Set([...QUEST_STATUSES].filter((status) => status !== 'dispatched'));
const REQUEST_KEY_PATTERN = /^[\w.:-]{1,80}$/;
const EVENTS_MAX = 500;

function requestSource(request) {
  const value = String(request.headers['x-questboard-source'] || '').trim();
  return ['ui', 'cli', 'mcp'].includes(value) ? value : 'unknown';
}

// F2: the project-wide latest dispatch time, over every quest's CURRENT attempt (assignee, or its last
// dispatch row once settled) — never just this one quest's history. progress.txt is shared by the whole
// project, so evidence.js needs this to refuse binding it to an attempt that a later dispatch of some OTHER
// quest has since superseded.
function projectLatestDispatchAt(quests) {
  let latest = null;
  for (const quest of quests) {
    const at = attemptOf(quest)?.at;
    const ms = at ? Date.parse(at) : NaN;
    if (Number.isFinite(ms) && (latest === null || ms > latest)) latest = ms;
  }
  return latest;
}

// Suggestion S3: the same evidenceOf(questId) bridge src/core/snapshot.js builds for the board's own
// eligibility loop, built here too for the two call sites in this file that judge or show a review's
// upstream evidence directly against the store rather than through a full buildSnapshot() env.
function makeEvidenceOf(config, store, verification) {
  const latestDispatchAt = projectLatestDispatchAt(store.list());
  return (questId) => {
    const quest = store.get(questId);
    return quest ? questEvidence({ config, quest, verification, latestDispatchAt }) : null;
  };
}

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
  // The project's extra allowed card env names (policy.cardEnvAllow); fixed for the server's lifetime,
  // since a config change needs a restart.
  const cardEnvAllow = config.policy?.cardEnvAllow || [];
  const rosterBulkRoutes = createRosterBulkRoutes({ rosterFile, statusLog, getQuests: () => store.list(), getLanes, cardEnvAllow });
  const clients = new Set();
  const timers = [];
  let lastLanes = null;

  store.on('event', (event) => {
    const frame = `event: quest\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) client.write(frame);
  });

  // Missing roster: the board still opens, empty, so the first card can be added from the 冒险者 tab.
  // A card whose saved env now breaks the env policy (deny list or allowed shapes) still loads (loadRosterOrEmpty never throws for
  // that); it just carries a note here, in memory only, so the board can show it and rules.js can refuse
  // dispatch — never written back to roster.json.
  const withEnvPolicy = (card) => {
    const envPolicy = envPolicyViolation(card, { cardEnvAllow });
    return envPolicy ? { ...card, envPolicy } : card;
  };
  // A card's status is project-scoped (owner decision 2026-09-17): the board reads only records written in
  // this project plus machine-level records that carry no project id.
  const adventurers = () => applyStatuses(loadRosterOrEmpty(rosterFile).adventurers, statusLog.current(projectId(config.root))).map(withEnvPolicy);
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
      const next = upsertAdventurer(roster, entry, { cardEnvAllow });
      // upsertAdventurer already checked this entry in full; another, untouched card's legacy env must
      // not block saving it.
      saveRoster(rosterFile, next, { lenientEnv: true });
      sendJson(response, 200, { adventurer: next.adventurers.find((a) => a.id === entry.id) });
      return;
    }
    if (parts[1] === 'roster' && parts[3] === 'delete') {
      const roster = loadRoster(rosterFile);
      if (!roster.adventurers.some((a) => a.id === parts[2])) { sendJson(response, 404, { error: `no adventurer ${parts[2]}` }); return; }
      const running = store.list().filter((q) => q.status === 'dispatched' && q.assignee && q.assignee.adventurerId === parts[2]).map((q) => q.id);
      if (running.length) { sendJson(response, 409, { error: `${parts[2]} is working on ${running.join(', ')}; wait until it finishes` }); return; }
      saveRoster(rosterFile, { ...roster, adventurers: roster.adventurers.filter((a) => a.id !== parts[2]) }, { lenientEnv: true });
      sendJson(response, 200, { removed: parts[2] });
      return;
    }
    if (parts[1] === 'roster' && parts[3] === 'status') {
      if (!loadRoster(rosterFile).adventurers.some((a) => a.id === parts[2])) { sendJson(response, 404, { error: `no adventurer ${parts[2]}` }); return; }
      if (!STATUSES.includes(body.status)) { sendJson(response, 400, { error: `status must be one of ${STATUSES.join('|')}` }); return; }
      sendJson(response, 200, { status: statusLog.set(parts[2], { status: body.status, reason: body.reason || '', setBy: body.setBy || 'owner', projectId: projectId(config.root) }) });
      return;
    }
    const questId = parts[1] === 'quests' ? parts[2] : null;
    if (!questId || !store.get(questId)) { sendJson(response, 404, { error: 'quest not found' }); return; }
    const source = requestSource(request);
    const actorSource = source;
    const by = String(body.by || (parts[3] === 'status' ? 'coordinator' : 'owner')).slice(0, 40);
    if (parts[3] === 'assign' || parts[3] === 'adopt') {
      const card = findCard(body.adventurer);
      if (!card) { sendJson(response, 400, { error: `no adventurer ${body.adventurer}` }); return; }
      const requestKey = body.requestKey === undefined || body.requestKey === null || body.requestKey === '' ? null : String(body.requestKey);
      if (requestKey !== null && !REQUEST_KEY_PATTERN.test(requestKey)) { sendJson(response, 400, { error: `requestKey must match ${REQUEST_KEY_PATTERN}` }); return; }
      const ifRevision = body.ifRevision === undefined || body.ifRevision === null || body.ifRevision === '' ? undefined : Number(body.ifRevision);
      if (ifRevision !== undefined && !Number.isInteger(ifRevision)) { sendJson(response, 400, { error: 'ifRevision must be an integer' }); return; }
      // F1: a plain assign on an already-posted review quest bypassed dispatcher.assign's own env (which
      // carries no evidenceOf, see dispatcher.js dispatchEnv), so the upstream-order policy was enforced only
      // by the web drop preview and the CLI's own pre-check — never by the server itself. Judge it here, with
      // the exact env buildSnapshot's own eligibility loop uses, so this verdict is byte-identical to the one
      // GET /api/quests already showed for this card. Never touches dispatcher.js or the queued recheckOpen
      // (that recheck's own dispatch becomes the project-wide latest and would make the parent's own
      // project-verification look stale against itself).
      //
      // R2-F1: this pre-check must not shadow dispatcher.assign's own idempotent-replay and stale-revision
      // answers (dispatcher.js repeated()/staleRevision(), checked in that order before canDispatch). A
      // requestKey that already matches a recorded dispatch, or a stale ifRevision, is answered exactly as on
      // MAIN — 200 {repeated:true} or {error:'stale'} — by skipping straight to dispatcher.assign below.
      // Otherwise, only an upstream_unverified reason is refused here; every other reason (including one this
      // route's own quest/quests read might disagree with, since it skips withFileSets' recheckingId and this
      // quest's own 'dispatched' exemption) is left for dispatcher.assign's own canDispatch to produce, so a
      // refusal here is never broader than what MAIN would have refused for a non-review quest.
      //
      // R2-F3: adopt stays ungated by this policy — it records a worker that is already running, not a fresh
      // dispatch decision, so there is nothing here for the upstream check to protect against.
      if (parts[3] === 'assign') {
        const quest = store.get(questId);
        if (quest.kind === 'review') {
          const alreadyDispatched = requestKey !== null && (quest.dispatches || []).some((d) => d.requestKey === requestKey);
          const staleRevisionSeen = ifRevision !== undefined && ifRevision !== (quest.revision || 0);
          if (!alreadyDispatched && !staleRevisionSeen) {
            const evidenceOf = makeEvidenceOf(config, store, getLanes()?.verification);
            const quests = withFileSets(config, store.list());
            const env = {
              treeLocked: lockPresent(config),
              laneIds: new Set(Object.keys(config.lanes)),
              evidenceOf,
              briefExists: briefExists(config, quest),
              briefUnusable: briefUnusable(config, quest),
              ...(downLanes ? { downLanes } : {}),
            };
            const verdict = canDispatch({ quest, adventurer: card, quests, policy: config.policy, env });
            const upstreamReasons = verdict.ok ? [] : verdict.reasons.filter((r) => r.code === 'upstream_unverified');
            if (upstreamReasons.length) { sendJson(response, 409, { error: 'refused', reasons: upstreamReasons }); return; }
          }
        }
      }
      const options = { requestKey, ifRevision };
      const result = parts[3] === 'assign' ? dispatcher.assign(questId, card, by, options) : dispatcher.adopt(questId, card, body.name, by, options);
      sendJson(response, result.status, result.body);
      return;
    }
    if (parts[3] === 'release') {
      const result = dispatcher.release(questId, actorSource, String(body.detail || '').slice(0, 2000), { source, ack: body.ack === true });
      sendJson(response, result.status, result.body);
      return;
    }
    if (parts[3] === 'cancel') {
      const result = await dispatcher.cancel(questId, source, body.reason || body.detail);
      sendJson(response, result.status, result.body);
      return;
    }
    if (parts[3] === 'resolve') {
      const result = dispatcher.resolve(questId, source, body.reason || body.detail, body.ack === true);
      sendJson(response, result.status, result.body);
      return;
    }
    if (parts[3] === 'status') {
      if (!MANUAL_STATUSES.has(body.status)) { sendJson(response, 400, { error: `status must be one of ${[...MANUAL_STATUSES].join('|')}; dispatch goes through assign` }); return; }
      try {
        // Feedback 15: an acceptance record is only ever built from THIS quest's own current-attempt evidence
        // (src/core/evidence.js), so a stale or fabricated ref cannot be stored, and `by` is the identity this
        // request was recorded under above — 'owner' for a board click (the client always sends it), never
        // overridable to 'coordinator' from the board.
        const acceptance = body.status === 'done' && body.acceptance !== undefined && body.acceptance !== null
          ? buildAcceptance(body.acceptance, {
            by,
            evidenceItems: questEvidence({
              config, quest: store.get(questId), verification: (getLanes() || {}).verification || null,
              latestDispatchAt: projectLatestDispatchAt(store.list()),
            }).items,
          })
          : undefined;
        sendJson(response, 200, { quest: store.setStatus(questId, body.status, { detail: body.detail || '', by: actorSource, source, ack: body.ack === true, ...(acceptance ? { acceptance } : {}) }) });
      } catch (error) {
        sendJson(response, 409, { error: 'refused', reasons: [{ code: error.code || 'status_refused', message: error.message }] });
      }
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
          const evidenceOf = makeEvidenceOf(config, store, snapshot().verification);
          const env = { treeLocked: lockPresent(config), laneIds: new Set(Object.keys(config.lanes)), evidenceOf, ...(downLanes ? { downLanes } : {}) };
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
    if (parts[3] === 'review-override') {
      // S3: records why the owner or coordinator is deliberately dispatching a review whose upstream check
      // would otherwise refuse it — never marks any evidence as passed. parentAttempts is computed here,
      // from the live store, never trusted from the request body: the client sends only the reason.
      const quest = store.get(questId);
      if (typeof body.reason !== 'string') { sendJson(response, 400, { error: '例外原因必须是文字' }); return; }
      const text = body.reason.trim();
      if (!text) { sendJson(response, 400, { error: '例外原因不能为空' }); return; }
      if (quest.kind !== 'review') { sendJson(response, 409, { error: `${questId} 不是审核委托，不能记录审核例外` }); return; }
      const evidenceOf = makeEvidenceOf(config, store, getLanes()?.verification);
      const nonReviewParents = (quest.parents || []).filter((id) => {
        const parent = store.get(id);
        return !parent || parent.kind !== 'review';
      });
      const parentAttempts = Object.fromEntries(nonReviewParents.map((id) => [id, evidenceOf(id)?.attemptId ?? null]));
      try {
        sendJson(response, 200, { quest: store.recordReviewOverride(questId, { reason: text, by, source, parentAttempts }) });
      } catch (error) {
        sendJson(response, 409, { error: error.message });
      }
      return;
    }
    if (parts[3] === 'metadata') {
      const ifRevision = body.ifRevision === undefined || body.ifRevision === null || body.ifRevision === '' ? undefined : Number(body.ifRevision);
      if (ifRevision !== undefined && !Number.isInteger(ifRevision)) { sendJson(response, 400, { error: 'ifRevision must be an integer' }); return; }
      let result;
      try {
        result = store.updateMetadata(questId, body, { by, ifRevision });
      } catch (error) {
        if (error.code === 'stale_revision') { sendJson(response, 409, { error: 'stale', revision: error.revision, reasons: [{ code: 'stale_revision', message: error.message }] }); return; }
        if (error.code === 'holds_slot') { sendJson(response, 409, { error: 'refused', reasons: [{ code: 'holds_slot', message: error.message }] }); return; }
        throw error;
      }
      if (result.errors) { sendJson(response, 400, { error: 'validation failed', fields: result.errors }); return; }
      sendJson(response, 200, { quest: result.quest });
      return;
    }
    if (parts[3] === 'send-back') {
      // FB2-02 item 2: one decision route for 退回重做. An annotation (or the owner's checkbox) calling for
      // the coordinator parks the quest in needs_coordinator with an inbox thread; anything else is the
      // ordinary ruling + back-to-posted the drawer used to do as two separate calls.
      const quest = store.get(questId);
      if (!quest) { sendJson(response, 404, { error: 'quest not found' }); return; }
      const reason = String(body.reason || '').trim().slice(0, 2000);
      if (!reason) { sendJson(response, 400, { error: '退回原因不能为空' }); return; }
      if (!['delivered', 'reviewing', 'needs_owner'].includes(quest.status)) {
        sendJson(response, 409, { error: 'refused', reasons: [{ code: 'send_back_status', message: `${questId} 现在是 ${quest.status}，只有已交差或复核中的任务能退回重做` }] });
        return;
      }
      const page = String(quest.reviewPage || '').trim();
      let items = [];
      if (page && config.reviewPages) {
        try {
          items = foldAnnotations(config, page);
        } catch (error) {
          sendJson(response, 409, { error: 'refused', reasons: [{ code: error.code || 'annotation_read', message: error.message }] });
          return;
        }
      }
      const mentioned = items.some((item) => /coordinator/i.test(`${item.note} ${item.verdict}`));
      const wantsCoordinator = body.needsCoordinator === true || mentioned;
      const rulingText = `退回重做：${reason}${wantsCoordinator ? '（需要 coordinator 处理）' : ''}`;
      store.rule(questId, { text: rulingText, by });
      replyOnThreads(questId, rulingText);
      if (wantsCoordinator) {
        const next = store.setStatus(questId, 'needs_coordinator', { detail: rulingText, by });
        if (boardStore) {
          boardStore.createThread({
            title: `${questId} 退回需要 coordinator`,
            body: `任务 ${questId}${page ? `（评审页 ${page}）` : ''}退回重做，需要 coordinator 处理。\n\n退回原因：${reason}${items.length ? `\n\n批注原文：\n${items.map((item) => `- ${item.note || item.verdict || item.id}`).join('\n')}` : ''}`,
            author: by,
            tags: ['question', questId],
          });
        }
        sendJson(response, 200, { quest: next, routed: 'needs_coordinator' });
        return;
      }
      const next = store.setStatus(questId, 'posted', { detail: rulingText, by });
      sendJson(response, 200, { quest: next, routed: 'posted' });
      return;
    }
    if (parts[3] === 'hand-to-coordinator') {
      // FB2-02 item 4: 交给 coordinator 重写 brief — one question thread naming the card, nothing else moves.
      const quest = store.get(questId);
      if (!quest) { sendJson(response, 404, { error: 'quest not found' }); return; }
      if (!boardStore) { sendJson(response, 503, { error: 'board unavailable' }); return; }
      const note = String(body.note || '').trim().slice(0, 2000);
      const created = boardStore.createThread({
        title: `重写 brief：${questId}`,
        body: `卡片 ${questId} 的简报需要 coordinator 重写。${note ? `\n\n${note}` : ''}`,
        author: by,
        tags: ['question', questId],
      });
      if (created.errors) { sendJson(response, 400, { error: 'validation failed', fields: created.errors }); return; }
      sendJson(response, 200, { thread: created.thread });
      return;
    }
    if (parts[3] === 'owner-ruling') {
      // FB2-02 item 6: the owner's saved verdict over a review page. needs_owner -> owner_ruled, the counts
      // and the annotation texts themselves go to the coordinator inbox, and an all-pass art quest then
      // waits for the coordinator to import (rules.js refuses the drag and says so).
      const quest = store.get(questId);
      if (!quest) { sendJson(response, 404, { error: 'quest not found' }); return; }
      if (quest.status !== 'needs_owner') {
        sendJson(response, 409, { error: 'refused', reasons: [{ code: 'owner_ruling_status', message: `${questId} 现在是 ${quest.status}，只有等你裁决的任务能保存评审结论` }] });
        return;
      }
      const page = String(quest.reviewPage || '').trim();
      if (!page || !config.reviewPages) {
        sendJson(response, 409, { error: 'refused', reasons: [{ code: 'owner_ruling_no_page', message: `${questId} 没有评审页，没法按批注下结论` }] });
        return;
      }
      let items;
      try {
        items = foldAnnotations(config, page);
      } catch (error) {
        sendJson(response, 409, { error: 'refused', reasons: [{ code: error.code || 'annotation_read', message: error.message }] });
        return;
      }
      const summary = summarizeAnnotations(items);
      const counts = `通过 ${summary.pass} / 不行 ${summary.fail} / 需要修改 ${summary.fix}${summary.other ? ` / 未表态 ${summary.other}` : ''}`;
      const detail = `评审结论：${counts}（评审页 ${page}）`;
      const next = store.setStatus(questId, 'owner_ruled', { detail, by });
      if (boardStore) {
        boardStore.createThread({
          title: `${questId} 评审结论已保存`,
          body: `任务 ${questId}（评审页 ${page}）的评审结论：${counts}。${items.length ? `\n\n批注原文：\n${items.map((item) => `- [${item.verdict || '未表态'}] ${item.note || item.id}`).join('\n')}` : ''}`,
          author: by,
          tags: ['note', questId],
        });
      }
      sendJson(response, 200, { quest: next, summary });
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
    if (parts[0] === 'api' && parts[1] === 'roster' && parts[2] === 'bulk') return rosterBulkRoutes.handle(request, response, url, parts);
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
          // Additive provenance for feedback 39: the current attempt's immutable review annotation capture.
          // Historical captures remain on their dispatches entries; legacy and non-art attempts answer null.
          annotationSnapshot: quest.assignee?.annotationSnapshot || null,
          // FB2-02 item 6: the review page's annotation summary rides the detail read so `get` can
          // print count + first notes. A broken log is loud in-band ({page, error}), never silently absent.
          annotationSummary: (() => {
            const page = String(quest.reviewPage || '').trim();
            if (!page || !config.reviewPages) return null;
            try {
              const items = foldAnnotations(config, page);
              const counts = summarizeAnnotations(items);
              return {
                page, ...counts,
                first: items.slice(0, 3).map((item) => ({ verdict: item.verdict || '', note: String(item.note || '').slice(0, 200) })),
              };
            } catch (error) {
              return { page, error: error.message };
            }
          })(),

          roleCard: quest.assignee?.roleCard || null,
          live: quest.assignee ? snap.live[quest.assignee.name] || null : null,
          threads: snap.threads[quest.id] || [],
          eligibility: eligibilitySummary(snap.eligibility[quest.id]),
          // The attempt's own report reference/verdict/summary (item 7/12/34). Read from the raw stored quest,
          // not the snapshot row: the snapshot carries only the pruned reference. Legacy rows and stale attempts
          // return null, which the surfaces render as 报告不可用.
          report: questReportView(store.get(quest.id)),
          // S2: structured, attempt-bound evidence (src/core/evidence.js) — additive, read-only, never part
          // of the snapshot fan-out. Uses the same raw stored quest as `report` above so the attempt identity
          // (assignee/dispatches) and the captured report reference agree.
          evidence: questEvidence({ config, quest: store.get(quest.id), verification: snap.verification, latestDispatchAt: projectLatestDispatchAt(store.list()) }),
          // S3: null for anything but a review quest — see reviewUpstreamEvidence. Drives the drawer's own
          // 上游证据 block independently of which card (if any) is selected, and independently of the
          // per-adventurer eligibility warnings the board's drop preview already shows.
          upstreamReview: reviewUpstreamEvidence({ quest, quests: snap.quests, policy: config.policy, env: { evidenceOf: makeEvidenceOf(config, store, snap.verification) } }),
          // Requirement 5/R3: a sanitized, process-local, explicitly not restart-durable diagnostic — this
          // process still remembers a session id for the quest's current attempt that its own durable
          // record does not (yet, or ever) confirm. null once there is nothing to report, or once a later
          // durable write makes it current again. Never secrets/commands/env/raw error text.
          unpersistedSession: quest.assignee ? dispatcher.getUnpersistedSession(quest.id, quest.assignee.attemptId) : null,
        } });
      } else if (parts[1] === 'quests' && parts.length === 4 && parts[3] === 'report' && request.method === 'GET') {
        // The full report text of the current attempt, bounded (see core/reportEvidence.js) and served as
        // plain text so it can never execute: no HTML rendering, no scripts, same no-store/nosniff headers
        // as every other read. The reference is re-checked and the digest re-verified on every read; a file
        // that changed after it was captured is refused (409) rather than shown as if it were that report.
        const quest = store.get(parts[2]);
        if (!quest) { sendJson(response, 404, { error: 'quest not found' }); return true; }
        const view = questReportView(quest);
        if (!view) { sendJson(response, 404, { error: '报告不可用：这次派遣没有留下报告引用' }); return true; }
        if (view.source === 'none') { sendJson(response, 404, { error: `报告不可用：${view.reason}` }); return true; }
        const read = readCapturedReport(config, view);
        if (!read.ok) { sendJson(response, read.code === 'changed' ? 409 : 404, { error: read.reason }); return true; }
        const body = Buffer.from(read.text, 'utf8');
        response.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-length': body.length,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'x-report-digest': read.digest,
          ...(read.truncated ? { 'x-report-truncated': '1' } : {}),
        });
        response.end(body);
      } else if (parts[1] === 'quests' && parts.length === 6 && parts[3] === 'hooks' && parts[5] === 'log' && request.method === 'GET') {
        const quest = store.get(parts[2]);
        if (!quest) { sendJson(response, 404, { error: 'quest not found' }); return true; }
        const hook = (config.verification?.hooks || []).find((candidate) => candidate.id === parts[4]);
        const attempt = attemptOf(quest);
        if (!hook || !attempt?.attemptId) { sendJson(response, 404, { error: 'verification hook log not found' }); return true; }
        const logPath = hookLogRelativePath(config, quest.id, attempt.attemptId, hook.id);
        const record = [...(attempt.hooks || [])].reverse().find((candidate) => candidate.attemptId === attempt.attemptId && candidate.logPath === logPath);
        const read = record?.logPath ? readHookLog(config, record.logPath) : null;
        if (!read) { sendJson(response, 404, { error: 'verification hook log not found' }); return true; }
        response.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-length': read.body.length,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          ...(read.truncated ? { 'x-hook-truncated': '1' } : {}),
        });
        response.end(read.body);
      } else if (url.pathname === '/api/roster' && request.method === 'GET') {
        sendJson(response, 200, { adventurers: effectiveRoster(adventurers(), getLanes()) });
      } else if (url.pathname === '/api/lanes' && request.method === 'GET') {
        const lanes = getLanes() || { packages: [], laneLimits: {}, verification: null };
        // B5: the history tab reads this route, so it must hide the same cleared limits the snapshot hides.
        const laneLimits = visibleLaneLimits(lanes.laneLimits, effectiveRoster(adventurers(), lanes)).laneLimits;
        sendJson(response, 200, { ...lanes, laneLimits, board: { openQuestions: boardStore ? boardStore.listThreads({ status: 'open', tag: 'question' }).length : 0 } });
      } else if (request.method === 'POST') {
        const refusal = writeRefusal(request);
        if (refusal) sendJson(response, 403, { error: refusal }); else await post(request, response, parts);
      } else {
        sendJson(response, 404, { error: 'not found' });
      }
    } catch (error) {
      if (!response.headersSent) sendJson(response, error.code === 'request_too_large' ? 413 : 400, { error: error.code === 'request_too_large' ? '请求内容太大' : error.message });
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

  return { handle, start, stop, applyLanes, snapshot, refreshLaneHealth, verifyProcessTree: (candidate) => dispatcher.verifyProcessTree(candidate) };
}
