// Pure dispatch guard. A refusal must be visible before the action, so the board computes these reasons
// for every adventurer on every quest and shows the message on the card before the drop.

export const OPEN_STATUSES = new Set(['posted', 'failed', 'bounced', 'stalled', 'lane_limited']);
export const RUNNING_STATUS = 'dispatched';

const MESSAGES = {
  owner_quest: () => '这是你亲自做的任务，不派给模型',
  quest_not_open: (quest) => `任务状态是「${quest.status}」，不能接`,
  needs_owner: (quest) => `等你先裁决：${quest.needsOwner}`,
  // FB2-02: both are named states, not raw status dumps — a send-back whose annotations call for the
  // coordinator waits there, and a ruled art quest waits for the coordinator to import the result.
  quest_needs_coordinator: () => '退回的批注里点名要 coordinator 处理，等它处理完再派',
  quest_owner_ruled: (quest) => quest.kind === 'art' ? '评审结论已经保存，等 coordinator 导入结果，不用再派' : '评审结论已经保存，等 coordinator 处理',
  parent_missing: (quest, adventurer, detail) => `父任务 ${detail} 不在板上，先让 coordinator 发布它`,
  // FB2-03: a parent counts only once it is accepted (done) — delivered/reviewing is still unverified.
  parent_not_accepted: (quest, adventurer, detail) => `父卡 ${detail} 还没验收`,
  quest_on_hold: (quest) => `挂起中：${quest.hold}`,
  quest_superseded: (quest) => `已被 ${quest.supersededBy || '新任务'} 取代，去派那张`,
  capabilities_missing: (quest, adventurer, detail) => `能力不够：卡和接入方式都没声明 ${detail}`,
  lane_missing: (quest, adventurer) => `这个项目没有配置 ${adventurer.lane} 通道`,
  adventurer_limited: (quest, adventurer, detail) => detail ? `这个模型限额中：${detail}` : '这个模型限额中',
  adventurer_broke: (quest, adventurer, detail) => detail ? `这张卡不能用了：${detail}` : '这个供应商余额不足',
  // FB2-07 item 4: a recovered card keeps its history visible at drop time — a warning, never a refusal.
  last_broke: (quest, adventurer, detail) => `上次 broke：${detail.reason}（${String(detail.at || '').slice(0, 16).replace('T', ' ')}），后来恢复了，派它之前留意一下`,
  adventurer_paused: () => '这个模型被暂停使用',
  adventurer_disabled: () => '这个模型已停用',
  model_banned: (quest, adventurer) => `模型 ${adventurer.model} 在禁用名单里`,
  // A legacy card whose saved env now breaks the env policy (roster.js envPolicyViolation): the roster
  // still loads and shows the card, but it is refused for dispatch exactly like a banned model, never
  // silently stripped or run with that env.
  env_policy: (quest, adventurer) => `${adventurer.envPolicy.reason}，这张卡不能派遣`,
  agent_banned: (quest, adventurer) => `人格 ${adventurer.agent} 在禁用名单里`,
  lane_not_allowed: (quest) => `coordinator 只允许这些通道：${quest.allowedLanes.join('、')}`,
  lane_server_down: (quest, adventurer, detail) => `${adventurer.lane} 通道的服务没开（${detail} 连不上）：先到 设置 → 执行通道 点「一键启动服务」`,
  // A refusal that says only "满了" cannot be checked: name the quests that hold the slots and their states.
  adventurer_busy: (quest, adventurer, detail) => `已在做 ${detail.holders.length}/${detail.limit} 个任务（${detail.holders.map((h) => `${h.id} ${h.status}`).join('、')}），满了`,
  // The lane's own ceiling, separate from a card's maxParallel: the lane is the shared resource. Lowering
  // it never touches the workers already on it; it only refuses the next one until one of them finishes.
  lane_busy: (quest, adventurer, detail) => `这条通道已有 ${detail.running} 个 worker 在跑，上限 ${detail.limit}，等一个结束再派`,
  reviewer_coded_parent: (quest, adventurer, detail) => `同一模型写过被审核的 ${detail}，不能自己审自己`,
  // Most packages in a design round share a partial, so a conflict reads as a queue, not an error.
  // A declared conflict holds even when the two file lists are disjoint, so the message must not claim
  // they touch the same files; only a real overlap names the shared file, and an unknown-brief conflict
  // (detail.unknown, from briefs.js's conflictKeys) must not claim to know that either — it says plainly
  // that the held quest's brief could not be confirmed, never "正在改同一批文件".
  conflict_running: (quest, adventurer, detail) => {
    if (detail.declared) return `排队：${detail.id} 和这个委托被标成不能同时做，一次只做一个`;
    if (detail.unknown) return `排队：${detail.id} 的简报现在读不了（${detail.reason}），不知道它会改哪些文件，先当作会撞车`;
    return `排队：${detail.id} 正在改同一批文件（${detail.file.split('/').filter(Boolean).pop() || detail.file}），一次一个`;
  },
  needs_artist: () => '美术委托只派给会画图的模型（strengths 含 art）',
  worker_unconfirmed: (quest) => `上一个 worker（${quest.assignee.name}）只是没动静，可能还在跑：确认它停了，先在档案里释放，再派`,
  tree_locked: () => 'coordinator 正在跑验证（锁文件存在），暂停派遣',
  upstream_unverified: (quest, adventurer, detail) => detail.text,
  brief_missing: (quest) => `找不到 brief 文件：${quest.brief || '（未填写）'}`,
  // Distinct from brief_missing: the file is there, but cannot be trusted right now (too large, a read
  // error, or it now resolves outside the project) — see briefs.js's briefUnusableInfo. Naming the file and
  // the actual cause instead of claiming it is missing.
  brief_unusable: (quest, adventurer, detail) => `简报文件读不了：${quest.brief}（${detail.reason}）`,
  variant_unsupported: (quest, adventurer, detail) => detail.accepted.length
    ? `这张卡的模型不支持变体「${detail.variant}」，只支持：${detail.accepted.join('、')}`
    : `这张卡的模型不支持变体「${detail.variant}」：到名册里清空这张卡的变体，或换一张支持它的卡`,
  // FB2-12 item 1: several cards behind one machine (five oc-lms-* cards on one LM Studio) share a ceiling,
  // so the refusal reads as a queue, not an error — and it names the group-mates actually holding the slots.
  group_busy: (quest, adventurer, detail) => `并发组 ${detail.group} 满了（${detail.running}/${detail.limit} 在跑）：同组的 ${detail.holders.join('、')} 正在跑，先排队等一个结束`,
  // A grouped card whose limit could not be read: guessing a number would either over-dispatch the shared
  // machine or silently block work, so the drop is refused and the missing field is named.
  group_limit_missing: (quest, adventurer, detail) => `这张卡在并发组 ${detail.group} 里，但没写 groupMaxParallel，说不清整组能同时跑几个：先到名册里补上`,
  // FB2-12 items 33/34: the coordinator may only dispatch the machine-check fast track. Each refusal names
  // the one thing that is missing and how to get out of it; the owner's own dispatch is never limited.
  coordinator_origin: (quest, adventurer, detail) => detail.origin
    ? `coordinator 只能直接派机器检查出来的小修复（origin 是 machine-check 或 post-delivery-check），${quest.id} 的 origin 是「${detail.origin}」；owner 不受这个限制，用 assign --by owner 派它`
    : `coordinator 只能直接派机器检查出来的小修复，${quest.id} 没有 origin：post 时加 --origin machine-check --check "哪条检查"，或者 owner 用 assign --by owner 派它`,
  coordinator_card: (quest, adventurer) => `这张卡（${adventurer.id}）没开 coordinatorAssignable：只有 owner 勾了的免费卡能由 coordinator 直接派，换一张卡，或让 owner 用 assign --by owner 派它`,
  coordinator_files: (quest, adventurer, detail) => `可改文件有 ${detail.count} 个，超过 coordinator 直接派的上限 ${detail.limit} 个（assign --max-files 可调）：让 owner 用 assign --by owner 派它`,
};

