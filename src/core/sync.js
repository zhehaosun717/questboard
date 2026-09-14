// Derives quest status changes from the lane collector. Pure: returns the transitions; the server applies
// them through the store so every change reaches the events file once.

const LANE_TO_QUEST = { delivered: 'delivered', failed: 'failed', bounced: 'bounced', superseded: 'bounced', stalled: 'stalled' };
const CLOCK_SKEW_MS = 60 * 1000;
// Every dispatch script registers itself before starting its worker, so a worker still absent after this
// long never started, or a later hand dispatch of the package replaced it.
export const NO_ROW_MS = 10 * 60 * 1000;

// An adopted worker was started before the board recorded it, so its registry row is older than the
// adoption; the worker name is its identity.
function isCurrentRow(row, assignee) {
  if (assignee.adopted) return true;
  return !row.dispatchedAt || Date.parse(row.dispatchedAt) >= Date.parse(assignee.at) - CLOCK_SKEW_MS;
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
  if (row.reason) parts.push(row.reason);
  if (row.bounceUntil) parts.push(`${row.bounceUntil} 恢复`);
  if (row.lastText) parts.push(tailText(row.lastText));
  return parts.join(' | ');
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
    if (!row || !isCurrentRow(row, quest.assignee)) {
      if (!silent && now - Date.parse(quest.assignee.at) > NO_ROW_MS) {
        transitions.push({ id: quest.id, status: 'stalled', detail: `派出 10 分钟后登记表里仍没有 worker ${quest.assignee.name}：脚本没有登记，或这个包被手动重派了` });
      }
      continue;
    }
    if (silent && row.state === 'running') {
      transitions.push({ id: quest.id, status: 'dispatched', detail: `worker ${quest.assignee.name} 又有动静了` });
      continue;
    }
    const status = LANE_TO_QUEST[row.state];
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
    live[row.name] = { state: row.state, elapsed: row.elapsed, edits: row.edits, lastText: tailText(row.lastText), tokens: row.tokens || null };
  }
  return live;
}
