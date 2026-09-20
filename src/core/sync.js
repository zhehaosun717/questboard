// Derives quest status changes from the lane collector. Pure: returns the transitions; the server applies
// them through the store so every change reaches the events file once.
import { attemptEvidence } from './cancellation.js';

const LANE_TO_QUEST = { delivered: 'delivered', failed: 'failed', bounced: 'bounced', superseded: 'bounced', stalled: 'stalled' };
const CLOCK_SKEW_MS = 60 * 1000;
// Every dispatch script registers itself before starting its worker, so a worker still absent after this
// long never started, or a later hand dispatch of the package replaced it.
export const NO_ROW_MS = 10 * 60 * 1000;

// An adopted worker was started before the board recorded it, so its registry row is older than the
// adoption; the worker name is its identity. That does not make the name itself permanently trusted,
// though: a row registered well *after* the adoption is some later, unrelated dispatch reusing the same
// name, not this adopted worker — adopted only widens the window backwards, not forwards without bound.
// The most recent *distinct* attempt this quest's own history recorded under the same name as `assignee`
// (skipped when it's the same attempt, matched by attemptId when both sides have one, else by `at`) — a
// same-quest re-adopt reusing a name is the only way this ever finds anything, since dispatch.js never hands
// out a name that collides with recordedNames() and dispatcher.js's adopt() now refuses that same reuse.
function priorAttemptFor(quest, assignee) {
  let latest = null;
  for (const dispatch of (quest && quest.dispatches) || []) {
    if (!dispatch || dispatch.name !== assignee.name || !dispatch.at) continue;
    const isCurrent = dispatch.attemptId && assignee.attemptId ? dispatch.attemptId === assignee.attemptId : dispatch.at === assignee.at;
    if (isCurrent) continue;
    if (!latest || Date.parse(dispatch.at) > Date.parse(latest.at)) latest = dispatch;
  }
  return latest;
}

export function isCurrentRow(row, assignee, quest) {
  // A row with no dispatchedAt has nothing to compare against a fresh attempt's own `at` — trusting it
  // unconditionally is only ever legitimate for an adopted worker, whose registry row predates the board
  // recording it at all (see the adopted branch below), never for a brand-new, timestamped attempt: an
  // unrelated legacy row that happens to reuse the same name must not end an attempt it never touched.
  if (!row.dispatchedAt) return Boolean(assignee.adopted);
  const rowAt = Date.parse(row.dispatchedAt);
  const at = Date.parse(assignee.at);
  // A row dated at or before a distinct earlier attempt's own start is that attempt's evidence, not this
  // one's, no matter how the current attempt was registered — reusing a worker name across attempts must
  // never let an old attempt's outcome bleed into whatever reused its name next.
  const prior = priorAttemptFor(quest, assignee);
  if (prior && rowAt <= Date.parse(prior.at) + CLOCK_SKEW_MS) return false;
  if (assignee.adopted) return rowAt <= at + CLOCK_SKEW_MS;
  return rowAt >= at - CLOCK_SKEW_MS;
}

// The end of a worker's output, cut to size. A bare slice(-300) cut mid-word and read as a typo ("trictly
// follow"), so the cut moves past the first space when one is near, and an ellipsis marks that text is missing.
export function tailText(text, max = 300) {
  const value = String(text || '');
  if (value.length <= max) return value;
  const tail = value.slice(-max);
  const space = tail.search(/\s/);
  return `…${(space >= 0 && space < 40 ? tail.slice(space + 1) : tail).trimStart()}`;
}

function detailFor(row) {
  const parts = [];
  if (row.limitReason && row.reason !== row.limitReason) parts.push(row.limitReason);
  else if (row.reason) parts.push(row.reason);
  if (row.bounceUntil) parts.push(`${row.bounceUntil} 恢复`);
  if (row.lastText) parts.push(tailText(row.lastText));
  if (row.manualRequired) parts.push('无法自动停止，请手动处理');
  return parts.join(' | ');
}

function alreadyStalledForLimit(quest, limitReason) {
  if (quest.status !== 'stalled' || typeof quest.lastDetail !== 'string') return false;
  return quest.lastDetail === limitReason || quest.lastDetail.startsWith(`${limitReason} |`);
}

