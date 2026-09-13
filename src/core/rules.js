// Pure dispatch guard. A refusal must be visible before the action, so the board computes these reasons
// for every adventurer on every quest and shows the message on the card before the drop.

export const OPEN_STATUSES = new Set(['posted', 'failed', 'bounced', 'stalled', 'lane_limited']);
export const RUNNING_STATUS = 'dispatched';

const MESSAGES = {
  owner_quest: () => '这是你亲自做的任务，不派给模型',
  quest_not_open: (quest) => `任务状态是「${quest.status}」，不能接`,
  needs_owner: (quest) => `等你先裁决：${quest.needsOwner}`,
  parent_missing: (quest, adventurer, detail) => `父任务 ${detail} 不在板上，先让 coordinator 发布它`,
  lane_missing: (quest, adventurer) => `这个项目没有配置 ${adventurer.lane} 通道`,
  adventurer_limited: () => '这个模型限额中',
  adventurer_broke: () => '这个供应商余额不足',
  adventurer_paused: () => '这个模型被暂停使用',
  adventurer_disabled: () => '这个模型已停用',
  model_banned: (quest, adventurer) => `模型 ${adventurer.model} 在禁用名单里`,
  agent_banned: (quest, adventurer) => `人格 ${adventurer.agent} 在禁用名单里`,
  lane_not_allowed: (quest) => `coordinator 只允许这些通道：${quest.allowedLanes.join('、')}`,
  adventurer_busy: (quest, adventurer) => `已在做 ${adventurer.maxParallel || 1} 个任务，满了`,
  reviewer_coded_parent: (quest, adventurer, detail) => `同一模型写过被审核的 ${detail}，不能自己审自己`,
  // Most packages in a design round share a partial, so a conflict reads as a queue, not an error.
  conflict_running: (quest, adventurer, detail) => `排队：${detail.id} 正在改同一批文件${detail.file ? `（${detail.file.split('/').filter(Boolean).pop() || detail.file}）` : ''}，一次一个`,
  needs_artist: () => '美术委托只派给会画图的模型（strengths 含 art）',
  tree_locked: () => 'coordinator 正在跑验证（锁文件存在），暂停派遣',
  brief_missing: (quest) => `找不到 brief 文件：${quest.brief || '（未填写）'}`,
};

function reason(code, quest, adventurer, detail) {
  return { code, message: MESSAGES[code](quest, adventurer, detail) };
}

function matchesAny(value, patterns) {
  if (!value) return false;
  return (patterns || []).some((pattern) => new RegExp(pattern, 'i').test(value));
}

function busyCount(adventurerId, quests) {
  return quests.filter((q) => q.status === RUNNING_STATUS && q.assignee && q.assignee.adventurerId === adventurerId).length;
}

// One underlying model reached through two providers is one author, so cards carry a family.
function sameAuthor(dispatch, adventurer) {
  if (dispatch.adventurerId === adventurer.id) return true;
  if (dispatch.family && adventurer.family && dispatch.family === adventurer.family) return true;
  return Boolean(dispatch.model) && dispatch.model === adventurer.model;
}

// Walks every ancestor: a review of a fix of a package must not go to whoever wrote the package.
// Earlier reviews in the chain are walked through but are not authorship.
function authoredAncestor(quest, adventurer, byId) {
  if (quest.kind !== 'review') return null;
  const seen = new Set();
  const stack = [...(quest.parents || [])];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const ancestor = byId.get(id);
    if (!ancestor) continue;
    const authors = [...(ancestor.dispatches || []), ...(ancestor.assignee ? [ancestor.assignee] : [])];
    if (ancestor.kind !== 'review' && authors.some((d) => sameAuthor(d, adventurer))) return id;
    stack.push(...(ancestor.parents || []));
  }
  return null;
}

// Declared conflicts in either direction, or an overlap between the briefs' file lists.
function runningConflict(quest, quests) {
  const own = new Set(quest.conflicts || []);
  const files = new Set(quest.files || []);
  for (const other of quests) {
    if (other.id === quest.id || other.status !== RUNNING_STATUS) continue;
    if (own.has(other.id) || (other.conflicts || []).includes(quest.id)) return { id: other.id, file: null };
    const shared = (other.files || []).find((file) => files.has(file));
    if (shared) return { id: other.id, file: shared };
  }
  return null;
}

function adventurerReasons(quest, adventurer, policy, env) {
  const reasons = [];
  if (env && env.laneIds && !env.laneIds.has(adventurer.lane)) reasons.push(reason('lane_missing', quest, adventurer));
  if (adventurer.status && adventurer.status !== 'available') {
    const code = MESSAGES[`adventurer_${adventurer.status}`] ? `adventurer_${adventurer.status}` : 'adventurer_disabled';
    reasons.push(reason(code, quest, adventurer));
  }
  if (matchesAny(adventurer.model, policy && policy.bannedModelPatterns)) reasons.push(reason('model_banned', quest, adventurer));
  if (matchesAny(adventurer.agent, policy && policy.bannedAgents)) reasons.push(reason('agent_banned', quest, adventurer));
  if ((quest.allowedLanes || []).length && !quest.allowedLanes.includes(adventurer.lane)) reasons.push(reason('lane_not_allowed', quest, adventurer));
  return reasons;
}

export function canDispatch({ quest, adventurer, quests, policy, env }) {
  const byId = new Map(quests.map((q) => [q.id, q]));
  const reasons = [];
  if (quest.kind === 'owner') reasons.push(reason('owner_quest', quest, adventurer));
  if (quest.kind === 'art' && !(adventurer.strengths || []).includes('art')) reasons.push(reason('needs_artist', quest, adventurer));
  if (!OPEN_STATUSES.has(quest.status)) reasons.push(reason('quest_not_open', quest, adventurer));
  if (quest.needsOwner) reasons.push(reason('needs_owner', quest, adventurer));
  const missing = (quest.parents || []).find((id) => !byId.has(id));
  if (missing) reasons.push(reason('parent_missing', quest, adventurer, missing));
  reasons.push(...adventurerReasons(quest, adventurer, policy, env));
  if (busyCount(adventurer.id, quests) >= (adventurer.maxParallel || 1)) reasons.push(reason('adventurer_busy', quest, adventurer));
  const authored = authoredAncestor(quest, adventurer, byId);
  if (authored) reasons.push(reason('reviewer_coded_parent', quest, adventurer, authored));
  const conflict = runningConflict(quest, quests);
  if (conflict) reasons.push(reason('conflict_running', quest, adventurer, conflict));
  if (env && env.treeLocked) reasons.push(reason('tree_locked', quest, adventurer));
  if (env && env.briefExists === false) reasons.push(reason('brief_missing', quest, adventurer));
  return { ok: reasons.length === 0, reasons };
}

export function eligibility({ quest, roster, quests, policy, env }) {
  return Object.fromEntries(roster.map((adventurer) => [adventurer.id, canDispatch({ quest, adventurer, quests, policy, env })]));
}