function reason(code, quest, adventurer, detail) {
  return { code, message: MESSAGES[code](quest, adventurer, detail) };
}

/**
 * Declared variant support is facts about the card, not a vendor-derived guess. An absent declaration is
 * deliberately allowed but produces a warning; an explicit empty/list declaration is authoritative.
 */
export function checkVariantSupport(quest, adventurer) {
  const variant = typeof adventurer.variant === 'string' ? adventurer.variant.trim() : '';
  if (!variant) return { ok: true, warnings: [] };
  if (adventurer.variants === undefined) {
    return {
      ok: true,
      warnings: [{ code: 'variant_unconfirmed', message: `还没确认这张卡支持变体「${variant}」，照常派遣` }],
    };
  }
  if (adventurer.variants.length === 0 || !adventurer.variants.includes(variant)) {
    return {
      ok: false,
      reason: reason('variant_unsupported', quest, adventurer, { variant, accepted: adventurer.variants }),
      warnings: [],
    };
  }
  return { ok: true, warnings: [] };
}

function matchesAny(value, patterns) {
  if (!value) return false;
  return (patterns || []).some((pattern) => new RegExp(pattern, 'i').test(value));
}

// A stalled worker has gone quiet, not away: it keeps its slot and its files until it is released.
export function holdsSlot(quest) {
  return Boolean(quest.assignee) && (quest.status === RUNNING_STATUS || quest.status === 'stalled');
}