export function deriveTransitions(quests, laneRows, now = Date.now()) {
  const byName = new Map();
  for (const row of laneRows || []) if (row && row.name) byName.set(row.name, row);
  const transitions = [];
  for (const quest of quests) {
    // A stalled quest still has its worker: watch it too, so it goes back to work when output resumes
    // and finishes when an exit file appears.
    const silent = quest.status === 'stalled';
    if ((quest.status !== 'dispatched' && !silent) || !quest.assignee || !quest.assignee.name) continue;
    const row = byName.get(quest.assignee.name);
    if (!row || !isCurrentRow(row, quest.assignee, quest)) {
      if (!silent && now - Date.parse(quest.assignee.at) > NO_ROW_MS) {
        transitions.push({ id: quest.id, status: 'stalled', detail: `派出 10 分钟后登记表里仍没有 worker ${quest.assignee.name}：脚本没有登记，或这个包被手动重派了` });
      }
      continue;
    }
    if (silent && row.state === 'running') {
      transitions.push({ id: quest.id, status: 'dispatched', detail: `worker ${quest.assignee.name} 又有动静了` });
      continue;
    }
    if (row.cancelRequestId && row.cancelScope === 'direct-child' && quest.cancelRequest?.requestId === row.cancelRequestId) {
      // Once this exact scoped exit has been recorded, a later collector poll is only a replay. Leave the
      // store untouched; this also keeps applyLanes from needing to rewrite the same acknowledgement.
      if (quest.cancelRequest.result === 'stopped_by_wrapper'
        && quest.cancelRequest.evidence?.exitRequestId === row.cancelRequestId
        && quest.cancelRequest.evidence?.scope === row.cancelScope) continue;
      transitions.push({
        // This exit record is scoped wrapper evidence, not ordinary terminal evidence. The store records it
        // while keeping the attempt dispatched/stalled; treating it as failed/delivered here would release
        // file reservations while a descendant of the wrapper can still be editing.
        id: quest.id, status: quest.status, detail: '包装脚本已确认停下它直接启动的进程（更深一层的进程不保证已停，委托仍占着）',
        cancellationResult: 'stopped_by_wrapper',
        evidence: {
          kind: 'collector', attempt: attemptEvidence(quest.assignee),
          ack: true, exitRequestId: row.cancelRequestId, scope: 'direct-child',
        },
      });
      continue;
    }
    const status = LANE_TO_QUEST[row.state];
    // A terminal exit/session result is authoritative even when the row also carries a stale bound reason.
    // Bounds are for non-terminal observations; they must never hide a finished worker from a silent quest.
    if (status && status !== 'stalled') {
      // A stream-json result row carries the extracted report text (FB2-01.3): the collector stays
      // read-only, so the write into <outputDir>/<name>.md is the dispatcher's job, keyed off this field.
      transitions.push({ id: quest.id, status, detail: detailFor(row), ...(row.streamResult ? { streamResult: row.streamResult } : {}) });
      continue;
    }
    const detail = detailFor(row);
    if (row.limitReason && !quest.cancelRequest && !alreadyStalledForLimit(quest, row.limitReason)) {
      transitions.push({ id: quest.id, status: 'stalled', detail, limitReason: row.limitReason, manualRequired: row.manualRequired === true });
      continue;
    }
    if (status && !(silent && status === 'stalled')) transitions.push({ id: quest.id, status, detail: detailFor(row) });
  }
  return transitions;
}

export function liveByName(laneRows, quests = []) {
  const assignees = new Map();
  for (const quest of quests) if (quest.assignee && quest.assignee.name) assignees.set(quest.assignee.name, quest.assignee);
  const live = {};
  for (const row of laneRows || []) {
    if (!row || !row.name) continue;
    const assignee = assignees.get(row.name);
    if (!assignee || !isCurrentRow(row, assignee)) continue;
    const liveRow = { state: row.state, elapsed: row.elapsed, edits: row.edits, lastText: tailText(row.lastText), tokens: row.tokens || null };
    if (Object.hasOwn(row, 'heartbeat')) liveRow.heartbeat = row.heartbeat;
    live[row.name] = liveRow;
  }
  return live;
}
