// questboard tools for agents. Writes go through the running board server (one writer per project); the
// events tool reads the events file directly, so it works while the server restarts.
import { eventsAfter, readEvents } from '../core/events.js';
import { StatusLog, STATUSES } from '../core/status.js';
import { QUEST_STATUSES, KINDS } from '../core/store.js';

const MANUAL_STATUSES = [...QUEST_STATUSES].filter((status) => status !== 'dispatched');
const idList = { type: 'array', items: { type: 'string' } };
const read = { readOnlyHint: true, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

function required(args, fields) {
  const missing = fields.filter((field) => args[field] === undefined || args[field] === null || args[field] === '');
  if (missing.length) throw new Error(`missing required argument${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
}

function questSummary(quest) {
  return {
    id: quest.id, status: quest.status, kind: quest.kind, priority: quest.priority, title: quest.title, revision: quest.revision || 0,
    ...(quest.assignee ? { assignee: `${quest.assignee.model} (${quest.assignee.name})` } : {}),
    ...(quest.needsOwner ? { needsOwner: quest.needsOwner } : {}),
    ...(quest.parents.length ? { parents: quest.parents } : {}),
    ...(quest.cancelRequest ? { cancelRequest: quest.cancelRequest } : {}),
    ...(quest.manualResolution ? { manualResolution: quest.manualResolution } : {}),
  };
}

// Groups refusals by message so one "queued behind RUN-4" line covers every card it applies to.
function eligibilitySummary(verdicts) {
  const canTake = [];
  const refused = {};
  for (const [card, verdict] of Object.entries(verdicts || {})) {
    if (verdict.ok) { canTake.push(card); continue; }
    for (const reason of verdict.reasons) (refused[reason.message] = refused[reason.message] || []).push(card);
  }
  return { canTake, refused };
}

export function createTools({ config, base, author, home, request }) {
  const api = (route, method, body) => request(base, route, method, body, { source: method && method !== 'GET' ? 'mcp' : undefined });
  const snapshot = () => api('/api/quests');

  return [
    {
      name: 'questboard_list_quests',
      title: 'List quests',
      description: `List quests on the ${config.name} board, optionally filtered by status or kind. Returns id, status, kind, priority, title, assignee and any open owner question.`,
      inputSchema: { type: 'object', properties: { status: { type: 'string', enum: [...QUEST_STATUSES] }, kind: { type: 'string', enum: [...KINDS] } } },
      annotations: read,
      handler: async (args) => {
        const { quests } = await snapshot();
        return quests.filter((q) => (!args.status || q.status === args.status) && (!args.kind || q.kind === args.kind)).map(questSummary);
      },
    },
    {
      name: 'questboard_get_quest',
      title: 'Get a quest',
      description: 'One quest with its history, the files its brief may edit, linked message-board threads, live worker output, and which cards may take it right now (refusals grouped by reason).',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Package id, e.g. RUN-4' } }, required: ['id'] },
      annotations: read,
      handler: async (args) => {
        required(args, ['id']);
        const snap = await snapshot();
        const quest = snap.quests.find((q) => q.id === args.id);
        if (!quest) throw new Error(`no quest ${args.id} on the board`);
        return { ...quest, live: quest.assignee ? snap.live[quest.assignee.name] || null : null, threads: snap.threads[quest.id] || [], eligibility: eligibilitySummary(snap.eligibility[quest.id]) };
      },
    },
    {
      name: 'questboard_post_quest',
      title: 'Post a quest',
      description: 'Post or update a quest for a written brief. Check here, at posting time, what the owner should not have to think about: parents (what it follows), conflicts (packages that must not run at the same time), allowed lanes, and an owner question that must be answered before dispatch.',
      inputSchema: {
        type: 'object',
        properties: {
          package: { type: 'string', description: 'Package id matching the project pattern, e.g. RUN-4' },
          brief: { type: 'string', description: `Brief path inside ${config.briefs.dispatchDirs.join(' or ')}` },
          kind: { type: 'string', enum: [...KINDS], default: 'code' },
          title: { type: 'string' },
          parents: idList, conflicts: idList,
          allowedLanes: { type: 'array', items: { type: 'string', enum: Object.keys(config.lanes) } },
          priority: { type: 'integer', enum: [1, 2, 3], default: 2 },
          needsOwner: { type: 'string', description: 'A question the owner must rule on before dispatch' },
          reviewPage: { type: 'string' },
        },
        required: ['package'],
      },
      annotations: { ...write, idempotentHint: true },
      handler: async (args) => {
        required(args, ['package']);
        return questSummary((await api('/api/quests', 'POST', { ...args, by: author })).quest);
      },
    },
    {
      name: 'questboard_update_metadata',
      title: 'Correct a posted quest',
      description: 'Revision-guarded correction of title, brief, parents, conflicts, allowedLanes or needsOwner on a quest that does not hold a worker\'s slot — never status or assignee, those only change through set_quest_status/assign/adopt/release, and any other field is refused with an error naming it. Only fields you pass are touched; a field left out stays exactly as it was. Pass ifRevision (from get_quest) so a quest changed since you read it is refused as stale (409) instead of clobbered; refused (409) while a worker holds the quest\'s slot, release it first. A posted review\'s own parent is fixed, and so is every ancestor its parent chain reaches (at any depth) and that ancestor\'s kind — clearing, reparenting or kind-switching any of them is always refused, permanently, even once the review is cancelled; post a new, correctly linked quest (and review, if needed) instead.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          brief: { type: 'string', description: `Brief path inside ${config.briefs.dispatchDirs.join(' or ')}` },
          parents: idList, conflicts: idList,
          allowedLanes: { type: 'array', items: { type: 'string', enum: Object.keys(config.lanes) } },
          needsOwner: { type: 'string' },
          ifRevision: { type: 'integer', description: 'The quest revision you decided on' },
        },
        required: ['id'],
      },
      annotations: write,
      handler: async (args) => {
        required(args, ['id']);
        const { id, ifRevision, ...fields } = args;
        const body = await api(`/api/quests/${encodeURIComponent(id)}/metadata`, 'POST', { ...fields, by: author, ifRevision });
        return questSummary(body.quest);
      },
    },
    {
      name: 'questboard_set_quest_status',
      title: 'Set a quest status',
      description: 'Move a quest after verification or a decision: done, delivered, reviewing, needs_owner, owner_playtest, lane_limited, superseded, cancelled, failed. Dispatch itself only happens through assign or adopt.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: MANUAL_STATUSES }, detail: { type: 'string' }, ack: { type: 'boolean' } }, required: ['id', 'status'] },
      annotations: write,
      handler: async (args) => {
        required(args, ['id', 'status']);
        return questSummary((await api(`/api/quests/${encodeURIComponent(args.id)}/status`, 'POST', { status: args.status, detail: args.detail || '', ack: args.ack === true, by: author })).quest);
      },
    },
    {
      name: 'questboard_record_ruling',
      title: 'Record an owner ruling',
      description: "Record the owner's answer to a quest's open question. Releases the quest for dispatch and replies on linked message-board threads. Only record what the owner actually said.",
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] },
      annotations: write,
      handler: async (args) => {
        required(args, ['id', 'text']);
        return questSummary((await api(`/api/quests/${encodeURIComponent(args.id)}/ruling`, 'POST', { text: args.text, by: author })).quest);
      },
    },
    {
      name: 'questboard_assign',
      title: 'Dispatch a card onto a quest',
      description: 'Run a card (model) on a quest now. This starts a real worker and may spend money; the owner normally does this by dragging on the board. Refusals come back with every reason. Always pass a requestKey you made up for this attempt: if the call is retried with the same key, the board answers with the existing attempt instead of starting a second worker. Pass ifRevision (from get_quest) so a quest that changed since you read it is refused as stale.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, adventurer: { type: 'string', description: 'Card id, e.g. codex-luna' }, requestKey: { type: 'string', description: 'Your own id for this attempt, e.g. run4-2026-09-13-a' }, ifRevision: { type: 'integer', description: 'The quest revision you decided on' } }, required: ['id', 'adventurer'] },
      annotations: { ...write, openWorldHint: true },
      handler: async (args) => {
        required(args, ['id', 'adventurer']);
        const body = await api(`/api/quests/${encodeURIComponent(args.id)}/assign`, 'POST', { adventurer: args.adventurer, by: author, requestKey: args.requestKey, ifRevision: args.ifRevision });
        return { ...questSummary(body.quest), ...(body.repeated ? { repeated: true, note: 'this requestKey was already dispatched; nothing new was started' } : {}) };
      },
    },
    {
      name: 'questboard_adopt',
      title: 'Adopt a worker started by hand',
      description: 'Record a worker you already started with the dispatch script, so the board tracks it and nobody dispatches the quest twice. Runs nothing.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, adventurer: { type: 'string' }, name: { type: 'string', description: 'The worker name given to the dispatch script, e.g. run3' }, requestKey: { type: 'string', description: 'Your own id for this attempt; a retry with the same key is answered, not recorded twice' } }, required: ['id', 'adventurer', 'name'] },
      annotations: write,
      handler: async (args) => {
        required(args, ['id', 'adventurer', 'name']);
        const body = await api(`/api/quests/${encodeURIComponent(args.id)}/adopt`, 'POST', { adventurer: args.adventurer, name: args.name, by: author, requestKey: args.requestKey });
        return { ...questSummary(body.quest), ...(body.repeated ? { repeated: true } : {}) };
      },
    },
    {
      name: 'questboard_release_worker',
      title: 'Release a silent worker',
      description: 'Free a stalled quest whose worker you have confirmed is gone (process exited, session dead). Silence alone does not free a quest: until released, its slot and file reservations stay held and nobody can be dispatched onto it. Say in detail how you confirmed it stopped.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, detail: { type: 'string', description: 'How you confirmed the worker stopped' } }, required: ['id', 'detail'] },
      annotations: write,
      handler: async (args) => {
        required(args, ['id', 'detail']);
        return questSummary((await api(`/api/quests/${encodeURIComponent(args.id)}/release`, 'POST', { detail: args.detail, ack: true, by: author })).quest);
      },
    },
    {
      name: 'questboard_cancel_worker',
      title: 'Request worker cancellation',
      description: 'Request one cooperative cancellation for the current attempt. The request is durable and keeps the slot until matching scoped evidence arrives; unsupported lanes return manual_required instead of pretending the worker stopped.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id', 'reason'] },
      annotations: write,
      handler: async (args) => {
        required(args, ['id', 'reason']);
        const body = await api(`/api/quests/${encodeURIComponent(args.id)}/cancel`, 'POST', { reason: args.reason });
        return { ...questSummary(body.quest), result: body.result };
      },
    },
    {
      name: 'questboard_resolve_worker',
      title: 'Resolve a worker manually',
      description: 'Free a held worker only after an explicit acknowledgement and a non-empty reason. This records a durable manualResolution with the MCP source and current attempt.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' }, ack: { type: 'boolean' } }, required: ['id', 'reason', 'ack'] },
      annotations: write,
      handler: async (args) => {
        required(args, ['id', 'reason', 'ack']);
        if (args.ack !== true) throw new Error('ack must be true for manual resolution');
        return questSummary((await api(`/api/quests/${encodeURIComponent(args.id)}/resolve`, 'POST', { reason: args.reason, ack: true })).quest);
      },
    },
    {
      name: 'questboard_list_cards',
      title: 'List cards',
      description: 'Every card (model) with its lane, model id, parallel limit and current status — including why and since when, and limits detected from worker output.',
      inputSchema: { type: 'object', properties: { status: { type: 'string', enum: STATUSES } } },
      annotations: read,
      handler: async (args) => {
        const { adventurers } = await api('/api/roster');
        return adventurers.filter((a) => !args.status || a.status === args.status).map((a) => ({
          id: a.id, name: a.name, lane: a.lane, model: a.model, variant: a.variant, maxParallel: a.maxParallel || 1, status: a.status,
          ...(a.statusReason ? { reason: a.statusReason } : {}), ...(a.statusSince ? { since: a.statusSince } : {}), ...(a.derived ? { detected: a.derived.reason } : {}),
        }));
      },
    },
    {
      name: 'questboard_set_card_status',
      title: 'Set a card status',
      description: 'Record that a model is limited, out of balance, paused or disabled — or available again — with a reason the owner will read on the card. Limits detected from worker output heal by themselves; use this for what the board cannot see.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: STATUSES }, reason: { type: 'string' } }, required: ['id', 'status'] },
      annotations: { ...write, idempotentHint: true },
      handler: async (args) => {
        required(args, ['id', 'status']);
        return { id: args.id, ...new StatusLog(home.status).set(args.id, { status: args.status, reason: args.reason || '', setBy: author }) };
      },
    },
    {
      name: 'questboard_events',
      title: 'Read recent events',
      description: 'Board events: posted, assigned, dispatched, delivered, failed, bounced, stalled, released, cancelled, owner_ruling and more. Every event has a seq. To read without missing any, pass the last seq you saw as `after` (oldest first, up to limit); `since` (ISO time, newest last) is the older way and can skip events written in the same second.',
      inputSchema: { type: 'object', properties: { after: { type: 'integer', minimum: 0, description: 'Only events with seq greater than this; 0 = from the start' }, since: { type: 'string', description: 'ISO time; only later events' }, package: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 } } },
      annotations: read,
      handler: async (args) => {
        if (args.after !== undefined) return eventsAfter(config.paths.events, { after: args.after, limit: args.limit || 50, pkg: args.package || null });
        return readEvents(config.paths.events)
          .filter((e) => (!args.since || e.at > args.since) && (!args.package || e.package === args.package))
          .slice(-(args.limit || 50));
      },
    },
    {
      name: 'questboard_board_post',
      title: 'Post on the message board',
      description: 'Start a message-board thread, for example a question for the owner. One thread per decision; plain text, no Markdown. Tag questions with "question" and the package id.',
      inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['title', 'body'] },
      annotations: write,
      handler: async (args) => {
        required(args, ['title', 'body']);
        const { thread } = await api('/api/threads', 'POST', { title: args.title, body: args.body, tags: args.tags || [], author });
        return { id: thread.id, title: thread.title };
      },
    },
    {
      name: 'questboard_board_reply',
      title: 'Reply on the message board',
      description: 'Reply on an existing message-board thread.',
      inputSchema: { type: 'object', properties: { thread: { type: 'string' }, body: { type: 'string' } }, required: ['thread', 'body'] },
      annotations: write,
      handler: async (args) => {
        required(args, ['thread', 'body']);
        const { thread } = await api(`/api/threads/${encodeURIComponent(args.thread)}/messages`, 'POST', { body: args.body, author });
        return { id: thread.id, messages: thread.messageCount };
      },
    },
    {
      name: 'questboard_board_inbox',
      title: 'Read the message-board inbox',
      description: 'Messages written by others since a cursor. Keep the returned nextCursor and pass it as since next time.',
      inputSchema: { type: 'object', properties: { since: { type: 'string' } } },
      annotations: read,
      handler: async (args) => {
        const params = new URLSearchParams({ for: author, ...(args.since ? { since: args.since } : {}) });
        return api(`/api/inbox?${params}`);
      },
    },
  ];
}