// The one thing that tells a queued recheck ("is my own attempt still allowed to actually spawn?") apart
// from a brand-new assignment request: a quest already dispatched or stalled as the very attempt asking is
// not a second assignment competing for the slot, it is the same one continuing. This narrows exactly the
// two reasons below that exist only to protect a slot from a competing assignment (quest_not_open,
// worker_unconfirmed) — every other safety condition canDispatch checks still runs in full for it, computed
// fresh from whatever quest/adventurer/env the caller passes in. Not a licence to skip anything else.
export function isOwnActiveAttempt(quest, selfAttemptId) {
  return Boolean(selfAttemptId) && Boolean(quest.assignee) && quest.assignee.attemptId === selfAttemptId
    && (quest.status === RUNNING_STATUS || quest.status === 'stalled');
}

// Quests actually reserving one of this card's parallel slots: dispatched or stalled work other than
// the candidate itself, whose own status is judged by the rules above, not counted against its limit.
function busyQuests(adventurerId, quests, candidateId) {
  return quests.filter((q) => q.id !== candidateId && holdsSlot(q) && q.assignee.adventurerId === adventurerId);
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

// Suggestion S3: review-order warning/refusal. A review quest's own upstream evidence — the parent's
// CURRENT-attempt evidence (src/core/evidence.js questEvidence, read through env.evidenceOf so this file
// stays pure and does no I/O of its own) — classified per kind so the model's own claim (report, 模型自报)
// never gets folded into what the project's own tooling actually verified (project-verification, hook).
const EVIDENCE_KIND_LABELS = { report: '模型自报', 'project-verification': '项目验证记录', hook: '验证钩子' };
const EVIDENCE_STATE_LABELS = { passed: '通过', failed: '失败', stale: '不是这次派遣的', missing: '缺失', not_configured: '未配置', unknown: '未知' };
const REVIEW_UPSTREAM_KINDS = ['report', 'project-verification', 'hook'];

// One of six honest states for one evidence item, in priority order: a kind the project never configured,
// one it configured but never produced, one bound to an earlier attempt (never counted for this one, even
// when its own recorded state says passed), then the item's own passed/failed, and anything else (findings,
// queued, running, timedout, an unrecognized record) as unknown — never dressed up as a pass.
export function classifyEvidenceItem(item) {
  if (!item) return 'unknown';
  if (item.state === 'not_configured') return 'not_configured';
  if (item.state === 'missing') return 'missing';
  if (!item.bound) return 'stale';
  if (item.state === 'passed') return 'passed';
  if (item.state === 'failed') return 'failed';
  return 'unknown';
}

export function parentUpstreamStates(evidence) {
  const byKind = Object.fromEntries((evidence?.items || []).map((item) => [item.kind, item]));
  return Object.fromEntries(REVIEW_UPSTREAM_KINDS.map((kind) => [kind, classifyEvidenceItem(byKind[kind])]));
}

function upstreamClause(kind, state) {
  return `${EVIDENCE_KIND_LABELS[kind]}${EVIDENCE_STATE_LABELS[state]}`;
}

// One Chinese line naming a parent's upstream evidence: the two project-test kinds first (what tooling
// actually showed), the model's own report last, flagged with 未经项目验证 whenever it claims a pass that
// neither project-verification nor the hook actually backs — the self-claim is never left to read the same
// as a verified one.
function parentUpstreamText(parentId, states) {
  const projectVerified = states['project-verification'] === 'passed' || states.hook === 'passed';
  const clauses = [];
  for (const kind of ['project-verification', 'hook']) {
    if (states[kind] !== 'passed') clauses.push(upstreamClause(kind, states[kind]));
  }
  clauses.push(states.report === 'passed' && !projectVerified
    ? `${upstreamClause('report', 'passed')}（未经项目验证）`
    : upstreamClause('report', states.report));
  return `上游 ${parentId} 最近一次派遣：${clauses.join('、')}`;
}

/**
 * The full review-order picture for one review quest (requirement 1-3): every non-review parent's
 * classified evidence, which policy.reviewRequires kinds it fails, whether a recorded reviewOverride
 * still covers the parents' CURRENT attempts, and whether that leaves the review blocked. Returns null for
 * anything that is not a review quest, or when the caller's env carries no evidenceOf (e.g. dispatcher.js's
 * own recheck env, which does not build one) — silence, never a fabricated pass, is the only safe answer
 * when the evidence cannot actually be read.
 */
export function reviewUpstreamEvidence({ quest, quests, policy, env }) {
  if (!quest || quest.kind !== 'review' || !env || typeof env.evidenceOf !== 'function') return null;
  const byId = new Map((quests || []).map((q) => [q.id, q]));
  const required = [...new Set((policy && policy.reviewRequires) || [])];
  const parentIds = (quest.parents || []).filter((id) => {
    const parent = byId.get(id);
    return !parent || parent.kind !== 'review';
  });
  const parents = [];
  for (const id of parentIds) {
    const evidence = env.evidenceOf(id);
    if (!evidence) continue;
    const states = parentUpstreamStates(evidence);
    const failing = required.filter((kind) => states[kind] !== 'passed');
    const projectVerified = states['project-verification'] === 'passed' || states.hook === 'passed';
    parents.push({
      id, attemptId: evidence.attemptId, states, failing,
      gap: !projectVerified || states.report !== 'passed',
      text: parentUpstreamText(id, states),
    });
  }
  const failingParents = parents.filter((p) => p.failing.length > 0).map((p) => p.id);
  const rawOverride = quest.reviewOverride || null;
  const overrideValid = Boolean(rawOverride && rawOverride.parentAttempts && parentIds.length > 0 && parentIds.every((id) => {
    const parent = parents.find((p) => p.id === id);
    const recorded = rawOverride.parentAttempts[id];
    return recorded !== undefined && parent && recorded === parent.attemptId;
  }));
  return {
    required,
    parents,
    failingParents,
    blocked: failingParents.length > 0 && !overrideValid,
    override: rawOverride ? { reason: rawOverride.reason, by: rawOverride.by, at: rawOverride.at, valid: overrideValid } : null,
  };
}

// Turns reviewUpstreamEvidence's structured report into the reasons/warnings shape canDispatch already
// returns everywhere else: silent when everything checks out, a warning per gap while policy asks for
// nothing specific, a refusal per failing-required parent, or — once a recorded override still covers the
// parents' current attempts — that same refusal downgraded to a warning that says so.
function reviewUpstreamMessages(quest, adventurer, quests, policy, env) {
  const upstream = reviewUpstreamEvidence({ quest, quests, policy, env });
  const reasons = [];
  const warnings = [];
  if (!upstream) return { reasons, warnings };
  if (!upstream.required.length) {
    for (const p of upstream.parents) if (p.gap) warnings.push(reason('upstream_unverified', quest, adventurer, { text: p.text }));
    return { reasons, warnings };
  }
  if (!upstream.failingParents.length) return { reasons, warnings };
  const invalidNote = upstream.override && !upstream.override.valid ? '（记录的例外已失效：上游有新的派遣，需要重新确认）' : '';
  for (const id of upstream.failingParents) {
    const p = upstream.parents.find((x) => x.id === id);
    if (upstream.blocked) reasons.push(reason('upstream_unverified', quest, adventurer, { text: `${p.text}${invalidNote}` }));
    else warnings.push(reason('upstream_unverified', quest, adventurer, { text: `${p.text}（已记录例外：${upstream.override.reason}）` }));
  }
  return { reasons, warnings };
}

// Declared conflicts in either direction, a real overlap between the briefs' file lists, or a shared
// unknown-brief conflict key (briefs.js's conflictKeys — never mixed into files itself, see withFileSets).
// A declared conflict binds even when the file lists are disjoint, so the result says which kind it is.
function runningConflict(quest, quests) {
  const own = new Set(quest.conflicts || []);
  const files = new Set(quest.files || []);
  const conflictKeys = new Set(quest.conflictKeys || []);
  for (const other of quests) {
    if (other.id === quest.id || !holdsSlot(other)) continue;
    if (own.has(other.id) || (other.conflicts || []).includes(quest.id)) return { id: other.id, file: null, declared: true };
    const shared = (other.files || []).find((file) => files.has(file));
    if (shared) return { id: other.id, file: shared, declared: false };
    const sharedKey = (other.conflictKeys || []).find((key) => conflictKeys.has(key));
    if (sharedKey) return { id: other.id, declared: false, unknown: true, reason: other.briefUnknownReason || '不知道它会改哪些文件' };
  }
  return null;
}

function adventurerReasons(quest, adventurer, policy, env) {
  const reasons = [];
  if (env && env.laneIds && !env.laneIds.has(adventurer.lane)) reasons.push(reason('lane_missing', quest, adventurer));
  if (env && env.downLanes && env.downLanes.has(adventurer.lane)) reasons.push(reason('lane_server_down', quest, adventurer, env.downLanes.get(adventurer.lane)));
  if (adventurer.status && adventurer.status !== 'available') {
    const code = MESSAGES[`adventurer_${adventurer.status}`] ? `adventurer_${adventurer.status}` : 'adventurer_disabled';
    const detail = code === 'adventurer_limited' || code === 'adventurer_broke'
      ? (adventurer.derived && adventurer.derived.reason) || adventurer.baseReason || adventurer.statusReason || ''
      : undefined;
    reasons.push(reason(code, quest, adventurer, detail));
  }
  if (adventurer.envPolicy) reasons.push(reason('env_policy', quest, adventurer));
  if (matchesAny(adventurer.model, policy && policy.bannedModelPatterns)) reasons.push(reason('model_banned', quest, adventurer));
  if (matchesAny(adventurer.agent, policy && policy.bannedAgents)) reasons.push(reason('agent_banned', quest, adventurer));
  if ((quest.allowedLanes || []).length && !quest.allowedLanes.includes(adventurer.lane)) reasons.push(reason('lane_not_allowed', quest, adventurer));
  return reasons;
}

export function canDispatch({ quest, adventurer, quests, policy, env, selfAttemptId }) {
  const byId = new Map(quests.map((q) => [q.id, q]));
  const reasons = [];
  const variantCheck = checkVariantSupport(quest, adventurer);
  if (!variantCheck.ok) reasons.push(variantCheck.reason);
  const ownAttempt = isOwnActiveAttempt(quest, selfAttemptId);
  if (quest.kind === 'owner') reasons.push(reason('owner_quest', quest, adventurer));
  if (quest.kind === 'art' && !(adventurer.strengths || []).includes('art')) reasons.push(reason('needs_artist', quest, adventurer));
  if (quest.status === 'needs_coordinator' && !ownAttempt) reasons.push(reason('quest_needs_coordinator', quest, adventurer));
  if (quest.status === 'owner_ruled' && !ownAttempt) reasons.push(reason('quest_owner_ruled', quest, adventurer));
  const specificHold = quest.status === 'needs_coordinator' || quest.status === 'owner_ruled' || quest.status === 'superseded';
  if (quest.status === 'superseded' && !ownAttempt) reasons.push(reason('quest_superseded', quest, adventurer));
  if (!OPEN_STATUSES.has(quest.status) && !ownAttempt && !specificHold) reasons.push(reason('quest_not_open', quest, adventurer));
  if (quest.status === 'stalled' && quest.assignee && !ownAttempt) reasons.push(reason('worker_unconfirmed', quest, adventurer));
  if (quest.needsOwner) reasons.push(reason('needs_owner', quest, adventurer));
  const missing = (quest.parents || []).find((id) => !byId.has(id));
  if (missing) reasons.push(reason('parent_missing', quest, adventurer, missing));
  // FB2-03: parents gate a work quest until every parent is accepted; a review of a delivered parent is
  // exactly the flow a review exists for, so reviews are exempt. Missing parents stay parent_missing.
  if (quest.kind !== 'review') {
    for (const parentId of quest.parents || []) {
      const parent = byId.get(parentId);
      if (parent && parent.status !== 'done') reasons.push(reason('parent_not_accepted', quest, adventurer, parentId));
    }
  }
  if (quest.hold) reasons.push(reason('quest_on_hold', quest, adventurer));
  const needs = quest.needs || [];
  if (needs.length) {
    const declared = new Set([...(adventurer.capabilities || []), ...((env && env.laneCapabilities && env.laneCapabilities[adventurer.lane]) || [])]);
    const gaps = needs.filter((n) => !declared.has(n));
    if (gaps.length) reasons.push(reason('capabilities_missing', quest, adventurer, gaps.join('、')));
  }
  const upstream = reviewUpstreamMessages(quest, adventurer, quests, policy, env);
  reasons.push(...upstream.reasons);
  reasons.push(...adventurerReasons(quest, adventurer, policy, env));
  const holders = busyQuests(adventurer.id, quests, quest.id);
  if (holders.length >= (adventurer.maxParallel || 1)) reasons.push(reason('adventurer_busy', quest, adventurer, { limit: adventurer.maxParallel || 1, holders: holders.map(({ id, status }) => ({ id, status })) }));
  reasons.push(...groupReasons(quest, adventurer, quests));
  reasons.push(...laneBusyReasons(quest, adventurer, quests, policy));
  const authored = authoredAncestor(quest, adventurer, byId);
  if (authored) reasons.push(reason('reviewer_coded_parent', quest, adventurer, authored));
  const conflict = runningConflict(quest, quests);
  if (conflict) reasons.push(reason('conflict_running', quest, adventurer, conflict));
  if (env && env.treeLocked) reasons.push(reason('tree_locked', quest, adventurer));
  if (env && env.briefUnusable) reasons.push(reason('brief_unusable', quest, adventurer, env.briefUnusable));
  else if (env && env.briefExists === false) reasons.push(reason('brief_missing', quest, adventurer));
  const allWarnings = [...variantCheck.warnings, ...upstream.warnings];
  // FB2-07 item 4: broke → available keeps the memory; the drop preview shows when and why it last died.
  if (adventurer.lastBroke && (!adventurer.status || adventurer.status === 'available')) {
    allWarnings.push({ code: 'last_broke', message: MESSAGES.last_broke(quest, adventurer, adventurer.lastBroke) });
  }
  return {
    ok: reasons.length === 0,
    reasons,
    ...(allWarnings.length ? { warnings: allWarnings } : {}),
  };
}

export function eligibility({ quest, roster, quests, policy, env }) {
  return Object.fromEntries(roster.map((adventurer) => [adventurer.id, canDispatch({ quest, adventurer, quests, policy, env })]));
}

// FB2-12 item 1: cards that share one machine carry a concurrencyGroup with that group's single ceiling
// (roster.js refuses a group whose members disagree, so the candidate's own card carries the number).
// Counted from the attempts themselves — every slot-holding quest records the group it was dispatched
// under (store.assign), so this needs no roster lookup and an attempt keeps the group it was started with
// even if the card is regrouped later. A candidate never counts against its own group slot (same shape as
// busyQuests), and a card outside any group is untouched by any of it.
function groupReasons(quest, adventurer, quests) {
  const group = adventurer.concurrencyGroup;
  if (!group) return [];
  const limit = adventurer.groupMaxParallel;
  if (!Number.isInteger(limit) || limit < 1) return [reason('group_limit_missing', quest, adventurer, { group })];
  const running = quests.filter((q) => q.id !== quest.id && holdsSlot(q) && q.assignee && q.assignee.concurrencyGroup === group);
  if (running.length < limit) return [];
  return [reason('group_busy', quest, adventurer, { group, limit, running: running.length, holders: running.map((q) => q.id) })];
}

// FB2-12 items 33/34: how many files a machine-check fix may touch and still be dispatched under the
// coordinator's own identity (the CLI's --max-files default).
export const COORDINATOR_MAX_FILES = 3;
const FAST_TRACK_ORIGINS = new Set(['machine-check', 'post-delivery-check']);

/**
 * The coordinator-identity dispatch gate. The owner approved the fast track for one shape only: a fix a
 * machine check produced (origin), on a card the owner marked coordinatorAssignable (free cards only,
 * roster.js enforces the billing half), touching at most `maxFiles` files. Anything else is refused here
 * with the one reason that is missing — never a silent pass, and never applied to the owner, whose own
 * dispatch this function is simply not called for. Returns null when the dispatch may proceed.
 *
 * The file count is the quest's own editable set (withFileSets: an explicit --files override, else the
 * brief's file-list section), and an empty set counts as 0 — the rule counts declared files, and a brief
 * that declares none is a state the project itself wrote. The origin is the coordinator's own claim on the
 * quest, which is why the card's billing and the file count are the two facts that carry the real weight.
 */
export function coordinatorFastTrackRefusal({ quest, adventurer, maxFiles = COORDINATOR_MAX_FILES }) {
  const origin = quest && quest.origin ? String(quest.origin) : null;
  if (!origin || !FAST_TRACK_ORIGINS.has(origin)) return reason('coordinator_origin', quest, adventurer, { origin });
  if (adventurer.coordinatorAssignable !== true) return reason('coordinator_card', quest, adventurer);
  const count = (quest.files || []).length;
  if (count > maxFiles) return reason('coordinator_files', quest, adventurer, { count, limit: maxFiles });
  return null;
}

// policy.laneConcurrency caps how many attempts one lane may carry at once, on top of each card's own
// maxParallel. Only quests that hold a slot (dispatched or stalled) count, and the candidate itself never
// counts against its own recheck — the same shape busyQuests uses. Counted here, at each refusal, so a
// lowered limit blocks the next dispatch without ever touching the workers already running.
function laneBusyReasons(quest, adventurer, quests, policy) {
  const limit = policy && policy.laneConcurrency ? policy.laneConcurrency[adventurer.lane] : undefined;
  if (!Number.isInteger(limit) || limit < 1) return [];
  const running = quests.filter((q) => q.id !== quest.id && holdsSlot(q) && q.assignee && q.assignee.lane === adventurer.lane).length;
  return running >= limit ? [reason('lane_busy', quest, adventurer, { running, limit })] : [];
}
